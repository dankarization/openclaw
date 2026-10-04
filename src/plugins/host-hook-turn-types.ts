// Defines host hook scheduled turn payload types.
import type { PluginJsonValue } from "./host-hook-json.js";

/** Placement for context injected into the next agent turn. */
type PluginNextTurnInjectionPlacement = "prepend_context" | "append_context";

/** Plugin request to inject text into the next turn for a session. */
export type PluginNextTurnInjection = {
  sessionKey: string;
  /** Selected owner when the session key is unscoped, such as global. */
  agentId?: string;
  text: string;
  idempotencyKey?: string;
  placement?: PluginNextTurnInjectionPlacement;
  ttlMs?: number;
  metadata?: PluginJsonValue;
};

/** Stored next-turn injection after session/plugin metadata is attached. */
export type PluginNextTurnInjectionRecord = Omit<
  PluginNextTurnInjection,
  "sessionKey" | "agentId"
> & {
  id: string;
  pluginId: string;
  pluginName?: string;
  createdAt: number;
  placement: PluginNextTurnInjectionPlacement;
};

/** Why a next-turn injection request was rejected. */
export type PluginNextTurnInjectionEnqueueRejectionReason =
  | "invalid_input"
  | "capacity"
  | "session_not_found"
  | "policy_blocked"
  | "inactive"
  | "unavailable";

/** Result returned after enqueueing or deduplicating a next-turn injection. */
export type PluginNextTurnInjectionEnqueueResult =
  | {
      outcome: "enqueued";
      enqueued: true;
      id: string;
      sessionKey: string;
    }
  | {
      outcome: "duplicate";
      enqueued: false;
      id: string;
      sessionKey: string;
    }
  | {
      outcome: "rejected";
      enqueued: false;
      id: string;
      sessionKey: string;
      reason: PluginNextTurnInjectionEnqueueRejectionReason;
    };

/** Event passed to plugins before an agent turn is prepared. */
export type PluginAgentTurnPrepareEvent = {
  prompt: string;
  messages: unknown[];
  queuedInjections: PluginNextTurnInjectionRecord[];
};

/** Plugin contribution to prepend or append context for a prepared agent turn. */
export type PluginAgentTurnPrepareResult = {
  prependContext?: string;
  appendContext?: string;
};

/** Event passed to plugins that contribute heartbeat prompt context. */
export type PluginHeartbeatPromptContributionEvent = {
  sessionKey?: string;
  agentId?: string;
  heartbeatName?: string;
};

/** Plugin contribution to heartbeat prompt context. */
export type PluginHeartbeatPromptContributionResult = {
  prependContext?: string;
  appendContext?: string;
};
