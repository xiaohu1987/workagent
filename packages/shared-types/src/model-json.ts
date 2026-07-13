import { jsonrepair } from "jsonrepair";

/**
 * Parses JSON emitted in a model text response. Standard JSON takes the fast
 * path; malformed JSON is repaired by jsonrepair before parsing.
 */
export function tryParseModelJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(jsonrepair(text));
    } catch {
      return null;
    }
  }
}

/**
 * Keeps protocol framing separate from JSON repair so callers can discard
 * explanatory prose surrounding an otherwise complete model payload.
 */
export function modelJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const start = [objectStart, arrayStart].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const objectEnd = trimmed.lastIndexOf("}");
  const arrayEnd = trimmed.lastIndexOf("]");
  const end = Math.max(objectEnd, arrayEnd);
  const extracted = start !== undefined && end >= start ? trimmed.slice(start, end + 1) : null;

  return extracted && extracted !== trimmed ? [trimmed, extracted] : [trimmed];
}
