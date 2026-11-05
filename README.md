# Spot the Human

A live party game for 10 to 15 phones and one shared screen. Six players, A to F, answer prompts. Three of them are people, the other three are Claude agents. Hidden humans try to pass as agents, and the room votes out the player it thinks is human. The host runs it from a laptop behind a Cloudflare quick tunnel.

## Install

```
npm ci
brew install cloudflared
```

Agents need `ANTHROPIC_API_KEY` in the shell that runs `npm start`. Before listening, the server makes one test call to the API and exits with "Agent check failed" if it gets no answer within 15 s, so a missing or bad key can't expose the humans at the first reveal. It prints the call's time when it works.

## Run order

1. Keep the laptop awake in a spare terminal: `caffeinate -dis`
2. Start the tunnel: `cloudflared tunnel --url http://localhost:3000`
3. Copy the `https://….trycloudflare.com` URL it prints.
4. In another terminal, set the key and a fixed host key, then check the agents:
   ```
   export ANTHROPIC_API_KEY=…        # fish: set -x ANTHROPIC_API_KEY …
   export HOST_KEY=<any long string> # fish: set -x HOST_KEY …
   npm run smoke
   ```
   `npm run smoke` has five agents answer and vote, then vote again on a full three-round game, prints each call's time and `stop_reason`, and ends with "smoke ok".
5. In the same terminal: `PUBLIC_URL=<that url> npm start`. It prints "Agent check ok" before "Listening".
6. Open the `Screen (host): http://localhost:3000/screen?host=…` URL it prints, on the laptop. The host key is in that URL only. Never open it through the tunnel and never show the address bar. The page drops `?host=` from the address bar and keeps the key for that tab, so reloading the tab keeps the host bar.
7. Best: set the display up as a second screen (not mirrored), open `http://localhost:3000/screen` without `?host=` there in full screen, and keep the host tab on the laptop. The room then never sees the host bar. If the room only allows mirroring, mirror the host tab; the host bar shows nothing secret. The lobby shows a QR code for the phone URL.

Options: `PORT` (default 3000; change the tunnel URL to match), `HOST_KEY` (default random per start; set it so the host URL survives a server restart), `SKIP_AGENT_CHECK=1` (skip the startup API check, for simulation runs without a key).

The tunnel URL changes on every `cloudflared` start. If you restart it, restart the server with the new `PUBLIC_URL`.

The host buttons: Start (deals three hidden humans and needs at least 3 connected phones in), Next, +15 s, Close vote, Skip prompt, New game, Reset. New game during a game and Reset both turn red on the first click and act only on a second click between 0.6 and 3 seconds later, so a double click does nothing. Close vote ends the vote as soon as every agent has voted (usually a few seconds), so no agent post shows as "…" next to a human's real one. Next, +15 s, Close vote and Skip act once on a double click; a second click needs to come at least 0.6 seconds after the first. New game after a game has ended takes one click. Reset forgets every phone, so use it only between sessions.

## If something breaks

- Server crashed or restarted mid-session: start it again with the same `PUBLIC_URL` and `HOST_KEY`. Phones reconnect by themselves and land in a fresh lobby (the game is lost; nothing is saved), so press Start again. Prompts from the lost game may come up again. With a fixed `HOST_KEY` the screen tab reconnects and its host bar keeps working; without one, open the new host URL the server prints.
- Tunnel died: restart `cloudflared`. It prints a new URL, so restart the server with that `PUBLIC_URL`; the lobby shows a new QR code and everyone rescans.
- Venue Wi-Fi failing: tether the laptop to your phone. `cloudflared` usually reconnects by itself; if the phone URL stops working, restart it as above.
- Agents show "…" on the screen: look at the server terminal. Every failed or empty call prints a line starting with `agent` and the reason (rate limit, timeout, bad key, stop reason).

## Simulation

Start the server with `SKIP_AGENT_CHECK=1` when there is no API key; the agents then answer "…".

`npm run simulate -- ws://localhost:3000/ws 12` joins 12 fake phones, then you press Start on the screen. One phone drops and reconnects at every phase. It prints each phase with its timing and any `error` message, and exits 1 if a phone is more than 2 s behind the screen's `phaseId`.

