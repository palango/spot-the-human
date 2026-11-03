export type Letter = "A" | "B" | "C" | "D" | "E" | "F";
export type PhaseName =
  | "lobby" | "answering" | "revealed" | "voting"
  | "votePosts" | "removal" | "ended";

export interface Player {
  letter: Letter;
  kind: "agent" | "human";
  phoneId?: string;        // humans only
  personaIndex?: number;   // agents only
  out: boolean;
}

export interface PlayerPost { letter: Letter; target: Letter | null; reason: string } // reason already normalized
export interface RemovalResult { removed: Letter | null; kind: "agent" | "human" | null; tally: Record<Letter, number> }

export interface TranscriptEntry {           // what the screen has shown, in order
  kind: "answers" | "posts" | "removal";
  prompt?: string;
  answers?: Partial<Record<Letter, string>>;
  posts?: PlayerPost[];
  removal?: RemovalResult;
}

export interface AgentContext {
  letter: Letter;
  personaIndex: number;
  inPlayers: Letter[];
  transcript: TranscriptEntry[];
  prompt?: string;             // set for answer calls
}

export interface AgentBrain {
  answer(ctx: AgentContext, budgetMs: number): Promise<string>;
  vote(ctx: AgentContext, budgetMs: number): Promise<{ target: Letter | null; reason: string }>;
}
