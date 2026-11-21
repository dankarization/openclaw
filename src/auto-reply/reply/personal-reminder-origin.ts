import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { PersonalReminderIdentity } from "../../gateway/server-methods/cron-personal-reminder-guards.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import type { EffectiveReplyRoute } from "./effective-reply-route.js";

/** Facts from one fresh host-admitted input; this is neither a grant nor persisted authority. */
export function resolvePersonalReminderOrigin(params: {
  fresh: boolean;
  provider?: string;
  senderId?: string;
  accountId?: string;
  operator?: AdmittedRunOperatorAuthority;
  requesterProfileId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  lifecycleRevision?: string;
  route: EffectiveReplyRoute;
}): PersonalReminderIdentity | undefined {
  const { operator, route } = params;
  if (
    !params.fresh ||
    params.provider !== "telegram" ||
    route.channel !== "telegram" ||
    route.inheritedExternalRoute ||
    !params.senderId ||
    !operator?.channelRecoverySource ||
    !operator.profileId ||
    params.requesterProfileId !== operator.profileId ||
    !operatorScopeSatisfied("operator.cron", operator.scopes) ||
    !params.agentId ||
    !params.sessionKey ||
    !params.sessionId ||
    !route.to ||
    normalizeAccountId(params.accountId) !== normalizeAccountId(route.accountId)
  ) {
    return undefined;
  }
  try {
    operator.assertCurrent();
  } catch {
    return undefined;
  }
  return Object.freeze({
    profileId: operator.profileId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    ...(params.lifecycleRevision !== undefined
      ? { lifecycleRevision: params.lifecycleRevision }
      : {}),
    accountId: normalizeAccountId(route.accountId),
    to: route.to,
    ...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
  });
}
