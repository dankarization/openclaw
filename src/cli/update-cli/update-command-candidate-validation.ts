import { resolveStateDir } from "../../config/paths.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateDisplayProgress } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";
import { updateRunLedgerOptions } from "./update-command-ledger.js";

export function validateUpdateCandidateWithProgress(
  params: Pick<
    Parameters<typeof validateUpdateCandidateCanary>[0],
    "root" | "config" | "snapshotTempDir"
  > & {
    env: NodeJS.ProcessEnv;
    assertCurrent: () => void;
  },
  execution: {
    packageUpdateNodeRunner?: string;
    timeoutMs?: number;
    opts: Pick<UpdateCommandOptions, "json">;
    progress: UpdateDisplayProgress;
  },
  run: UpdateCommandOptions["run"],
) {
  return validateUpdateCandidateCanary({
    ...params,
    stateDir: resolveStateDir(params.env),
    nodeRunner: execution.packageUpdateNodeRunner,
    timeoutMs: execution.timeoutMs,
    onProgress: (step) => {
      params.assertCurrent();
      if (run) {
        recordUpdateRunStep(run.runId, step, updateRunLedgerOptions(run));
      }
      defaultRuntime[execution.opts.json ? "error" : "log"](
        `${step.step}: ${step.detail ?? step.status}`,
      );
    },
    onStep: (step) => execution.progress?.onStepComplete?.({ ...step, index: 0, total: 0 }),
  });
}
