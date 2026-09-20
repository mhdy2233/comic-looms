import EBUS from "../event-bus";
import { IMGFetcherQueue } from "../fetcher-queue";
import { FetchState, IMGFetcher } from "../img-fetcher";
import { Chapter } from "../page-fetcher";
import { ADAPTER } from "../platform/adapt";
import { evLog } from "../utils/ev-log";
import { sleep } from "../utils/sleep";
import { InkClient, inkAPIConf, inkTargetLanguage } from "./ink-client";
import { inkBlobDataURL, inkBounding, inkCanvasToBlob, inkComposite, inkCoverColor, inkCoverLuminance, inkLoadImage, inkTextMask, InkRepairedPatch, InkTextSpec } from "./ink-render";

export type InkStatus = "idle" | "running" | "done" | "cancelled" | "failed";
export const INK_TRANSLATED_KEY = "__inkTranslated";
type InkFetcher = IMGFetcher & { [INK_TRANSLATED_KEY]?: string };

export function INK_TRANSLATED_SRC(imf: IMGFetcher): string | undefined {
  return (imf as InkFetcher)[INK_TRANSLATED_KEY];
}

export class InkTranslateService {
  status: InkStatus = "idle";
  progress = { done: 0, total: 0, failed: 0 };
  error?: string;
  private version = 0;
  private controllers = new Set<AbortController>();
  private cached = new Set<InkFetcher>();

  constructor(private queue: IMGFetcherQueue, private chapter: (index: number) => Chapter) { }

  start(): void {
    if (this.status === "running") return;
    const chapterIndex = this.queue.chapterIndex;
    const chapter = this.chapter(chapterIndex);
    if (!chapter?.filteredQueue.length) {
      EBUS.emit("notify-message", "error", "当前章节没有可翻译的图片", 3000);
      return;
    }
    const ver = ++this.version;
    this.status = "running";
    this.error = undefined;
    this.progress = { done: 0, total: chapter.filteredQueue.length, failed: 0 };
    const controller = new AbortController();
    this.controllers.add(controller);
    EBUS.emit("ink-progress");
    const client = new InkClient(inkAPIConf());
    const targetLanguage = inkTargetLanguage();
    void this.run(chapterIndex, chapter, ver, client, targetLanguage, controller.signal)
      .catch(error => {
        if (ver !== this.version) return;
        this.error = error instanceof Error ? error.message : String(error);
        this.status = "failed";
        EBUS.emit("notify-message", "error", this.error, 3000);
        EBUS.emit("ink-progress");
      })
      .finally(() => this.controllers.delete(controller));
  }

