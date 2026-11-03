# Spot the Human

A live party game for 10 to 15 phones and one shared screen. Six players, A to F, answer prompts. One or two of them are people, the rest are Claude agents. Hidden humans try to pass as agents, and the room votes out the player it thinks is human. The host runs it from a laptop behind a Cloudflare quick tunnel.

## Install

```
npm ci
brew install cloudflared
```

Agents need `ANTHROPIC_API_KEY` in the shell that runs `npm start`. Without it every agent answers "…". `npm run smoke` checks the key against the API.

## Run order

1. Keep the laptop awake in a spare terminal: `caffeinate -dis`
2. Start the tunnel: `cloudflared tunnel --url http://localhost:3000`
3. Copy the `https://….trycloudflare.com` URL it prints.
4. In another terminal: `PUBLIC_URL=<that url> npm start`
5. Open the `Screen (host): http://localhost:3000/screen?host=…` URL it prints, on the laptop. The host key is in that URL only. Never open it through the tunnel and never show the address bar.
6. Mirror the screen to the display. The lobby shows a QR code for the phone URL.

Options: `PORT` (default 3000; change the tunnel URL to match), `HOST_KEY` (default random per start).

The tunnel URL changes on every `cloudflared` start. If you restart it, restart the server with the new `PUBLIC_URL`.

The host buttons: Start (with 1 or 2 humans), Next, +15 s, Close vote, Skip prompt, New game, Reset (click twice). Reset forgets every phone, so use it only between sessions.

## Simulation

`npm run simulate -- ws://localhost:3000/ws 12` joins 12 fake phones, then you press Start on the screen. One phone drops and reconnects at every phase. It prints each phase with its timing and any `error` message, and exits 1 if a phone is more than 2 s behind the screen's `phaseId`.

`npm run simulate -- ws://localhost:3000/ws 12 --host <key>` also plays the host: Start, Next through a whole game, New game, then a second Start through its first reveal. A full game takes about 10 minutes.

To test through the tunnel, use `wss://<tunnel host>/ws`.

## Briefing checklist (say this before Start)

- Scan the QR code with the normal camera app. Do not install anything.
- Tap "I'm in". Everyone who is in when the host presses Start plays.
- Each phone has a role card. Hold it to see it, let go to hide it. It also shows your rejoin code. It says either "You're a hidden human. You are Player X. Make them think you're an agent." or "You're a voter. Watch the six players and find the humans hiding among them." Do not show it to anyone.
- One or two of the six players are human. The rest are agents. A hidden human answers so that people take them for an agent.
- Each prompt: 45 seconds to type an answer. It appears on screen with a letter, not a name.
- Then 60 seconds to vote for who you think is human, with a short reason. Everybody votes, hidden humans too.
- The player with the most votes is out and shown as a human or an agent. A tie or no votes removes nobody.
- Three rounds of three prompts. Humans win if one is still in at the end.
- If your phone locks or the page reloads, reopen the page. If it says "Game in progress", type the rejoin code shown on your role card. Hold the role card to see it, and write it down.

## Real-phone rehearsal checklist

Run this through the tunnel with your own phone and at least one other device (one iPhone, one Android if possible). Record the results in `implementation-notes.md`.

Phone page
- Typing in the answer box, then Send. "Sent, you can still edit" appears and an edit after Send still counts.
- The draft keeps up with typing (300 ms delay); lock the phone mid-answer, unlock, and the draft is still there and still counts at the deadline.
- Switch to another app mid-answer and back. Same check.
- Refresh the page mid-answer, and again mid-vote. Draft, vote and reason come back.
- Rejoin: open the page in a private tab (new identity), then enter the code from the other tab. A wrong code shows "That code did not work."
- Hold-to-see card: press and hold shows the role, release hides it. No long-press menu, no text selection. Hold it and turn the phone to the next seat: it must be unreadable from there. Locking or switching apps while holding hides it.
- Layout at the real screen size (about 390 px wide) with the keyboard open: the Send button and the vote buttons stay reachable, nothing overflows sideways.
- Vote: pick a letter, type a reason, change the letter, and check that only players still in appear after a removal.
- The "I'm in" toggle, on and off, in the lobby.
- Join mid-game: shows "Game in progress, you can join the next one" and the rejoin field.
- After a Reset on the screen, the phone gets a new identity without errors.
- Mobile Safari and mobile Chrome both load through the tunnel.

Host screen (opened on the laptop with the host URL)
- Click every button: Start, the 1/2 humans switch, Next, +15 s (the countdown gains 15 s), Close vote, Skip (only in answering), New game, Reset (first click arms it and turns it red, second within 3 s resets).
- Error text in the host bar when Start fails (for example with no ready phones).
- The address bar loses `?host=` after load.
- Reload the screen mid-game: the "Connecting…" banner shows, then the game returns.
- Play to a tie ("Tie, nobody is out"), a human removed ("a human" in red) and a game that ends with "The agents win".
- Check the screen on the real display at distance: answers, countdown and the removal reveal readable from the back of the room.

Whole game
- With `ANTHROPIC_API_KEY` set, every reveal shows agent answers (not "…") and every reveal happens at its deadline.
- Run `npm run simulate` against the tunnel URL with 12 phones while the real devices play along.
