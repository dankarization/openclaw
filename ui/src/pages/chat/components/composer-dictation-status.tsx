import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { InlineAlert } from "../../../components/solid/inline-alert.tsx";
import { registerChatDictationEnglish } from "../../../i18n/locales/en-chat-dictation.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDictationOwner } from "../composer-dictation.ts";
import type { MicrophoneMeterStatus } from "../talk/microphone-meter.ts";
import { MicrophoneActivity } from "./chat-voice-activity.tsx";

registerEnglishCatalog(registerChatDictationEnglish);

// Dictation feedback starts on the click itself: pulsing bars while the microphone
// opens, then the live input level while listening. The permission hint only
// appears when opening takes long enough that a browser prompt is the likely cause.
const DICTATION_PERMISSION_HINT_DELAY_MS = 1_000;

function DictationStartingLabel() {
  const [slow, setSlow] = createSignal(false);
  onSettled(() => {
    const timer = globalThis.setTimeout(() => setSlow(true), DICTATION_PERMISSION_HINT_DELAY_MS);
    return () => globalThis.clearTimeout(timer);
  });
  return (
    <>
      {slow() ? t("chat.composer.microphoneAccessPending") : t("chat.composer.dictationStarting")}
    </>
  );
}

export function ActiveDictationStatus(props: {
  readDictation: () => ComposerDictationOwner | undefined;
}) {
  const phase = createMemo((): MicrophoneMeterStatus | null => {
    const dictation = props.readDictation();
    if (!dictation?.active && !dictation?.transcribing) {
      return null;
    }
    return dictation.connecting
      ? "connecting"
      : dictation.finalizing || !dictation.active
        ? "thinking"
        : "listening";
  });
  return (
    <Show
      when={props.readDictation()?.recovery}
      fallback={
        <Show when={phase()} keyed>
          {(current) => (
            <div
              class="agent-chat__dictation-status"
              data-transcribing={current === "thinking" ? "" : undefined}
              role={current === "listening" ? undefined : "status"}
              aria-live={current === "listening" ? undefined : "polite"}
              aria-atomic={current === "listening" ? undefined : "true"}
            >
              <span
                class={[
                  "agent-chat__dictation-phase",
                  {
                    "agent-chat__dictation-phase--listening text-shimmer": current === "listening",
                  },
                ]}
                // Listening can last a while, so its shimmer sweeps slower than running work.
                // Set here rather than in CSS: the shared stylesheet is at its size ceiling.
                style={{ "--text-shimmer-duration": "4s" }}
              >
                {current === "connecting" ? (
                  <DictationStartingLabel />
                ) : current === "thinking" ? (
                  t("chat.composer.dictationFinalizing")
                ) : (
                  t("chat.composer.dictationListening")
                )}
              </span>
              <MicrophoneActivity
                status={current}
                inputLevel={current === "listening" ? props.readDictation()?.inputLevel : undefined}
              />
            </div>
          )}
        </Show>
      }
    >
      <InlineAlert
        tone="warning"
        action={
          <>
            <button
              class="btn btn--sm"
              type="button"
              onClick={() => props.readDictation()?.discardRecovery()}
            >
              {t("chat.composer.dictationDiscardRecording")}
            </button>
            <button
              class="btn btn--sm"
              type="button"
              disabled={
                !props.readDictation()?.canRetry || props.readDictation()?.recovery?.retrying
              }
              onClick={() => void props.readDictation()?.retry()}
            >
              {t("chat.composer.dictationRetryRecording")}
            </button>
          </>
        }
      >
        {props.readDictation()?.recovery?.retrying
          ? t("chat.composer.dictationFinalizing")
          : t("chat.composer.dictationRecordingKept")}
      </InlineAlert>
    </Show>
  );
}
