# Spot the Human Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live party game for one Devcon session: phones answer prompts and vote, Claude agents play alongside one or two hidden humans, a shared screen shows answers, votes and reveals.

**Architecture:** One Node process holds a single in-memory `Session` (phones, prompt pool, current `Game`). A pure game engine (`src/game.ts`) owns every phase change and deadline; the server (`src/server.ts`) only translates WebSocket messages into engine calls and pushes per-recipient views built by `src/views.ts`. Agents sit behind an `AgentBrain` interface so the engine and server tests run with a scripted brain and the real Claude brain is checked by a live smoke script.

**Tech Stack:** Node 24, TypeScript 7 run with `tsx`, `ws` 8, `@anthropic-ai/sdk` 1.3, `qrcode` 1.5, `vitest` 5. Plain HTML/JS pages, no frontend framework, no bundler.

**Spec:** `docs/superpowers/specs/2026-11-04-spot-the-human-design.md` (read it before any task).

## Global Constraints

- Six players, letters A to F, shuffled per game. One or two hidden humans, chosen by the host at Start (default two), picked at random from ready phones.
- Answer window 45 s; vote window 60 s; "+15 seconds" adds 15 s. Three prompts per round, three rounds per game.
- Every answer and every vote reason shown on screen: lowercased, punctuation stripped, cut to 120 characters; empty becomes "…".
- Only room votes remove a player. The top vote-getter is removed; a tie at the top or zero votes removes nobody.
- The exact number of humans is never shown. Screen copy: "One or two of these players are human."
- Prompts are never reused within a session. Pool of 40 in `prompts.txt`. Start needs ≥ 9 unused prompts; Skip is disabled when it would leave too few to finish the game.
- Agents: model `claude-sonnet-5-5`, Anthropic TypeScript SDK, credentials resolved by `new Anthropic()` (normally `ANTHROPIC_API_KEY`). Each call has a budget that ends 3 s before the phase deadline (first try plus one retry); missing results show as "…"; late results are dropped.
- Server owns all deadlines. Every client message and agent result carries the `phaseId` it belongs to; anything for a closed phase is ignored.
- Each phone receives only shared state plus its own role, letter and rejoin code. Agents receive only what the screen has shown.
- Host commands are accepted only on a WebSocket that presented the correct host key. The key never appears in the QR code or on screen.
- Runs on Paul's laptop on port 3000 behind `cloudflared tunnel --url http://localhost:3000`. `PUBLIC_URL` (the tunnel URL) feeds the QR code.
- No database, no accounts, no framework. Twists, moderation and any Bonfires notice are out of scope.

## Review Focus

1. A phone that locks or refreshes mid-answer must come back with its draft and still have it frozen at the deadline. (Task 6 test `reconnect keeps draft`.)
2. Two people's phones must look identical whatever their roles: same buttons during the vote, including the human's own letter. (Task 3 test `human self-vote counts in room but posts no target`; Task 7 manual check.)
3. Host presses buttons twice or out of order (double Next, Close vote after the deadline already closed it, Skip during voting). Each must be a no-op, not a crash or a double removal. (Task 3 test `repeated and out-of-phase host commands are no-ops`.)
4. An agent API call hangs or errors: the reveal must still happen on time with "…". (Task 3 test `slow agent shows ellipsis and late result is dropped`.)
5. Someone scans after Start: they get "game in progress" with a rejoin field and can play the next game after New game. (Task 6 test `late joiner waits then plays next game`.)

---

## File structure

```
package.json, tsconfig.json, vitest.config.ts, README.md, implementation-notes.md
prompts.txt                 one prompt per line, 40 lines
src/config.ts               all timing and size constants
src/text.ts                 normalizeShown()
src/prompts.ts              PromptPool
src/types.ts                shared types (Phase, Player, AgentBrain, views)
src/game.ts                 Session + Game engine (pure, timers via setTimeout)
src/agents.ts               ClaudeBrain, prompt building, vote parsing
src/views.ts                screenView(), phoneView()
src/server.ts               HTTP static + WebSocket protocol + identity + host auth
src/main.ts                 entry point: reads env, starts server, prints URLs
public/phone.html, public/phone.js
public/screen.html, public/screen.js
public/style.css
scripts/smoke-agents.ts     live API check of ClaudeBrain
scripts/simulate.ts         12 simulated phones against a running server
tests/*.test.ts
```

