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

## Task 5

- In the lobby (`Session.game` is null) both views report phase "lobby" with an empty `players` list, `phaseId` 0, and `rosterCount` equal to `readyCount` (ready phones).
- In phase "ended" `revealedKind` is set for every player, on screen and phones. Before that, only out players have it.
- Added `Session.promptsLeft` (read-only, the pool's `remaining`) for the `promptsLeft` field.
- `answers` is present only in "revealed", `posts` only in "votePosts" and "removal", `removal` (with `tally`) only in "removal".
- `you.role` is `null` for a phone outside the roster (joined mid-game), `"voter"` for roster phones that are not a player in, `"human"` only while the human is in. `draft` and `vote` are empty for phones outside the roster.
- The repo has no Prettier config; `src/views.ts` follows the style of `src/game.ts` and is not run through Prettier.

## Task 6

- `durations` was already on `Session` (Task 3), so `ServerOptions.durations` just passes it through as the engine's `Durations` type.
- Protocol additions the brief leaves open: a wrong rejoin code gets `{t:"error", reason:"bad-code"}` (so the phone page can say so); the fifth wrong code on a socket closes it with 1008 instead. Rejoin codes are trimmed and uppercased before lookup, so a code typed in lowercase works.
- After Reset the server closes every phone socket bound to a wiped phone with code 4000; the phone page reconnects, its `hello-phone` id is unknown, and it gets a new identity. This avoids ever calling `phoneView` for an unknown id.
- A socket is a phone (after `hello-phone` or `rejoin`) or a screen (after `hello-screen`); a later hello of the other kind switches it. `rejoin` also works on an already bound phone socket, so the "not in this game" page can rejoin an old identity. `{t:"host"}` from a non-screen socket is ignored; from a screen without the key it gets `not-host`. Malformed messages (bad JSON, wrong field types, unknown `t` or `cmd`, `humans` not 1 or 2) are ignored.
- Static files are limited to known extensions (html, js, css, svg, png, ico, json, txt); anything else is 404. Pages are sent with `cache-control: no-cache`.
- Every `ws` socket has an `error` listener: without one, an oversized message (ws closes it with 1009) would throw and crash the process.
- `main.ts` loads `prompts.txt` relative to the source file, not the working directory, and URL-encodes the host key in the printed screen URL. It rejects a non-numeric `PORT`.
- `public/phone.html` and `public/screen.html` are placeholders for Tasks 7 and 8.
- Fix round 1: `Session` takes an optional `isConnected(phoneId)` callback (default: every phone is connected). `start()` deals hidden humans only from ready phones with an open socket; every ready phone still joins the roster, and `too-few-ready` now means fewer ready and connected phones than the human count. The server answers it from its open sockets.
- `hello-phone` with no known id on a socket that already has a phone keeps that phone instead of adding one.
- `wss` has an `error` listener: a listen error (such as EADDRINUSE) rejects `startServer`, and later server errors are logged. The ticker starts only after listening succeeds, so a failed start leaves no timer behind. `main.ts` prints a one-line message and exits 1 when the port is busy.
- `main.ts` prints the host screen URL as `http://localhost:<port>/screen?host=<key>`, so the key never goes through the tunnel.

## Task 7

- Files: `public/phone.html`, `public/phone.js`, `public/style.css` (phone rules under `body.phone`; `:root` colours and the reset are shared for Task 8). No external fonts or scripts. Pages load `/public/style.css` and `/public/phone.js`.
- The page fills the draft or the vote from the server only once per `phaseId`, so a reconnect restores it and later views never overwrite typing. The countdown runs on the local clock from each view's `remainingMs`.
- The role text is written into the card only while pressed and cleared on release, blur or when the page is hidden. Pointer and touch events both fire the hold; the card is a fixed 220 px high for both roles.
- On close code 4000 the page clears the stored phoneId and reconnects. A wrong rejoin code shows "That code did not work."
- Out players (human voted out) get `role: "voter"` from the server, so the card shows the voter text for them. The vote buttons list only players still in.
- Headless check (controller ruling 1). Server started with `PUBLIC_URL=http://localhost:3000 HOST_KEY=test npm start`, no API key. A throwaway driver (outside the repo) connected 5 fake phones and a host screen, started a game with 1 human, and stepped through all phases. Captured with headless Chrome and a fixed `--user-data-dir`, so the real page kept its phoneId and was a roster voter:
  - `phone-lobby.png`: title, "I'm in" toggle (on), "1 ready". OK.
  - `phone-answering.png`: prompt, 41 s countdown at 88 px, text area, Send, held-role box. OK.
  - `phone-revealed.png`, `phone-ended.png`: "Look at the screen" plus the role box. OK.
  - `phone-voting.png`: countdown, six "Player A..F" buttons, reason field, role box. OK.
  - `phone-notin.png`: late joiner mid-game: "Game in progress, you can join the next one", rejoin field and button. OK.
  - Headless Chrome will not make a window narrower than 500 px, so these are 500 px wide, not 390. A 390 px iframe check (`phone-voting-390.png`) lost its phoneId to storage partitioning and showed the not-in-game page instead; it does show that one at 390 without overflow. The vote grid at 390 px is not seen.
- Not verified, still to do on real phones: typing and the 300 ms draft debounce; Send and the "Sent, you can still edit" line; draft and vote restored after a refresh mid-phase; hold-to-see (touch, long-press menu, release); lock and unlock the phone; vote selection and reason; layout at 390 px and with the keyboard open; "I'm in" toggle; rejoin code entry; reset (4000) handling; mobile Safari and Chrome through the tunnel.
