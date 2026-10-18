import { describe, expect, it } from "vitest";
import { resolveSubagentPublicPresentation } from "./public-presentation.js";

describe("resolveSubagentPublicPresentation", () => {
  it("keeps announce and thread-direct runs public", () => {
    expect(resolveSubagentPublicPresentation({ completionMode: "announce" })).toBe(true);
    expect(resolveSubagentPublicPresentation({ completionMode: "thread-direct" })).toBe(true);
  });

  it("excludes quiet and collector runs", () => {
    expect(resolveSubagentPublicPresentation({ completionMode: "quiet" })).toBe(false);
    expect(resolveSubagentPublicPresentation({ completionMode: "collector" })).toBe(false);
  });

  it("fail-closes when only a completion flag is available", () => {
    expect(resolveSubagentPublicPresentation({ expectsCompletionMessage: true })).toBe(true);
    expect(resolveSubagentPublicPresentation({ expectsCompletionMessage: false })).toBe(false);
    expect(resolveSubagentPublicPresentation({})).toBe(false);
  });
});
