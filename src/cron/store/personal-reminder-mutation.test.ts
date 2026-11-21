import { expect, it } from "vitest";
import type { PersonalReminderIdentity } from "../../gateway/cron-creator-authority-grant.types.js";
import type { CronJobCreate, CronStoredJob, CronStoreFile } from "../types.js";
import { planCronJobMutation } from "./job-mutations.js";
import type { CronJobMutation } from "./job-mutations.types.js";

const origin: PersonalReminderIdentity = {
  profileId: "alice",
  agentId: "main",
  sessionKey: "agent:main:chat",
  sessionId: "session-1",
  lifecycleRevision: "generation-1",
  accountId: "default",
  to: "chat",
  threadId: 8,
};
const input: CronJobCreate = {
  name: "remind",
  enabled: true,
  deleteAfterRun: true,
  schedule: { kind: "at", at: "2030-01-01T00:00:00Z" },
  sessionTarget: "current",
  sessionKey: origin.sessionKey,
  agentId: "main",
  owner: { agentId: "main", sessionKey: origin.sessionKey, accountId: "default" },
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "remember", toolsAllow: [] },
  delivery: {
    mode: "announce",
    channel: "telegram",
    to: "chat",
    accountId: "default",
    threadId: 8,
  },
};
const source = {
  kind: "channel",
  version: 1,
  agentId: "main",
  sessionKey: origin.sessionKey,
  sourceRunId: "run-1",
  snapshot: {
    profileId: "alice",
    scopes: ["operator.cron"],
    reference: { version: 1, id: "channel-link" },
  },
} as NonNullable<CronStoredJob["operatorSource"]>["source"];
function mutation(): CronJobMutation {
  return {
    kind: "add",
    input,
    options: {
      captured: false,
      requiredPersonalReminder: origin,
      createdActor: { type: "human", source: "profile", id: "alice" },
      sourceConversation: {
        sessionKey: origin.sessionKey,
        sessionId: origin.sessionId,
        lifecycleRevision: origin.lifecycleRevision,
      },
      operatorSource: source,
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: origin.sessionKey,
        ownerAccountId: "default",
      },
    },
  };
}
const empty: CronStoreFile = { version: 1, jobs: [] };
const context = { nowMs: Date.parse("2029-01-01T00:00:00Z"), defaultAgentId: "main" };
it("requires the canonical mutation to retain exact personal source and owner before publishing", () => {
  const plan = planCronJobMutation(empty, mutation(), context);
  expect(plan.job?.operatorSource?.source).toEqual(source);
  expect(plan.job?.ownerProfileId).toBe("alice");
  expect(empty.jobs).toEqual([]);
  const missing = mutation();
  if (missing.kind !== "add") throw new Error("invalid fixture");
  delete missing.options.operatorSource;
  expect(() => planCronJobMutation(empty, missing, context)).toThrow(
    "Personal reminder source was not retained",
  );
  const wrong = mutation();
  if (wrong.kind !== "add" || wrong.options.operatorSource?.kind !== "channel")
    throw new Error("invalid fixture");
  wrong.options.operatorSource = {
    ...wrong.options.operatorSource,
    snapshot: { ...wrong.options.operatorSource.snapshot, profileId: "bob" },
  };
  expect(() => planCronJobMutation(empty, wrong, context)).toThrow(
    "Personal reminder source was not retained",
  );
  expect(empty.jobs).toEqual([]);
});
