import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type { A2aPeerConfig } from "./types.js";

/**
 * Peer-scoped outbound authorization.
 *
 * A peer without `allowedAgents` keeps the previous account-level behavior: any agent
 * that can reach the A2A channel may start a task for it. Once a peer lists agents,
 * only those agents may start a NEW task, and the decision uses the host-resolved
 * agent-scoped session key instead of tool or model arguments.
 *
 * A reply to an inbound task is not an outbound send: inbound replies complete the
 * original task in the store, so listing agents never blocks them.
 */
export function assertA2aOutboundAgentAllowed(params: {
  peerName: string;
  peer: Pick<A2aPeerConfig, "allowedAgents">;
  sessionKey?: string | null;
}): void {
  const allowed = (params.peer.allowedAgents ?? [])
    .map((entry) => normalizeAgentId(entry))
    .filter(Boolean);
  if (allowed.length === 0) {
    return;
  }
  const parsed = parseAgentSessionKey(params.sessionKey?.trim() ?? "");
  const originAgentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : undefined;
  if (originAgentId && allowed.includes(originAgentId)) {
    return;
  }
  // Fail closed: an absent or unscoped origin must not borrow a listed agent's grant.
  throw new Error(
    `A2A outbound tasks to peer ${params.peerName} are limited to ${allowed.join(", ")}; this send has no attested allowed source agent. Ask an operator to reconcile instead of retrying from an unscoped context.`,
  );
}
