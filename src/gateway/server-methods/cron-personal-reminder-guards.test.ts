import { describe, expect, it } from "vitest";
import type { CronJobCreate, CronStoredJob } from "../../cron/types.js";
import { cronJobMatchesCallerScope } from "./cron-caller-scope.js";
import {
  matchesPersonalReminderCreate,
  matchesPersonalReminderOwner,
  matchesPersonalReminderStoredSource,
  type PersonalReminderIdentity,
} from "./cron-personal-reminder-guards.js";

const origin: PersonalReminderIdentity = {
  profileId: "profile-a",
  agentId: "main",
  sessionKey: "agent:main:telegram:group:1",
  sessionId: "session-1",
  lifecycleRevision: "generation-1",
  accountId: "default",
  to: "telegram:group:1",
  threadId: 12,
};

function createJob(): CronJobCreate {
  return {
    name: "Reminder",
    enabled: true,
    deleteAfterRun: true,
    schedule: { kind: "at", at: "2027-01-01T12:00:00Z" },
    sessionTarget: "current",
    sessionKey: origin.sessionKey,
    agentId: origin.agentId,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Remind me", toolsAllow: [] },
    delivery: {
      mode: "announce",
      channel: "telegram",
      to: origin.to,
      accountId: "default",
      threadId: 12,
    },
  } as CronJobCreate;
}

function ownedJob(): CronStoredJob {
  return {
    ...createJob(),
    id: "job-1",
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
    ownerProfileId: origin.profileId,
    sourceConversation: {
      sessionKey: origin.sessionKey,
      sessionId: origin.sessionId,
      lifecycleRevision: origin.lifecycleRevision,
    },
    createdActor: { type: "human", source: "profile", id: origin.profileId },
    owner: { agentId: origin.agentId, sessionKey: origin.sessionKey, accountId: "default" },
    scheduledToolPolicy: {
      version: 1,
      mode: "account",
      ownerSessionKey: origin.sessionKey,
      ownerAccountId: "default",
    },
    operatorSource: {
      source: {
        kind: "channel",
        version: 1,
        agentId: origin.agentId,
        sessionKey: origin.sessionKey,
        sourceRunId: "run-1",
        snapshot: { profileId: origin.profileId },
      },
      executionRevision: "revision",
    },
  } as unknown as CronStoredJob;
}

describe("personal reminder bounded route", () => {
  it("accepts the exact one-shot, tool-free Telegram route", () => {
    expect(matchesPersonalReminderCreate(createJob(), origin)).toBe(true);
    expect(matchesPersonalReminderOwner(ownedJob(), origin)).toBe(true);
  });
  it.each<[string, (job: CronJobCreate) => void]>([
    [
      "repeat",
      (j: CronJobCreate) => {
        j.schedule = { kind: "every", everyMs: 60_000 };
      },
    ],
    [
      "other agent",
      (j: CronJobCreate) => {
        j.agentId = "other";
      },
    ],
    [
      "other session",
      (j: CronJobCreate) => {
        j.sessionKey = "agent:main:other";
      },
    ],
    [
      "isolated target",
      (j: CronJobCreate) => {
        j.sessionTarget = "isolated";
      },
    ],
    [
      "tools",
      (j: CronJobCreate) => {
        j.payload = { kind: "agentTurn", message: "run", toolsAllow: ["exec"] };
      },
    ],
    [
      "missing explicit cap",
      (j: CronJobCreate) => {
        j.payload = { kind: "agentTurn", message: "run" };
      },
    ],
    [
      "different thread",
      (j: CronJobCreate) => {
        j.delivery!.threadId = 13;
      },
    ],
    [
      "different account",
      (j: CronJobCreate) => {
        j.delivery!.accountId = "other";
      },
    ],
    [
      "different destination",
      (j: CronJobCreate) => {
        j.delivery!.to = "telegram:group:2";
      },
    ],
    [
      "failure destination",
      (j: CronJobCreate) => {
        j.delivery!.failureDestination = { to: "other" };
      },
    ],
    [
      "completion destination",
      (j: CronJobCreate) => {
        j.delivery!.completionDestination = { mode: "webhook", to: "https://example.invalid" };
      },
    ],
    [
      "keep after run",
      (j: CronJobCreate) => {
        j.deleteAfterRun = false;
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const job = createJob();
    mutate(job);
    expect(matchesPersonalReminderCreate(job, origin)).toBe(false);
  });
  it("retains same owner management across a new incarnation of the same conversation", () => {
    expect(
      matchesPersonalReminderOwner(ownedJob(), {
        ...origin,
        sessionId: "new-session",
        lifecycleRevision: "new-generation",
      }),
    ).toBe(true);
  });
  it("preserves recorded R3 owner management without promoting sourceless execution", () => {
    const job = ownedJob();
    expect(matchesPersonalReminderOwner(job, { ...origin, profileId: "profile-b" })).toBe(false);
    delete job.operatorSource;
    expect(matchesPersonalReminderOwner(job, origin)).toBe(true);
    expect(matchesPersonalReminderStoredSource(job, origin)).toBe(false);
  });
  it("uses the bounded owner check in the actual Gateway caller-scope selector", () => {
    const job = ownedJob();
    const callerScope = {
      kind: "agentTool" as const,
      agentId: "main",
      sessionKey: origin.sessionKey,
      accountId: "default",
      personalReminder: origin,
    };
    expect(cronJobMatchesCallerScope({ job, callerScope })).toBe(true);
    expect(
      cronJobMatchesCallerScope({
        job,
        callerScope: { ...callerScope, personalReminder: { ...origin, profileId: "profile-b" } },
      }),
    ).toBe(false);
    delete job.operatorSource;
    expect(cronJobMatchesCallerScope({ job, callerScope })).toBe(true);
    expect(matchesPersonalReminderStoredSource(job, origin)).toBe(false);
  });
  it("requires source and actor to remain bound to the original identity", () => {
    const job = ownedJob();
    if (job.operatorSource?.source.kind !== "channel") throw new Error("bad test fixture");
    job.operatorSource.source.snapshot.profileId = "profile-b";
    expect(matchesPersonalReminderStoredSource(job, origin)).toBe(false);
    job.operatorSource.source.snapshot.profileId = origin.profileId;
    job.createdActor = { type: "human", source: "profile", id: "profile-b" };
    expect(matchesPersonalReminderOwner(job, origin)).toBe(false);
  });
});
