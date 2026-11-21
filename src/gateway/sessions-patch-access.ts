import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { resolveSessionCreationVisibility } from "../config/sessions/creation-visibility.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Project creation policy before explicit, separately authorized access changes. */
export function projectSessionPatchAccess(params: {
  cfg: OpenClawConfig;
  storeKey: string;
  existingEntry?: SessionEntry;
  attendedProfileOperator?: boolean;
  patch: SessionsPatchParams;
}) {
  return {
    ...(params.existingEntry === undefined
      ? resolveSessionCreationVisibility(params.cfg, params.storeKey, undefined, {
          attendedProfileOperator: params.attendedProfileOperator,
        })
      : {}),
    ...(params.patch.access ? { access: params.patch.access } : {}),
  };
}
