import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Game, Session, type HumanCount, type PhoneRecord } from "../src/game.js";
import { PromptPool } from "../src/prompts.js";
import type { Letter, Player } from "../src/types.js";
import { ScriptedBrain, seededRandom } from "./helpers.js";

const LETTERS: Letter[] = ["A", "B", "C", "D", "E", "F"];

interface SetupOptions {
  phones?: number;
  prompts?: number;
  brain?: ScriptedBrain;
  random?: () => number;
  durations?: { answerMs: number; voteMs: number; extendMs: number; agentMarginMs: number };
}

function setup(opts: SetupOptions = {}) {
  const brain = opts.brain ?? new ScriptedBrain();
  const pool = new PromptPool(Array.from({ length: opts.prompts ?? 40 }, (_, i) => `prompt ${i}`));
  const onChange = vi.fn();
  const session = new Session({ brain, pool, onChange, random: opts.random, durations: opts.durations });
  const phones = Array.from({ length: opts.phones ?? 12 }, () => session.addPhone());
  return { session, brain, pool, onChange, phones };
}

function startGame(humanCount: HumanCount = 2, opts: SetupOptions = {}) {
  const s = setup(opts);
  expect(s.session.start(humanCount)).toEqual({ ok: true });
  const game = s.session.game!;
  const humans = game.players.filter((p) => p.kind === "human");
  const agents = game.players.filter((p) => p.kind === "agent");
  const voters = s.phones.filter((phone) => !humans.some((h) => h.phoneId === phone.id));
  return { ...s, game, humans, agents, voters };
}

/** Lets settled agent promises store their results. */
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Runs the clock to the current phase's deadline. */
async function runToDeadline(game: Game) {
  await vi.advanceTimersByTimeAsync(game.deadline! - Date.now());
}

/** From the first prompt of a round to the open vote. */
async function playToVoting(game: Game) {
  for (let i = 0; i < 3; i++) {
    await runToDeadline(game);
    game.next();
  }
  await flush();
}

function voteAll(game: Game, phones: PhoneRecord[], target: Letter, reason = "sus") {
  for (const phone of phones) game.vote(phone.id, game.phaseId, target, reason);
}

/** Plays a whole round; every phone votes for `target` (or nobody votes). Ends in "removal". */
async function playRound(game: Game, phones: PhoneRecord[], target: Letter | null) {
  await playToVoting(game);
  if (target) voteAll(game, phones, target);
  game.closeVote();
  game.next();
}