`npm run simulate -- ws://localhost:3000/ws 12 --host <key>` also plays the host: Start, Next through a whole game, New game, then a second Start through its first reveal. A full game takes about 10 minutes.

To test through the tunnel, use `wss://<tunnel host>/ws`.

## Briefing checklist (say this before Start)

- Scan the QR code with the normal camera app. Do not install anything.
- Check your phone says you're in. Everyone who is in when the host presses Start plays.
- Each phone has a role card. Hold it to see it, let go to hide it. It also shows your rejoin code. It says either "You're a hidden human, Player X. Make them think you're an agent. Your answers, vote and reason show on screen." or "You're a voter. Watch the six players and find the three humans hiding among them. Vote and say why in a few words." Do not show it to anyone.
- Three of the six players are human. The other three are agents. A hidden human answers so that people take them for an agent.
- Each prompt: 30 seconds to type an answer. It appears on screen with a letter, not a name.
- Then 60 seconds to vote for who you think is human, with a short reason. Everybody votes, hidden humans too. The screen lists each player's three answers from the round while you vote.
- The player with the most votes from the room's phones is out and shown as a human or an agent. A tie or no votes removes nobody. The players post votes too, but those are only their opinion: the room decides.
- Up to three rounds of three prompts. The agents win as soon as the room has caught two humans. The humans win if two of them are still in at the end, or once the votes left can't catch two (no human out after round 2). The end screen says how many humans were caught.
- Always type something before the timer runs out.
- If your phone locks or the page reloads, reopen the page. If it says "Game in progress", type the rejoin code shown on your role card. Hold the role card to see it, and write it down.

## Real-phone rehearsal checklist

Run this through the tunnel with your own phone and at least one other device (one iPhone, one Android if possible). Record the results in `implementation-notes.md`.

Phone page
- Typing in the answer box, then Send. "Sent, you can still edit" appears and an edit after Send still counts.
- The draft keeps up with typing (300 ms delay); lock the phone mid-answer, unlock, and the draft is still there and still counts at the deadline.
- Switch to another app mid-answer and back. Same check.
- Refresh the page mid-answer, and again mid-vote. Draft, vote and reason come back.
- Rejoin: open the page in a private tab (new identity), then enter the code from the other tab. A wrong code shows "That code did not work." After 32 wrong codes in a minute from anyone, every rejoin is refused for the rest of that minute, so a right code may need a second try.
- Hold-to-see card: press and hold shows the role, release hides it. No long-press menu, no text selection. Hold it and turn the phone to the next seat: it must be unreadable from there. Locking or switching apps while holding hides it.
- Layout at the real screen size (about 390 px wide) with the keyboard open: the Send button and the vote buttons stay reachable, nothing overflows sideways.
- Vote: pick a letter, type a reason, change the letter, and check that only players still in appear after a removal.
- The lobby button, on and off: it reads "You're in · tap to sit out" when in and "Tap to join the next game" when out.
- Lock the phone for 10 seconds during answering, then unlock: "Reconnecting…" may flash, then the countdown is right and the draft is still there. Same with flight mode on and off.
- Join mid-game: shows "Game in progress, you can join the next one" and the rejoin field.
- After a Reset on the screen, the phone gets a new identity without errors.
- Mobile Safari and mobile Chrome both load through the tunnel.

Host screen (opened on the laptop with the host URL)
- Click every button: Start, Next, +15 s (the countdown gains 15 s), Close vote, Skip (only in answering), New game, Reset. New game in a running game and Reset: the first click turns them red, a double click does nothing, a second click about a second later acts.
- Double-click Next on the vote posts: the removal reveal still shows.
- Error text in the host bar when Start fails (for example with no ready phones).
- The address bar loses `?host=` after load.
- Reload the screen tab mid-game: the "Connecting…" banner shows, then the game returns with the host bar, and the address bar still has no `?host=`.
- Play to a tie ("Tie in the room vote, nobody is out"), a human removed ("a human" in red), a game that ends after round 2 with "The agents win" and "2 of 3 humans caught", and one that ends with "The humans win".
- Check the screen on the real display at distance: answers, countdown and the removal reveal readable from the back of the room.

Whole game
- With `ANTHROPIC_API_KEY` set, every reveal shows agent answers (not "…") and every reveal happens at its deadline.
- Run `npm run simulate` against the tunnel URL with 12 phones while the real devices play along.