## Shared types (`src/types.ts`, written in Task 1, used everywhere)

```ts
export type Letter = "A" | "B" | "C" | "D" | "E" | "F";
export type PhaseName =
  | "lobby" | "answering" | "revealed" | "voting"
  | "votePosts" | "removal" | "ended";

export interface Player {
  letter: Letter;
  kind: "agent" | "human";
  phoneId?: string;        // humans only
  personaIndex?: number;   // agents only
  out: boolean;
}

export interface PlayerPost { letter: Letter; target: Letter | null; reason: string } // reason already normalized
export interface RemovalResult { removed: Letter | null; kind: "agent" | "human" | null; tally: Record<Letter, number> }

export interface TranscriptEntry {           // what the screen has shown, in order
  kind: "answers" | "posts" | "removal";
  prompt?: string;
  answers?: Partial<Record<Letter, string>>;
  posts?: PlayerPost[];
  removal?: RemovalResult;
}

export interface AgentContext {
  letter: Letter;
  personaIndex: number;
  inPlayers: Letter[];
  transcript: TranscriptEntry[];
  prompt?: string;             // set for answer calls
}

export interface AgentBrain {
  answer(ctx: AgentContext, budgetMs: number): Promise<string>;
  vote(ctx: AgentContext, budgetMs: number): Promise<{ target: Letter | null; reason: string }>;
}
```

---

### Task 1: Scaffold, constants and text normalization

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (`node_modules`), `implementation-notes.md`, `src/config.ts`, `src/types.ts`, `src/text.ts`
- Test: `tests/text.test.ts`

**Interfaces:**
- Produces: `src/types.ts` (above); `src/config.ts` exporting `ANSWER_MS = 45_000`, `VOTE_MS = 60_000`, `EXTEND_MS = 15_000`, `AGENT_MARGIN_MS = 3_000`, `MAX_SHOWN_CHARS = 120`, `PROMPTS_PER_ROUND = 3`, `ROUNDS = 3`, `LETTERS: Letter[]`, `TICK_MS = 1_000`, `REJOIN_MAX_FAILS = 5`; `normalizeShown(text: string): string` in `src/text.ts`.

- [ ] **Step 1:** `npm init`, set `"type": "module"`, install exact versions: `ws@8.18.x @anthropic-ai/sdk@1.3.0 qrcode@1.5.4`, dev `typescript@7.0.2 tsx vitest@5.0.5 @types/ws @types/qrcode @types/node`. Scripts: `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`, `"start": "tsx src/main.ts"`, `"smoke": "tsx scripts/smoke-agents.ts"`, `"simulate": "tsx scripts/simulate.ts"`. `tsconfig`: strict, `module`/`moduleResolution` `nodenext`, `noEmit`.
- [ ] **Step 2: Write failing tests** in `tests/text.test.ts`:

```ts
expect(normalizeShown("Hello, World!")).toBe("hello world");
expect(normalizeShown("  It's 391.  ")).toBe("its 391");
expect(normalizeShown("")).toBe("…");
expect(normalizeShown("?!...")).toBe("…");
expect(normalizeShown("a".repeat(200))).toHaveLength(120);
expect(normalizeShown("17 × 23 = 391")).toBe("17 × 23 391"); // × kept, = stripped, spaces collapsed
expect(normalizeShown("मुंबई traffic 🚗")).toBe("मुंबई traffic 🚗");           // letters in any script and emoji survive
expect(normalizeShown("line\nbreak")).toBe("line break");
```

