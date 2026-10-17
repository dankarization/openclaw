import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { sessionEntryCommitGuardOptions } from "../config/sessions/session-source-authority.js";
import type { SessionTitleRefinementState } from "../sessions/session-title-refinement-state.js";
import {
  countTitleRefinementMessage,
  resolveSessionTitleRefineConfig,
} from "../sessions/session-title-refinement-state.js";
import { resolveSessionTitleSource } from "../sessions/session-title-source.js";
import {
  prepareTitleSkillCommands,
  generateDashboardSessionTitle,
  type SessionTitleParams,
} from "./dashboard-session-title.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { readSessionTitleFieldsFromTranscriptAsync } from "./session-transcript-title-reader.js";

/**
 * Opt-in one-time refinement of an already generated title after several later
 * task messages. Never touches explicit labels (the same persist guard that
 * protects first titles also protects refinements) and runs at most once per
 * session generation (durable `titleRefinement` state, sessionId-bound).
 */
const SESSION_TITLE_REFINEMENT_PROMPT =
  "Generate a concise session title (3-6 words, max 60 characters) from the supplied conversation excerpt. Use the language the excerpt is written in, not the language of quoted literals, in sentence case: capitalize only the first word and words that language always capitalizes. No emoji. Return only the title.";

export async function maybeRefineDashboardSessionTitle(params: SessionTitleParams): Promise<void> {
  const sessionKey = resolveStoredSessionKeyForAgentStore(params);
  const scope = { agentId: params.agentId, sessionKey, storePath: params.storePath };
  const assertCurrent = () => params.commitGuard?.();
  const memory = captureSessionActorStorageOwner(scope, {
    assertCurrent,
    authorize: assertCurrent,
  });
  if (memory && !memory.owner?.readSession(sessionKey, memory.authority)?.entry) {
    return;
  }
  const assertMemorySessionCurrent = memory?.owner?.captureSessionReadGuard(sessionKey);
  const assertMemoryCurrent = () => {
    assertMemorySessionCurrent?.();
    memory?.binding?.actor.assertReadable();
    memory?.authority.assertCurrent();
  };
  try {
    const entry = await readSessionEntryReadOnlyInWorker(scope, assertMemoryCurrent);
    if (!entry || entry.incognito || entry.sessionId !== params.sessionId) {
      return;
    }
    // Manual titles are never refined; only generated displayName candidates.
    // Device/platform autoLabel metadata is NOT a manual name (the initial
    // title path ignores it too), so it must not block refinement eligibility.
    if (entry.label?.trim() || !entry.displayName?.trim()) {
      return;
    }
    const refineConfig = resolveSessionTitleRefineConfig({ cfgSession: params.cfg.session });
    if (!refineConfig.enabled) {
      return;
    }
    // Only real task turns advance the threshold: control-only slash messages
    // (e.g. /status, /model with no args) resolve to no source and don't count.
    {
      const skillCommands = await prepareTitleSkillCommands({
        cfg: params.cfg,
        agentId: params.agentId,
        entry,
        sessionKey,
        assertCurrent: assertMemoryCurrent,
      });
      const currentSource = resolveSessionTitleSource(
        params.currentUserMessage ?? params.userMessage,
        skillCommands,
      );
      if (!currentSource) {
        return;
      }
    }
    const generatedName = entry.displayName.trim();
    const priorState = entry.titleRefinement;
    // Provenance: only names the automatic title writer marked (via
    // initializeTitleRefinementState) may be refined. A displayName that
    // exists without this state was set explicitly by the user/operator and
    // must never be adopted as a generated name.
    if (
      !priorState ||
      priorState.sessionId !== params.sessionId ||
      priorState.generatedName !== generatedName
    ) {
      return;
    }
    // Exactly-once: a completed refinement never counts or writes again.
    if (priorState.refinementDone) {
      return;
    }
    // Atomic claim: each job computes its increment INSIDE the entry-guarded
    // patch from the persisted state, so overlapping background turns
    // serialise without losing counter increments; exactly one caller sees
    // the claim succeed on the turn that reaches afterMessages.
    let claimed = false;
    let claimedState: SessionTitleRefinementState | undefined;
    await patchSessionEntryCore(
      scope,
      (current) => {
        if (
          current.sessionId !== params.sessionId ||
          current.incognito ||
          current.label?.trim() ||
          current.displayName?.trim() !== generatedName
        ) {
          return null;
        }
        const currentPrior = current.titleRefinement;
        // Provenance must persist into the claim: no state, or state from a
        // different session/name, means the name is not writer-owned.
        if (
          !currentPrior ||
          currentPrior.refinementDone ||
          currentPrior.generatedName !== generatedName ||
          currentPrior.sessionId !== params.sessionId
        ) {
          return null;
        }
        const nextState = countTitleRefinementMessage(
          current.titleRefinement,
          params.sessionId,
          generatedName,
        );
        // Below threshold: persist the counter only; the claim (and inference)
        // happens on the turn that reaches afterMessages.
        if (nextState.taskMessagesSinceTitle < refineConfig.afterMessages) {
          return { titleRefinement: nextState };
        }
        claimed = true;
        claimedState = nextState;
        return { titleRefinement: nextState };
      },
      {
        requireWriteSuccess: false,
        ...sessionEntryCommitGuardOptions(assertMemoryCurrent),
      },
    );
    if (!claimed || !claimedState) {
      return;
    }
    const claimedTitleRefinement = claimedState;
    const skillCommands = await prepareTitleSkillCommands({
      cfg: params.cfg,
      agentId: params.agentId,
      entry,
      sessionKey,
      assertCurrent: assertMemoryCurrent,
    });
    const transcriptScope = {
      agentId: params.agentId,
      sessionEntry: entry,
      sessionId: params.sessionId,
      sessionKey,
      storePath: params.storePath,
    };
    const fields = await readSessionTitleFieldsFromTranscriptAsync(transcriptScope, {
      skillCommands,
    });
    assertMemoryCurrent();
    // The triggering turn may not be in the transcript yet (background naming
    // raced transcript publication), so its validated source is appended.
    const triggeringSource = resolveSessionTitleSource(
      params.currentUserMessage ?? "",
      skillCommands,
    );
    const sourceText = [
      fields.firstUserMessage ?? "",
      fields.lastMessagePreview ?? "",
      triggeringSource && triggeringSource !== fields.lastMessagePreview ? triggeringSource : "",
    ]
      .filter(Boolean)
      .join("\n---\n")
      .trim();
    // Consume the attempt when there is nothing to refine from.
    if (!sourceText) {
      await patchSessionEntryCore(
        scope,
        (current) =>
          current.sessionId === params.sessionId &&
          current.displayName?.trim() === generatedName &&
          current.titleRefinement?.generatedName === generatedName &&
          !current.titleRefinement.refinementDone
            ? { titleRefinement: { ...claimedTitleRefinement, refinementDone: true } }
            : null,
        {
          requireWriteSuccess: false,
          ...sessionEntryCommitGuardOptions(assertMemoryCurrent),
        },
      );
      return;
    }
    // Utility-only mode: refinement must never fall back to a random slug —
    // a provider outage consumes the optional attempt without a rename.
    const refined = await generateDashboardSessionTitle({
      cfg: params.cfg,
      agentId: params.agentId,
      entry: params.entry ?? entry,
      sourceText,
      promptOverride: SESSION_TITLE_REFINEMENT_PROMPT,
      utilityOnly: true,
      operatorAuthority: params.operatorAuthority,
      ...(memory ? { assertCurrent: assertMemoryCurrent } : {}),
    });
    if (!refined || refined === generatedName) {
      // Attempt consumed without a rename (null/failure or unchanged label).
      await patchSessionEntryCore(
        scope,
        (current) =>
          current.sessionId === params.sessionId &&
          current.displayName?.trim() === generatedName &&
          current.titleRefinement?.generatedName === generatedName &&
          !current.titleRefinement.refinementDone
            ? { titleRefinement: { ...claimedTitleRefinement, refinementDone: true } }
            : null,
        {
          requireWriteSuccess: false,
          ...sessionEntryCommitGuardOptions(assertMemoryCurrent),
        },
      );
      return;
    }
    let persisted = false;
    await patchSessionEntryCore(
      scope,
      (current) => {
        if (
          current.sessionId !== params.sessionId ||
          current.displayName?.trim() !== generatedName ||
          current.titleRefinement?.generatedName !== generatedName ||
          current.titleRefinement.refinementDone
        ) {
          return null;
        }
        persisted = true;
        return {
          displayName: refined,
          titleRefinement: {
            ...claimedTitleRefinement,
            refinementDone: true,
            generatedName: refined,
          },
        };
      },
      {
        requireWriteSuccess: true,
        ...sessionEntryCommitGuardOptions(assertMemoryCurrent),
      },
    );
    if (persisted) {
      params.onTitleStateChanged?.();
    }
  } catch {
    // Refinement is optional; it must never fail a chat send. The attempt was
    // already claimed atomically before inference, so no retry loop exists.
  }
}
