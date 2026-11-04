import { randomInt, randomUUID } from "node:crypto";
import {
  AGENT_MARGIN_MS,
  ANSWER_MS,
  EXTEND_MS,
  LETTERS,
  PROMPTS_PER_ROUND,
  ROUNDS,
  VOTE_MS,
} from "./config.js";
import type { PromptPool } from "./prompts.js";
import { normalizeShown } from "./text.js";
import type {
  AgentBrain,
  AgentContext,
  Letter,
  PhaseName,
  Player,
  PlayerPost,
  RemovalResult,
  TranscriptEntry,
} from "./types.js";

export interface PhoneRecord { id: string; rejoinCode: string; ready: boolean }

/** How many hidden humans the host asks for; "random" lets the server pick one or two in secret. */
export type HumanCount = 1 | 2 | "random";

export interface Durations { answerMs: number; voteMs: number; extendMs: number; agentMarginMs: number }

const DEFAULT_DURATIONS: Durations = {
  answerMs: ANSWER_MS,
  voteMs: VOTE_MS,
  extendMs: EXTEND_MS,
  agentMarginMs: AGENT_MARGIN_MS,
};

const REJOIN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const REJOIN_LENGTH = 6;
// One persona per agent; a game has at most five agents.
const PERSONAS = [0, 1, 2, 3, 4];
const NO_POST = "…";

interface RoomVote { target: Letter; reason: string }
interface AgentVote { target: Letter | null; reason: string }

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Calls fn and turns a synchronous throw into a rejected promise. */
function settle<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

export interface SessionOptions {
  brain: AgentBrain;
  pool: PromptPool;
  random?: () => number;
  onChange: () => void;
  durations?: Durations;
  /** Whether a phone has an open connection right now. Only connected phones can be dealt human. Default: all are. */
  isConnected?: (phoneId: string) => boolean;
}

/** Everything one Devcon session holds: joined phones, the prompt pool and the current game. */
export class Session {
  readonly phones = new Map<string, PhoneRecord>();
  game: Game | null = null;
  private readonly brain: AgentBrain;
  private readonly pool: PromptPool;
  private readonly random: () => number;
  private readonly onChange: () => void;
  private readonly durations: Durations;
  private readonly isConnected: (phoneId: string) => boolean;
  // Never reset, so a phaseId from an earlier game or before a reset can never match again.
  private lastPhaseId = 0;

  constructor(opts: SessionOptions) {
    this.brain = opts.brain;
    this.pool = opts.pool;
    this.random = opts.random ?? Math.random;
    this.onChange = opts.onChange;
    this.durations = opts.durations ?? DEFAULT_DURATIONS;
    this.isConnected = opts.isConnected ?? (() => true);
  }

  get phase(): PhaseName {
    return this.game?.phase ?? "lobby";
  }

  /** Prompts not yet used this session. */
  get promptsLeft(): number {
    return this.pool.remaining;
  }

  /** Phones that join in the lobby are in the next game; phones that join mid-game wait for the next lobby. */
  addPhone(): PhoneRecord {
    const phone: PhoneRecord = { id: randomUUID(), rejoinCode: this.newRejoinCode(), ready: this.phase === "lobby" };
    this.phones.set(phone.id, phone);
    this.onChange();
    return phone;
  }

  setReady(phoneId: string, ready: boolean): void {
    const phone = this.phones.get(phoneId);
    if (this.phase !== "lobby" || !phone) return;
    phone.ready = ready;
    this.onChange();
  }

  phoneByRejoinCode(code: string): PhoneRecord | undefined {
    for (const phone of this.phones.values()) {
      if (phone.rejoinCode === code) return phone;
    }
    return undefined;
  }