- [ ] **Step 3:** Run `npx vitest run tests/text.test.ts` — expect FAIL (module missing).
- [ ] **Step 4:** Implement `normalizeShown`: lowercase, remove characters in Unicode punctuation class `\p{P}` plus `=`, `+`, `<`, `>`, `|`, `~`, `^`, backtick (keep `×` and symbols like emoji), collapse whitespace to one space, trim, cut to `MAX_SHOWN_CHARS` by code points, `"…"` if empty.
- [ ] **Step 5:** `npx vitest run` and `npm run typecheck` — PASS.
- [ ] **Step 6:** Commit `Scaffold project and normalize shown text`.

### Task 2: Prompt pool and the 40 prompts

**Files:**
- Create: `prompts.txt`, `src/prompts.ts`
- Test: `tests/prompts.test.ts`

**Interfaces:**
- Produces: `class PromptPool { constructor(prompts: string[]); static fromFile(path: string): PromptPool; get remaining(): number; take(): string; canStartGame(): boolean; canSkip(promptsStillNeeded: number): boolean }`. `fromFile` ignores blank lines and lines starting with `#`, trims, throws if fewer than 9 prompts.

- [ ] **Step 1: Write `prompts.txt`** with 40 prompts: the 12 drafts from the spec (keep the rude one, prefixed with `# REVIEW:` on the line above it) plus 28 more in the same spirit: short, answerable in under 120 characters on a phone, mixing ones agents ace (arithmetic, trivia), ones only someone in the room knows (the room, today, Mumbai, the venue food), and opinion/feeling prompts. No real token or bridge names.
- [ ] **Step 2: Write failing tests:**

```ts
test("take never repeats and counts down", () => { const p = new PromptPool(["a","b","c"]); expect(new Set([p.take(),p.take(),p.take()]).size).toBe(3); expect(p.remaining).toBe(0); expect(() => p.take()).toThrow(); });
test("canStartGame needs nine unused", () => { const p = new PromptPool(nine()); expect(p.canStartGame()).toBe(true); p.take(); expect(p.canStartGame()).toBe(false); });
test("canSkip keeps enough to finish", () => { const p = new PromptPool(Array.from({length: 10}, (_, i) => `q${i}`)); expect(p.canSkip(9)).toBe(true); p.take(); expect(p.canSkip(9)).toBe(false); });
test("fromFile reads prompts.txt with 40 prompts and skips comments", () => { expect(PromptPool.fromFile("prompts.txt").remaining).toBe(40); });
```

`canSkip(promptsStillNeeded)` returns `remaining >= promptsStillNeeded`. The game passes the replacement plus every prompt it still has to draw after the current one (`1 + (9 - promptsDrawnSoFar)`).

- [ ] **Step 3:** Run, expect FAIL. **Step 4:** Implement; `take()` picks a random unused prompt. **Step 5:** Run, PASS. **Step 6:** Commit `Add prompt pool and prompt list`.

### Task 3: Game engine

**Files:**
- Create: `src/game.ts`
- Test: `tests/game.test.ts` (use `vi.useFakeTimers()`; a `ScriptedBrain` test helper in `tests/helpers.ts` that returns configured answers/votes, optionally after a delay, or never resolves)

**Interfaces:**
- Consumes: Task 1 types and constants, `normalizeShown`, `PromptPool`.
- Produces:

