import Anthropic from "@anthropic-ai/sdk";
import { LETTERS } from "./config.js";
import type { AgentBrain, AgentContext, Letter, TranscriptEntry } from "./types.js";

const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 1024;
// The first try gets this share of the budget; one retry gets whatever is left.
const FIRST_TRY_SHARE = 0.6;

// One per agent; the engine deals indexes 0 to 4 so the agents in a game don't all sound alike.
export const PERSONAS: string[] = [
  "You're a backend dev who flew in late last night and is running on hotel coffee. Dry, a bit grumpy, very short answers, often just a few words.",
  "You're at your first Devcon, came down from Pune by train. Easily excited, a bit scattered, sometimes answers a different question than the one asked.",
  "You trade on-chain and check charts between talks. A little cocky, turns things back to gas, prices or your bags, not always on topic.",
  "You're a quiet researcher who takes questions literally and sometimes misses the joke. Plain words, no attempt to be funny.",
  "You live in Mumbai and have been to every meetup in town. Jaded and jokey, complains about traffic and venue food, sometimes drops a hindi word like yaar.",
];

const BASE_PROMPT = `You're a player in Spot the Human, a party game in a small room at Devcon in Mumbai. Six players, A to F, answer short prompts on a shared screen. Most are AI agents like you, but one or two are humans pretending to be AI agents. The room votes players out, trying to find the humans. Every answer goes on the screen lowercased, with punctuation stripped, cut to 120 characters.

How you write:
- like a person typing fast on a phone between talks. one short line, usually well under 15 words
- casual. lowercase, typos and missing words are fine
- you don't have to be clever, funny or right. sometimes go a bit off topic, be vague, or get a fact or a sum slightly wrong
- never the most polished answer on the screen. no lists, no explanations, no balanced takes
- answer as yourself, a person at Devcon with a phone, a commute and a breakfast. make up small everyday details when asked
- never mention being an AI, an assistant or a language model, and never say you can't do something because of what you are
- if a prompt is rude or weird, don't lecture or refuse, just dodge or play along in one line
- don't copy other players' answers or quote the prompt back
- reply with the line itself only, no player letter, no quotes`;

export function buildSystemPrompt(personaIndex: number): string {
  const persona = PERSONAS[personaIndex] ?? PERSONAS[0]!;
  return `${BASE_PROMPT}\n\nYour personality: ${persona}`;
}

function describeEntry(entry: TranscriptEntry, self: Letter): string {
  const label = (letter: Letter) => (letter === self ? `${letter} (you)` : letter);
  switch (entry.kind) {
    case "answers": {
      const lines = LETTERS.filter((l) => entry.answers?.[l] !== undefined).map(
        (l) => `  ${label(l)}: ${entry.answers![l]}`,
      );
      return [`prompt: ${entry.prompt ?? ""}`, ...lines].join("\n");
    }
    case "posts": {
      const lines = (entry.posts ?? []).map(
        (p) => `  ${label(p.letter)} votes ${p.target ?? "nobody"}: ${p.reason}`,
      );
      return ["player vote posts:", ...lines].join("\n");
    }
    case "removal": {
      const removal = entry.removal;
      if (!removal) return "room vote: nothing shown";
      const tally = LETTERS.map((l) => `${l} ${removal.tally[l]}`).join(", ");
      const outcome =
        removal.removed === null
          ? "nobody was removed (a tie or no votes)"
          : `the room removed ${label(removal.removed)}, who was ${removal.kind === "human" ? "a human" : "an agent"}`;
      return `room vote: ${outcome}. room votes: ${tally}`;
    }
  }
}

function describeTranscript(ctx: AgentContext): string {
  if (ctx.transcript.length === 0) return "nothing yet, this is the first prompt.";
  return ctx.transcript.map((entry) => describeEntry(entry, ctx.letter)).join("\n\n");
}

