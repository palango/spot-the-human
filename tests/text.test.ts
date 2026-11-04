import { describe, expect, it } from "vitest";
import { normalizeShown } from "../src/text.js";

describe("normalizeShown", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeShown("Hello, World!")).toBe("hello world");
    expect(normalizeShown("  It's 391.  ")).toBe("its 391");
  });

  it("returns an ellipsis when nothing is left", () => {
    expect(normalizeShown("")).toBe("…");
    expect(normalizeShown("?!...")).toBe("…");
  });

  it("cuts to 120 characters", () => {
    expect(normalizeShown("a".repeat(200))).toHaveLength(120);
  });

  it("strips emoji, which agents never type, so they can't mark a human", () => {
    expect(normalizeShown("lol 😂😂")).toBe("lol");
    expect(normalizeShown("👍🏽 ok")).toBe("ok");
    expect(normalizeShown("🇮🇳 mumbai ❤️ chai")).toBe("mumbai chai");
    expect(normalizeShown("👨‍👩‍👧 family")).toBe("family");
    expect(normalizeShown("🙃")).toBe("…");
    expect(normalizeShown("3 chai 2 coffee")).toBe("3 chai 2 coffee");
  });

  it("strips listed symbols but keeps × and collapses spaces", () => {
    expect(normalizeShown("17 × 23 = 391")).toBe("17 × 23 391");
  });

  it("keeps letters in any script", () => {
    expect(normalizeShown("मुंबई traffic 🚗")).toBe("मुंबई traffic");
  });

  it("turns newlines into spaces", () => {
    expect(normalizeShown("line\nbreak")).toBe("line break");
  });
});
