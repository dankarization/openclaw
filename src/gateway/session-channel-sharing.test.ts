import { expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { prepareSessionSharing } from "./session-sharing-read.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

it("adds verified group reads without widening private ACLs or narrowing existing role grants", () => {
  const key = "agent:main:telegram:group:-123456";
  const entry: SessionEntry = {
    sessionId: "channel-sharing",
    updatedAt: 1,
    createdVia: "channel",
    createdActor: { type: "human", source: "channel", id: "777" },
    delivery: {
      kind: "external",
      route: { channel: "telegram", accountId: "default", target: { to: "telegram:-123456" } },
      context: {},
      origin: { provider: "telegram", chatType: "group", nativeChannelId: "-123456" },
    },
  };
  const target = {
    agentId: "main",
    canonicalKey: key,
    storeKey: key,
    storeKeys: [key],
    storePath: "/fixture",
    entry,
  };
  const client = sharingPolicyClient({ user: "viewer" });
  const prepared = {
    aliases: new Set(["viewer"]),
    sessionCap: "none" as const,
    isMember: () => false,
  };
  expect(prepareSessionSharing({ cfg: {}, client }, prepared).canReadTarget(target)).toBe(false);
  expect(
    prepareSessionSharing(
      { cfg: {}, client },
      { ...prepared, channelRead: () => false },
    ).canReadTarget(target),
  ).toBe(false);
  expect(
    prepareSessionSharing(
      { cfg: {}, client },
      { ...prepared, channelRead: () => true },
    ).canReadTarget(target),
  ).toBe(true);
  expect(
    prepareSessionSharing({ cfg: {}, client }, { ...prepared, sessionCap: "write" }).canReadTarget(
      target,
    ),
  ).toBe(true);
  // Verified channel membership cannot override a draft or incognito boundary.
  for (const restricted of [
    { ...entry, visibility: "draft" as const },
    { ...entry, incognito: true },
  ]) {
    const sharing = prepareSessionSharing(
      { cfg: {}, client },
      { ...prepared, channelRead: () => true },
    );
    expect(sharing.canReadTarget({ ...target, entry: restricted })).toBe(false);
    expect(sharing.canReadDirectTarget({ ...target, entry: restricted })).toBe(false);
  }
  const creatorDraft = {
    ...target,
    entry: {
      ...entry,
      visibility: "draft" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: "viewer" },
    },
  };
  expect(
    prepareSessionSharing({ cfg: {}, client }, prepared).canReadDirectTarget(creatorDraft),
  ).toBe(true);
  const privateTarget = { ...target, entry: { ...entry, access: { mode: "creator" as const } } };
  expect(
    prepareSessionSharing(
      { cfg: {}, client },
      { ...prepared, channelRead: () => true },
    ).canReadTarget(privateTarget),
  ).toBe(false);
  // A real Telegram group membership never widens an explicit source audience.
  const sourceTarget = { ...target, entry: { ...entry, access: { mode: "source" as const } } };
  const sourcePolicy = (profileId: string, agentId = "main") => ({
    session: {
      sharing: {
        accessPolicy: {
          default: "creator" as const,
          groups: [{ agentId, channel: "telegram", peerId: "-123456", profileIds: [profileId] }],
        },
      },
    },
  });
  expect(
    prepareSessionSharing(
      { cfg: sourcePolicy("other"), client },
      { ...prepared, channelRead: () => true },
    ).canReadTarget(sourceTarget),
  ).toBe(false);
  expect(
    prepareSessionSharing(
      { cfg: sourcePolicy("viewer"), client },
      { ...prepared, channelRead: () => true },
    ).canReadTarget(sourceTarget),
  ).toBe(true);
  // A channel-origin creator is not automatically the authenticated profile. Direct
  // target admission uses the same source audience as list admission.
  const allowedSource = prepareSessionSharing(
    { cfg: sourcePolicy("viewer"), client },
    { ...prepared, channelRead: () => true },
  );
  const deniedSource = prepareSessionSharing(
    { cfg: sourcePolicy("other"), client },
    { ...prepared, channelRead: () => true },
  );
  expect(allowedSource.isCreator(entry.createdActor)).toBe(false);
  expect(allowedSource.canReadDirectTarget(sourceTarget)).toBe(true);
  expect(deniedSource.canReadDirectTarget(sourceTarget)).toBe(false);
  const workerTarget = {
    ...sourceTarget,
    agentId: "worker",
    canonicalKey: "agent:worker:telegram:group:-123456",
    storeKey: "agent:worker:telegram:group:-123456",
    storeKeys: ["agent:worker:telegram:group:-123456"],
  };
  expect(
    prepareSessionSharing(
      { cfg: sourcePolicy("viewer", "worker"), client },
      { ...prepared, channelRead: () => true },
    ).canReadDirectTarget(workerTarget),
  ).toBe(true);
  expect(
    prepareSessionSharing(
      { cfg: sourcePolicy("viewer"), client },
      { ...prepared, channelRead: () => true },
    ).canReadDirectTarget(workerTarget),
  ).toBe(false);
});
