import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Game, Session } from "../src/game.js";
import { PromptPool } from "../src/prompts.js";
import { phoneView, screenView } from "../src/views.js";
import { ScriptedBrain } from "./helpers.js";

function setup() {
  const pool = new PromptPool(Array.from({ length: 40 }, (_, i) => `prompt ${i}`));
  const session = new Session({ brain: new ScriptedBrain(), pool, onChange: vi.fn() });
  const phones = Array.from({ length: 12 }, () => session.addPhone());
  return { session, phones };
}

function startGame() {
  const s = setup();
  s.session.start(2);
  const game = s.session.game!;
  const humans = game.players.filter((p) => p.kind === "human");
  const humanPhones = s.phones.filter((p) => humans.some((h) => h.phoneId === p.id));
  const voters = s.phones.filter((p) => !humanPhones.includes(p));
  return { ...s, game, humans, humanPhones, voters };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
async function runToDeadline(game: Game) {
  await vi.advanceTimersByTimeAsync(game.deadline! - Date.now());
}
async function playToVoting(game: Game) {
  for (let i = 0; i < 3; i++) {
    await runToDeadline(game);
    game.next();
  }
  await flush();
}

/** Every string value in the JSON that equals "human" or "agent", with the key path it sits at. */
function kindPaths(value: unknown, path = ""): string[] {
  if (value === "human" || value === "agent") return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => kindPaths(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => kindPaths(v, path ? `${path}.${k}` : k));
  }
  return [];
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("lobby", () => {
  it("has no game: phase lobby, no players, ready count from phones", () => {
    const { session, phones } = setup();
    session.setReady(phones[0]!.id, false);
    const v = screenView(session, Date.now());
    expect(v.phase).toBe("lobby");
    expect(v.players).toEqual([]);
    expect(v.readyCount).toBe(11);
    expect(v.rosterCount).toBe(11);
    expect(v.remainingMs).toBeNull();
    expect(v.promptsLeft).toBe(40);
    const p = phoneView(session, phones[0]!.id, Date.now());
    expect(p.you).toMatchObject({ inRoster: false, role: null, letter: null, ready: false, rejoinCode: phones[0]!.rejoinCode });
  });
});

describe("screenView privacy", () => {
  it("never holds a phone id or rejoin code, and shows kinds only for out players or the removal", async () => {
    const { session, phones, game, voters } = startGame();
    for (let round = 1; round <= 2 && game.phase !== "ended"; round++) {
      await playToVoting(game);
      const target = game.players.find((p) => !p.out && p.kind === "human") ?? game.players[0]!;
      for (const phone of voters) game.vote(phone.id, game.phaseId, target.letter, "sus");
      game.closeVote();
      game.next();
      const json = JSON.stringify(screenView(session, Date.now()));
      for (const phone of phones) {
        expect(json).not.toContain(phone.id);
        expect(json).not.toContain(phone.rejoinCode);
      }
      const view = screenView(session, Date.now());
      const paths = kindPaths(view);
      const allowed = view.players.flatMap((p, i) => (p.out ? [`players[${i}].revealedKind`] : []));
      if (view.removal?.kind) allowed.push("removal.kind");
      expect(paths.sort()).toEqual(allowed.sort());
      for (const p of view.players.filter((q) => !q.out)) expect(p.revealedKind).toBeNull();
      game.next();
    }
  });

  it("hides kinds in every phase before ended", async () => {
    const { session, game } = startGame();
    const seen = new Set<string>();
    const check = () => {
      seen.add(game.phase);
      expect(kindPaths(screenView(session, Date.now()))).toEqual([]);
    };
    check();
    await runToDeadline(game);
    check();
    game.next();
    await runToDeadline(game);
    game.next();
    await runToDeadline(game);
    game.next();
    check();
    game.closeVote();
    check();
    expect([...seen]).toEqual(expect.arrayContaining(["answering", "revealed", "voting", "votePosts"]));
  });
});

describe("phoneView", () => {
  it("gives a voter their own rejoin code and no other phone's id or code, and no in-player's kind", () => {
    const { session, phones, voters } = startGame();
    const me = voters[0]!;
    const json = JSON.stringify(phoneView(session, me.id, Date.now()));
    expect(json).toContain(me.rejoinCode);
    for (const phone of phones.filter((p) => p !== me)) {
      expect(json).not.toContain(phone.id);
      expect(json).not.toContain(phone.rejoinCode);
    }
    const view = phoneView(session, me.id, Date.now());
    expect(view.you).toMatchObject({ inRoster: true, role: "voter", letter: null });
    expect(kindPaths(view)).toEqual([]);
  });

  it("tells a human their role and letter, and nothing about the other human", () => {
    const { session, humans, humanPhones, game } = startGame();
    game.draft(humanPhones[0]!.id, game.phaseId, "my draft");
    const mine = humans.find((h) => h.phoneId === humanPhones[0]!.id)!;
    const other = humans.find((h) => h !== mine)!;
    const view = phoneView(session, humanPhones[0]!.id, Date.now());
    expect(view.you).toMatchObject({ role: "human", letter: mine.letter, draft: "my draft" });
    expect(kindPaths(view)).toEqual(["you.role"]);
    expect(view.players.find((p) => p.letter === other.letter)!.revealedKind).toBeNull();
    expect(JSON.stringify(view)).not.toContain(other.phoneId!);
  });

  it("makes a removed human a voter without a letter", async () => {
    const { session, humans, humanPhones, voters, game } = startGame();
    await playToVoting(game);
    const target = humans[0]!;
    for (const phone of voters) game.vote(phone.id, game.phaseId, target.letter, "sus");
    game.closeVote();
    game.next();
    const phone = humanPhones.find((p) => p.id === target.phoneId)!;
    const view = phoneView(session, phone.id, Date.now());
    expect(view.you).toMatchObject({ role: "voter", letter: null });
    expect(view.removal).toMatchObject({ removed: target.letter, kind: "human" });
  });

  it("shows a phone only its own draft and vote", async () => {
    const { session, humanPhones, voters, game } = startGame();
    game.draft(humanPhones[1]!.id, game.phaseId, "secret");
    expect(JSON.stringify(phoneView(session, humanPhones[0]!.id, Date.now()))).not.toContain("secret");
    await playToVoting(game);
    game.vote(voters[0]!.id, game.phaseId, "A", "because");
    expect(phoneView(session, voters[0]!.id, Date.now()).you.vote).toEqual({ target: "A", reason: "because" });
    expect(phoneView(session, voters[1]!.id, Date.now()).you.vote).toEqual({ target: null, reason: "" });
    expect(phoneView(session, voters[0]!.id, Date.now()).votedCount).toBe(1);
  });

  it("marks a phone that joined mid-game as outside the roster", () => {
    const { session, game } = startGame();
    const late = session.addPhone();
    const view = phoneView(session, late.id, Date.now());
    expect(view.you).toMatchObject({ inRoster: false, role: null, letter: null });
    expect(game.roster.has(late.id)).toBe(false);
  });
});

describe("phase-dependent fields", () => {
  it("shows answers only once revealed and posts only after voting closes", async () => {
    const { session, game } = startGame();
    expect(screenView(session, Date.now()).answers).toBeNull();
    await runToDeadline(game);
    expect(game.phase).toBe("revealed");
    expect(Object.keys(screenView(session, Date.now()).answers!)).toHaveLength(6);
    game.next();
    await runToDeadline(game);
    game.next();
    await runToDeadline(game);
    game.next();
    expect(game.phase).toBe("voting");
    const voting = screenView(session, Date.now());
    expect(voting.posts).toBeNull();
    expect(voting.answers).toBeNull();
    expect(voting.removal).toBeNull();
    game.closeVote();
    expect(screenView(session, Date.now()).posts).toHaveLength(6);
    game.next();
    const removal = screenView(session, Date.now());
    expect(removal.phase).toBe("removal");
    expect(removal.posts).toHaveLength(6);
    expect(removal.removal).not.toBeNull();
    expect(removal.removal!.tally).toBeDefined();
  });

  it("shows each player still in their three answers from this round, only while voting", async () => {
    const { session, game, voters } = startGame();
    expect(screenView(session, Date.now()).roundAnswers).toBeNull();
    await playToVoting(game);
    const target = game.players.find((p) => p.kind === "agent")!;
    const round1 = screenView(session, Date.now()).roundAnswers!;
    expect(Object.keys(round1).sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
    for (const p of game.players) {
      expect(round1[p.letter]).toEqual(game.transcript.filter((e) => e.kind === "answers").map((e) => e.answers![p.letter]));
    }
    for (const phone of voters) game.vote(phone.id, game.phaseId, target.letter, "sus");
    game.closeVote();
    expect(screenView(session, Date.now()).roundAnswers).toBeNull();
    game.next();
    expect(game.removal!.removed).toBe(target.letter);
    game.next();
    await runToDeadline(game);
    game.next();
    expect(screenView(session, Date.now()).roundAnswers).toBeNull();
    await runToDeadline(game);
    game.next();
    await runToDeadline(game);
    game.next();
    expect(game.phase).toBe("voting");
    const round2 = screenView(session, Date.now()).roundAnswers!;
    expect(round2[target.letter]).toBeUndefined();
    const round2Sets = game.transcript.filter((e) => e.kind === "answers").slice(-3);
    for (const p of game.players.filter((x) => !x.out)) {
      expect(round2[p.letter]).toEqual(round2Sets.map((e) => e.answers![p.letter]));
    }
  });

  it("computes remainingMs from the deadline, floored at 0, and null when untimed", async () => {
    const { session, game } = startGame();
    const now = Date.now();
    expect(screenView(session, now).remainingMs).toBe(game.deadline! - now);
    expect(screenView(session, game.deadline! + 5000).remainingMs).toBe(0);
    await runToDeadline(game);
    expect(screenView(session, Date.now()).remainingMs).toBeNull();
  });

  it("reports vote count, roster and prompts left", async () => {
    const { session, game, voters } = startGame();
    await playToVoting(game);
    game.vote(voters[0]!.id, game.phaseId, "A", "x");
    const view = screenView(session, Date.now());
    expect(view).toMatchObject({ votedCount: 1, rosterCount: 12, readyCount: 12, promptsLeft: 37, canSkip: game.canSkip() });
    expect(view.phaseId).toBe(game.phaseId);
  });
});

describe("ended", () => {
  it("reveals every player's kind on screen and phones", async () => {
    const { session, game, voters } = startGame();
    for (let i = 0; i < 3; i++) {
      await playToVoting(game);
      game.closeVote();
      game.next();
      expect(game.removal!.removed).toBeNull();
      game.next();
    }
    expect(game.phase).toBe("ended");
    const screen = screenView(session, Date.now());
    expect(screen.winner).toBe("humans");
    expect(screen.players.every((p) => p.revealedKind !== null)).toBe(true);
    expect(screen.players.map((p) => p.revealedKind)).toEqual(game.players.map((p) => p.kind));
    const phone = phoneView(session, voters[0]!.id, Date.now());
    expect(phone.players.every((p) => p.revealedKind !== null)).toBe(true);
  });
});
