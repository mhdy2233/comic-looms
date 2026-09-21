import { ADAPTER } from "../platform/adapt";
import { GM_XHR } from "../utils/query";

export type InkOCRLine = {
  box: [number, number][];
  text: string;
  vertical: boolean;
};

export type InkOCRResult = {
  width: number;
  height: number;
  lines: InkOCRLine[];
};

export type InkRepairPatch = {
  bounds: [number, number, number, number];
  backgroundPNG: string;
  foreground: string | null;
  /** Text mask returned by the service; only "mask" fill mode uses it. */
  maskPNG: string | null;
};

export type InkAPIConf = { baseURL: string; token: string; mode: string };
export type InkTranslateParagraph = { source: string; translation: string };

type OCRJob = {
  id: string;
  status: string;
  error?: unknown;
  result?: {
    width: number;
    height: number;
    lines?: { box: [number, number][]; text: string; vertical?: boolean }[];
    boxesWithText?: { bounding: [number, number, number, number]; originalText: string }[];
  };
};

export function inkAPIConf(): InkAPIConf {
  const conf = ADAPTER.conf;
  return {
    baseURL: (conf.inkOCRBaseURL || "http://127.0.0.1:18765").trim().replace(/\/+$/, "") || "http://127.0.0.1:18765",
    token: (conf.inkOCRToken || "").trim(),
    mode: (conf.inkOCRMode || "manga").trim() || "manga",
  };
}

export function inkTargetLanguage(): string {
  const language = navigator.language || "";
  // The service accepts base language codes (en, ja, ko, …) plus zh-Hans/zh-Hant only;
  // region variants such as en-US are rejected with invalid_language.
  if (/^zh(?:-|$)/i.test(language)) {
    return /(?:^|-)(?:Hant|TW|HK)(?:-|$)/i.test(language) ? "zh-Hant" : "zh-Hans";
  }
  return language.split("-")[0].toLowerCase() || "en";
}

function inkError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === "object" && "error" in value) value = value.error;
  if (typeof value === "string" && value.trim()) return new Error(value);
  if (value && typeof value === "object") {
    if ("message" in value && typeof value.message === "string" && value.message.trim()) return new Error(value.message);
    if ("code" in value && typeof value.code === "string" && value.code.trim()) return new Error(`${fallback} (${value.code})`);
  }
  return new Error(fallback);
}

function validBounds(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
}

export class InkClient {
  constructor(private conf: InkAPIConf) { }

