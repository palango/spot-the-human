import { describe, expect, it } from "vitest";
import { PromptPool } from "../src/prompts.js";

const nine = () => Array.from({ length: 9 }, (_, i) => `q${i}`);

describe("PromptPool", () => {
  it("take never repeats and counts down", () => {
    const p = new PromptPool(["a", "b", "c"]);
    expect(new Set([p.take(), p.take(), p.take()]).size).toBe(3);
    expect(p.remaining).toBe(0);
    expect(() => p.take()).toThrow();
  });

  it("canStartGame needs nine unused", () => {
    const p = new PromptPool(nine());
    expect(p.canStartGame()).toBe(true);
    p.take();
    expect(p.canStartGame()).toBe(false);
  });

  it("canSkip keeps enough to finish", () => {
    const p = new PromptPool(Array.from({ length: 10 }, (_, i) => `q${i}`));
    expect(p.canSkip(9)).toBe(true);
    p.take();
    expect(p.canSkip(9)).toBe(false);
  });

  it("reset restores every prompt", () => {
    const p = new PromptPool(["a", "b", "c"]);
    p.take();
    p.take();
    p.take();
    p.reset();
    expect(p.remaining).toBe(3);
  });

  it("fromFile reads prompts.txt with 40 prompts and skips comments", () => {
    expect(PromptPool.fromFile("prompts.txt").remaining).toBe(40);
  });
});