```ts
export interface PhoneRecord { id: string; rejoinCode: string; ready: boolean }

export class Session {
  constructor(opts: { brain: AgentBrain; pool: PromptPool; random?: () => number; onChange: () => void });
  readonly phones: Map<string, PhoneRecord>;
  game: Game | null;                       // null until the first Start
  addPhone(): PhoneRecord;                 // ready = true only while in lobby
  setReady(phoneId: string, ready: boolean): void;   // lobby only
  phoneByRejoinCode(code: string): PhoneRecord | undefined;
  start(humanCount: 1 | 2): { ok: true } | { ok: false; reason: "not-in-lobby" | "too-few-ready" | "too-few-prompts" };
  newGame(): void;                         // back to lobby, phones kept, all ready = false
  reset(): void;                           // wipe phones, game and prompt pool (reloaded from the same list)
  get phase(): PhaseName;                  // "lobby" when game is null or after newGame
}

export class Game {
  readonly players: Player[];              // 6, letters shuffled
  readonly roster: Set<string>;            // phoneIds frozen at Start
  readonly transcript: TranscriptEntry[];
  phase: PhaseName;
  phaseId: number;                         // increments on every phase change
  round: number;                           // 1..3
  promptInRound: number;                   // 1..3
  prompt: string | null;
  deadline: number | null;                 // epoch ms, null when untimed
  answers: Partial<Record<Letter, string>>;    // shown answers for the current prompt (normalized), set at reveal
  posts: PlayerPost[];                     // set at votePosts
  removal: RemovalResult | null;           // set at removal
  winner: "humans" | "agents" | null;
  votedCount(): number;                    // roster phones with a vote this phase
  // client inputs (ignored unless phaseId matches and phone is in roster)
  draft(phoneId: string, phaseId: number, text: string): void;
  vote(phoneId: string, phaseId: number, target: Letter, reason: string): void;
  // host commands (no-ops when not valid for the current phase)
  next(): void;          // revealed -> answering (next prompt) | revealed(3rd) -> voting | votePosts -> removal | removal -> answering(next round) | ended
  extend(): void;        // answering/voting: deadline += EXTEND_MS
  closeVote(): void;     // voting -> votePosts now
  skip(): void;          // answering only, if pool.canSkip(...): new prompt, new phaseId, fresh 45 s, drafts cleared, agents re-asked
  // per-phone private state for views
  draftOf(phoneId: string): string;
  voteOf(phoneId: string): { target: Letter | null; reason: string };
  playerOfPhone(phoneId: string): Player | undefined;
}
```

Rules the tests pin (all values from the spec):

- [ ] **Step 1: Write failing tests** in `tests/game.test.ts`, grouped:

`describe("start")`
- `start(2)` with 12 ready phones → `game.players` has 6 entries with letters A–F each once, exactly 2 `kind === "human"`, both `phoneId`s in `roster`, `roster.size === 12`, phase `"answering"`, `deadline === now + 45_000`.
- `start(2)` with 1 ready phone → `{ ok:false, reason:"too-few-ready" }`; with a pool of 8 → `"too-few-prompts"`; during a game → `"not-in-lobby"`.
- With `random` seeded, human letters vary across seeds (not always the same letters).

`describe("answering")`
- Drafts from roster phones are kept; the human's last draft before the deadline is its shown answer, normalized: draft `"I think, 391!"` → `answers[humanLetter] === "i think 391"`.
- A draft with a stale `phaseId` or from a non-roster phone is ignored.
- At the deadline phase becomes `"revealed"` and `answers` has exactly the letters of players not out; voters' drafts appear nowhere in `answers`.
- Human with no draft → `"…"`.
- `slow agent shows ellipsis and late result is dropped`: brain answer resolves after 50 s → at 45 s that letter shows `"…"`; advancing to 50 s does not change `answers`. Brain called with `budgetMs === 42_000`.
- `extend()` during answering moves the deadline by 15 s; the reveal happens at 60 s.
- `skip()` replaces the prompt, increments `phaseId`, resets the deadline to now + 45 s, discards earlier drafts; disabled (`prompt` unchanged) when `pool.canSkip` is false.
- Revealed answers are appended to `transcript` as `{kind:"answers", prompt, answers}`.

`describe("voting")`
- After the 3rd reveal, `next()` → `"voting"`, `deadline === now + 60_000`, agent `vote` called with `budgetMs === 57_000` and a context whose `transcript` has 3 answer entries.
- Room tally counts one vote per roster phone, last vote wins; `votedCount()` reflects it.
- Each in-player has one post: agents from the brain; humans from their phone's vote and normalized reason; missing → `{ target:null, reason:"…" }`.
- `human self-vote counts in room but posts no target`: the human votes for their own letter → that counts in the room tally; their post has `target: null`.
- An agent returning its own letter or an out/unknown letter → post `target: null`.
- `closeVote()` → `"votePosts"` immediately; then `next()` → `"removal"` with the top vote-getter `out = true` and `removal.kind` matching.
- Tie at the top → `removal.removed === null`; zero votes → `null`.
- Removed players' answers are not in later `answers`; a removed human's phone stays in `roster`, still votes, and its drafts are not shown.

