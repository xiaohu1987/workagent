/** Strip HTML and cap page text so browser tools do not flood model context. */

export const BROWSER_PAGE_TEXT_LIMIT = 12_000;

export type PageLike = {
  title?: string;
  url?: string;
  text?: string;
  html?: string;
  fetchedAt?: string;
  [key: string]: unknown;
};

export function truncatePageText(text: string, limit = BROWSER_PAGE_TEXT_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

/** Model-facing page payload: no html, truncated text. */
export function pageForModel(page: PageLike | null | undefined): Record<string, unknown> | undefined {
  if (!page || typeof page !== "object") {
    return page as undefined;
  }
  const { html: _html, text, ...rest } = page;
  return {
    ...rest,
    text: truncatePageText(typeof text === "string" ? text : "")
  };
}

export function sanitizeBrowserToolJson(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return json;
  }
  const record = json as Record<string, unknown>;
  const next = { ...record };
  if (next.page && typeof next.page === "object" && !Array.isArray(next.page)) {
    next.page = pageForModel(next.page as PageLike);
  } else if (typeof next.html === "string" || typeof next.text === "string") {
    return pageForModel(next as PageLike);
  }
  return next;
}
