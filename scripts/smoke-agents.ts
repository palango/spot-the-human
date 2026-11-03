// Live check of the agent brain against the Claude API: five personas answer one prompt, then vote.
// Needs credentials that `new Anthropic()` can resolve (normally ANTHROPIC_API_KEY).
import { ClaudeBrain } from "../src/agents.js";
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

function contextFor(letter: Letter, personaIndex: number, prompt?: string): AgentContext {
  return { letter, personaIndex, inPlayers: IN_PLAYERS, transcript: [...transcript], prompt };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

const brain = new ClaudeBrain();
let failed = false;

console.log(`prompt: ${PROMPT}`);
const answers = await Promise.all(
  AGENTS.map((letter, i) => timed(() => brain.answer(contextFor(letter, i, PROMPT), ANSWER_BUDGET_MS))),
);
const shown: Partial<Record<Letter, string>> = { [HUMAN]: "auto guy took the long way round again" };
answers.forEach(({ value, ms }, i) => {
  const letter = AGENTS[i]!;
  if (value === "") failed = true;
  shown[letter] = normalizeShown(value);
  console.log(`${letter} (persona ${i}, ${ms} ms): ${shown[letter]}`);
});
transcript.push({ kind: "answers", prompt: PROMPT, answers: shown });

console.log("\nvotes:");
const votes = await Promise.all(
  AGENTS.map((letter, i) => timed(() => brain.vote(contextFor(letter, i), VOTE_BUDGET_MS))),
);
votes.forEach(({ value, ms }, i) => {
  const letter = AGENTS[i]!;
  if (value.reason === "") failed = true;
  console.log(`${letter} (${ms} ms) votes ${value.target ?? "nobody"}: ${normalizeShown(value.reason)}`);
});

if (failed) {
  console.error("\nsmoke failed: at least one call came back empty");
  process.exit(1);
}
console.log("\nsmoke ok");