`describe("end and replay")`
- When the last human is removed, `next()` from `"removal"` → `"ended"`, `winner === "agents"`.
- After the 3rd round's removal with a human still in, `next()` → `"ended"`, `winner === "humans"`.
- Otherwise `next()` from `"removal"` starts the next round at prompt 1.
- `newGame()` → phase `"lobby"`, phones kept with the same ids and rejoin codes, all `ready === false`; `start` then needs `setReady` again; prompts from the previous game are not drawn again.
- `repeated and out-of-phase host commands are no-ops`: `next()` twice during `"answering"`, `closeVote()` in `"revealed"`, `skip()` in `"voting"`, `extend()` in `"removal"`, and `closeVote()` after the vote deadline already fired → state unchanged, no second removal, no throw.
- `addPhone()` during a game returns a phone not in `roster`; after `newGame()` + `setReady(true)` it can be picked.

- [ ] **Step 2:** Run `npx vitest run tests/game.test.ts` — FAIL.
- [ ] **Step 3:** Implement `src/game.ts`. Phase changes go through one private `enterPhase(name, durationMs | null)` that bumps `phaseId`, clears the previous timer, sets `deadline`, schedules the close with `setTimeout`, and calls `onChange`. Agent calls are started inside `enterPhase` for `answering`/`voting`, each tagged with the `phaseId` at call time; their results are stored only if `phaseId` still matches and the phase is still open. Rejoin codes: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` via `crypto.randomInt`; phone ids via `crypto.randomUUID()`. Personas: assign `personaIndex` 0..4 to agents in shuffled order.
- [ ] **Step 4:** Run — PASS. `npm run typecheck` — PASS.
- [ ] **Step 5:** Commit `Add game engine`.

### Task 4: Claude agent brain

**Files:**
- Create: `src/agents.ts`, `scripts/smoke-agents.ts`
- Test: `tests/agents.test.ts`

**Interfaces:**
- Consumes: `AgentBrain`, `AgentContext`, `TranscriptEntry`, `Letter`.
- Produces: `class ClaudeBrain implements AgentBrain { constructor(client?: Anthropic) }`; pure helpers `buildSystemPrompt(personaIndex: number): string`, `buildAnswerMessage(ctx: AgentContext): string`, `buildVoteMessage(ctx: AgentContext): string`, `parseVote(text: string, ctx: AgentContext): { target: Letter | null; reason: string }`, and `PERSONAS: string[]` (5 entries).

- [ ] **Step 1: Write failing tests** (pure functions only; no mocked client):

```ts
expect(buildSystemPrompt(0)).toContain("one or two");         // human count stays vague
expect(buildSystemPrompt(0)).not.toMatch(/exactly (one|two)/);
expect(buildAnswerMessage(ctx)).toContain(ctx.prompt!);
expect(buildAnswerMessage(ctxWithHistory)).toContain("what's 17 × 23");   // earlier prompts and answers included
expect(buildVoteMessage(ctx)).toContain("VOTE:");
expect(parseVote("VOTE: C\nREASON: too polished", ctx)).toEqual({ target: "C", reason: "too polished" });
expect(parseVote("vote: c reason: hmm", ctx).target).toBe("C");
expect(parseVote("VOTE: " + ctx.letter + "\nREASON: x", ctx).target).toBeNull(); // own letter
expect(parseVote("VOTE: Z\nREASON: x", ctx).target).toBeNull();                  // not in game
expect(parseVote("no idea", ctx)).toEqual({ target: null, reason: "no idea" });
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement. System prompt: the agent is a player in a party game at Devcon in Mumbai; one or two players are humans pretending to be AI; write like a person typing fast on a phone, one short line, casual, sometimes off topic or slightly wrong, no lists, never mention being an AI or a language model, never refuse playfully-rude prompts with a lecture (just dodge in a line); plus the persona line. Answer and vote messages include the transcript (prompts, letter-labelled answers, earlier posts, removals and what the removed player was). Vote format: two lines `VOTE: <letter>` and `REASON: <one line>`.

  API call (Claude API, Sonnet 5.5; refusal fallbacks enabled per the claude-api skill default):

