import type { CronJobCreate, CronStoredJob } from "../../cron/types.js";
import { normalizeAccountId } from "../../routing/account-id.js";

export type { PersonalReminderIdentity } from "../cron-creator-authority-grant.types.js";
import type { PersonalReminderIdentity } from "../cron-creator-authority-grant.types.js";

export function matchesPersonalReminderCreate(
  job: CronJobCreate,
  origin: PersonalReminderIdentity,
): boolean {
  const d = job.delivery;
  return Boolean(
    origin.profileId &&
    origin.agentId &&
    origin.sessionKey &&
    origin.sessionId &&
    origin.to &&
    job.schedule.kind === "at" &&
    job.deleteAfterRun === true &&
    job.sessionTarget === "current" &&
    job.sessionKey === origin.sessionKey &&
    job.agentId === origin.agentId &&
    job.payload.kind === "agentTurn" &&
    job.payload.toolsAllowIsDefault !== true &&
    Array.isArray(job.payload.toolsAllow) &&
    job.payload.toolsAllow.length === 0 &&
    job.trigger === undefined &&
    (job.failureAlert === undefined || job.failureAlert === false) &&
    !job.declarationKey &&
    d?.mode === "announce" &&
    d.channel === "telegram" &&
    d.to === origin.to &&
    normalizeAccountId(d.accountId) === normalizeAccountId(origin.accountId) &&
    String(d.threadId ?? "") === String(origin.threadId ?? "") &&
    !d.target &&
    !d.completionDestination &&
    !d.failureDestination,
  );
}

/** Match the recorded human and route; this never grants execution authority. */
export function matchesPersonalReminderOwner(
  job: CronStoredJob,
  origin: PersonalReminderIdentity,
): boolean {
  const actor = job.createdActor;
  const policy = job.scheduledToolPolicy;
  return Boolean(
    origin.profileId &&
    job.ownerProfileId === origin.profileId &&
    actor?.type === "human" &&
    actor.source === "profile" &&
    actor.id === origin.profileId &&
    job.owner?.sessionKey === origin.sessionKey &&
    job.owner?.accountId &&
    normalizeAccountId(job.owner.accountId) === normalizeAccountId(origin.accountId) &&
    policy?.mode === "account" &&
    policy.ownerSessionKey === origin.sessionKey &&
    normalizeAccountId(policy.ownerAccountId) === normalizeAccountId(origin.accountId) &&
    (job.delivery?.mode === "announce" || job.delivery?.mode === "none") &&
    job.delivery.channel === "telegram" &&
    job.delivery.to === origin.to &&
    normalizeAccountId(job.delivery.accountId) === normalizeAccountId(origin.accountId) &&
    String(job.delivery.threadId ?? "") === String(origin.threadId ?? ""),
  );
}

/** New personal jobs require the original captured channel source at durable mutation. */
export function matchesPersonalReminderStoredSource(
  job: CronStoredJob,
  origin: PersonalReminderIdentity,
): boolean {
  const source = job.operatorSource?.source;
  return Boolean(
    matchesPersonalReminderOwner(job, origin) &&
    matchesPersonalReminderCreate(job, origin) &&
    source?.kind === "channel" &&
    source.snapshot.profileId === origin.profileId &&
    source.sessionKey === origin.sessionKey &&
    source.agentId === origin.agentId &&
    job.sourceConversation?.sessionKey === origin.sessionKey &&
    job.sourceConversation.sessionId === origin.sessionId &&
    job.sourceConversation.lifecycleRevision === origin.lifecycleRevision,
  );
}
