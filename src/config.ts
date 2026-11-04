import type { Letter } from "./types.js";

export const ANSWER_MS = 45_000;
export const VOTE_MS = 60_000;
export const EXTEND_MS = 15_000;
export const AGENT_MARGIN_MS = 3_000;
// Countdowns reach 0 this long before the server closes a phase, so what a phone sends at 0 still arrives.
export const DEADLINE_LEAD_MS = 500;
export const MAX_SHOWN_CHARS = 120;
export const PROMPTS_PER_ROUND = 3;
export const ROUNDS = 3;
export const LETTERS: Letter[] = ["A", "B", "C", "D", "E", "F"];
export const TICK_MS = 1_000;
export const REJOIN_MAX_FAILS = 5; // wrong codes before one connection is closed
// Wrong codes from all connections together, per REJOIN_WINDOW_MS. Behind the tunnel every phone has the same
// address, so a reconnect is the only thing a per-connection limit can see; this cap is what stops guessing.
export const REJOIN_FAILS_PER_WINDOW = 32;
export const REJOIN_WINDOW_MS = 60_000;