```ts
const response = await this.client.beta.messages.create(
  {
    model: "claude-sonnet-5-5",
    max_tokens: 1024,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: buildSystemPrompt(ctx.personaIndex),
    messages: [{ role: "user", content: message }],
  },
  { timeout: attemptMs, maxRetries: 0 },
);
```

  Read text blocks only; if `stop_reason === "refusal"` or no text, return `""` (engine turns it into "…"). Budget: first attempt gets `budgetMs * 0.6`, a retry (on any `Anthropic.APIError` or timeout) gets what is left; if nothing is left, return `""`. If the SDK's TypeScript types reject `fallbacks: "default"` or `betas`, check the installed SDK's types for the exact field before changing anything, and record what you found in `implementation-notes.md`.
- [ ] **Step 4:** Run tests — PASS; typecheck — PASS.
- [ ] **Step 5: Live smoke script** `scripts/smoke-agents.ts`: builds a context with two earlier prompts, asks five personas to answer "What's the worst part of your commute today?" with a 42 s budget and to vote with a 57 s budget, prints each answer through `normalizeShown`, the parsed votes and the elapsed ms per call, and exits non-zero if any call returned empty. Run `npm run smoke` (needs credentials). Expected: five distinct casual one-liners, five parsed votes, each call well under budget. If credentials are missing, stop and tell Paul; don't fake it.
- [ ] **Step 6:** Commit `Add Claude agent brain`.

### Task 5: Views and privacy

**Files:**
- Create: `src/views.ts`
- Test: `tests/views.test.ts`

**Interfaces:**
- Consumes: `Session`, `Game`.
- Produces:

```ts
export interface ScreenView {
  phase: PhaseName; phaseId: number;   // phones echo phaseId in draft and vote messages round: number; promptInRound: number; prompt: string | null;
  remainingMs: number | null;
  players: { letter: Letter; out: boolean; revealedKind: "agent" | "human" | null }[]; // revealedKind only for out players
  answers: Partial<Record<Letter, string>> | null;   // revealed only
  posts: PlayerPost[] | null;                         // votePosts and removal only
  removal: RemovalResult | null;                      // removal only
  votedCount: number; rosterCount: number; readyCount: number;
  promptsLeft: number; canSkip: boolean;
  winner: "humans" | "agents" | null;
}
export interface PhoneView extends ScreenView {
  you: { inRoster: boolean; role: "human" | "voter" | null; letter: Letter | null; rejoinCode: string; ready: boolean;
         draft: string; vote: { target: Letter | null; reason: string } };
}
export function screenView(s: Session, now: number): ScreenView;
export function phoneView(s: Session, phoneId: string, now: number): PhoneView;
```

  `role` is `"human"` only while the phone's player is in; a removed human gets `"voter"` and `letter: null`.

- [ ] **Step 1: Write failing tests:**
  - `screenView` JSON contains no phone id, no rejoin code, and the string `"human"` only inside `revealedKind` of out players or in `removal.kind`.
  - `phoneView(voter)` JSON contains its own rejoin code and no other phone's id or rejoin code, and no in-player's kind.
  - `phoneView(human)` has `role:"human"` and its letter; the other human's letter appears nowhere as a role.
  - `answers` is `null` during `answering`; `posts` is `null` during `voting`.
  - `remainingMs` is `deadline - now`, floored at 0, and `null` in untimed phases.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS. **Step 5:** Commit `Add screen and phone views`.

### Task 6: Server, protocol, identity and host auth

**Files:**
- Create: `src/server.ts`, `src/main.ts`
- Test: `tests/server.test.ts` (real HTTP + real `ws` clients on an ephemeral port, `ScriptedBrain`, real timers with short durations via an options override)

**Interfaces:**
- Consumes: `Session`, views, `PromptPool`, `AgentBrain`.
- Produces:

