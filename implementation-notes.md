# Implementation notes

Records deviations from the plan.

## Task 2

- Added `PromptPool.reset()` (controller ruling): marks every prompt unused again, needed by the full reset. Not in the original brief.
- The `# REVIEW:` comment above the rude prompt also says why: it is rude by design and needs a decision before the event.
- `prompts.txt` starts with a one-line header comment; `fromFile` skips it.
- The brief's `canSkip` test took one prompt from 10 and expected `canSkip(9)` false. That contradicts the brief's own definition (`remaining >= promptsStillNeeded`: 9 >= 9 is true). I kept the definition and changed the test to take two prompts before expecting false. Controller should confirm the definition.
- The first commit was made with a failing test and 41 prompts by mistake; the follow-up commit fixes both.

## Task 3

- `Game.begin()` is public and separate from the constructor, so `Session.game` is set before the first `onChange` fires. `Game.dispose()` clears the timer; `Session.newGame()` and `reset()` call it.
- `Game.canSkip()` is public (not in the brief): `skip()` uses it and Task 5's `canSkip` view field needs it. It counts the replacement prompt plus every prompt still to come this game.
- `Session.newGame()` sets `game` to `null` (so `phase` is "lobby") and is a no-op when already in the lobby, so a stray press can't un-ready everyone.
- `players` is ordered A to F; the shuffle decides which letters are human and which persona each agent gets.
- `removal.tally` has all six letters (out players at 0) so it matches `Record<Letter, number>` without a cast.
- Room votes for an out or unknown letter are ignored (the buttons only show players still in). Drafts and votes whose text is not a string are ignored, so bad client input can't crash the deadline handler.
- Drafts do not call `onChange` (nothing shared changes); room votes do, because `votedCount` changes. Agent results never call `onChange`.
- Drafts and room votes are cleared when answering or voting opens. Posts and removal are cleared when voting opens.
- `extend()` keeps the `phaseId`: the phase stays open, so in-flight drafts and agent calls still count.
- phaseIds come from a counter on `Session` that never resets (not on New game, not on Reset), so a message tagged for an earlier game can't match a phase in a later one.

## Task 4

- The SDK types (`@anthropic-ai/sdk@0.115.0`) accept the brief's call shape as written: `fallbacks: "default"`, `betas: ["server-side-fallback-2026-07-01"]` and `output_config: { effort: "low" }` all typecheck. No change.
- Retry rule: any `Anthropic.APIError` (which includes `APIConnectionTimeoutError`) gets one retry with what is left of the budget. Any other error (for example the SDK's "Could not resolve authentication method" when no credentials exist, which is a plain `Error`) returns `""` at once, since a retry can't fix it.
- Only `stop_reason === "refusal"` returns `""` outright. Any other stop reason (including `max_tokens`) uses whatever text came back; an empty result is logged with its stop reason.
- `answer` and `vote` wrap everything in try/catch, so they resolve to a string and a `{ target, reason: string }` even if building the message throws.
- The brief's history test expects `"what's 17 × 23"`; the fixture's prompt is written in lowercase so the assertion stays verbatim. Real prompts keep their case in the message, as the screen shows them.
- `parseVote` accepts `VOTE: player C` and, without a `REASON:` label, keeps the rest of the text as the reason. A word that only starts with a letter (`VOTE: abstain`) is not read as a vote.
- Failures are logged to stderr (`agent call failed (attempt n): ...`) so a rate limit or outage shows on the laptop during the session. The log never includes the key.
