export type InkTextSpec = {
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  vertical: boolean;
  color: string;
  stroke: string;
};

export type InkRepairedPatch = {
  rect: { x: number; y: number; w: number; h: number };
  image?: CanvasImageSource;
  /** Flat cover colour; with `mask` it fills only the masked pixels. */
  color?: string;
  mask?: CanvasImageSource;
};

const inkFontFamily = "'Noto Sans SC','Noto Sans JP','MS Gothic','Microsoft YaHei',sans-serif";

export function inkBounding(
  box: readonly (readonly [number, number])[],
  width = Infinity,
  height = Infinity,
): [number, number, number, number] {
  if (box.length === 0) return [0, 0, 0, 0];
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const [x, y] of box) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  left = Math.max(0, Math.min(width, Math.round(left)));
  top = Math.max(0, Math.min(height, Math.round(top)));
  right = Math.max(0, Math.min(width, Math.round(right)));
  bottom = Math.max(0, Math.min(height, Math.round(bottom)));
  return [left, top, right - left, bottom - top];
}

export async function inkDataURLBytes(dataURL: string): Promise<Uint8Array> {
  const comma = dataURL.indexOf(",");
  if (comma < 0) throw new Error("Invalid image data URL");
  const decoded = atob(dataURL.slice(comma + 1));
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

export async function inkBlobDataURL(blob: Blob): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === "string") resolve(reader.result);
    else reject(new Error("Unable to read Ink image"));
  };
  reader.onerror = () => reject(reader.error ?? new Error("Unable to read Ink image"));
  reader.onabort = () => reject(new DOMException("Image read aborted", "AbortError"));
  reader.readAsDataURL(blob);
  return promise;
}

export async function inkLoadImage(src: string | Blob): Promise<HTMLImageElement> {
  const { promise, resolve, reject } = Promise.withResolvers<HTMLImageElement>();
  const image = new Image();
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  const cleanup = () => {
    image.onload = null;
    image.onerror = null;
    if (typeof src !== "string") URL.revokeObjectURL(url);
  };
  image.onload = () => {
    cleanup();
    resolve(image);
  };
  image.onerror = () => {
    cleanup();
    reject(new Error("Unable to load Ink image"));
  };
  try {
    image.src = url;
  } catch (error) {
    cleanup();
    reject(error);
  }
  return promise;
}

/**
 * Rasterise the service text mask into a stencil canvas plus a per-pixel lookup.
 * The service returns a grayscale (L) mask whose white pixels mark what to clear, so a plain
 * alpha read would mark nothing; RGBA masks are honoured through their alpha channel.
 */
export function inkTextMask(mask: CanvasImageSource, w: number, h: number): { canvas: HTMLCanvasElement, inside: Uint8ClampedArray } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext("2d");
  const inside = new Uint8ClampedArray(canvas.width * canvas.height);
  if (!ctx) return { canvas, inside };
  ctx.drawImage(mask, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let alphaCarriesMask = false;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 200) { alphaCarriesMask = true; break; }
  }
  for (let p = 0; p < inside.length; p++) {
    const i = p * 4;
    const marked = alphaCarriesMask
      ? pixels[i + 3] >= 32
      : pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722 >= 32;
    inside[p] = marked ? 1 : 0;
  }
  const stencil = ctx.createImageData(canvas.width, canvas.height);
  for (let p = 0; p < inside.length; p++) {
    if (inside[p]) stencil.data[p * 4 + 3] = 255;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.putImageData(stencil, 0, 0);
  return { canvas, inside };
}

const inkCoverBuckets = 32;

/** Dominant colour of the pixels a cover keeps visible; `skip` marks pixels to ignore (the text mask). */
export function inkCoverColor(pixels: Uint8ClampedArray, skip?: Uint8ClampedArray): string {
  const buckets = new Uint32Array(inkCoverBuckets ** 3);
  let counted = 0;
  const index = (channel: number) => Math.min(inkCoverBuckets - 1, channel >> 3);
  for (let i = 0, pixel = 0; i < pixels.length; i += 4, pixel++) {
    if (skip && skip[pixel]) continue;
    buckets[(index(pixels[i]) * inkCoverBuckets + index(pixels[i + 1])) * inkCoverBuckets + index(pixels[i + 2])]++;
    counted++;
  }
  if (!counted) return "#ffffff";
  let best = 0, bestCount = 0;
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i] > bestCount) { bestCount = buckets[i]; best = i; }
  }
  return "#" + [best >> 10, (best >> 5) & 31, best & 31].map(v => ((v << 3) | 4).toString(16).padStart(2, "0")).join("");
}

/** Relative luminance of an `#rrggbb` colour; picks readable translated text over a flat cover. */
export function inkCoverLuminance(hex: string): number {
  return parseInt(hex.slice(1, 3), 16) * 0.2126 + parseInt(hex.slice(3, 5), 16) * 0.7152 + parseInt(hex.slice(5, 7), 16) * 0.0722;
}