  private request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 600000): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    let request: GmAsyncXmlhttpRequestReturnType<"text"> | undefined;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const abortRequest = () => {
      try {
        request?.abort();
      } catch {
        // The cancellation reason wins even if the userscript manager cannot abort.
      }
    };
    const onAbort = () => {
      fail(signal?.reason ?? new DOMException("Ink OCR request cancelled", "AbortError"));
      abortRequest();
    };
    if (signal?.aborted) {
      onAbort();
      return promise;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (typeof GM_XHR !== "function") throw new Error("Ink OCR requires a userscript manager with GM.xmlHttpRequest support");
      const data = body === undefined ? undefined : JSON.stringify(body);
      if (signal?.aborted) {
        onAbort();
        return promise;
      }
      request = GM_XHR<"text">({
        method,
        url: this.conf.baseURL + path,
        responseType: "text",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.conf.token}`,
        },
        data,
        onload: response => {
          if (settled) return;
          if (signal?.aborted) {
            onAbort();
            return;
          }
          const body = response.responseText || response.response;
          let result: T;
          try {
            result = JSON.parse(body);
          } catch (error) {
            fail(new Error("Ink OCR 返回非 JSON 响应: " + body.slice(0, 200), { cause: error }));
            return;
          }
          if (response.status < 200 || response.status >= 300) {
            fail(inkError(result, `Ink OCR HTTP ${response.status}: ${response.statusText}`));
            return;
          }
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
        onerror: error => fail(new Error(`Ink OCR request to ${this.conf.baseURL} failed: ${inkError(error, "Network error").message}`)),
        ontimeout: () => fail(new Error(`Ink OCR request to ${this.conf.baseURL} timed out after 600 seconds`)),
        onabort: () => fail(signal?.reason ?? new DOMException("Ink OCR request cancelled", "AbortError")),
      });
      // GM4 returns a rejecting Promise as well as invoking the callbacks.
      void request?.catch?.(error => fail(new Error(`Ink OCR request to ${this.conf.baseURL} failed: ${inkError(error, "Network error").message}`)));
      if (signal?.aborted) abortRequest();
    } catch (error) {
      fail(inkError(error, "Ink OCR request failed"));
    }
    return promise;
  }

  /**
   * OCR slots the service advertises for the configured mode.
   * Any transport, HTTP, parsing or shape problem degrades to 1 (serial) instead of failing a chapter.
   */
  async ocrCapacity(): Promise<number> {
    try {
      const status = await this.request<{ engines?: { id?: unknown; concurrency?: unknown }[]; ocr?: { manga_workers?: unknown } }>("GET", "/v1/engines");
      const engine = status?.engines?.find(entry => entry?.id === this.conf.mode)?.concurrency;
      if (typeof engine === "number" && Number.isInteger(engine) && engine >= 1) return engine;
      const workers = status?.ocr?.manga_workers;
      return typeof workers === "number" && Number.isInteger(workers) && workers >= 1 ? workers : 1;
    } catch {
      return 1;
    }
  }

  async ocr(imageDataURL: string, signal?: AbortSignal): Promise<InkOCRResult> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error("Ink OCR job timed out after 610 seconds")), 610000);
    let jobID: string | undefined;
    // Best-effort remote cancel: the aborted request keeps occupying a service slot until the backend notices.
    // Swallowing the DELETE keeps the original cancellation error as the one the caller sees, and a fresh short-lived
    // request is required because the aborting signal has already fired.
    const cancelJob = () => {
      const id = jobID;
      jobID = undefined;
      if (!id) return;
      // Fire and forget: the DELETE must never delay the cancellation error the caller is waiting for.
      void this.request("DELETE", `/v1/ocr/jobs/${encodeURIComponent(id)}`, undefined, undefined, 10000).catch(() => {
        // The job may have finished or the service may be gone; cancellation is best effort.
      });
    };
    try {
      let job = await this.request<OCRJob>("POST", "/v1/ocr/jobs", { image: imageDataURL, mode: this.conf.mode }, controller.signal);
      controller.signal.throwIfAborted();
      if (!controller.signal.aborted && job && typeof job.id === "string" && job.id) jobID = job.id;
      if (!job || typeof job.id !== "string" || !job.id) throw new Error("Ink OCR did not return a job ID");
      const path = `/v1/ocr/jobs/${encodeURIComponent(job.id)}`;
      while (true) {
        controller.signal.throwIfAborted();
        if (job.status === "completed") {
          const result = job.result;
          if (!result || !Number.isFinite(result.width) || !Number.isFinite(result.height) || result.width <= 0 || result.height <= 0) {
            throw new Error("Ink OCR returned invalid image dimensions");
          }
          let lines: InkOCRLine[];
          if (result.lines != null) {
            if (!Array.isArray(result.lines)) throw new Error("Ink OCR returned invalid text lines");
            lines = result.lines.map(line => {
              if (!line || typeof line.text !== "string" || !Array.isArray(line.box) || !line.box.length ||
                !line.box.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) {
                throw new Error("Ink OCR returned an invalid text line");
              }
              return { box: line.box, text: line.text, vertical: line.vertical === true };
            });
          } else {
            if (!Array.isArray(result.boxesWithText)) throw new Error("Ink OCR returned no text lines");
            lines = result.boxesWithText.map(box => {
              if (!box || !validBounds(box.bounding) || typeof box.originalText !== "string") throw new Error("Ink OCR returned an invalid text box");
              const [x, y, w, h] = box.bounding;
              return { box: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], text: box.originalText, vertical: h > w };
            });
          }
          return { width: result.width, height: result.height, lines };
        }
        if (job.status === "failed" || job.status === "cancelled") throw inkError(job.error, `Ink OCR job ${job.status}`);
        if (job.status !== "queued" && job.status !== "running") throw new Error("Ink OCR returned an invalid job status");
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const pollSignal = controller.signal;
        const onAbort = () => {
          clearTimeout(timer);
          pollSignal.removeEventListener("abort", onAbort);
          reject(pollSignal.reason);
        };
        const timer = setTimeout(() => {
          pollSignal.removeEventListener("abort", onAbort);
          if (pollSignal.aborted) reject(pollSignal.reason);
          else resolve();
        }, 1000);
        pollSignal.addEventListener("abort", onAbort, { once: true });
        if (pollSignal.aborted) onAbort();
        await promise;
        job = await this.request<OCRJob>("GET", path, undefined, controller.signal);
        if (!job) throw new Error("Ink OCR returned an invalid job");
      }
    } catch (error) {
      if (controller.signal.aborted) cancelJob();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async translate(paragraphs: string[], targetLanguage: string, signal?: AbortSignal): Promise<InkTranslateParagraph[]> {
    signal?.throwIfAborted();
    const sources = paragraphs.filter(paragraph => paragraph.trim());
    if (!sources.length) return [];
    const result = await this.request<{ paragraphs?: { translation?: unknown }[] } | null>("POST", "/v1/translate", {
      paragraphs: sources,
      target_language: targetLanguage,
    }, signal);
    signal?.throwIfAborted();
    const translated = Array.isArray(result?.paragraphs) ? result.paragraphs : [];
    let index = 0;
    return paragraphs.map(source => {
      const value = source.trim() ? translated[index++]?.translation : undefined;
      return { source, translation: typeof value === "string" ? value.trim() : "" };
    });
  }

  async repair(imageDataURL: string, boxes: { bounding: [number, number, number, number]; originalText: string }[], signal?: AbortSignal): Promise<InkRepairPatch[]> {
    signal?.throwIfAborted();
    const result = await this.request<{ patches?: { bounds: unknown; background_png?: unknown; foreground?: unknown }[] } | null>("POST", "/v1/images/repair", {
      image: imageDataURL,
      boxes,
      model: "anime",
      mask_mode: "auto",
    }, signal);
    signal?.throwIfAborted();
    if (!Array.isArray(result?.patches)) throw new Error("Ink OCR returned no repair patches");
    return result.patches.map(patch => {
      if (!patch || !validBounds(patch.bounds) || typeof patch.background_png !== "string" || !patch.background_png.startsWith("data:image/png;base64,")) {
        throw new Error("Ink OCR returned an invalid repair patch");
      }
      const maskPNG = (patch as { mask_png?: unknown }).mask_png;
      return {
        bounds: patch.bounds,
        backgroundPNG: patch.background_png,
        foreground: typeof patch.foreground === "string" ? patch.foreground : null,
        maskPNG: typeof maskPNG === "string" && maskPNG.startsWith("data:image/png;base64,") ? maskPNG : null,
      };
    });
  }
}
