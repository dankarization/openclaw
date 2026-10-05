import { describe, expect, it, vi } from "vitest";
import { createTelegramProgressRoutingDiagnostics } from "./progress-routing-diagnostics.js";

describe("Telegram progress routing diagnostics", () => {
  it("emits one content-free info summary with callback outcomes", () => {
    const info = vi.fn();
    const diagnostics = createTelegramProgressRoutingDiagnostics({ info });
    diagnostics.noteToolStart(true);
    diagnostics.noteToolStart(false);
    diagnostics.noteItemEvent("preamble", true);
    diagnostics.noteItemEvent("preamble", false);
    diagnostics.noteItemEvent("plan", true);

    const snapshotWithPrivateFields = {
      streamMode: "progress",
      toolProgressEnabled: true,
      commentaryProgressEnabled: true,
      progressPreambleEnabled: true,
      answerStreamActive: true,
      roomEvent: false,
      allowProgressCallbacksWhenSourceDeliverySuppressed: true,
      providerPreviewAllowed: true,
      sourceRepliesAreToolOnly: false,
      accountId: "synthetic-account",
      sessionKey: "synthetic-session",
      text: "synthetic-private-text",
      args: { token: "synthetic-secret" },
    };
    diagnostics.report(snapshotWithPrivateFields);

    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith("Telegram progress routing summary", {
      streamMode: "progress",
      toolProgressEnabled: true,
      commentaryProgressEnabled: true,
      progressPreambleEnabled: true,
      answerStreamActive: true,
      roomEvent: false,
      allowProgressCallbacksWhenSourceDeliverySuppressed: true,
      providerPreviewAllowed: true,
      sourceRepliesAreToolOnly: false,
      toolStartCallbacks: 2,
      toolStartVisible: 1,
      preambleCallbacks: 2,
      preambleVisible: 1,
      otherItemCallbacks: 1,
    });
    const fields = info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(fields)).not.toContain("accountId");
    expect(Object.keys(fields)).not.toContain("sessionKey");
    expect(Object.keys(fields)).not.toContain("text");
    expect(Object.keys(fields)).not.toContain("args");
    expect(Object.keys(fields)).not.toContain("token");
    expect(Object.values(fields)).not.toContain("synthetic-account");
    expect(Object.values(fields)).not.toContain("synthetic-session");
    expect(Object.values(fields)).not.toContain("synthetic-private-text");
    expect(JSON.stringify(fields)).not.toContain("synthetic-secret");

    const failingDiagnostics = createTelegramProgressRoutingDiagnostics({
      info: () => {
        throw new Error("synthetic logger failure");
      },
    });
    expect(() => failingDiagnostics.report(snapshotWithPrivateFields)).not.toThrow();
  });
});
