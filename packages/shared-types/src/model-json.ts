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

  const candidates = [trimmed];
  const completeValues = extractCompleteJsonValues(trimmed);
  candidates.push(...completeValues);

  // Preserve the previous repair path for an incomplete JSON value preceded
  // by provider commentary, but never merge multiple complete values.
  if (completeValues.length === 0) {
    const start = firstJsonValueStart(trimmed);
    if (start > 0) candidates.push(trimmed.slice(start));
  }

  return [...new Set(candidates)];
}

function firstJsonValueStart(text: string): number {
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  return [objectStart, arrayStart].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? -1;
}

/** Extract independently complete JSON objects and arrays without matching braces inside strings. */
function extractCompleteJsonValues(text: string): string[] {
  const values: string[] = [];
  let start = -1;
  let stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      if (stack.length === 0) start = index;
      stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]" || stack.length === 0) continue;

    const opening = stack.pop();
    const matches = (opening === "{" && character === "}") || (opening === "[" && character === "]");
    if (!matches) {
      start = -1;
      stack = [];
      continue;
    }
    if (stack.length === 0 && start >= 0) {
      values.push(text.slice(start, index + 1));
      start = -1;
    }
  }

  return values;
}
