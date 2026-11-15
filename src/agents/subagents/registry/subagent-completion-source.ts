import { isDeepStrictEqual } from "node:util";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentCompletionCustody } from "./subagent-registry-memory.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

/** A known registry owner/custody refusal, distinct from lookup and storage failures. */
export class SourceError extends Error {}

/** Notice publication cannot borrow the ambient caller of a legacy or cancellation-only batch. */
export function assertBatchSource(
  batch: readonly SubagentRunRecord[],
  custody: ReadonlyMap<object, SubagentCompletionCustody>,
  required: boolean | undefined,
): void {
  if (!required) {
    return;
  }
  const sources = batch.map((entry) => custody.get(getSubagentRunRuntimeKey(entry))?.authority);
  const first = sources[0];
  const original = first?.operatorAuthority;
  if (
    !first ||
    !original ||
    sources.some(
      (source) =>
        !source?.operatorAuthority ||
        source.operatorAuthority.source !== original.source ||
        source.operatorAuthority.invocation !== original.invocation ||
        !isDeepStrictEqual(source.operatorAuthority.scopes, original.scopes) ||
        !isDeepStrictEqual(source.scopes, first.scopes),
    )
  ) {
    throw new SourceError(
      "Subagent completion notice requires compatible retained requester authority",
    );
  }
}

export function isCancellation(entry: SubagentRunRecord): boolean {
  return (
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.execution.outcome?.status === "error"
  );
}
