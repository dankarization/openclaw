import { isDeepStrictEqual } from "node:util";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionCreationVisibility } from "../../config/sessions/creation-visibility.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import type { TrustedSessionCreation } from "../session-creation-provenance.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { isAttendedControlUiSessionCreator } from "./gateway-personal-caller.js";
import { sessionChangedError } from "./sessions-patch-errors.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export function attendedPatchCreation(
  client: GatewayClient | null,
  creation: TrustedSessionCreation,
): boolean {
  return (
    isAttendedControlUiSessionCreator(client) &&
    creation.via === "operator" &&
    creation.actor?.type === "human" &&
    creation.actor.source === "profile" &&
    creation.actor.id === client?.authenticatedUserProfile?.profileId
  );
}

export function createSessionPatchDefaultAccessGuard(params: {
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  getCurrentConfig: GatewayRequestContext["getRuntimeConfig"];
  client: GatewayClient | null;
  creation: TrustedSessionCreation;
  primaryKey: string;
  key: string;
}) {
  const resolveDefault = (currentCfg: typeof params.cfg) =>
    resolveSessionCreationVisibility(currentCfg, params.primaryKey, undefined, {
      attendedProfileOperator: attendedPatchCreation(params.client, params.creation),
    }).access;
  const admittedDefault = resolveDefault(params.cfg);
  return () =>
    isDeepStrictEqual(admittedDefault, resolveDefault(params.getCurrentConfig()))
      ? undefined
      : sessionChangedError(params.key);
}

export function createSessionPatchTargetAccessCheck(params: {
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  client: GatewayClient | null;
  pluginOwnerId: string | undefined;
}) {
  return (entry: SessionEntry | undefined, agentId: string, key: string) =>
    (!entry &&
      authorizeGatewaySessionCreation({ cfg: params.cfg, client: params.client, agentId })) ||
    resolvePluginSessionOwnershipError({
      action: "patch",
      entry,
      key,
      pluginOwnerId: params.pluginOwnerId,
    });
}
