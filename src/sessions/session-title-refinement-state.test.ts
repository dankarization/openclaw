import { describe, expect, it } from "vitest";
import {
  countTitleRefinementMessage,
  resolveSessionTitleRefineConfig,
  SESSION_TITLE_REFINE_AFTER_MESSAGES_DEFAULT,
  shouldRunTitleRefinement,
  type SessionTitleRefinementState,
} from "./session-title-refinement-state.js";

const SID = "sess-1";

describe("resolveSessionTitleRefineConfig", () => {
  it("is opt-in: disabled by default", () => {
    expect(resolveSessionTitleRefineConfig({}).enabled).toBe(false);
    expect(resolveSessionTitleRefineConfig({ cfgSession: {} }).enabled).toBe(false);
  });

  it("enables only on explicit refine=true", () => {
    expect(
      resolveSessionTitleRefineConfig({ cfgSession: { autoTitle: { refine: true } } }).enabled,
    ).toBe(true);
    expect(
      resolveSessionTitleRefineConfig({ cfgSession: { autoTitle: { refine: false } } }).enabled,
    ).toBe(false);
  });

  it("uses default threshold and clamps invalid values out of 1..100", () => {
    const cfg = (after: number | undefined) =>
      resolveSessionTitleRefineConfig({
        cfgSession: { autoTitle: { refine: true, refineAfterMessages: after } },
      });
    expect(cfg(undefined).afterMessages).toBe(SESSION_TITLE_REFINE_AFTER_MESSAGES_DEFAULT);
    expect(cfg(0).afterMessages).toBe(SESSION_TITLE_REFINE_AFTER_MESSAGES_DEFAULT);
    expect(cfg(101).afterMessages).toBe(SESSION_TITLE_REFINE_AFTER_MESSAGES_DEFAULT);
    expect(cfg(3.5 as unknown as number).afterMessages).toBe(
      SESSION_TITLE_REFINE_AFTER_MESSAGES_DEFAULT,
    );
    expect(cfg(10).afterMessages).toBe(10);
  });
});

describe("countTitleRefinementMessage", () => {
  it("starts at 1 without prior state", () => {
    expect(countTitleRefinementMessage(undefined, SID)).toEqual({
      taskMessagesSinceTitle: 1,
      refinementDone: false,
      sessionId: SID,
    });
  });

  it("increments prior state", () => {
    const prior: SessionTitleRefinementState = {
      taskMessagesSinceTitle: 2,
      refinementDone: false,
      sessionId: SID,
    };
    expect(countTitleRefinementMessage(prior, SID).taskMessagesSinceTitle).toBe(3);
  });

  it("resets on sessionId change (new session after /reset)", () => {
    const prior: SessionTitleRefinementState = {
      taskMessagesSinceTitle: 5,
      refinementDone: false,
      sessionId: "old-session",
    };
    expect(countTitleRefinementMessage(prior, SID)).toEqual({
      taskMessagesSinceTitle: 1,
      refinementDone: false,
      sessionId: SID,
    });
  });
});

describe("shouldRunTitleRefinement", () => {
  const state = (over: Partial<SessionTitleRefinementState>): SessionTitleRefinementState => ({
    taskMessagesSinceTitle: 6,
    refinementDone: false,
    sessionId: SID,
    ...over,
  });

  it("does not run without state or before threshold", () => {
    expect(shouldRunTitleRefinement({ state: undefined, sessionId: SID, afterMessages: 6 })).toBe(
      false,
    );
    expect(
      shouldRunTitleRefinement({
        state: state({ taskMessagesSinceTitle: 5 }),
        sessionId: SID,
        afterMessages: 6,
      }),
    ).toBe(false);
  });

  it("runs exactly at threshold", () => {
    expect(shouldRunTitleRefinement({ state: state(), sessionId: SID, afterMessages: 6 })).toBe(
      true,
    );
  });

  it("never runs twice (exactly-once)", () => {
    expect(
      shouldRunTitleRefinement({
        state: state({ refinementDone: true }),
        sessionId: SID,
        afterMessages: 6,
      }),
    ).toBe(false);
  });

  it("does not run across a session reset (stale state guard)", () => {
    expect(
      shouldRunTitleRefinement({
        state: state({ sessionId: "old-session" }),
        sessionId: SID,
        afterMessages: 6,
      }),
    ).toBe(false);
  });
});
