# Spot the Human: design

Date: 2026-11-04. Event: Agents Hub, Devcon 8 Mumbai. The session is on 2026-11-06, so there are two days to build and test.

## What it is and why

A live party game for one 20 to 30 minute session. Six players, A to F, answer short prompts on a shared screen. One or two of them are people in the room pretending to be agents; the rest are Claude agents. The room tries to find the humans and votes players out. Any human still in after three rounds wins.

The point for the room is to have fun and to notice how hard it is to tell people and agents apart from text alone.

## The room

A small screen with chairs around it and 10 to 15 people at most. Everyone can see the screen, and people can see each other's phones. That shapes the whole design: nothing a person does on their phone may give away their role.

## Goals

- Every person in the room opens the same phone page. The page secretly makes one or two of them hidden humans and everyone else a voter. Nobody can tell who is who by watching phones.
- One session runs from start to finish without anyone having to fix anything.

## Anti-goals (failure even if it technically works)

Paul named these three:

1. **Voting doesn't work.** Votes get lost, phones drop out, or the count is wrong.
2. **It's too obvious.** The humans are easy to spot from writing style, length or speed, or the agents give themselves away by sounding like assistants.
3. **People can't answer in time.** Phone typing is slow and people miss the window.

## Non-goals

- The twists from the original notes (reverse round, AI-assisted human, Hinglish round). Not before Devcon.
- Anything shared with the Sleeper Agent game. Build only what this session needs.
- Moderation of answers, and any notice about Bonfires recording the hub (Paul's decision).
- Accounts, sign-up, names, persistence across server restarts, more than one game running at a time.
- Hosting anywhere other than Paul's laptop.

## How the session goes

### Joining and briefing

- People scan a QR code that opens the phone page. There is no sign-up or name. The page shows a waiting screen.
- Paul briefs the whole room at once, then presses Start. Joining closes at Start; anyone who opens the page later sees "game in progress".
- At Start the server picks the hidden humans at random from the joined phones. Paul chooses one or two humans when he presses Start (my call; default two). The six player letters A to F are shuffled, so a human could be any letter.
- The exact number of humans stays secret (Paul's decision). The screen says "one or two of these players are human", and the agents are told the same. After the first human is revealed, the room still doesn't know whether the hunt is over.

### Roles on the phone

- Each phone shows its role on a card that only appears while the person holds a finger on it ("hold to see your role"), so neighbours can't read it. A hidden human's card also shows their letter ("You are Player C"). (My call.)
- With two humans, neither knows the other's letter (Paul's decision). They are rivals for the room's suspicion, not a team.
- Apart from that card, a human's page and a voter's page look and behave the same.

### A round

A round is three prompts and then a vote. A game is three rounds.

For each prompt:

1. The screen and every phone show the prompt and a visible 45-second countdown.
2. **Everyone types an answer**, voters included, so all thumbs move at the same time. Voters' answers are cover only and never appear on screen.
3. When the timer runs out, each phone sends whatever has been typed, even half a sentence. An empty answer shows as "…". People can also press Send early, but nothing appears on screen until the timer ends.
4. The screen shows all six players' answers at once. The room reads and talks. Paul presses Next when they're done (no timer on the discussion; my call).

After the third prompt, the vote:

1. Every phone shows buttons for the players still in, with a visible 45-second countdown. Each person has one vote and can change it until the vote closes. Hidden humans vote too, so their phones look the same (my call).
2. The screen shows how many people have voted ("9 of 12 voted") but not who they voted for.
3. At the same time, each agent posts its vote and a one-line reason on screen.
4. When the vote closes, the player with the most room votes is removed and the screen reveals whether they were a human or an agent. That reveal is the big moment and gets the full screen.
5. If the top two tie, nobody is removed that round.

If a hidden human is removed, their phone becomes an ordinary voter's phone.

### The end

- After three rounds, any human still in wins and the screen says so.
- If every human is out before that, the game ends there and the agents win.

### Playing again

A session can hold more than one game (Paul's decision), since a game with one human can end about 7 minutes in. When Paul presses New game, every phone goes back to the lobby with its identity kept, nobody has to rescan, and the server deals new roles and shuffles the letters again. Prompts played in an earlier game of the same session are not reused, so the prompt list needs at least 30 entries (three games of nine, plus spares for Skip). Joining reopens in the lobby between games, so newcomers can join.

### Agent votes (decision open)

Paul will decide later whether agents' votes count toward who is removed. Until then, only the room's votes remove a player and the agents' votes are commentary. Keep the two counts separate so switching to "both count" is a small change.

## Keeping it fair (anti-goal 2)

- Every answer, human or agent, gets the same treatment before it reaches the screen: lowercased, punctuation stripped, cut to 120 characters. Style alone must not give anyone away.
- Answers appear together at the end of the timer, so speed gives nothing away.
- Agents are told to write like a person typing fast on a phone: short, casual, sometimes off topic or a little wrong. No polished paragraphs, no lists, no "As an AI". Each agent gets a short personality on top of the shared base prompt so the four don't sound alike.
- Agents are told that one or more of the players are humans pretending to be agents, and that they should find them. Each agent sees every prompt and every player's answers so far, so it can reason when voting.
- The prompt list is chosen so a human can't win just by being plainly human. Paul reviews it before the session.

## Reliability (anti-goals 1 and 3)

- Each phone keeps its identity in browser storage. A refresh, a locked screen or a dropped connection puts the person back exactly where they were, with their role, draft answer and vote kept.
- If a phone loses that storage (a QR scanner's in-app browser, private mode, switching browsers), the person can get back in with a short rejoin code shown on their role card. The "game in progress" page has a field for it. The briefing should also ask everyone to scan with the phone's own camera app. (My call.)
- The server holds the authoritative state and timers. Phones only display the time the server says is left.
- Typed text is saved as a draft on the server while the person types, so the timer-end submit works even if the phone's connection drops in the last second.
- If an agent's API call fails, retry once; if it still fails, that agent's answer is "…" (the same as a human who typed nothing). A failed agent vote is left out.
- Before the session, run a test game with a dozen simulated phones to find failures before the room does.

## Host controls

Paul runs the game from the screen page on the laptop. The host controls appear only when the page is opened with a secret host key in the URL. Controls:

- Start (with the one-or-two-humans choice)
- Next (moves to the next prompt or the vote)
- +15 seconds (during answering or voting)
- Close vote now
- Skip prompt (replace the current prompt with the next unused one)
- New game (back to the lobby, phones kept, see "Playing again")
- Reset (wipe everything; for testing)

## What it's built with (my calls)

- One small TypeScript app. A Node server holds the whole game in memory and pushes updates to phones and the screen over WebSockets. No database.
- Two pages served by the app: the phone page and the screen page. Plain HTML and JavaScript, no frontend framework.
- It runs on Paul's laptop. A Cloudflare quick tunnel (`cloudflared tunnel --url http://localhost:3000`) gives it a public URL with no account; that URL goes in the QR code. Everything depends on the laptop staying awake and online.
- Agents run on Claude Sonnet 5.5 (`claude-sonnet-5-5`) through the Anthropic API. The key comes from the `ANTHROPIC_API_KEY` environment variable.
- Prompts live in a plain config file Paul can edit.

## First draft of the prompts (for Paul to edit)

Nine are needed per game and at least 30 per session. The builder extends this list to 30; Paul edits it.

- What's 17 × 23?
- Describe the worst part of your commute today.
- Answer in one word: Mumbai traffic.
- Write a haiku about gas fees.
- What did you have for breakfast?
- What does this room smell like?
- Which talk today would you skip, and why?
- What would you do with 1 ETH right now?
- What's the last thing that made you laugh?
- What's your phone battery at?
- Tell us a secret.
- Say something rude about the person to your left. (Risky in a small room with no way to hide an answer; keep or drop.)

## Left to the builder

- Screen and phone layout and styling, as long as the timer, the answers and the reveal are easy to read from the chairs.
- The agents' exact prompts and personalities, within the rules above.
- Message format between server and pages, file layout, test setup.
- How the simulated-phone test game works.