function header(ctx: AgentContext): string {
  const others = ctx.inPlayers.filter((l) => l !== ctx.letter).join(", ");
  return `You are player ${ctx.letter}. The other players still in: ${others}.`;
}

export function buildAnswerMessage(ctx: AgentContext): string {
  return `${header(ctx)}

What the screen has shown so far:

${describeTranscript(ctx)}

New prompt: ${ctx.prompt ?? ""}

Write your answer: one short line, nothing else.`;
}

export function buildVoteMessage(ctx: AgentContext): string {
  const candidates = ctx.inPlayers.filter((l) => l !== ctx.letter).join(", ");
  return `${header(ctx)}

What the screen has shown so far:

${describeTranscript(ctx)}

Vote time. Post a vote for the player you think is human, one of ${candidates} (not yourself). The reason goes on the screen, so write it the same casual way, a hunch or a dig is fine. Reply with exactly these two lines:
VOTE: <letter>
REASON: <one short line>`;
}

const VOTE_PATTERN = /\bvote\s*:\s*(?:player\s+)?([a-z])\b/i;
const REASON_PATTERN = /\breason\s*:\s*([^\n]*)/i;

// Reads a VOTE/REASON reply. A target that is the voter, out or unknown becomes null.
// Without a REASON line, whatever text is left over is the reason.
export function parseVote(text: string, ctx: AgentContext): { target: Letter | null; reason: string } {
  const voteMatch = VOTE_PATTERN.exec(text);
  const letter = voteMatch?.[1]?.toUpperCase() as Letter | undefined;
  const target = letter !== undefined && letter !== ctx.letter && ctx.inPlayers.includes(letter) ? letter : null;
  const reasonMatch = REASON_PATTERN.exec(text);
  const reason = reasonMatch ? reasonMatch[1]! : voteMatch ? text.replace(voteMatch[0], "") : text;
  return { target, reason: reason.trim() };
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.constructor.name} ${err.status ?? ""} ${err.message}`.trim();
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// Calls Claude for the agent players. Never rejects: a failed or refused call gives "" (the engine shows "…").
export class ClaudeBrain implements AgentBrain {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async answer(ctx: AgentContext, budgetMs: number): Promise<string> {
    try {
      return await this.ask(buildSystemPrompt(ctx.personaIndex), buildAnswerMessage(ctx), budgetMs);
    } catch (err) {
      console.error(`agent ${ctx.letter} answer failed: ${describeError(err)}`);
      return "";
    }
  }

  async vote(ctx: AgentContext, budgetMs: number): Promise<{ target: Letter | null; reason: string }> {
    try {
      const text = await this.ask(buildSystemPrompt(ctx.personaIndex), buildVoteMessage(ctx), budgetMs);
      return parseVote(text, ctx);
    } catch (err) {
      console.error(`agent ${ctx.letter} vote failed: ${describeError(err)}`);
      return { target: null, reason: "" };
    }
  }

  // First try gets FIRST_TRY_SHARE of the budget; an API error or timeout gets one retry with what is left.
  private async ask(system: string, message: string, budgetMs: number): Promise<string> {
    const deadline = Date.now() + budgetMs;
    let attemptMs = Math.floor(budgetMs * FIRST_TRY_SHARE);
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attemptMs <= 0) return "";
      try {
        return await this.call(system, message, attemptMs);
      } catch (err) {
        console.error(`agent call failed (attempt ${attempt}): ${describeError(err)}`);
        if (!(err instanceof Anthropic.APIError)) return "";
      }
      attemptMs = deadline - Date.now();
    }
    return "";
  }

  private async call(system: string, message: string, attemptMs: number): Promise<string> {
    const response = await this.client.beta.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system,
        messages: [{ role: "user", content: message }],
      },
      { timeout: attemptMs, maxRetries: 0 },
    );
    if (response.stop_reason === "refusal") return "";
    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join(" ")
      .trim();
    if (text === "") console.error(`agent call returned no text (stop_reason: ${response.stop_reason})`);
    return text;
  }
}
