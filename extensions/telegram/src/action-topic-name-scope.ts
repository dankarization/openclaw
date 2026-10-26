import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { resolveDefaultTelegramAccountId } from "./accounts.js";
import { resolveTelegramDirectTopicNameCacheScope } from "./topic-name-cache.js";

export function resolveActionTopicNameCacheScope(
  cfg: OpenClawConfig,
  accountId?: string | null,
): string {
  const resolvedAccountId = accountId ?? resolveDefaultTelegramAccountId(cfg);
  return resolveTelegramDirectTopicNameCacheScope(
    resolveStorePath(cfg.session?.store, {
      agentId: resolveTelegramAccountOwnerAgentId({ cfg, accountId: resolvedAccountId }),
    }),
    resolvedAccountId,
  );
}
