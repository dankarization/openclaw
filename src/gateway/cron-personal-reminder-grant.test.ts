import { expect, it } from "vitest";
import {
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  resolveCronCreatorAuthorityGrantProvenance,
  revokeCronCreatorAuthorityRunScope,
} from "./cron-creator-authority-grant.js";

it("binds a reminder grant to its admitted profile and expires on revocation", () => {
  let current = true;
  const origin = {
    profileId: "profile-a",
    agentId: "main",
    sessionKey: "agent:main:chat",
    sessionId: "session-1",
    accountId: "default",
    to: "chat",
    threadId: 3,
  };
  const scope = createCronCreatorAuthorityRunScope(
    "run-1",
    { kind: "external", channel: "telegram" },
    undefined,
    () => current,
    { version: 1, channel: "telegram", accountId: "default", senderId: "sender" },
    undefined,
    true,
    origin,
  );
  try {
    expect(() =>
      mintCronCreatorAuthorityGrant(
        scope,
        undefined,
        undefined,
        undefined,
        "requester",
        undefined,
        "profile-b",
      ),
    ).toThrow();
    const grant = mintCronCreatorAuthorityGrant(
      scope,
      undefined,
      undefined,
      undefined,
      "requester",
      undefined,
      "profile-a",
    );
    expect(resolveCronCreatorAuthorityGrantProvenance(grant, "run-1")?.personalReminder).toEqual(
      origin,
    );
    expect(resolveCronCreatorAuthorityGrantProvenance(grant, "other-run")).toBeUndefined();
    current = false;
    expect(resolveCronCreatorAuthorityGrantProvenance(grant, "run-1")).toBeUndefined();
  } finally {
    revokeCronCreatorAuthorityRunScope(scope);
  }
});
