import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const logger = createSubsystemLogger("telegram/progress-routing");

export type TelegramProgressRoutingSnapshot = {
  streamMode: string;
  toolProgressEnabled: boolean;
  commentaryProgressEnabled: boolean;
  progressPreambleEnabled: boolean;
  answerStreamActive: boolean;
  roomEvent: boolean;
  allowProgressCallbacksWhenSourceDeliverySuppressed: boolean;
  providerPreviewAllowed: boolean;
  sourceRepliesAreToolOnly: boolean | null;
};

type ProgressRoutingInfoLogger = {
  info: (message: string, fields: Record<string, unknown>) => void;
};

/** Counts Telegram callbacks without retaining provider payloads or routing identifiers. */
export function createTelegramProgressRoutingDiagnostics(log: ProgressRoutingInfoLogger = logger) {
  let toolStartCallbacks = 0;
  let toolStartVisible = 0;
  let preambleCallbacks = 0;
  let preambleVisible = 0;
  let otherItemCallbacks = 0;

  return {
    noteToolStart(visible: boolean) {
      toolStartCallbacks += 1;
      if (visible) {
        toolStartVisible += 1;
      }
    },
    noteItemEvent(kind: string | undefined, visible: boolean) {
      if (kind === "preamble") {
        preambleCallbacks += 1;
        if (visible) {
          preambleVisible += 1;
        }
      } else {
        otherItemCallbacks += 1;
      }
    },
    report(snapshot: TelegramProgressRoutingSnapshot) {
      try {
        log.info("Telegram progress routing summary", {
          streamMode: snapshot.streamMode,
          toolProgressEnabled: snapshot.toolProgressEnabled,
          commentaryProgressEnabled: snapshot.commentaryProgressEnabled,
          progressPreambleEnabled: snapshot.progressPreambleEnabled,
          answerStreamActive: snapshot.answerStreamActive,
          roomEvent: snapshot.roomEvent,
          allowProgressCallbacksWhenSourceDeliverySuppressed:
            snapshot.allowProgressCallbacksWhenSourceDeliverySuppressed,
          providerPreviewAllowed: snapshot.providerPreviewAllowed,
          sourceRepliesAreToolOnly: snapshot.sourceRepliesAreToolOnly,
          toolStartCallbacks,
          toolStartVisible,
          preambleCallbacks,
          preambleVisible,
          otherItemCallbacks,
        });
      } catch {
        // Diagnostics must never change the turn result or skip delivery cleanup.
      }
    },
  };
}