  start(choice: HumanCount): { ok: true } | { ok: false; reason: "not-in-lobby" | "too-few-ready" | "too-few-prompts" } {
    if (this.phase !== "lobby") return { ok: false, reason: "not-in-lobby" };
    const ready = [...this.phones.values()].filter((p) => p.ready).map((p) => p.id);
    // A phone that locked or closed its tab still votes, but a hidden human who can't answer would show "…" all game.
    const humanCandidates = ready.filter((id) => this.isConnected(id));
    // A random start checks against the larger count before rolling, so a refusal never reveals the roll.
    if (humanCandidates.length < (choice === "random" ? 2 : choice)) return { ok: false, reason: "too-few-ready" };
    if (!this.pool.canStartGame()) return { ok: false, reason: "too-few-prompts" };
    const humanCount = choice === "random" ? (this.random() < 0.5 ? 1 : 2) : choice;
    this.game = new Game({
      brain: this.brain,
      pool: this.pool,
      random: this.random,
      onChange: this.onChange,
      durations: this.durations,
      roster: ready,
      humanPhoneIds: shuffle(humanCandidates, this.random).slice(0, humanCount),
      nextPhaseId: () => ++this.lastPhaseId,
    });
    this.game.begin();
    return { ok: true };
  }

  /** Back to the lobby; phones keep their identity but must tap in again ("Tap to join the next game"). No-op in the lobby. */
  newGame(): void {
    if (!this.game) return;
    this.game.dispose();
    this.game = null;
    for (const phone of this.phones.values()) phone.ready = false;
    this.onChange();
  }

  /** Wipes phones, the game and prompt use. */
  reset(): void {
    this.game?.dispose();
    this.game = null;
    this.phones.clear();
    this.pool.reset();
    this.onChange();
  }

  private newRejoinCode(): string {
    for (;;) {
      let code = "";
      for (let i = 0; i < REJOIN_LENGTH; i++) code += REJOIN_ALPHABET[randomInt(REJOIN_ALPHABET.length)];
      if (!this.phoneByRejoinCode(code)) return code;
    }
  }
}

export interface GameOptions {
  brain: AgentBrain;
  pool: PromptPool;
  random: () => number;
  onChange: () => void;
  durations: Durations;
  roster: string[];
  humanPhoneIds: string[];
  /** Hands out phaseIds that are unique for the whole session. */
  nextPhaseId: () => number;
}

/** One game: three rounds of three prompts and a vote. Owns every phase change and deadline. */
export class Game {
  readonly players: Player[];
  readonly roster: Set<string>;
  readonly transcript: TranscriptEntry[] = [];
  phase: PhaseName = "lobby";
  phaseId = 0;
  round = 1;
  promptInRound = 1;
  prompt: string | null = null;
  deadline: number | null = null;
  answers: Partial<Record<Letter, string>> = {};
  posts: PlayerPost[] = [];
  removal: RemovalResult | null = null;
  winner: "humans" | "agents" | null = null;

