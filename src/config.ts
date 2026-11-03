import type { Letter } from "./types.js";

export const ANSWER_MS = 45_000;
export const VOTE_MS = 60_000;
export const EXTEND_MS = 15_000;
export const AGENT_MARGIN_MS = 3_000;
export const MAX_SHOWN_CHARS = 120;
export const PROMPTS_PER_ROUND = 3;
export const ROUNDS = 3;
export const LETTERS: Letter[] = ["A", "B", "C", "D", "E", "F"];
export const TICK_MS = 1_000;
export const REJOIN_MAX_FAILS = 5;
