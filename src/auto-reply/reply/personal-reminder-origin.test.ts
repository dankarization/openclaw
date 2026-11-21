import { describe, expect, it } from "vitest";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { resolvePersonalReminderOrigin } from "./personal-reminder-origin.js";

const operator = {
  profileId: "profile-a",
  scopes: ["operator.cron"],
  assertCurrent: () => {},
  channelRecoverySource: { reference: { version: 1, id: "link-1" } },
} as AdmittedRunOperatorAuthority;
function input() {
  return {
    fresh: true,
    provider: "telegram",
    senderId: "sender",
    accountId: "default",
    operator,
    requesterProfileId: "profile-a",
    agentId: "main",
    sessionKey: "agent:main:chat",
    sessionId: "session",
    lifecycleRevision: "rev",
    route: { channel: "telegram", to: "chat", accountId: "default", threadId: 9 },
  };
}
describe("fresh personal reminder origin", () => {
  it("captures only a current, linked, scoped human and the exact route", () => {
    expect(resolvePersonalReminderOrigin(input())).toEqual({
      profileId: "profile-a",
      agentId: "main",
      sessionKey: "agent:main:chat",
      sessionId: "session",
      lifecycleRevision: "rev",
      accountId: "default",
      to: "chat",
      threadId: 9,
    });
  });
  it.each([
    ["not fresh", { fresh: false }],
    ["other requester", { requesterProfileId: "profile-b" }],
    ["wrong account", { accountId: "other" }],
    ["missing sender", { senderId: undefined }],
    ["wrong channel", { provider: "discord" }],
    ["missing linked source", { operator: { ...operator, channelRecoverySource: undefined } }],
    ["missing scope", { operator: { ...operator, scopes: ["operator.read"] } }],
    [
      "revoked",
      {
        operator: {
          ...operator,
          assertCurrent: () => {
            throw new Error("revoked");
          },
        },
      },
    ],
    ["missing parent", { sessionKey: undefined }],
    ["missing incarnation", { sessionId: undefined }],
    [
      "inherited route",
      { route: { channel: "telegram", to: "chat", inheritedExternalRoute: true } },
    ],
  ])("rejects %s", (_name, override) => {
    expect(resolvePersonalReminderOrigin({ ...input(), ...override })).toBeUndefined();
  });
});
