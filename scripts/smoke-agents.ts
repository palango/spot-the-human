// Live check of the agent brain against the Claude API: five personas answer one prompt and vote, then the
// agents still in vote again on a full three-round transcript. Prints latency and stop_reason for every API call.
// Needs credentials that `new Anthropic()` can resolve (normally ANTHROPIC_API_KEY).
import { type CallReport, ClaudeBrain } from "../src/agents.js";
import { ANSWER_MS, AGENT_MARGIN_MS, VOTE_MS } from "../src/config.js";
import { normalizeShown } from "../src/text.js";
import type { AgentContext, Letter, TranscriptEntry } from "../src/types.js";

const PROMPT = "What's the worst part of your commute today?";
const ANSWER_BUDGET_MS = ANSWER_MS - AGENT_MARGIN_MS; // 42 000
const VOTE_BUDGET_MS = VOTE_MS - AGENT_MARGIN_MS; // 57 000

const AGENTS: Letter[] = ["A", "B", "C", "D", "E"];
const HUMAN: Letter = "F";
const IN_PLAYERS: Letter[] = [...AGENTS, HUMAN];

const transcript: TranscriptEntry[] = [
  {
    kind: "answers",
    prompt: "What did you have for breakfast?",
    answers: {
      A: "coffee thats it",
      B: "poha from a stall near the venue so good",
      C: "nothing yet waiting for the free lunch",
      D: "two eggs and toast",
      E: "vada pav obviously",
      F: "idli and way too much chai",
    },
  },
  {
    kind: "answers",
    prompt: "What's your phone battery at?",
    answers: {
      A: "14 dont ask",
      B: "62 i think",
      C: "100 charged on the train",
      D: "it is at 48 percent",
      E: "dying yaar 9",
      F: "23 and no charger",
    },
  },
];

// Late in a game: three rounds of answers, two rounds of posts and removals. D was voted out in round 1 and
// round 2 tied, so A, B, C and E vote again with everything the screen has shown.
const LATE_IN: Letter[] = ["A", "B", "C", "E", "F"];
const lateTranscript: TranscriptEntry[] = [
  ...transcript,
  {
    kind: "answers",
    prompt: "What's 17 × 23?",
    answers: { A: "391", B: "uh 400 something", C: "no calculator no answer", D: "391", E: "too early for maths", F: "like 390ish" },
  },
  {
    kind: "posts",
    posts: [
      { letter: "A", target: "D", reason: "d types like a manual" },
      { letter: "B", target: "F", reason: "f is way too chill" },
      { letter: "C", target: "D", reason: "it is at 48 percent nobody talks like that" },
      { letter: "D", target: "C", reason: "c dodged the maths" },
      { letter: "E", target: "D", reason: "d again yaar" },
      { letter: "F", target: "D", reason: "d obviously" },
    ],
  },
  { kind: "removal", removal: { removed: "D", kind: "agent", tally: { A: 1, B: 0, C: 1, D: 8, E: 0, F: 2 } } },
  {
    kind: "answers",
    prompt: "Describe the worst part of your commute today.",
    answers: { A: "the auto meter", B: "train was packed but fun", C: "sea link toll", E: "bandra signal 20 mins", F: "uber cancelled twice" },
  },
  {
    kind: "answers",
    prompt: "Answer in one word: Mumbai traffic.",
    answers: { A: "no", B: "chaos", C: "eternal", E: "yaar", F: "honking" },
  },
  {
    kind: "answers",
    prompt: "What does this room smell like?",
    answers: { A: "burnt coffee", B: "new swag tshirts", C: "carpet", E: "samosa from the stall", F: "ac and sweat" },
  },
  {
    kind: "posts",
    posts: [
      { letter: "A", target: "B", reason: "b is too excited for a human" },
      { letter: "B", target: "C", reason: "c too short" },
      { letter: "C", target: "F", reason: "f feels real" },
      { letter: "E", target: "A", reason: "a is grumpy like a bot" },
      { letter: "F", target: "E", reason: "e says yaar too much" },
    ],
  },
  { kind: "removal", removal: { removed: null, kind: null, tally: { A: 3, B: 2, C: 3, D: 0, E: 2, F: 2 } } },
  {
    kind: "answers",
    prompt: "What would you do with 1 ETH right now?",
    answers: { A: "pay rent", B: "buy everyone chai", C: "hold", E: "lose it on gas", F: "flight home" },
  },
  {
    kind: "answers",
    prompt: "What's the last thing that made you laugh?",
    answers: { A: "my own code", B: "the guy who fell asleep in the keynote", C: "a meme", E: "venue wifi", F: "my friend missing his stop" },
  },
  {
    kind: "answers",
    prompt: "Which talk today would you skip, and why?",
    answers: { A: "all of them", B: "none theyre all great", C: "the one before lunch", E: "anything with zk in the title", F: "the 9am one obviously" },
  },
];

