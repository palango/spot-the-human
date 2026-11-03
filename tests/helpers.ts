import type { AgentBrain, AgentContext, Letter } from "../src/types.js";

export interface ScriptedVote { target: Letter | null; reason: string }

export interface ScriptedBrainOptions {
  /** Answer per agent letter; unlisted letters answer `agent <letter>`. */
  answers?: Partial<Record<Letter, string>>;
  /** Vote per agent letter; unlisted letters post no target. */
  votes?: Partial<Record<Letter, ScriptedVote>>;
  /** Settle after this many ms, for every letter or per letter. Uses setTimeout, so fake timers apply. */
  delayMs?: number | Partial<Record<Letter, number>>;
  /** Calls never settle. */
  neverResolve?: boolean;
  /** Calls reject instead of resolving. */
  fail?: boolean;
}

export interface BrainCall { ctx: AgentContext; budgetMs: number }

/** An AgentBrain that returns configured results and records every call. Options are read at call time. */
export class ScriptedBrain implements AgentBrain {
  readonly answerCalls: BrainCall[] = [];
  readonly voteCalls: BrainCall[] = [];

  constructor(public opts: ScriptedBrainOptions = {}) {}

  answer(ctx: AgentContext, budgetMs: number): Promise<string> {
    this.answerCalls.push({ ctx, budgetMs });
    return this.settle(ctx.letter, this.opts.answers?.[ctx.letter] ?? `agent ${ctx.letter}`);
  }

  vote(ctx: AgentContext, budgetMs: number): Promise<ScriptedVote> {
    this.voteCalls.push({ ctx, budgetMs });
    return this.settle(ctx.letter, this.opts.votes?.[ctx.letter] ?? { target: null, reason: `agent ${ctx.letter} pass` });
  }

  private settle<T>(letter: Letter, value: T): Promise<T> {
    if (this.opts.neverResolve) return new Promise(() => {});
    const { delayMs, fail } = this.opts;
    const delay = typeof delayMs === "number" ? delayMs : (delayMs?.[letter] ?? 0);
    return new Promise((resolve, reject) => {
      const finish = () => (fail ? reject(new Error("scripted brain failure")) : resolve(value));
      if (delay > 0) setTimeout(finish, delay);
      else finish();
    });
  }
}

/** Deterministic random source (mulberry32) for repeatable shuffles. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
