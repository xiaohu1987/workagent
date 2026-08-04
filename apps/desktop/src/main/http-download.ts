import path from "node:path";

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-7z-compressed": ".7z",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "audio/mpeg": ".mp3",
  "video/mp4": ".mp4"
};

export function normalizeResponseMimeType(headers: Record<string, string>): string {
  return (headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
}

export function isTextualResponseMimeType(mimeType: string): boolean {
  return !mimeType ||
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml") ||
    mimeType === "application/javascript" ||
    mimeType === "application/x-www-form-urlencoded" ||
    mimeType === "image/svg+xml";
}

export function hasAttachmentDisposition(headers: Record<string, string>): boolean {
  const disposition = headers["content-disposition"] ?? "";
  return /\battachment\b|\bfilename\s*\*=|\bfilename\s*=/i.test(disposition);
}

export function looksLikeBinaryData(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8_192));
  if (sample.byteLength === 0) return false;
  const signatures = [
    [0x89, 0x50, 0x4e, 0x47],
    [0xff, 0xd8, 0xff],
    [0x47, 0x49, 0x46, 0x38],
    [0x25, 0x50, 0x44, 0x46],
    [0x50, 0x4b, 0x03, 0x04],
    [0x1f, 0x8b]
  ];
  if (signatures.some((signature) => signature.every((byte, index) => sample[index] === byte))) {
    return true;
  }
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.byteLength > 0.08;
}

export function shouldDownloadHttpResponse(
  status: number,
  headers: Record<string, string>,
  bytes: Uint8Array
): boolean {
  if (status < 200 || status >= 300 || bytes.byteLength === 0) return false;
  if (hasAttachmentDisposition(headers)) return true;
  const mimeType = normalizeResponseMimeType(headers);
  return (mimeType ? !isTextualResponseMimeType(mimeType) : false) || looksLikeBinaryData(bytes);
}

function decodeDispositionFileName(disposition: string): string | null {
  const encoded = disposition.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1]?.trim();
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
    } catch {
      return encoded.replace(/^"|"$/g, "");
    }
  }
  return disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
    ?? disposition.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim()
    ?? null;
}

export function sanitizeDownloadFileName(value: string): string {
  const leaf = path.basename(value.replace(/\\/g, "/"));
  const sanitized = leaf
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  const limited = sanitized.slice(0, 180);
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(limited) ? `_${limited}` : limited;
}

export function resolveHttpDownloadFileName(input: {
  preferredFileName?: string;
  headers: Record<string, string>;
  url: string;
}): string {
  const mimeType = normalizeResponseMimeType(input.headers);
  const dispositionName = decodeDispositionFileName(input.headers["content-disposition"] ?? "");
  let urlName = "";
  try {
    urlName = decodeURIComponent(new URL(input.url).pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    // The request URL was already validated by the proxy.
  }
  const extension = MIME_EXTENSIONS[mimeType] ?? "";
  const candidate = sanitizeDownloadFileName(input.preferredFileName ?? dispositionName ?? urlName ?? "");
  if (!candidate) return `download${extension || ".bin"}`;
  return path.extname(candidate) || !extension ? candidate : `${candidate}${extension}`;
}