function snapshot(game: Game) {
  return {
    phase: game.phase,
    phaseId: game.phaseId,
    deadline: game.deadline,
    prompt: game.prompt,
    round: game.round,
    promptInRound: game.promptInRound,
    transcript: game.transcript.length,
    removal: game.removal,
    out: game.players.map((p) => p.out),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("start", () => {
  it("deals six players with the chosen number of hidden humans", () => {
    const now = Date.now();
    const { game, humans, phones, session, onChange } = startGame(2);
    expect(game.players.map((p) => p.letter).sort()).toEqual(LETTERS);
    expect(humans).toHaveLength(2);
    expect(humans[0]!.phoneId).not.toBe(humans[1]!.phoneId);
    for (const h of humans) expect(game.roster.has(h.phoneId!)).toBe(true);
    expect(game.roster.size).toBe(12);
    expect([...game.roster].sort()).toEqual(phones.map((p) => p.id).sort());
    expect(session.phase).toBe("answering");
    expect(game.phase).toBe("answering");
    expect(game.round).toBe(1);
    expect(game.promptInRound).toBe(1);
    expect(game.prompt).toMatch(/^prompt \d+$/);
    expect(game.deadline).toBe(now + 45_000);
    expect(onChange).toHaveBeenCalled();
  });

  it("gives agents distinct personas from 0 to 4", () => {
    const { agents } = startGame(1);
    expect(agents.map((a) => a.personaIndex).sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("refuses with too few ready phones, too few prompts, or a game running", () => {
    expect(setup({ phones: 1 }).session.start(2)).toEqual({ ok: false, reason: "too-few-ready" });
    expect(setup({ prompts: 8 }).session.start(2)).toEqual({ ok: false, reason: "too-few-prompts" });
    const { session } = startGame(2);
    expect(session.start(2)).toEqual({ ok: false, reason: "not-in-lobby" });
  });

  it("deals human only to connected phones but keeps disconnected ready phones in the roster", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const pool = new PromptPool(Array.from({ length: 40 }, (_, i) => `prompt ${i}`));
      const connected = new Set<string>();
      const session = new Session({
        brain: new ScriptedBrain(),
        pool,
        onChange: vi.fn(),
        random: seededRandom(seed),
        isConnected: (id) => connected.has(id),
      });
      const phones = Array.from({ length: 4 }, () => session.addPhone());
      connected.add(phones[1]!.id);
      connected.add(phones[3]!.id);
      expect(session.start(2)).toEqual({ ok: true });
      const game = session.game!;
      const humanIds = game.players.filter((p) => p.kind === "human").map((p) => p.phoneId).sort();
      expect(humanIds).toEqual([phones[1]!.id, phones[3]!.id].sort());
      expect([...game.roster].sort()).toEqual(phones.map((p) => p.id).sort());
    }
  });

  it("refuses when fewer ready phones are connected than the human count", () => {
    const pool = new PromptPool(Array.from({ length: 40 }, (_, i) => `prompt ${i}`));
    const session = new Session({ brain: new ScriptedBrain(), pool, onChange: vi.fn(), isConnected: () => false });
    session.addPhone();
    session.addPhone();
    expect(session.start(1)).toEqual({ ok: false, reason: "too-few-ready" });
    expect(session.phase).toBe("lobby");
  });

  it("deals one or two humans at random for a random start", () => {
    const counts = new Set<number>();
    for (let seed = 1; seed <= 20; seed++) {
      const { humans } = startGame("random", { random: seededRandom(seed) });
      expect([1, 2]).toContain(humans.length);
      counts.add(humans.length);
    }
    expect(counts).toEqual(new Set([1, 2]));
  });

  it("refuses a random start with fewer than two connected ready phones, whatever the roll", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { session } = setup({ phones: 1, random: seededRandom(seed) });
      expect(session.start("random")).toEqual({ ok: false, reason: "too-few-ready" });
    }
  });

  it("picks different human letters for different seeds", () => {
    const picks = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const { humans } = startGame(2, { random: seededRandom(seed) });
      picks.add(humans.map((h) => h.letter).sort().join(""));
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it("issues rejoin codes and finds phones by them", () => {
    const { session, phones } = setup({ phones: 3 });
    for (const phone of phones) {
      expect(phone.rejoinCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
      expect(phone.ready).toBe(true);
      expect(session.phoneByRejoinCode(phone.rejoinCode)).toBe(phone);
    }
    expect(new Set(phones.map((p) => p.id)).size).toBe(3);
    expect(session.phoneByRejoinCode("ZZZZZZ")).toBeUndefined();
  });

  it("uses custom durations for timers and agent budgets", async () => {
    const now = Date.now();
    const durations = { answerMs: 1_000, voteMs: 2_000, extendMs: 500, agentMarginMs: 100 };
    const { game, brain } = startGame(2, { durations });
    expect(game.deadline).toBe(now + 1_000);
    expect(brain.answerCalls[0]!.budgetMs).toBe(900);
    game.extend();
    expect(game.deadline).toBe(now + 1_500);
    await playToVoting(game);
    expect(game.deadline).toBe(Date.now() + 2_000);
    expect(brain.voteCalls[0]!.budgetMs).toBe(1_900);
  });
});

describe("answering", () => {
  it("shows the human's last draft, normalized", async () => {
    const { game, humans } = startGame(2);
    const h = humans[0]!;
    game.draft(h.phoneId!, game.phaseId, "first try");
    game.draft(h.phoneId!, game.phaseId, "I think, 391!");
    expect(game.draftOf(h.phoneId!)).toBe("I think, 391!");
    await runToDeadline(game);
    expect(game.answers[h.letter]).toBe("i think 391");
  });

  it("ignores drafts with a stale phaseId or from phones outside the roster", async () => {
    const { game, humans, session } = startGame(2);
    const h = humans[0]!;
    game.draft(h.phoneId!, game.phaseId - 1, "stale");
    const latecomer = session.addPhone();
    game.draft(latecomer.id, game.phaseId, "latecomer");
    expect(game.draftOf(h.phoneId!)).toBe("");
    expect(game.draftOf(latecomer.id)).toBe("");
    await runToDeadline(game);
    expect(game.answers[h.letter]).toBe("…");
    expect(Object.values(game.answers)).not.toContain("latecomer");
  });

  it("reveals one answer per player still in and never a voter's draft", async () => {
    const { game, voters } = startGame(2);
    for (const v of voters) game.draft(v.id, game.phaseId, "voter secret");
    expect(game.draftOf(voters[0]!.id)).toBe("voter secret");
    await vi.advanceTimersByTimeAsync(44_999);
    expect(game.phase).toBe("answering");
    await vi.advanceTimersByTimeAsync(1);
    expect(game.phase).toBe("revealed");
    expect(game.deadline).toBeNull();
    expect(Object.keys(game.answers).sort()).toEqual(LETTERS);
    expect(Object.values(game.answers)).not.toContain("voter secret");
  });

  it("shows an ellipsis for a human with no draft and agent answers from the brain", async () => {
    const { game, humans, agents } = startGame(2);
    await runToDeadline(game);
    for (const h of humans) expect(game.answers[h.letter]).toBe("…");
    for (const a of agents) expect(game.answers[a.letter]).toBe(`agent ${a.letter.toLowerCase()}`);
  });

  it("slow agent shows ellipsis and late result is dropped", async () => {
    const slow: Letter[] = ["A", "B", "C"];
    const brain = new ScriptedBrain({ delayMs: { A: 50_000, B: 50_000, C: 50_000 } });
    const { game, agents } = startGame(2, { brain });
    expect(brain.answerCalls).toHaveLength(4);
    for (const call of brain.answerCalls) expect(call.budgetMs).toBe(42_000);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(game.phase).toBe("revealed");
    for (const a of agents) {
      expect(game.answers[a.letter]).toBe(slow.includes(a.letter) ? "…" : `agent ${a.letter.toLowerCase()}`);
    }
    expect(agents.some((a) => slow.includes(a.letter))).toBe(true);
    const shown = { ...game.answers };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(game.answers).toEqual(shown);
  });

  it("a failing, silent or empty brain shows ellipses without unhandled rejections", async () => {
    const empty = {
      answers: Object.fromEntries(LETTERS.map((l) => [l, ""])),
      votes: Object.fromEntries(LETTERS.map((l) => [l, { target: null, reason: "" }])),
    };
    for (const opts of [{ fail: true }, { neverResolve: true }, empty]) {
      const { game, agents } = startGame(1, { brain: new ScriptedBrain(opts) });
      await playToVoting(game);
      for (const a of agents) expect(game.transcript[0]!.answers![a.letter]).toBe("…");
      game.closeVote();
      if (opts === empty) expect(game.phase).toBe("votePosts");
      else if ("neverResolve" in opts) await runToDeadline(game); // Close vote waits for votes that never come
      for (const a of agents) {
        expect(game.posts.find((p) => p.letter === a.letter)).toEqual({ letter: a.letter, target: null, reason: "…" });
      }
    }
  });

  it("extend during answering moves the deadline by 15 s and delays the reveal", async () => {
    const now = Date.now();
    const { game, onChange } = startGame(2);
    const id = game.phaseId;
    onChange.mockClear();
    game.extend();
    expect(game.deadline).toBe(now + 60_000);
    expect(game.phaseId).toBe(id);
    expect(onChange).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(game.phase).toBe("answering");
    await vi.advanceTimersByTimeAsync(1);
    expect(game.phase).toBe("revealed");
  });

  it("skip replaces the prompt, clears drafts and re-asks the agents", async () => {
    const { game, humans, brain } = startGame(2);
    const h = humans[0]!;
    const oldPrompt = game.prompt;
    const oldId = game.phaseId;
    game.draft(h.phoneId!, oldId, "old draft");
    await vi.advanceTimersByTimeAsync(10_000);
    game.skip();
    expect(game.prompt).not.toBe(oldPrompt);
    expect(game.phase).toBe("answering");
    expect(game.phaseId).toBe(oldId + 1);
    expect(game.deadline).toBe(Date.now() + 45_000);
    expect(game.draftOf(h.phoneId!)).toBe("");
    game.draft(h.phoneId!, oldId, "late old draft");
    expect(game.draftOf(h.phoneId!)).toBe("");
    expect(brain.answerCalls).toHaveLength(8);
    for (const call of brain.answerCalls.slice(4)) expect(call.ctx.prompt).toBe(game.prompt);
    await runToDeadline(game);
    expect(game.answers[h.letter]).toBe("…");
    expect(game.transcript).toHaveLength(1);
    expect(game.transcript[0]!.prompt).toBe(game.prompt);
  });

  it("skip drops the old prompt's agent results", async () => {
    const all = (text: string) => Object.fromEntries(LETTERS.map((l) => [l, text]));
    // The old prompt's answers arrive at 30 s, after the new prompt's answers (6 s).
    const brain = new ScriptedBrain({ delayMs: 30_000, answers: all("old") });
    const { game, agents } = startGame(2, { brain });
    await vi.advanceTimersByTimeAsync(5_000);
    brain.opts = { delayMs: 1_000, answers: all("new") };
    game.skip();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(game.phase).toBe("answering");
    await runToDeadline(game);
    for (const a of agents) expect(game.answers[a.letter]).toBe("new");
  });

  it("skip is disabled when it would leave too few prompts", () => {
    const { game, pool } = startGame(2, { prompts: 9 });
    const before = snapshot(game);
    expect(game.canSkip()).toBe(false);
    game.skip();
    expect(snapshot(game)).toEqual(before);
    expect(pool.remaining).toBe(8);
  });

  it("skip stays enabled while spare prompts remain", () => {
    const { game } = startGame(2, { prompts: 10 });
    expect(game.canSkip()).toBe(true);
    game.skip();
    expect(game.canSkip()).toBe(false);
  });

  it("appends revealed answers to the transcript", async () => {
    const { game } = startGame(2);
    const prompt = game.prompt;
    await runToDeadline(game);
    expect(game.transcript).toEqual([{ kind: "answers", round: 1, prompt, answers: game.answers }]);
    game.next();
    expect(game.promptInRound).toBe(2);
    expect(game.phase).toBe("answering");
    expect(game.answers).toEqual({});
    await runToDeadline(game);
    expect(game.transcript).toHaveLength(2);
  });
});

describe("voting", () => {
  it("opens after the third reveal and asks agents with what the screen showed", async () => {
    const { game, brain, agents } = startGame(2);
    for (let i = 0; i < 3; i++) {
      await runToDeadline(game);
      expect(game.phase).toBe("revealed");
      game.next();
    }
    expect(game.phase).toBe("voting");
    expect(game.deadline).toBe(Date.now() + 60_000);
    expect(brain.voteCalls).toHaveLength(agents.length);
    for (const call of brain.voteCalls) {
      expect(call.budgetMs).toBe(57_000);
      expect(call.ctx.transcript.filter((t) => t.kind === "answers")).toHaveLength(3);
      expect(call.ctx.transcript).toHaveLength(3);
      expect(call.ctx.inPlayers.sort()).toEqual(LETTERS);
      expect(call.ctx.prompt).toBeUndefined();
    }
    await flush();
    game.closeVote();
    expect(game.transcript).toHaveLength(4);
    expect(brain.voteCalls[0]!.ctx.transcript).toHaveLength(3);
  });

  it("a late agent vote from an earlier round is dropped", async () => {
    // Round 1 votes resolve 200 s after they were asked: round 1's vote runs to its 60 s deadline, round 2 takes
    // 3 x 45 s, so they land 5 s into round 2's vote window.
    const brain = new ScriptedBrain({ delayMs: 200_000 });
    const { game, agents } = startGame(2, { brain });
    const target = agents[0]!.letter;
    brain.opts.votes = Object.fromEntries(agents.map((a) => [a.letter, { target, reason: "stale" }]));
    await playToVoting(game);
    await runToDeadline(game);
    game.next();
    brain.opts = { neverResolve: true };
    game.next();
    await playToVoting(game);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(game.phase).toBe("voting");
    game.closeVote();
    await runToDeadline(game);
    for (const a of agents) {
      expect(game.posts.find((p) => p.letter === a.letter)).toEqual({ letter: a.letter, target: null, reason: "…" });
    }
  });

  it("vote deadline closes the vote and extend delays it", async () => {
    const { game } = startGame(2);
    await playToVoting(game);
    game.extend();
    await vi.advanceTimersByTimeAsync(74_999);
    expect(game.phase).toBe("voting");
    await vi.advanceTimersByTimeAsync(1);
    expect(game.phase).toBe("votePosts");
    expect(game.deadline).toBeNull();
  });

  it("counts one room vote per roster phone, last vote wins", async () => {
    const { game, phones, agents, session } = startGame(2);
    await playToVoting(game);
    const [x, y] = [agents[0]!.letter, agents[1]!.letter];
    game.vote(phones[0]!.id, game.phaseId, x, "first");
    game.vote(phones[0]!.id, game.phaseId, y, "changed my mind");
    game.vote(phones[1]!.id, game.phaseId, y, "same");
    game.vote(phones[2]!.id, game.phaseId - 1, x, "stale");
    game.vote(phones[3]!.id, game.phaseId, "Z" as Letter, "unknown letter");
    const latecomer = session.addPhone();
    game.vote(latecomer.id, game.phaseId, x, "not in roster");
    expect(game.votedCount()).toBe(2);
    expect(game.voteOf(phones[0]!.id)).toEqual({ target: y, reason: "changed my mind" });
    expect(game.voteOf(phones[2]!.id)).toEqual({ target: null, reason: "" });
    game.closeVote();
    game.next();
    expect(game.removal!.tally[y]).toBe(2);
    expect(game.removal!.tally[x]).toBe(0);
    for (const letter of LETTERS) expect(game.removal!.tally[letter]).toBeTypeOf("number");
  });

  it("posts one vote per player still in", async () => {
    const brain = new ScriptedBrain();
    const { game, humans, agents } = startGame(2, { brain });
    const [h1, h2] = humans as [Player, Player];
    brain.opts.votes = Object.fromEntries(agents.map((a) => [a.letter, { target: h1.letter, reason: "Way too POLISHED!!" }]));
    await playToVoting(game);
    game.vote(h1.phoneId!, game.phaseId, agents[0]!.letter, "Too slow, honestly.");
    game.closeVote();
    expect(game.phase).toBe("votePosts");
    expect(game.posts.map((p) => p.letter).sort()).toEqual(LETTERS);
    expect(game.posts.find((p) => p.letter === h1.letter)).toEqual({ letter: h1.letter, target: agents[0]!.letter, reason: "too slow honestly" });
    expect(game.posts.find((p) => p.letter === h2.letter)).toEqual({ letter: h2.letter, target: null, reason: "…" });
    for (const a of agents) {
      expect(game.posts.find((p) => p.letter === a.letter)).toEqual({ letter: a.letter, target: h1.letter, reason: "way too polished" });
    }
    expect(game.transcript.at(-1)).toEqual({ kind: "posts", posts: game.posts });
  });

  it("human self-vote counts in room but posts no target", async () => {
    const { game, humans } = startGame(2);
    const h = humans[0]!;
    await playToVoting(game);
    game.vote(h.phoneId!, game.phaseId, h.letter, "trust me");
    expect(game.votedCount()).toBe(1);
    game.closeVote();
    expect(game.posts.find((p) => p.letter === h.letter)).toEqual({ letter: h.letter, target: null, reason: "trust me" });
    game.next();
    expect(game.removal!.tally[h.letter]).toBe(1);
    expect(game.removal!.removed).toBe(h.letter);
  });

  it("an agent voting for itself, an out player or an unknown letter posts no target", async () => {
    const brain = new ScriptedBrain();
    const { game, agents, phones } = startGame(2, { brain });
    const [self, unknown, outVoter, removed] = agents as [Player, Player, Player, Player];
    brain.opts.votes = {
      [self.letter]: { target: self.letter, reason: "me" },
      [unknown.letter]: { target: "Z" as Letter, reason: "who" },
    };
    await playRound(game, phones, removed.letter);
    expect(game.posts.find((p) => p.letter === self.letter)!.target).toBeNull();
    expect(game.posts.find((p) => p.letter === unknown.letter)!.target).toBeNull();
    expect(game.removal!.removed).toBe(removed.letter);
    brain.opts.votes = { [outVoter.letter]: { target: removed.letter, reason: "ghost" } };
    game.next();
    await playToVoting(game);
    game.closeVote();
    expect(game.posts.find((p) => p.letter === outVoter.letter)).toEqual({ letter: outVoter.letter, target: null, reason: "ghost" });
    expect(game.posts.find((p) => p.letter === removed.letter)).toBeUndefined();
  });

  it("closeVote shows posts now, then next removes the top vote-getter", async () => {
    const { game, agents, phones } = startGame(2);
    const target = agents[0]!;
    await playToVoting(game);
    voteAll(game, phones.slice(0, 7), target.letter);
    voteAll(game, phones.slice(7), agents[1]!.letter);
    game.closeVote();
    expect(game.phase).toBe("votePosts");
    expect(game.removal).toBeNull();
    expect(target.out).toBe(false);
    game.next();
    expect(game.phase).toBe("removal");
    expect(target.out).toBe(true);
    expect(game.removal).toMatchObject({ removed: target.letter, kind: "agent" });
    expect(game.removal!.tally[target.letter]).toBe(7);
    expect(game.removal!.tally[agents[1]!.letter]).toBe(5);
    expect(game.transcript.at(-1)).toEqual({ kind: "removal", removal: game.removal });
  });

  it("Close vote waits for agent votes still out, then closes as soon as the last arrives", async () => {
    const { game, agents, phones } = startGame(2, { brain: new ScriptedBrain({ delayMs: 5_000 }) });
    await playToVoting(game);
    voteAll(game, phones, agents[0]!.letter);
    await vi.advanceTimersByTimeAsync(1_000);
    game.closeVote();
    expect(game.phase).toBe("voting");
    await vi.advanceTimersByTimeAsync(3_999);
    expect(game.phase).toBe("voting");
    await vi.advanceTimersByTimeAsync(1);
    expect(game.phase).toBe("votePosts");
    for (const a of agents) expect(game.posts.find((p) => p.letter === a.letter)!.reason).toBe(`agent ${a.letter.toLowerCase()} pass`);
  });

  it("Close vote counts a failed agent vote as in, and falls back to the deadline for one that never returns", async () => {
    const failing = startGame(2, { brain: new ScriptedBrain({ fail: true }) });
    await playToVoting(failing.game);
    failing.game.closeVote();
    expect(failing.game.phase).toBe("votePosts");

    const brain = new ScriptedBrain();
    const { game } = startGame(2, { brain });
    for (let i = 0; i < 2; i++) {
      await runToDeadline(game);
      game.next();
    }
    await runToDeadline(game);
    brain.opts.neverResolve = true; // only the vote calls hang
    game.next();
    expect(game.phase).toBe("voting");
    game.closeVote();
    expect(game.phase).toBe("voting");
    await runToDeadline(game);
    expect(game.phase).toBe("votePosts");
  });

  it("a tie at the top or zero votes removes nobody", async () => {
    const { game, agents, phones } = startGame(2);
    await playToVoting(game);
    voteAll(game, phones.slice(0, 6), agents[0]!.letter);
    voteAll(game, phones.slice(6), agents[1]!.letter);
    game.closeVote();
    game.next();
    expect(game.removal).toMatchObject({ removed: null, kind: null });
    expect(game.players.every((p) => !p.out)).toBe(true);

    game.next();
    await playRound(game, phones, null);
    expect(game.removal).toEqual({ removed: null, kind: null, tally: Object.fromEntries(LETTERS.map((l) => [l, 0])) });
    expect(game.players.every((p) => !p.out)).toBe(true);
  });

  it("a removed human keeps voting but is no longer shown", async () => {
    const { game, humans, phones } = startGame(2);
    const [gone, still] = humans as [Player, Player];
    await playRound(game, phones, gone.letter);
    expect(game.removal).toMatchObject({ removed: gone.letter, kind: "human" });
    game.next();
    expect(game.phase).toBe("answering");
    expect(game.roster.has(gone.phoneId!)).toBe(true);
    game.draft(gone.phoneId!, game.phaseId, "ex human secret");
    expect(game.draftOf(gone.phoneId!)).toBe("ex human secret");
    await runToDeadline(game);
    expect(game.answers[gone.letter]).toBeUndefined();
    expect(Object.keys(game.answers)).toHaveLength(5);
    expect(Object.values(game.answers)).not.toContain("ex human secret");
    game.next();
    await runToDeadline(game);
    game.next();
    await runToDeadline(game);
    game.next();
    expect(game.phase).toBe("voting");
    game.vote(gone.phoneId!, game.phaseId, still.letter, "i know who");
    expect(game.votedCount()).toBe(1);
    await flush();
    game.closeVote();
    expect(game.posts.map((p) => p.letter)).not.toContain(gone.letter);
    game.next();
    expect(game.removal!.tally[still.letter]).toBe(1);
  });

  it("rejects votes for a player already out", async () => {
    const { game, agents, phones } = startGame(2);
    await playRound(game, phones, agents[0]!.letter);
    game.next();
    await playToVoting(game);
    game.vote(phones[0]!.id, game.phaseId, agents[0]!.letter, "again");
    expect(game.votedCount()).toBe(0);
  });
});

describe("end and replay", () => {
  it("plays all three rounds after the last human is out, so the room can't count humans, and the agents win", async () => {
    const { game, humans, agents, phones } = startGame(1);
    await playRound(game, phones, humans[0]!.letter);
    expect(game.removal).toMatchObject({ removed: humans[0]!.letter, kind: "human" });
    game.next();
    expect(game.phase).toBe("answering");
    expect(game.round).toBe(2);
    await playRound(game, phones, agents[0]!.letter);
    game.next();
    expect(game.round).toBe(3);
    await playRound(game, phones, null);
    expect(game.winner).toBeNull();
    game.next();
    expect(game.phase).toBe("ended");
    expect(game.winner).toBe("agents");
    expect(game.deadline).toBeNull();
  });

  it("humans win when one is still in after the third round", async () => {
    const { game, humans, phones } = startGame(2);
    await playRound(game, phones, humans[0]!.letter);
    game.next();
    await playRound(game, phones, null);
    game.next();
    expect(game.round).toBe(3);
    await playRound(game, phones, null);
    expect(game.winner).toBeNull();
    game.next();
    expect(game.phase).toBe("ended");
    expect(game.winner).toBe("humans");
  });

  it("next after a removal starts the next round at prompt 1", async () => {
    const { game, agents, phones } = startGame(2);
    await playRound(game, phones, agents[0]!.letter);
    const now = Date.now();
    game.next();
    expect(game.phase).toBe("answering");
    expect(game.round).toBe(2);
    expect(game.promptInRound).toBe(1);
    expect(game.deadline).toBe(now + 45_000);
    expect(game.votedCount()).toBe(0);
  });

  it("newGame returns to the lobby with phones kept and prompts not reused", async () => {
    const { session, phones, pool } = startGame(2, { prompts: 18 });
    const first = session.game!;
    for (let round = 0; round < 3; round++) {
      await playRound(first, phones, null);
      first.next();
    }
    expect(first.phase).toBe("ended");
    const firstPrompts = first.transcript.filter((t) => t.kind === "answers").map((t) => t.prompt);
    const ids = phones.map((p) => [p.id, p.rejoinCode]);

    session.newGame();
    expect(session.phase).toBe("lobby");
    expect([...session.phones.values()].map((p) => [p.id, p.rejoinCode])).toEqual(ids);
    expect([...session.phones.values()].every((p) => !p.ready)).toBe(true);
    expect(session.start(2)).toEqual({ ok: false, reason: "too-few-ready" });

    for (const p of phones) session.setReady(p.id, true);
    expect(pool.remaining).toBe(9);
    expect(session.start(2)).toEqual({ ok: true });
    const second = session.game!;
    expect(second).not.toBe(first);
    for (let round = 0; round < 3; round++) {
      await playRound(second, phones, null);
      second.next();
    }
    const secondPrompts = second.transcript.filter((t) => t.kind === "answers").map((t) => t.prompt);
    expect(new Set([...firstPrompts, ...secondPrompts]).size).toBe(18);
  });

  it("drafts and votes tagged with an earlier game's phaseId are ignored", async () => {
    const { session, phones } = startGame(2);
    const first = session.game!;
    const firstAnswering = first.phaseId;
    await playToVoting(first);
    const firstVoting = first.phaseId;

    session.newGame();
    for (const p of phones) session.setReady(p.id, true);
    expect(session.start(2)).toEqual({ ok: true });
    const second = session.game!;
    expect(second.phaseId).toBeGreaterThan(firstVoting);
    const human = second.players.find((p) => p.kind === "human")!;
    second.draft(human.phoneId!, firstAnswering, "stale draft");
    expect(second.draftOf(human.phoneId!)).toBe("");
    await playToVoting(second);
    second.vote(phones[0]!.id, firstVoting, human.letter, "stale vote");
    expect(second.votedCount()).toBe(0);

    session.reset();
    const phone = session.addPhone();
    expect(session.start(1)).toEqual({ ok: true });
    expect(session.game!.phaseId).toBeGreaterThan(second.phaseId);
    session.game!.draft(phone.id, firstAnswering, "stale after reset");
    expect(session.game!.draftOf(phone.id)).toBe("");
  });

  it("newGame mid-game stops the old game's timers", async () => {
    const { session, onChange } = startGame(2);
    const old = session.game!;
    session.newGame();
    onChange.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(old.phase).toBe("answering");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("setReady only works in the lobby", () => {
    const { session, phones } = startGame(2);
    session.setReady(phones[0]!.id, false);
    expect(phones[0]!.ready).toBe(true);
  });

  it("repeated and out-of-phase host commands are no-ops", async () => {
    const { game, phones, agents } = startGame(2);
    let before = snapshot(game);
    game.next();
    game.next();
    game.closeVote();
    expect(snapshot(game)).toEqual(before);

    await runToDeadline(game);
    expect(game.phase).toBe("revealed");
    before = snapshot(game);
    game.closeVote();
    game.extend();
    game.skip();
    expect(snapshot(game)).toEqual(before);

    game.next();
    await runToDeadline(game);
    game.next();
    await runToDeadline(game);
    game.next();
    expect(game.phase).toBe("voting");
    before = snapshot(game);
    game.skip();
    game.next();
    expect(snapshot(game)).toEqual(before);

    voteAll(game, phones, agents[0]!.letter);
    await runToDeadline(game);
    expect(game.phase).toBe("votePosts");
    before = snapshot(game);
    game.closeVote();
    game.extend();
    game.skip();
    expect(snapshot(game)).toEqual(before);

    game.next();
    expect(game.phase).toBe("removal");
    before = snapshot(game);
    game.extend();
    game.closeVote();
    game.skip();
    expect(snapshot(game)).toEqual(before);
    expect(game.transcript.filter((t) => t.kind === "removal")).toHaveLength(1);
    expect(game.players.filter((p) => p.out)).toHaveLength(1);
  });

  it("a phone added during a game joins only after newGame and ready", () => {
    const { session, game } = startGame(2);
    const latecomer = session.addPhone();
    expect(latecomer.ready).toBe(false);
    expect(game.roster.has(latecomer.id)).toBe(false);
    expect(game.playerOfPhone(latecomer.id)).toBeUndefined();
    session.newGame();
    session.setReady(latecomer.id, true);
    expect(session.start(1)).toEqual({ ok: true });
    const next = session.game!;
    expect(next.roster).toEqual(new Set([latecomer.id]));
    expect(next.playerOfPhone(latecomer.id)).toMatchObject({ kind: "human", phoneId: latecomer.id });
  });

  it("reset wipes phones, the game and prompt use", () => {
    const { session, pool } = startGame(2, { prompts: 9 });
    expect(pool.remaining).toBe(8);
    session.reset();
    expect(session.phones.size).toBe(0);
    expect(session.game).toBeNull();
    expect(session.phase).toBe("lobby");
    expect(pool.remaining).toBe(9);
  });
});
