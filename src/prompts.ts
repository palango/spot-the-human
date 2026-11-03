import { readFileSync } from "node:fs";

const MIN_PROMPTS = 9;

/** Draws prompts at random without repeats until reset. */
export class PromptPool {
  private unused: string[];

  constructor(private readonly prompts: string[]) {
    this.unused = [...prompts];
  }

  /** Loads one prompt per line; blank lines and lines starting with # are ignored. */
  static fromFile(path: string): PromptPool {
    const prompts = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    if (prompts.length < MIN_PROMPTS) {
      throw new Error(`${path} has ${prompts.length} prompts, need at least ${MIN_PROMPTS}`);
    }
    return new PromptPool(prompts);
  }

  get remaining(): number {
    return this.unused.length;
  }

  take(): string {
    if (this.unused.length === 0) throw new Error("no prompts left");
    const i = Math.floor(Math.random() * this.unused.length);
    return this.unused.splice(i, 1)[0]!;
  }

  canStartGame(): boolean {
    return this.remaining >= MIN_PROMPTS;
  }

  /** True if skipping still leaves enough prompts to finish the game. */
  canSkip(promptsStillNeeded: number): boolean {
    return this.remaining >= promptsStillNeeded;
  }

  /** Marks every prompt unused again. */
  reset(): void {
    this.unused = [...this.prompts];
  }
}