function contextFor(letter: Letter, personaIndex: number, prompt?: string): AgentContext {
  return { letter, personaIndex, inPlayers: IN_PLAYERS, transcript: [...transcript], prompt };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

function describeCall(r: CallReport): string {
  return `attempt ${r.attempt} ${r.ms} ms ${r.error ? `error ${r.error}` : `stop_reason ${r.stopReason}`}`;
}

// One brain per letter, so each call's report can be printed under the agent that made it.
const reports = new Map<Letter, CallReport[]>();
const brains = new Map<Letter, ClaudeBrain>(
  AGENTS.map((letter) => [letter, new ClaudeBrain({ onCall: (r) => reports.get(letter)!.push(r) })]),
);
function brain(letter: Letter): ClaudeBrain {
  reports.set(letter, []);
  return brains.get(letter)!;
}
function callsOf(letter: Letter): string {
  return reports.get(letter)!.map(describeCall).join("; ");
}

let failed = false;

console.log(`prompt: ${PROMPT}`);
const answers = await Promise.all(
  AGENTS.map((letter, i) => timed(() => brain(letter).answer(contextFor(letter, i, PROMPT), ANSWER_BUDGET_MS))),
);
const shown: Partial<Record<Letter, string>> = { [HUMAN]: "auto guy took the long way round again" };
answers.forEach(({ value, ms }, i) => {
  const letter = AGENTS[i]!;
  if (value === "") failed = true;
  shown[letter] = normalizeShown(value);
  console.log(`${letter} (persona ${i}, ${ms} ms): ${shown[letter]}`);
  console.log(`   calls: ${callsOf(letter)}`);
});
transcript.push({ kind: "answers", prompt: PROMPT, answers: shown });

console.log("\nvotes:");
const votes = await Promise.all(AGENTS.map((letter, i) => timed(() => brain(letter).vote(contextFor(letter, i), VOTE_BUDGET_MS))));
votes.forEach(({ value, ms }, i) => {
  const letter = AGENTS[i]!;
  if (value.reason === "") failed = true;
  console.log(`${letter} (${ms} ms) votes ${value.target ?? "nobody"}: ${normalizeShown(value.reason)}`);
  console.log(`   calls: ${callsOf(letter)}`);
});

const lateAgents = AGENTS.filter((l) => LATE_IN.includes(l));
console.log(`\nlate-game votes (9 answer sets, 2 vote rounds, ${lateAgents.join(", ")} still in):`);
const lateVotes = await Promise.all(
  lateAgents.map((letter) =>
    timed(() =>
      brain(letter).vote(
        { letter, personaIndex: AGENTS.indexOf(letter), inPlayers: LATE_IN, transcript: lateTranscript },
        VOTE_BUDGET_MS,
      ),
    ),
  ),
);
lateVotes.forEach(({ value, ms }, i) => {
  const letter = lateAgents[i]!;
  if (value.reason === "" || value.target === null) failed = true;
  console.log(`${letter} (${ms} ms) votes ${value.target ?? "nobody"}: ${normalizeShown(value.reason)}`);
  console.log(`   calls: ${callsOf(letter)}`);
});

if (failed) {
  console.error("\nsmoke failed: at least one call came back empty or a late vote had no target");
  process.exit(1);
}
console.log("\nsmoke ok");
