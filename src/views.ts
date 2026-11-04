import type { Game, Session } from "./game.js";
import type { Letter, PhaseName, PlayerPost, RemovalResult } from "./types.js";

type Kind = "agent" | "human";

export interface ScreenView {
  phase: PhaseName;
  phaseId: number; // phones echo phaseId in draft and vote messages
  round: number;
  promptInRound: number;
  prompt: string | null;
  remainingMs: number | null;
  /** Empty in the lobby. revealedKind is set for out players, and for everyone once the game has ended. */
  players: { letter: Letter; out: boolean; revealedKind: Kind | null }[];
  answers: Partial<Record<Letter, string>> | null; // revealed only
  /** Screen only, while voting: each player still in, with their answers to this round's prompts in order. */
  roundAnswers: Partial<Record<Letter, string[]>> | null;
  posts: PlayerPost[] | null; // votePosts and removal only
  removal: RemovalResult | null; // removal only
  votedCount: number;
  rosterCount: number;
  readyCount: number;
  promptsLeft: number;
  canSkip: boolean;
  winner: "humans" | "agents" | null;
}

export interface PhoneView extends ScreenView {
  you: {
    inRoster: boolean;
    role: "human" | "voter" | null;
    letter: Letter | null;
    rejoinCode: string;
    ready: boolean;
    draft: string;
    vote: { target: Letter | null; reason: string };
  };
}

/** What the shared screen may show. Never holds a phone id, rejoin code or the kind of a player still in. */
export function screenView(s: Session, now: number): ScreenView {
  const game = s.game;
  const readyCount = [...s.phones.values()].filter((p) => p.ready).length;
  if (!game) {
    return {
      phase: "lobby", phaseId: 0, round: 1, promptInRound: 1, prompt: null, remainingMs: null,
      players: [], answers: null, roundAnswers: null, posts: null, removal: null,
      votedCount: 0, rosterCount: readyCount, readyCount,
      promptsLeft: s.promptsLeft, canSkip: false, winner: null,
    };
  }
  const phase = game.phase;
  return {
    phase,
    phaseId: game.phaseId,
    round: game.round,
    promptInRound: game.promptInRound,
    prompt: game.prompt,
    remainingMs: game.deadline === null ? null : Math.max(0, game.deadline - now),
    players: game.players.map((p) => ({
      letter: p.letter,
      out: p.out,
      revealedKind: p.out || phase === "ended" ? p.kind : null,
    })),
    answers: phase === "revealed" ? { ...game.answers } : null,
    roundAnswers: phase === "voting" ? roundAnswers(game) : null,
    posts: phase === "votePosts" || phase === "removal" ? [...game.posts] : null,
    removal: phase === "removal" ? game.removal : null,
    votedCount: game.votedCount(),
    rosterCount: game.roster.size,
    readyCount,
    promptsLeft: s.promptsLeft,
    canSkip: game.canSkip(),
    winner: game.winner,
  };
}

function roundAnswers(game: Game): Partial<Record<Letter, string[]>> {
  const sets = game.transcript.filter((entry) => entry.kind === "answers" && entry.round === game.round);
  const result: Partial<Record<Letter, string[]>> = {};
  for (const p of game.players) {
    if (!p.out) result[p.letter] = sets.map((entry) => entry.answers?.[p.letter] ?? "…");
  }
  return result;
}

/** The screen's view plus the one phone's own role, letter, rejoin code, draft and vote. */
export function phoneView(s: Session, phoneId: string, now: number): PhoneView {
  const phone = s.phones.get(phoneId);
  const game = s.game;
  const player = game?.playerOfPhone(phoneId);
  const inRoster = game ? game.roster.has(phoneId) : false;
  const isHumanIn = player !== undefined && !player.out;
  return {
    ...screenView(s, now),
    roundAnswers: null, // only the shared screen lists them; phones never read it
    you: {
      inRoster,
      role: !inRoster ? null : isHumanIn ? "human" : "voter",
      letter: isHumanIn ? player.letter : null,
      rejoinCode: phone?.rejoinCode ?? "",
      ready: phone?.ready ?? false,
      draft: game && inRoster ? game.draftOf(phoneId) : "",
      vote: game && inRoster ? game.voteOf(phoneId) : { target: null, reason: "" },
    },
  };
}
