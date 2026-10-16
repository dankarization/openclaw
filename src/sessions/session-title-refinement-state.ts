import { z } from "zod";

/**
 * Durable refinement state for the opt-in one-time automatic title refinement.
 * Reset naturally: the entry is keyed to sessionId, and every write re-checks
 * sessionId identity, so /reset (new sessionId) and stale async writers are
 * handled by the existing session writer guards.
 */
export const SessionTitleRefinementStateSchema = z.strictObject({
  /** User task messages observed after the first generated title existed. */
  taskMessagesSinceTitle: z.number().int().min(0),
  /** True once the single refinement has run (successfully or not). */
  refinementDone: z.boolean(),
  /** Session generation the state was captured against. */
  sessionId: z.string(),
  /** Generated title this state owns; refinement writes must still match it. */
  generatedName: z.string(),
});

export type SessionTitleRefinementState = z.infer<typeof SessionTitleRefinementStateSchema>;

/** Default task messages after the first title before the single refinement runs. */
export const SESSION_TITLE_REFINE_AFTER_MESSAGES_DEFAULT = 6;

function clampRefineAfterMessages(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : SESSION_TITLE_REFINE_AFTER_MESSAGES_DEFAULT;
}

export function resolveSessionTitleRefineConfig(params: {
  cfgSession?: {
    autoTitle?: {
      refine?: boolean;
      refineAfterMessages?: number;
    };
  };
}): { enabled: boolean; afterMessages: number } {
  const autoTitle = params.cfgSession?.autoTitle;
  return {
    enabled: autoTitle?.refine === true,
    afterMessages: clampRefineAfterMessages(autoTitle?.refineAfterMessages),
  };
}

/** Counts one subsequent user task message toward the refinement threshold. */
export function countTitleRefinementMessage(
  state: SessionTitleRefinementState | undefined,
  sessionId: string,
  generatedName: string,
): SessionTitleRefinementState {
  // A state from a previous session incarnation (/reset) does not count.
  const owned = state && state.sessionId === sessionId ? state : undefined;
  return {
    taskMessagesSinceTitle: (owned?.taskMessagesSinceTitle ?? 0) + 1,
    refinementDone: owned?.refinementDone ?? false,
    sessionId,
    generatedName,
  };
}

/** True when the bounded one-time refinement should run on this message. */
export function shouldRunTitleRefinement(params: {
  state: SessionTitleRefinementState | undefined;
  sessionId: string;
  afterMessages: number;
}): boolean {
  if (!params.state || params.state.refinementDone) {
    return false;
  }
  if (params.state.sessionId !== params.sessionId) {
    return false;
  }
  return params.state.taskMessagesSinceTitle >= params.afterMessages;
}
