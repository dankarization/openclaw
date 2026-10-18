import type { SubagentCompletionMode } from "./spawn/subagent-system-prompt.js";

/**
 * Core-owned fact: this child may produce requester-visible channel follow-up.
 * Quiet and collector runs are intentionally silent. Announce and thread-direct
 * runs are public. Missing facts fail closed.
 */
export function resolveSubagentPublicPresentation(params: {
  completionMode?: SubagentCompletionMode;
  expectsCompletionMessage?: boolean;
}): boolean {
  if (params.completionMode === "quiet" || params.completionMode === "collector") {
    return false;
  }
  if (params.completionMode === "announce" || params.completionMode === "thread-direct") {
    return true;
  }
  return params.expectsCompletionMessage === true;
}
