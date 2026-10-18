import {
  finiteSecondsToTimerSafeMilliseconds,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";

const DEFAULT_TYPING_INTERVAL_SECONDS = 6;
const MAX_TYPING_INTERVAL_MS = Math.floor(MAX_TIMER_TIMEOUT_MS / 2);

export type TelegramSubagentTypingPresentation = {
  enabled: boolean;
  intervalMs: number;
};

/**
 * Same conversion as core `resolveTypingIntervalMs`. Extensions cannot import
 * that core helper; keep the numeric contract aligned with recovery typing.
 */
export function resolveConfiguredTypingIntervalMs(seconds: number | undefined): number {
  if (Number.isFinite(seconds) && (seconds ?? 0) <= 0) {
    return 0;
  }
  const intervalMs =
    finiteSecondsToTimerSafeMilliseconds(seconds ?? DEFAULT_TYPING_INTERVAL_SECONDS) ??
    DEFAULT_TYPING_INTERVAL_SECONDS * 1000;
  return Math.min(intervalMs, MAX_TYPING_INTERVAL_MS);
}

/** Requester typing policy, matching recovery typing: agent override, then defaults. */
export function resolveTelegramSubagentTypingPresentation(params: {
  config: OpenClawConfig;
  requesterSessionKey?: string;
}): TelegramSubagentTypingPresentation {
  let agentId: string | undefined;
  if (params.requesterSessionKey) {
    try {
      agentId = resolveAgentIdFromSessionKey(params.requesterSessionKey);
    } catch {
      agentId = undefined;
    }
  }
  const typingMode = agentId
    ? (resolveAgentConfig(params.config, agentId)?.typingMode ??
      params.config.agents?.defaults?.typingMode)
    : params.config.agents?.defaults?.typingMode;
  return {
    enabled: typingMode !== "never",
    intervalMs: resolveConfiguredTypingIntervalMs(
      params.config.agents?.defaults?.typingIntervalSeconds,
    ),
  };
}