```ts
export interface ServerOptions {
  port: number; hostKey: string; publicUrl: string; brain: AgentBrain; pool: PromptPool;
  durations?: { answerMs: number; voteMs: number; extendMs: number; agentMarginMs: number }; // tests only
}
export function startServer(opts: ServerOptions): Promise<{ port: number; close(): Promise<void> }>;
```

  `Session`/`Game` accept the same optional `durations` (add the constructor option in this task, defaulting to `src/config.ts`).

  HTTP: `GET /` → `public/phone.html`; `GET /screen` → `public/screen.html`; `GET /qr.svg` → QR of `publicUrl` (via `qrcode.toString(url, { type: "svg" })`); static files under `/public/`. Nothing else.

  WebSocket `/ws`, JSON messages. Client → server:

```
{ t:"hello-phone", phoneId?: string }          // unknown or missing id → new phone in lobby, or "not in this game" during a game
{ t:"rejoin", code: string }
{ t:"ready", ready: boolean }
{ t:"draft", phaseId: number, text: string }
{ t:"vote", phaseId: number, target: Letter, reason: string }
{ t:"hello-screen", hostKey?: string }         // host commands allowed only if hostKey matches
{ t:"host", cmd: "start", humans: 1|2 } | { t:"host", cmd: "next"|"extend"|"closeVote"|"skip"|"newGame"|"reset" }
```

  Server → client: `{ t:"you", phoneId }` once after hello/rejoin; `{ t:"view", view }` on every change and every `TICK_MS` while a deadline is set; `{ t:"error", reason }` for refused host commands and failed starts.

  Limits: text and reason capped at 500 characters server-side before storage; messages over 4 KB close the socket; `REJOIN_MAX_FAILS` wrong codes on one socket close it.

  `main.ts`: reads `PORT` (default 3000), `PUBLIC_URL` (required; exit with a message if missing), `HOST_KEY` (default `crypto.randomUUID()`), loads `prompts.txt`, uses `ClaudeBrain`, prints the phone URL and `PUBLIC_URL/screen?host=<key>`.

- [ ] **Step 1: Write failing tests:**
  - `twelve phones play a full game`: 12 phone clients join, screen with host key starts with 2 humans, phones send drafts and votes each phase; after three rounds the screen view reaches `ended` with a winner. Durations: answer 300 ms, vote 300 ms.
  - `reconnect keeps draft`: a human sends a draft, closes its socket, reconnects with `hello-phone` + same id before the deadline; its `you.draft` is restored and the revealed answer equals the normalized draft.
  - `rejoin code restores identity`: a new socket sends `rejoin` with a human's code → receives the same `phoneId` and `role:"human"`; five wrong codes close the socket.
  - `host command without key is refused`: a screen without the key sends `start` → `{t:"error"}` and phase stays `lobby`; a phone socket sending `{t:"host"}` is ignored.
  - `late joiner waits then plays next game`: a phone joining mid-game gets `inRoster:false`; after `newGame` and `ready`, the next `start` can include it.
  - `qr and pages are served`: `GET /`, `/screen`, `/qr.svg` return 200; `/qr.svg` body contains `<svg`; `GET /src/game.ts` returns 404.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run full suite — PASS, output free of warnings. **Step 5:** Commit `Add WebSocket server`.

### Task 7: Phone page

**Files:**
- Create: `public/phone.html`, `public/phone.js`, `public/style.css`

**Interfaces:**
- Consumes: the Task 6 protocol and `PhoneView`.

