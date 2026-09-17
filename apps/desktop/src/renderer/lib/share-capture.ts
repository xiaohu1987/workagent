import type { ShareImagePayload } from "@shared-types";

/**
 * Conversation-to-image pipeline.
 *
 * The card is rendered into an off-screen host inside the real document, so it
 * inherits the application stylesheet and the current theme. Capturing then
 * follows the same approach WorkBuddy uses for its share landing pages: clone
 * the rendered DOM, inline the stylesheet and media, and serialize it into an
 * SVG `foreignObject` that is rasterized onto a canvas. Nothing is uploaded and
 * no extra dependency is required.
 *
 * Slices are rasterized separately because a single very tall image exceeds the
 * canvas size limit; each slice keeps a 1:1 CSS-to-user-unit mapping so text
 * stays crisp at the requested scale.
 */

/** Rendered width of the shared card, in CSS pixels. */
export const SHARE_CARD_WIDTH = 820;

/** Taller conversations are refused instead of being silently truncated. */
export const SHARE_MAX_CAPTURE_HEIGHT = 16000;

/** Conservative ceiling for a canvas edge (Chrome allows 32767). */
const MAX_CANVAS_EDGE = 16000;

/** CSS pixels rasterized per slice. */
const SLICE_HEIGHT = 3600;

/** Minimum acceptable stylesheet length; below this the render would be unstyled. */
const MIN_STYLESHEET_LENGTH = 5000;

/** Image formats delivered through channels other than `copyMarkdown`. */
export class ShareCaptureError extends Error {
  public readonly detail: string;

  constructor(message: string, detail = "") {
    super(message);
    this.name = "ShareCaptureError";
    this.detail = detail;
  }
}

/** Raised when the selected range cannot fit into a single shareable image. */
export class ShareCaptureTooLargeError extends ShareCaptureError {
  public readonly height: number;

  constructor(height: number) {
    super(`选中内容过长（约 ${height} px），请减少分享范围后重试。`);
    this.name = "ShareCaptureTooLargeError";
    this.height = height;
  }
}

let cachedStylesheet: string | null = null;

/**
 * Collect every stylesheet the document currently exposes. The renderer is
 * served from a local HTTP origin in both dev and packaged builds, so these
 * sheets are same-origin and readable; bundling a copy would duplicate ~700 KB
 * and still miss component-scoped CSS.
 */
export function getShareStylesheet(): string {
  if (cachedStylesheet !== null) return cachedStylesheet;
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      // A cross-origin sheet cannot be read; skip it rather than failing.
      continue;
    }
    if (!rules || rules.length === 0) continue;
    for (const rule of Array.from(rules)) {
      parts.push(rule.cssText);
    }
  }
  const css = parts.join("\n");
  if (css.length < MIN_STYLESHEET_LENGTH) {
    throw new ShareCaptureError("无法读取应用样式，分享图片可能不完整。", `stylesheet=${css.length} chars`);
  }
  cachedStylesheet = css;
  return css;
}

/**
 * Snapshot the resolved theme variables. The card lives inside an SVG document
 * with no `<html>`/`<body>` ancestors, so the values the app computed have to
 * be carried over explicitly or the image renders with unstyled surfaces.
 */
export function snapshotThemeDeclarations(css: string): string {
  const body = window.getComputedStyle(document.body);
  const names = new Set<string>();
  for (const match of css.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)) {
    names.add(match[1]);
  }
  const declarations: string[] = [];
  for (const name of names) {
    const value = body.getPropertyValue(`--${name}`).trim();
    // A custom property value never contains a top-level semicolon, so the
    // declarations can be joined safely.
    if (value) declarations.push(`--${name}:${value}`);
  }
  return declarations.join(";");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取资源失败"));
    reader.readAsDataURL(blob);
  });
}

/**
 * A referenced resource (image, media preview, chart canvas) cannot be fetched
 * from inside an SVG image, so every one of them is replaced by an inline copy
 * before serialization.
 */
async function inlineCloneResources(root: HTMLElement): Promise<void> {
  for (const canvas of Array.from(root.querySelectorAll("canvas"))) {
    try {
      const inline = document.createElement("img");
      inline.setAttribute("src", canvas.toDataURL("image/png"));
      inline.setAttribute("style", `width:${canvas.clientWidth || canvas.width}px;height:${canvas.clientHeight || canvas.height}px;`);
      canvas.replaceWith(inline);
    } catch {
      // A tainted canvas cannot be exported; drop it instead of breaking the image.
      canvas.remove();
    }
  }

  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(images.map(async (image) => {
    const source = image.getAttribute("src") ?? "";
    if (!source || source.startsWith("data:")) return;
    try {
      const response = await fetch(source);
      if (!response.ok) throw new Error(String(response.status));
      image.setAttribute("src", await blobToDataUrl(await response.blob()));
    } catch {
      image.remove();
    }
  }));
}

type CaptureFrame = {
  /** Serialized card markup, XHTML namespaced and safe to embed in SVG. */
  xml: string;
  /** `<style>` content: the app stylesheet plus the theme snapshot. */
  css: string;
  width: number;
  height: number;
  background: string;
};

