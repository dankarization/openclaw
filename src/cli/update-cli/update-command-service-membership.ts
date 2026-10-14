import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV, isGatewayServiceEnv } from "../../daemon/constants.js";
import { inspectSelfAndAncestorPidsSync } from "../../infra/restart-stale-pids.js";
import { isCurrentManagedServiceUpdateHandoffProcess } from "../../infra/update-managed-service-handoff-current.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { gatewayServiceMembershipBlock } from "./update-command-handoff.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";

export async function mutableUpdateGatewayServiceBlock(params: {
  preManagedServiceStop: PreManagedServiceStop | undefined;
  root: string;
  runId?: string;
}) {
  const stopState = params.preManagedServiceStop;
  const ancestry = inspectSelfAndAncestorPidsSync(undefined, { requireVerifiedParent: true });
  const inheritedPid = isGatewayServiceEnv(process.env)
    ? parseStrictPositiveInteger(process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV] ?? "")
    : undefined;
  // Another service's stopped state cannot authorize replacing the caller's Gateway.
  const block =
    (inheritedPid && (ancestry.pids.has(inheritedPid) || isPidAlive(inheritedPid))
      ? gatewayServiceMembershipBlock(
          inheritedPid,
          ancestry,
          inheritedPid === stopState?.servicePid ? stopState.serviceControlGroup : undefined,
        )
      : undefined) ??
    (stopState?.running && !stopState.stopped
      ? gatewayServiceMembershipBlock(stopState.servicePid, ancestry, stopState.serviceControlGroup)
      : undefined);
  return block &&
    !(await isCurrentManagedServiceUpdateHandoffProcess({
      root: params.root,
      runId: params.runId,
      env: process.env,
    }))
    ? block
    : undefined;
}