export function inkCanvasToBlob(
  canvas: HTMLCanvasElement,
  mime = "image/jpeg",
  quality = 0.92,
): Promise<Blob> {
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error("Unable to encode Ink image"));
  }, mime, quality);
  return promise;
}

function characterWidth(character: string, size: number): number {
  return character.charCodeAt(0) <= 0x7f ? size * 0.55 : size;
}

function characterCount(text: string): number {
  let count = 0;
  for (const _character of text) count++;
  return count;
}

export function wrapHorizontal(text: string, size: number, w: number, _h: number): string[] {
  if (!text) return [];
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n?|\n/)) {
    let line = "", width = 0;
    for (const character of paragraph) {
      const advance = characterWidth(character, size);
      if (line && width + advance > w) {
        lines.push(line);
        line = "";
        width = 0;
      }
      line += character;
      width += advance;
    }
    lines.push(line);
  }
  return lines;
}

export function wrapVertical(text: string, size: number, _w: number, h: number): string[] {
  if (!text) return [];
  // Keep overflowing glyphs for clipping when even one character cannot fit.
  const capacity = Math.max(1, Math.floor((h - 2) / size));
  const columns: string[] = [];
  for (const paragraph of text.split(/\r\n?|\n/)) {
    let column = "", count = 0;
    for (const character of paragraph) {
      if (count === capacity) {
        columns.push(column);
        column = "";
        count = 0;
      }
      column += character;
      count++;
    }
    columns.push(column);
  }
  return columns;
}

export function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  w: number,
  h: number,
  vertical: boolean,
): number {
  if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error("Invalid text bounds");
  let size = Math.max(8, Math.floor((vertical ? w : h) * 0.85));
  for (; size > 8; size--) {
    if (vertical) {
      const columns = wrapVertical(text, size, w, h);
      if (columns.length * size * 1.15 <= w && columns.every(column => characterCount(column) * size + 2 <= h)) break;
    } else {
      const lines = wrapHorizontal(text, size, w, h);
      if (lines.length * size * 1.15 <= h && lines.every(line => {
        let width = 0;
        for (const character of line) width += characterWidth(character, size);
        return width <= w;
      })) break;
    }
  }
  ctx.font = `${size}px ${inkFontFamily}`;
  return size;
}

export function inkComposite(
  base: CanvasImageSource,
  baseWidth: number,
  baseHeight: number,
  patches: InkRepairedPatch[],
  texts: InkTextSpec[],
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = baseWidth;
  canvas.height = baseHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to create Ink canvas");
  ctx.drawImage(base, 0, 0);
  for (const { rect, image, color, mask } of patches) {
    if (rect.w <= 0 || rect.h <= 0) continue;
    if (!color) {
      if (image) ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h);
      continue;
    }
    const layer = document.createElement("canvas");
    layer.width = Math.ceil(rect.w);
    layer.height = Math.ceil(rect.h);
    const lctx = layer.getContext("2d");
    if (!lctx) continue;
    lctx.fillStyle = color;
    lctx.fillRect(0, 0, layer.width, layer.height);
    if (mask) {
      lctx.globalCompositeOperation = "destination-in";
      lctx.drawImage(mask, 0, 0, layer.width, layer.height);
    }
    ctx.drawImage(layer, rect.x, rect.y, rect.w, rect.h);
  }
  for (const { text, rect, vertical, color, stroke } of texts) {
    if (!text || rect.w <= 0 || rect.h <= 0) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    const size = fitFontSize(ctx, text, rect.w, rect.h, vertical);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1, size / 12);
    if (vertical) {
      const columns = wrapVertical(text, size, rect.w, rect.h);
      const columnWidth = size * 1.15;
      let rows = 0;
      for (const column of columns) rows = Math.max(rows, characterCount(column));
      const top = rect.y + (rect.h - rows * size) / 2;
      const right = rect.x + (rect.w + columns.length * columnWidth) / 2;
      for (let i = 0; i < columns.length; i++) {
        const x = right - (i + 0.5) * columnWidth;
        let y = top + size / 2;
        for (const character of columns[i]) {
          if (stroke !== "transparent") ctx.strokeText(character, x, y);
          ctx.fillText(character, x, y);
          y += size;
        }
      }
    } else {
      const lines = wrapHorizontal(text, size, rect.w, rect.h);
      const lineHeight = size * 1.15;
      const top = rect.y + (rect.h - lines.length * lineHeight) / 2;
      const x = rect.x + rect.w / 2;
      for (let i = 0; i < lines.length; i++) {
        const y = top + (i + 0.5) * lineHeight;
        if (stroke !== "transparent") ctx.strokeText(lines[i], x, y);
        ctx.fillText(lines[i], x, y);
      }
    }
    ctx.restore();
  }
  return canvas;
}