Screens by phase (one page, sections toggled with `hidden`):
- **Lobby:** "Waiting for the game to start", an "I'm in" toggle (pre-set on first join), number ready.
- **Not in this game:** "Game in progress, you can join the next one", plus a rejoin-code field.
- **Role card:** a box labelled "Hold to see your role"; while pressed (pointer and touch events) it shows either "You're a hidden human. You are Player C. Make them think you're an agent." or "You're a voter. Find the humans." plus "Rejoin code: XXXXXX". Same box size and wording length for both roles. Available in every in-game phase.
- **Answering:** prompt, big countdown from `remainingMs`, a text area (`maxlength=120`), Send button. Each input sends `draft` (debounced 300 ms); Send sends immediately and shows "Sent, you can still edit". Text area is restored from `you.draft` after reconnect. Everyone in the roster sees this, whatever their role.
- **Revealed / votePosts / removal / ended:** "Look at the screen".
- **Voting:** one button per player still in (all in-players for everyone, including the human's own letter), a reason field, countdown. Selection and reason send `vote` (debounced 300 ms).
- Identity: `phoneId` in `localStorage` (wrapped in try/catch); reconnect with backoff 0.5–5 s; `hello-phone` with the stored id on every connect.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Manual check** with `PUBLIC_URL=http://localhost:3000 npm start`, two browser windows as phones and one as screen: play one prompt and one vote; refresh a phone mid-answer and confirm the draft returns; confirm both roles show identical controls (same buttons in the vote) except inside the held card. Record the result in `implementation-notes.md`.
- [ ] **Step 3:** Commit `Add phone page`.

### Task 8: Screen page and host controls

**Files:**
- Create: `public/screen.html`, `public/screen.js` (shares `public/style.css`)

**Interfaces:**
- Consumes: the Task 6 protocol and `ScreenView`; host key from the `host` query parameter, sent in `hello-screen` and never rendered.

Layout (readable from the chairs on a small screen; large type):
- **Lobby:** QR code (`/qr.svg`), the phone URL as text, "N ready", the line "One or two of these players are human."
- **Every in-game phase:** six player tiles A–F (removed ones greyed with "agent"/"human" label), round and prompt number, and the countdown when `remainingMs` is set.
- **Answering:** the prompt, countdown.
- **Revealed:** each in-player's answer under its tile.
- **Voting:** "9 of 12 voted", countdown.
- **VotePosts:** each post as "Player B votes D: reason" (or "Player B: reason" when `target` is null).
- **Removal:** full-screen "Player C was… an agent" / "a human", or "Tie, nobody is out".
- **Ended:** "The humans win" / "The agents win", with every player's kind revealed.
- **Host bar** (only when the page has a host key): Start with a 1/2 humans switch (default 2), Next, +15 s, Close vote, Skip (disabled when `!canSkip`), prompts left, New game, Reset (Reset asks for a second click within 3 s instead of `confirm()`). Show `{t:"error"}` reasons in the bar.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Manual check** with the same local setup: run a whole game with 2 phone windows, using every host button once; open `/screen` without the key and confirm the host bar is absent and commands are refused. Record the result in `implementation-notes.md`.
- [ ] **Step 3:** Commit `Add screen page and host controls`.

### Task 9: Simulation, rehearsal and run instructions

**Files:**
- Create: `scripts/simulate.ts`, `README.md`

**Interfaces:**
- Consumes: the Task 6 protocol.

- [ ] **Step 1:** `scripts/simulate.ts <url> [phones=12]`: opens N phone WebSockets against a running server, each typing random drafts during answering and voting randomly, with one phone dropping and reconnecting every phase. Prints per-phase timing and any `error` messages; exits non-zero if a phone ever sees a view with a `phaseId` older than the screen's after 2 s.
- [ ] **Step 2: Run against a real server with the real brain:** `PUBLIC_URL=http://localhost:3000 npm start` and, in another shell, `npm run simulate -- ws://localhost:3000/ws 12`, then drive the game from `/screen?host=…`. Expected: a full game ends, every reveal happens at its deadline with agent answers present (not "…"), no errors.
- [ ] **Step 3: README:** install (`npm ci`, `brew install cloudflared`), the run order (start `cloudflared tunnel --url http://localhost:3000`, copy the `trycloudflare.com` URL, `PUBLIC_URL=<url> npm start`, open the printed screen URL on the laptop), keep-the-laptop-awake (`caffeinate -dis` alongside), briefing checklist (scan with the camera app, what the role card means, the rules), and a real-phone rehearsal checklist: lock the phone mid-answer, switch apps, refresh, rejoin with the code, hold-to-see card unreadable from the next seat.
- [ ] **Step 4: Real-phone rehearsal through the tunnel** with Paul's phone plus at least one other device. Record results in `implementation-notes.md`.
- [ ] **Step 5:** Commit `Add simulation script and run instructions`.
