import { MAX_SHOWN_CHARS } from "./config.js";

const STRIPPED = /[\p{P}=+<>|~^`]/gu;

// Normalizes player text for the screen: lowercase, no punctuation, one line, capped length.
export function normalizeShown(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(STRIPPED, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = Array.from(cleaned).slice(0, MAX_SHOWN_CHARS).join("").trim();
  return cut === "" ? "…" : cut;
}