async function buildCaptureFrame(element: HTMLElement, width: number): Promise<CaptureFrame> {
  const stylesheet = getShareStylesheet();
  const theme = snapshotThemeDeclarations(stylesheet);
  const body = window.getComputedStyle(document.body);
  const background = body.backgroundColor && body.backgroundColor !== "rgba(0, 0, 0, 0)"
    ? body.backgroundColor
    : "#1b1d21";

  const clone = element.cloneNode(true) as HTMLElement;
  await inlineCloneResources(clone);

  const holder = document.createElement("div");
  holder.setAttribute("style", [
    `width:${width}px`,
    "box-sizing:border-box",
    `background:${background}`,
    `color:${body.color}`,
    `font-family:${body.fontFamily}`,
    `font-size:${body.fontSize}`,
    `line-height:${body.lineHeight}`,
    theme
  ].join(";"));

  const style = document.createElement("style");
  style.textContent = stylesheet;
  holder.appendChild(style);
  holder.appendChild(clone);

  const height = Math.ceil(element.getBoundingClientRect().height);
  return {
    xml: new XMLSerializer().serializeToString(holder),
    css: stylesheet,
    width,
    height,
    background
  };
}

/** Serialize one vertical slice of the card into a standalone SVG document. */
function buildSliceSvg(frame: CaptureFrame, scale: number, sliceTop: number, sliceHeight: number): string {
  const { width, height, background, xml } = frame;
  const rect = `<rect x="0" y="0" width="${width}" height="${height}" fill="${background}"/>`;
  // The viewBox maps the requested band of user units onto the full viewport,
  // which is what makes a single tall document rasterizable piece by piece.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * scale)}" height="${Math.round(sliceHeight * scale)}"`,
    ` viewBox="0 ${sliceTop} ${width} ${sliceHeight}" preserveAspectRatio="none">`,
    rect,
    `<foreignObject x="0" y="0" width="${width}" height="${height}">`,
    xml,
    "</foreignObject>",
    "</svg>"
  ].join("");
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new ShareCaptureError("分享图片生成失败：无法栅格化对话内容。", "svg decode failed"));
    image.src = source;
  });
}

/**
 * Guard against the failure mode that makes this technique dangerous: an SVG
 * that decodes but paints nothing. A uniformly coloured result means the
 * stylesheet or the content was lost, which is worth surfacing rather than
 * silently sharing a blank image.
 */
function looksBlank(canvas: HTMLCanvasElement): boolean {
  const probe = document.createElement("canvas");
  probe.width = 32;
  probe.height = 32;
  const context = probe.getContext("2d");
  if (!context) return false;
  context.drawImage(canvas, 0, 0, 32, 32);
  const { data } = context.getImageData(0, 0, 32, 32);
  let min = 255;
  let max = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const luma = (data[index] * 299 + data[index + 1] * 587 + data[index + 2] * 114) / 1000;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
  }
  return max - min < 6;
}

export async function rasterizeCaptureFrame(frame: CaptureFrame): Promise<ShareImagePayload> {
  if (frame.height <= 0) {
    throw new ShareCaptureError("分享图片生成失败：内容高度为空。", "zero height");
  }
  if (frame.height > SHARE_MAX_CAPTURE_HEIGHT) {
    throw new ShareCaptureTooLargeError(frame.height);
  }

  const scale = frame.height * 2 <= MAX_CANVAS_EDGE ? 2 : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(frame.width * scale);
  canvas.height = Math.round(frame.height * scale);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new ShareCaptureError("分享图片生成失败：当前环境不支持画布绘制。", "no 2d context");
  }
  context.setTransform(scale, 0, 0, scale, 0, 0);

  for (let top = 0; top < frame.height; top += SLICE_HEIGHT) {
    const sliceHeight = Math.min(SLICE_HEIGHT, frame.height - top);
    const image = await loadSvgImage(buildSliceSvg(frame, scale, top, sliceHeight));
    context.drawImage(image, 0, top, frame.width, sliceHeight);
  }

  if (looksBlank(canvas)) {
    throw new ShareCaptureError("分享图片生成失败：渲染结果为空。", "blank canvas");
  }

  const dataUrl = canvas.toDataURL("image/png");
  return {
    dataUrl,
    width: canvas.width,
    height: canvas.height,
    bytes: Math.round(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4)
  };
}

/**
 * Render `mount` into an off-screen host, wait for the layout (and any
 * asynchronously rendered diagram or chart) to settle, then rasterize it.
 * `mount` returns its own cleanup so the caller owns the React root.
 */
export async function captureShareCard(mount: (host: HTMLElement) => () => void): Promise<ShareImagePayload> {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("data-share-capture-host", "true");
  host.style.cssText = `position:fixed;left:-200000px;top:0;width:${SHARE_CARD_WIDTH}px;pointer-events:none;z-index:-1;`;
  document.body.appendChild(host);

  let unmount: () => void = () => undefined;
  try {
    unmount = mount(host);
    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch {
        // Font loading failures fall back to system fonts in the capture.
      }
    }

    const deadline = performance.now() + 5000;
    let card = host.querySelector<HTMLElement>("[data-share-card]");
    while (!card && performance.now() < deadline) {
      await delay(16);
      card = host.querySelector<HTMLElement>("[data-share-card]");
    }
    if (!card) {
      throw new ShareCaptureError("分享内容渲染失败，请稍后重试。", "card not mounted");
    }

    // Mermaid diagrams and ECharts render on their own schedule; keep sampling
    // until the height stops changing instead of guessing a fixed delay.
    let previousHeight = -1;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      await nextFrame();
      await nextFrame();
      const height = Math.ceil(card.getBoundingClientRect().height);
      if (height > 0 && height === previousHeight) break;
      previousHeight = height;
      await delay(160);
    }

    const width = Math.round(card.getBoundingClientRect().width) || SHARE_CARD_WIDTH;
    const frame = await buildCaptureFrame(card, width);
    return await rasterizeCaptureFrame(frame);
  } finally {
    unmount();
    host.remove();
  }
}

/** Test seam: drop the cached stylesheet when the document is replaced. */
export function resetShareCaptureCache(): void {
  cachedStylesheet = null;
}