  private readonly brain: AgentBrain;
  private readonly pool: PromptPool;
  private readonly onChange: () => void;
  private readonly durations: Durations;
  private readonly nextPhaseId: () => number;
  private readonly drafts = new Map<string, string>();
  private readonly votes = new Map<string, RoomVote>();
  private readonly agentAnswers = new Map<Letter, string>();
  private readonly agentVotes = new Map<Letter, AgentVote>();
  /** Agents whose vote call has settled this vote, failed ones included. */
  private readonly agentVotesIn = new Set<Letter>();
  /** Close vote was pressed while agent votes were still out. */
  private closeRequested = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: GameOptions) {
    this.brain = opts.brain;
    this.pool = opts.pool;
    this.onChange = opts.onChange;
    this.durations = opts.durations;
    this.nextPhaseId = opts.nextPhaseId;
    this.roster = new Set(opts.roster);

    const humanLetters = shuffle(LETTERS, opts.random);
    const humanByLetter = new Map(opts.humanPhoneIds.map((phoneId, i) => [humanLetters[i]!, phoneId]));
    const personas = shuffle(PERSONAS, opts.random);
    let nextPersona = 0;
    this.players = LETTERS.map((letter): Player => {
      const phoneId = humanByLetter.get(letter);
      return phoneId
        ? { letter, kind: "human", phoneId, out: false }
        : { letter, kind: "agent", personaIndex: personas[nextPersona++]!, out: false };
    });
  }

  /** Opens the first prompt. Separate from the constructor so Session.game is set before onChange fires. */
  begin(): void {
    if (this.phase !== "lobby") return;
    this.openPrompt();
  }

  /** Stops the timer; the discarded game never changes phase again. */
  dispose(): void {
    this.clearTimer();
  }

  votedCount(): number {
    return this.votes.size;
  }

  canSkip(): boolean {
    const drawn = (this.round - 1) * PROMPTS_PER_ROUND + this.promptInRound;
    // The replacement prompt plus every prompt still to come this game.
    const stillNeeded = 1 + ROUNDS * PROMPTS_PER_ROUND - drawn;
    return this.pool.canSkip(stillNeeded);
  }

  draft(phoneId: string, phaseId: number, text: string): void {
    if (this.phase !== "answering" || phaseId !== this.phaseId || !this.roster.has(phoneId)) return;
    if (typeof text !== "string") return;
    this.drafts.set(phoneId, text);
  }

  vote(phoneId: string, phaseId: number, target: Letter, reason: string): void {
    if (this.phase !== "voting" || phaseId !== this.phaseId || !this.roster.has(phoneId)) return;
    if (typeof reason !== "string" || !this.isIn(target)) return;
    this.votes.set(phoneId, { target, reason });
    this.onChange();
  }

  next(): void {
    switch (this.phase) {
      case "revealed":
        if (this.promptInRound < PROMPTS_PER_ROUND) {
          this.promptInRound += 1;
          this.openPrompt();
        } else {
          this.enterPhase("voting", this.durations.voteMs);
        }
        return;
      case "votePosts":
        this.removeTopVoteGetter();
        return;
      case "removal":
        this.finishRound();
        return;
    }
  }

  extend(): void {
    if ((this.phase !== "answering" && this.phase !== "voting") || this.deadline === null) return;
    this.deadline += this.durations.extendMs;
    this.clearTimer();
    this.schedule(this.deadline - Date.now());
    this.onChange();
  }

  // Closing before every agent vote is back would post "…" for those agents next to the human's real post, so an
  // early close waits for the last agent vote (or the deadline, for one that never returns).
  closeVote(): void {
    if (this.phase !== "voting") return;
    if (this.allAgentVotesIn()) this.closeVoting();
    else this.closeRequested = true;
  }

  skip(): void {
    if (this.phase !== "answering" || !this.canSkip()) return;
    this.openPrompt();
  }

  draftOf(phoneId: string): string {
    return this.drafts.get(phoneId) ?? "";
  }

  voteOf(phoneId: string): { target: Letter | null; reason: string } {
    return this.votes.get(phoneId) ?? { target: null, reason: "" };
  }

  playerOfPhone(phoneId: string): Player | undefined {
    return this.players.find((p) => p.phoneId === phoneId);
  }

  private inPlayers(): Player[] {
    return this.players.filter((p) => !p.out);
  }

  private allAgentVotesIn(): boolean {
    return this.inPlayers().every((p) => p.kind !== "agent" || this.agentVotesIn.has(p.letter));
  }

  private isIn(letter: Letter): boolean {
    return this.players.some((p) => p.letter === letter && !p.out);
  }

  private openPrompt(): void {
    this.prompt = this.pool.take();
    this.enterPhase("answering", this.durations.answerMs);
  }

  private enterPhase(name: PhaseName, durationMs: number | null): void {
    this.clearTimer();
    this.phaseId = this.nextPhaseId();
    this.phase = name;
    this.deadline = durationMs === null ? null : Date.now() + durationMs;
    this.closeRequested = false;
    if (name === "answering" || name === "voting") {
      this.drafts.clear();
      this.votes.clear();
    }
    if (name === "answering") {
      this.answers = {};
      this.agentAnswers.clear();
      this.askAgentsToAnswer();
    }
    if (name === "voting") {
      this.posts = [];
      this.removal = null;
      this.agentVotes.clear();
      this.agentVotesIn.clear();
      this.askAgentsToVote();
    }
    if (durationMs !== null) this.schedule(durationMs);
    this.onChange();
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.phase === "answering") this.reveal();
      else if (this.phase === "voting") this.closeVoting();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private contextFor(agent: Player): AgentContext {
    return {
      letter: agent.letter,
      personaIndex: agent.personaIndex!,
      inPlayers: this.inPlayers().map((p) => p.letter),
      transcript: [...this.transcript],
    };
  }

  // Each call is tagged with the phaseId it was made for; results for a closed phase are dropped.
  private askAgentsToAnswer(): void {
    const phaseId = this.phaseId;
    const budgetMs = this.durations.answerMs - this.durations.agentMarginMs;
    for (const agent of this.inPlayers().filter((p) => p.kind === "agent")) {
      const ctx = { ...this.contextFor(agent), prompt: this.prompt! };
      settle(() => this.brain.answer(ctx, budgetMs)).then(
        (text) => {
          if (this.phaseId === phaseId && this.phase === "answering") this.agentAnswers.set(agent.letter, text);
        },
        () => {}, // a failed call shows as "…", like a human who typed nothing
      );
    }
  }

  private askAgentsToVote(): void {
    const phaseId = this.phaseId;
    const budgetMs = this.durations.voteMs - this.durations.agentMarginMs;
    for (const agent of this.inPlayers().filter((p) => p.kind === "agent")) {
      const ctx = this.contextFor(agent);
      const settled = (vote: AgentVote | null) => {
        if (this.phaseId !== phaseId || this.phase !== "voting") return;
        if (vote) this.agentVotes.set(agent.letter, vote);
        this.agentVotesIn.add(agent.letter);
        if (this.closeRequested && this.allAgentVotesIn()) this.closeVoting();
      };
      settle(() => this.brain.vote(ctx, budgetMs)).then(
        (vote) => settled(vote),
        () => settled(null), // a failed call posts "…"
      );
    }
  }

  private reveal(): void {
    const answers: Partial<Record<Letter, string>> = {};
    for (const p of this.inPlayers()) {
      const raw = p.kind === "human" ? this.drafts.get(p.phoneId!) : this.agentAnswers.get(p.letter);
      answers[p.letter] = normalizeShown(raw ?? "");
    }
    this.answers = answers;
    this.transcript.push({ kind: "answers", round: this.round, prompt: this.prompt!, answers: { ...answers } });
    this.enterPhase("revealed", null);
  }

  private closeVoting(): void {
    this.posts = this.inPlayers().map((p): PlayerPost => {
      const vote = p.kind === "human" ? this.votes.get(p.phoneId!) : this.agentVotes.get(p.letter);
      if (!vote) return { letter: p.letter, target: null, reason: NO_POST };
      // A player can't vote for themselves; a self, out or unknown target posts no target.
      const target = vote.target !== null && vote.target !== p.letter && this.isIn(vote.target) ? vote.target : null;
      return { letter: p.letter, target, reason: normalizeShown(vote.reason ?? "") };
    });
    this.transcript.push({ kind: "posts", posts: [...this.posts] });
    this.enterPhase("votePosts", null);
  }

  // Only room votes remove a player: the unique top vote-getter goes; a tie or no votes removes nobody.
  private removeTopVoteGetter(): void {
    const tally = Object.fromEntries(LETTERS.map((l) => [l, 0])) as Record<Letter, number>;
    for (const vote of this.votes.values()) tally[vote.target] += 1;
    const top = Math.max(...Object.values(tally));
    const leaders = LETTERS.filter((l) => tally[l] === top);
    const removed = top > 0 && leaders.length === 1 ? this.players.find((p) => p.letter === leaders[0]) : undefined;
    if (removed) removed.out = true;
    this.removal = { removed: removed?.letter ?? null, kind: removed?.kind ?? null, tally };
    this.transcript.push({ kind: "removal", removal: this.removal });
    this.enterPhase("removal", null);
  }

  // Every game plays all rounds, even after the last human is out: ending early would tell the room how many
  // humans there were.
  private finishRound(): void {
    if (this.round >= ROUNDS) {
      this.end(this.players.some((p) => p.kind === "human" && !p.out) ? "humans" : "agents");
    } else {
      this.round += 1;
      this.promptInRound = 1;
      this.openPrompt();
    }
  }

  private end(winner: "humans" | "agents"): void {
    this.winner = winner;
    this.enterPhase("ended", null);
  }
}