  private async run(chapterIndex: number, chapter: Chapter, ver: number, client: InkClient, targetLanguage: string, signal: AbortSignal): Promise<void> {
    let next = 0;
    let discovery: Promise<void> | undefined;
    let discoveryError: unknown;
    const discover = async () => {
      const length = chapter.filteredQueue.length;
      const started = Date.now();
      let requested = false;
      while (!chapter.done && chapter.filteredQueue.length === length) {
        signal.throwIfAborted();
        if (this.queue.chapterIndex !== chapterIndex) {
          this.cancel();
          signal.throwIfAborted();
        }
        // Request the first missing index, not length - 1 (which is already loaded).
        if (!requested && !this.queue.downloading?.()) {
          requested = true;
          EBUS.emit("pf-load-until", chapterIndex, length);
        }
        if (Date.now() - started >= 60000) throw new Error("等待章节后续图片超时，未完成整章翻译");
        await sleep(150);
      }
      signal.throwIfAborted();
      this.progress.total = chapter.filteredQueue.length;
      EBUS.emit("ink-progress");
    };
    const worker = async () => {
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        while (ver === this.version) {
          if (this.queue.chapterIndex !== chapterIndex) { this.cancel(); return; }
          if (next >= chapter.filteredQueue.length) {
            if (chapter.done || discoveryError) return;
            if (!discovery) {
              discovery = discover().catch(error => { discoveryError = error; })
                .finally(() => { discovery = undefined; });
            }
            await discovery;
            continue;
          }
          const imf = chapter.filteredQueue[next++];
          this.progress.total = chapter.filteredQueue.length;
          try {
            if (await this.ensureLoaded(imf, controller.signal)) {
              await this.process(imf, client, targetLanguage, controller.signal);
            }
          } catch (error) {
            if (ver !== this.version) return;
            this.progress.failed++;
            this.error = error instanceof Error ? error.message : String(error);
            EBUS.emit("notify-message", "error", `第 ${imf.index + 1} 页翻译失败: ${this.error}`, 3000);
          }
          if (ver !== this.version) return;
          this.progress.done++;
          EBUS.emit("ink-progress");
        }
      } finally {
        this.controllers.delete(controller);
      }
    };
    const threads = Math.max(1, Math.floor(ADAPTER.conf.downloadThreads) || 1);
    await Promise.all(Array.from({ length: threads }, worker));
    if (ver !== this.version) return;
    if (discoveryError) throw discoveryError;
    this.status = this.progress.failed === this.progress.total ? "failed" : "done";
    EBUS.emit("ink-progress");
  }

  private async ensureLoaded(imf: IMGFetcher, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (imf.stage === FetchState.DONE && imf.data) return true;
    // A download's selection must not be bypassed by this independent load queue.
    const excluded = () => this.queue.downloading?.() && EBUS.emit("imf-check-picked", imf.chapterIndex, imf.index) === false;
    if (excluded()) return false;
    void imf.start();
    const started = Date.now();
    while (imf.stage !== FetchState.DONE || !imf.data) {
      signal.throwIfAborted();
      if (excluded()) return false;
      if (Date.now() - started >= 60000) throw new Error(imf.failedReason || "等待大图加载超时");
      await sleep(150);
    }
    signal.throwIfAborted();
    return true;
  }

  private async process(imf: IMGFetcher, client: InkClient, targetLanguage: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.translatedSrc(imf) !== undefined) return;
    if (!(imf.data instanceof Uint8Array) || !imf.node.blobSrc || /^(video|ugoira)/.test(imf.contentType || "")) {
      throw new Error("不支持的图片类型");
    }
    const original = new Blob([imf.data], { type: imf.contentType });
    const dataURL = await inkBlobDataURL(original);
    signal.throwIfAborted();
    const started = performance.now();
    const ocr = await client.ocr(dataURL, signal);
    signal.throwIfAborted();
    evLog("info", `ink translate #${imf.index + 1} ${ocr.lines.length} lines, OCR ${Math.round(performance.now() - started)}ms`);
    const lines = ocr.lines.filter(line => line.text.trim() !== "");
    if (!lines.length) { this.cache(imf, ""); return; }
    const translated = await client.translate(lines.map(line => line.text), targetLanguage, signal);
    signal.throwIfAborted();
    const bounds = lines.map(line => inkBounding(line.box, ocr.width, ocr.height));
    const fillMode = (ADAPTER.conf.inkFillMode || "repair").trim() || "repair";
    // "solid" needs no service round trip, so a flat cover works even when repair models are unavailable.
    const patches = fillMode === "solid" ? [] : await client.repair(dataURL, lines.map((line, i) => ({ bounding: bounds[i], originalText: line.text })), signal);
    signal.throwIfAborted();
    // Decode the fetched bytes, never a thumbnail or the remote URL used by CSP fallback.
    const base = await inkLoadImage(original);
    signal.throwIfAborted();
    const baseCanvas = document.createElement("canvas");
    baseCanvas.width = ocr.width;
    baseCanvas.height = ocr.height;
    const ctx = baseCanvas.getContext("2d")!;
    ctx.drawImage(base, 0, 0);
    const repaired: InkRepairedPatch[] = [];
    const texts: InkTextSpec[] = [];
    for (let i = 0; i < lines.length; i++) {
      signal.throwIfAborted();
      const [x, y, w, h] = bounds[i];
      const patch = patches[i];
      let cover: string | undefined;
      if (patch && fillMode === "repair") {
        const image = await inkLoadImage(patch.backgroundPNG);
        signal.throwIfAborted();
        const [px, py, pw, ph] = patch.bounds;
        repaired.push({ rect: { x: px, y: py, w: pw, h: ph }, image });
      } else if (w > 0 && h > 0 && fillMode !== "repair") {
        // Cover the original glyphs; the fill colour is sampled from the box, ignoring the glyphs themselves.
        const pixels = ctx.getImageData(x, y, w, h).data;
        let skip: Uint8ClampedArray | undefined;
        let mask: CanvasImageSource | undefined;
        if (fillMode === "mask" && patch?.maskPNG) {
          const textMask = inkTextMask(await inkLoadImage(patch.maskPNG), w, h);
          signal.throwIfAborted();
          mask = textMask.canvas;
          skip = textMask.inside;
        }
        cover = inkCoverColor(pixels, skip);
        // "mask" keeps the surrounding artwork: only glyph pixels are covered; "solid" covers the whole box.
        repaired.push({ rect: { x, y, w, h }, color: cover, mask });
      }
      const sampled = patch?.foreground || (cover ? (inkCoverLuminance(cover) > 140 ? "#101010" : "#ffffff") : null);
      let color = sampled;
      if (!color && w > 0 && h > 0) {
        const pixels = ctx.getImageData(x, y, w, h).data;
        let dark = 0;
        for (let p = 0; p < pixels.length; p += 4) {
          if (pixels[p] * 0.2126 + pixels[p + 1] * 0.7152 + pixels[p + 2] * 0.0722 < 128) dark++;
        }
        color = dark > w * h / 2 ? "#101010" : "#ffffff";
      }
      texts.push({ text: translated[i]?.translation || "", rect: { x, y, w, h }, vertical: lines[i].vertical, color: color || "#101010", stroke: sampled ? "transparent" : "rgba(255,255,255,0.85)" });
    }
    const canvas = inkComposite(baseCanvas, ocr.width, ocr.height, repaired, texts);
    baseCanvas.width = baseCanvas.height = 0;
    const blob = await inkCanvasToBlob(canvas);
    canvas.width = canvas.height = 0;
    signal.throwIfAborted();
    this.cache(imf, URL.createObjectURL(blob));
    EBUS.emit("imf-translated", imf);
  }

  private cache(imf: InkFetcher, src: string): void {
    const previous = this.translatedSrc(imf);
    if (previous) URL.revokeObjectURL(previous);
    imf[INK_TRANSLATED_KEY] = src;
    this.cached.add(imf);
  }

  translatedSrc(imf: IMGFetcher): string | undefined { return INK_TRANSLATED_SRC(imf); }

  cancel(): void {
    this.version++;
    this.status = "cancelled";
    this.error = undefined;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    EBUS.emit("ink-progress");
  }

  release(): void {
    this.cancel();
    for (const imf of this.cached) {
      const src = this.translatedSrc(imf);
      if (src) URL.revokeObjectURL(src);
      delete imf[INK_TRANSLATED_KEY];
    }
    this.cached.clear();
  }

}
