import { describe, expect, it } from "vitest";
import {
  PERSONAS,
  buildAnswerMessage,
  buildSystemPrompt,
  buildVoteMessage,
  parseVote,
} from "../src/agents.js";
import type { AgentContext, TranscriptEntry } from "../src/types.js";

const ctx: AgentContext = {
  letter: "B",
  personaIndex: 0,
  inPlayers: ["A", "B", "C", "D", "F"],
  transcript: [],
  prompt: "What did you have for breakfast?",
};

const history: TranscriptEntry[] = [
  {
    kind: "answers",
    prompt: "what's 17 × 23?",
    answers: { A: "391", B: "no clue", C: "like 400", D: "391 obviously", E: "…", F: "i used a calculator" },
  },
  {
    kind: "posts",
    posts: [
      { letter: "A", target: "C", reason: "too vague" },
      { letter: "C", target: null, reason: "…" },
    ],
  },
  {
    kind: "removal",
    removal: { removed: "E", kind: "agent", tally: { A: 1, B: 0, C: 2, D: 0, E: 5, F: 0 } },
  },
];

const ctxWithHistory: AgentContext = { ...ctx, transcript: history };

describe("PERSONAS", () => {
  it("has five distinct personas", () => {
    expect(PERSONAS).toHaveLength(5);
    expect(new Set(PERSONAS).size).toBe(5);
  });
});

describe("buildSystemPrompt", () => {
  it("keeps the human count vague", () => {
    expect(buildSystemPrompt(0)).toContain("one or two");
    expect(buildSystemPrompt(0)).not.toMatch(/exactly (one|two)/);
  });

  it("adds the persona for the index", () => {
    PERSONAS.forEach((persona, i) => expect(buildSystemPrompt(i)).toContain(persona));
  });

  it("gives each persona a different prompt", () => {
    const prompts = PERSONAS.map((_, i) => buildSystemPrompt(i));
    expect(new Set(prompts).size).toBe(PERSONAS.length);
  });
});

describe("buildAnswerMessage", () => {
  it("includes the current prompt and the player's letter", () => {
    expect(buildAnswerMessage(ctx)).toContain(ctx.prompt!);
    expect(buildAnswerMessage(ctx)).toContain("player B");
  });

  it("includes earlier prompts, answers, posts and removals", () => {
    const message = buildAnswerMessage(ctxWithHistory);
    expect(message).toContain("what's 17 × 23");
    expect(message).toContain("i used a calculator");
    expect(message).toContain("too vague");
    expect(message).toMatch(/E.*agent/);
  });
});

describe("buildVoteMessage", () => {
  it("asks for the two-line vote format", () => {
    expect(buildVoteMessage(ctx)).toContain("VOTE:");
    expect(buildVoteMessage(ctx)).toContain("REASON:");
  });

  it("lists the players still in, without the voter", () => {
    const message = buildVoteMessage(ctx);
    expect(message).toContain("A, C, D, F");
    expect(message).not.toContain("A, B");
  });

  it("includes the transcript and the room vote tally", () => {
    const message = buildVoteMessage(ctxWithHistory);
    expect(message).toContain("what's 17 × 23");
    expect(message).toContain("E 5");
  });
});

describe("parseVote", () => {
  it("reads the two-line format", () => {
    expect(parseVote("VOTE: C\nREASON: too polished", ctx)).toEqual({ target: "C", reason: "too polished" });
  });

  it("is case-insensitive and allows one line", () => {
    expect(parseVote("vote: c reason: hmm", ctx)).toEqual({ target: "C", reason: "hmm" });
  });

  it("rejects the voter's own letter", () => {
    expect(parseVote("VOTE: " + ctx.letter + "\nREASON: x", ctx).target).toBeNull();
  });

  it("rejects letters not in the game", () => {
    expect(parseVote("VOTE: Z\nREASON: x", ctx).target).toBeNull();
    expect(parseVote("VOTE: E\nREASON: x", ctx).target).toBeNull(); // E is out
  });

  it("rejects words that only start with a letter", () => {
    expect(parseVote("VOTE: abstain\nREASON: x", ctx).target).toBeNull();
  });

  it("uses the whole text as the reason when there is no format", () => {
    expect(parseVote("no idea", ctx)).toEqual({ target: null, reason: "no idea" });
  });

  it("keeps the rest of the text as the reason when REASON is missing", () => {
    expect(parseVote("VOTE: D\nway too fast with the math", ctx)).toEqual({
      target: "D",
      reason: "way too fast with the math",
    });
  });

  it("returns an empty reason for empty text", () => {
    expect(parseVote("", ctx)).toEqual({ target: null, reason: "" });
  });
});
