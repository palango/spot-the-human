import { MAX_SHOWN_CHARS } from "./config.js";

const STRIPPED = /[\p{P}=+<>|~^`]/gu;
// Emoji with their joiners, skin tones, variation selectors and flag letters: agents never type them.
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3]/gu;

// Normalizes player text for the screen: lowercase, no punctuation or emoji, one line, capped length.
export function normalizeShown(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(STRIPPED, "")
    .replace(EMOJI, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = Array.from(cleaned).slice(0, MAX_SHOWN_CHARS).join("").trim();
  return cut === "" ? "…" : cut;
}
