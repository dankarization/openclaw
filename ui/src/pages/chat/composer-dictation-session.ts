import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { registerChatDictationEnglish } from "../../i18n/locales/en-chat-dictation.ts";
import { bytesToBase64 } from "../../lib/bytes-base64.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import type { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import {
  floatToG711Ulaw,
  measureRealtimeTalkAudioFrame,
  RealtimeTalkMediaStreamMeter,
  RealtimeTalkPcmInputPump,
} from "./talk/audio.ts";
import { describeRealtimeTalkInputError, RealtimeTalkInputOwner } from "./talk/input.ts";
import { RealtimeTalkLevelSignal } from "./talk/level.ts";

registerEnglishCatalog(registerChatDictationEnglish);

const FINAL_TRANSCRIPT_MAX_WAIT_MS = 10_000;
const DICTATION_ENCODING = "g711_ulaw";
const DICTATION_SAMPLE_RATE_HZ = 8000;

type DictationSessionResult = {
  sessionId: string;
  transcriptionSessionId?: string;
  audio?: {
    inputEncoding?: unknown;
    inputSampleRateHz?: unknown;
  };
};

type ComposerDictationSessionCallbacks = {
  onError: (message: string, preservesText: boolean) => void | (() => void);
  onLevel?: (level: number) => void;
  onTranscriptChange: () => void;
  onReady: () => void;
  onSilence?: () => void;
};

// Transcription relay events use the shared transcriptionSessionId envelope;
// the canonical TalkEvent rides alongside it as `talkEvent`.
function eventPayload(frame: GatewayEventFrame) {
  if (frame.event !== "talk.event" || !frame.payload || typeof frame.payload !== "object") {
    return null;
  }
  return asOptionalObjectRecord(frame.payload) ?? null;
}

function formatDictationError(error: unknown): string {
  if (error instanceof DOMException) {
    return describeRealtimeTalkInputError(error);
  }
  return formatUiError(error);
}

/**
 * Stopped recordings that still await their final transcript. Each keeps its
 * Gateway session until settled; results are delivered in capture order, even
 * when a later recording's provider finishes first.
 */
export class ComposerDictationCommits {
  private readonly sessions = new Set<ComposerDictationSession>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly recoveryWaiters = new Map<ComposerDictationSession, (text: string | null) => void>();
  private readonly recoveryResults = new Map<ComposerDictationSession, string | null>();
  // Consumers place delivered and preview transcripts in their drafts.
  readonly place = placeComposerDictation;

  get size(): number {
    return this.sessions.size;
  }

  get hasRecovery(): boolean {
    for (const session of this.sessions) {
      if (session.recovery && session.hasRecording) {
        return true;
      }
    }
    return false;
  }

  // Only the head recording is actionable. Later finals wait here so retry or
  // discard preserves the main commit queue's capture-order and preview contract.
  get recovery(): ComposerDictationSession | undefined {
    const first = this.sessions.values().next().value as ComposerDictationSession | undefined;
    return first?.recovery ? first : undefined;
  }

  has(session: ComposerDictationSession): boolean {
    return this.sessions.has(session);
  }

  add(
    session: ComposerDictationSession,
    deliver: (transcript: string) => boolean,
  ): Promise<boolean> {
    const previous = this.tail;
    this.sessions.add(session);
    const settled = session
      .finish(true)
      .catch(() => "")
      .then(async (initialTranscript) => {
        await previous;
        if (!this.sessions.has(session)) {
          return false;
        }
        const transcript = initialTranscript ||
          (session.hasRecording ? await this.waitForRecovery(session) : "");
        const owned = this.sessions.delete(session);
        this.recoveryWaiters.delete(session);
        this.recoveryResults.delete(session);
        return owned && transcript ? deliver(transcript) : false;
      })
      .catch(() => false);
    this.tail = settled;
    return settled;
  }

  async retry(playback: GatewaySpeechPlayback, superseded: () => void): Promise<boolean> {
    const session = this.recovery;
    if (!session || session.retrying) {
      return false;
    }
    const transcript = await session.retry(playback, superseded);
    if (!transcript) {
      return false;
    }
    this.resolveRecovery(session, transcript);
    return true;
  }

  discardRecovery(): boolean {
    const session = this.recovery;
    if (!session) {
      return false;
    }
    this.sessions.delete(session);
    this.resolveRecovery(session, null);
    void session.cancel().catch(() => undefined);
    return true;
  }

  cancelRetry(): void {
    this.recovery?.cancelRetryAttempt();
  }

  markGatewayDisconnected(): void {
    for (const session of this.sessions) {
      session.markGatewayDisconnected();
    }
  }

  retire(): void {
    for (const session of this.sessions) {
      this.resolveRecovery(session, null);
      void session.cancel().catch(() => undefined);
    }
    this.sessions.clear();
    this.recoveryWaiters.clear();
    this.recoveryResults.clear();
  }

  private waitForRecovery(session: ComposerDictationSession): Promise<string | null> {
    if (this.recoveryResults.has(session)) {
      const result = this.recoveryResults.get(session) ?? null;
      this.recoveryResults.delete(session);
      return Promise.resolve(result);
    }
    return new Promise((resolve) => this.recoveryWaiters.set(session, resolve));
  }

  private resolveRecovery(session: ComposerDictationSession, text: string | null): void {
    const resolve = this.recoveryWaiters.get(session);
    if (resolve) {
      this.recoveryWaiters.delete(session);
      resolve(text);
    } else {
      this.recoveryResults.set(session, text);
    }
  }
}

function insertComposerDictation(
  value: string,
  transcript: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; caret: number } {
  const spoken = transcript.trim();
  if (!spoken) {
    return { value, caret: selectionEnd };
  }
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leadingSpace = before && !/\s$/.test(before) && !/^\s|^[,.;:!?)]/.test(spoken) ? " " : "";
  const trailingSpace =
    after && !/^\s|^[,.;:!?)]/.test(after) && !/[\s([{]$/.test(spoken) ? " " : "";
  const inserted = `${leadingSpace}${spoken}${trailingSpace}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

type DictationSelection = { start: number; end: number; value: string };

/**
 * Places a transcript in a draft. The captured selection holds unless a late final
 * finds the draft edited after Stop; with a newer recording's preview painted over
 * the draft, the next result chains from the captured draft instead.
 */
export function placeComposerDictation(
  transcript: string,
  captured: DictationSelection | null,
  live: DictationSelection,
  late?: true,
  preservePreview?: true,
): { value: string; caret: number; changed: boolean; captured: DictationSelection | null } {
  const selection =
    captured && (preservePreview || !late || captured.value === live.value) ? captured : live;
  const insertion = insertComposerDictation(
    selection.value,
    transcript,
    selection.start,
    selection.end,
  );
  return {
    ...insertion,
    changed: insertion.value !== selection.value,
    captured: preservePreview
      ? { start: insertion.caret, end: insertion.caret, value: insertion.value }
      : null,
  };
}

export function describeDictationStartError(error: unknown): [string, "busy" | "start"] {
  // Stopped recordings hold their Gateway sessions until transcribed; a full
  // connection refuses the next one before its microphone opens.
  const details = asOptionalObjectRecord(asOptionalObjectRecord(error)?.details);
  return details?.code === "TALK_SESSION_CAPACITY"
    ? [t("chat.dictation.busy"), "busy"]
    : [formatDictationError(error), "start"];
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export class ComposerDictationSession {
  private readonly input = new RealtimeTalkInputOwner((detail) => this.reportFailure(detail));
  private context: AudioContext | null = null;
  private readonly inputPump = new RealtimeTalkPcmInputPump();
  private inputMeter: RealtimeTalkMediaStreamMeter | null = null;
  // Live microphone level for the listening meter; lives with the lazily loaded capture.
  readonly inputLevel = new RealtimeTalkLevelSignal();
  private unsubscribe: (() => void) | null = null;
  private sessionId: string | null = null;
  private transcriptionSessionId: string | null = null;
  private readonly finalTranscripts: string[] = [];
  private currentPartial = "";
  private startPromise: Promise<void> | null = null;
  private readonly recording: Float32Array[] = [];
  recovery = false;
  retrying = false;
  dismissFailure: (() => void) | undefined;
  private retryCancelled = false;
  private retryGeneration: object | undefined;
  private appendChain: Promise<void> = Promise.resolve();
  private closeRequest: { discard: boolean; promise: Promise<void> } | null = null;
  private cleanupPromise: Promise<void> = Promise.resolve();
  private stopped = false;
  private discarded = false;
  private failed = false;
  private gatewayDisconnected = false;
  private settleLateFinalDrain: ((discard: boolean) => void) | null = null;
  private pauseFinalDrain: (() => void) | null = null;
  private resumeFinalDrain: (() => void) | null = null;
  private heardSpeech = false;
  private silentSamples = 0;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly callbacks: ComposerDictationSessionCallbacks,
    private readonly options?: {
      sessionKey?: string;
      inputDeviceId?: string;
      silenceTimeoutMs?: number;
    },
  ) {}

  start(): Promise<void> {
    this.startPromise ??= this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const inputDeviceId =
      this.options && "inputDeviceId" in this.options
        ? this.options.inputDeviceId
        : loadSettings().realtimeTalkInputDeviceId?.trim() || undefined;
    // Start the audio graph while the Gateway admits the session instead of after it.
    // stopCapture() closes the context on every exit.
    try {
      this.context = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE_HZ });
    } catch {
      this.context = null;
    }
    // Admission stays before microphone access so capacity failures never open a mic.
    await this.createRemote();
    if (this.stopped) {
      return;
    }
    this.subscribeToRemote();
    const media = await this.input.open(inputDeviceId);
    if (this.stopped || this.failed) {
      return;
    }
    if (this.context?.sampleRate !== DICTATION_SAMPLE_RATE_HZ) {
      throw new Error(t("chat.composer.dictationBrowserAudioUnsupported"));
    }
    const context = this.context;
    this.inputMeter = new RealtimeTalkMediaStreamMeter((level) => {
      this.inputLevel.set(level);
      this.callbacks.onLevel?.(level);
    });
    this.inputMeter.start(media, context);
    this.inputPump.start(media, context, (samples) => {
      if (this.stopped) {
        return;
      }
      this.queueAudio(samples);
      this.detectSilence(samples);
    });
    this.callbacks.onReady();
  }

  private async createRemote(): Promise<void> {
    const result = await this.client.request<DictationSessionResult>("talk.session.create", {
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
      ...(this.options?.sessionKey ? { sessionKey: this.options.sessionKey } : {}),
    });
    this.sessionId = result.sessionId;
    this.transcriptionSessionId = result.transcriptionSessionId ?? result.sessionId;
    if (
      result.audio?.inputEncoding !== DICTATION_ENCODING ||
      result.audio.inputSampleRateHz !== DICTATION_SAMPLE_RATE_HZ
    ) {
      await this.closeRemote();
      throw new Error(t("chat.composer.dictationAudioUnsupported"));
    }
  }

  private subscribeToRemote(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.client.addEventListener((frame) => {
      const payload = eventPayload(frame);
      if (
        !payload ||
        payload.transcriptionSessionId !== this.transcriptionSessionId ||
        this.stopped ||
        this.discarded ||
        (this.retrying && this.retryCancelled)
      ) {
        return;
      }
      if (
        (payload.type === "transcript" || payload.type === "partial") &&
        typeof payload.text === "string"
      ) {
        const text = payload.text.trim();
        if (payload.type === "partial" || payload.final !== true) {
          this.currentPartial = text;
        } else if (text) {
          this.finalTranscripts.push(text);
          this.currentPartial = "";
        }
        this.callbacks.onTranscriptChange();
        return;
      }
      if (payload.type === "error") {
        this.reportFailure(
          formatUiExternalText(
            typeof payload.message === "string" ? payload.message : undefined,
            t("chat.composer.dictationFailed"),
          ),
        );
        return;
      }
      if (payload.type === "close" && payload.reason === "error") {
        this.reportFailure(t("chat.composer.dictationDisconnected"));
      }
    });
  }

  transcriptSnapshot(): string {
    return [...this.finalTranscripts, this.currentPartial].filter(Boolean).join(" ").trim();
  }

  get hasRecording(): boolean {
    return this.recording.length > 0 && !this.discarded;
  }

  async finish(requireTranscript?: true): Promise<string> {
    const transcript =
      this.gatewayDisconnected || this.failed ? this.transcriptSnapshot() : this.waitForLateFinal();
    // Retry must join this attempt's capture/append/close cleanup before replacing
    // its mutable transport fields with a new Gateway session.
    this.cleanupPromise = this.stopAndClose(true).catch(() => undefined);
    const text = await transcript;
    const recovery = !text && this.hasRecording;
    if (this.recovery !== recovery) {
      this.recovery = recovery;
      this.callbacks.onTranscriptChange();
    }
    if (text) {
      this.recording.length = 0;
      this.recovery = false;
    }
    if (requireTranscript && !text && !this.discarded && !this.failed && !this.retryCancelled) {
      this.reportFailure(
        t(
          this.gatewayDisconnected
            ? "chat.composer.dictationDisconnected"
            : "chat.composer.dictationFailed",
        ),
      );
    }
    return text;
  }

  async retry(playback: GatewaySpeechPlayback, superseded: () => void): Promise<string> {
    if (!this.recovery || !this.hasRecording || this.retrying || this.discarded) {
      return "";
    }
    const generation = {};
    this.retryGeneration = generation;
    this.retryCancelled = false;
    this.retrying = true;
    this.callbacks.onTranscriptChange();
    // Shared playback supersession cancels only this relay attempt; the captured
    // PCM remains in this tab for another explicit retry.
    this.failed = false;
    try {
      playback.prepare(this.client, () => {
        if (this.retryGeneration === generation) {
          superseded();
        }
      });
      // finish() can surface recovery before stopCapture()/append/close cleanup
      // settles. Keep the old session fields intact until that owner is quiescent.
      await this.cleanupPromise;
      if (this.discarded || this.retryCancelled) {
        return "";
      }
      this.gatewayDisconnected = false;
      this.stopped = false;
      this.sessionId = null;
      this.transcriptionSessionId = null;
      this.closeRequest = null;
      this.appendChain = Promise.resolve();
      this.finalTranscripts.length = 0;
      this.currentPartial = "";
      await this.createRemote();
      if (this.discarded || this.retryCancelled || !this.sessionId) {
        await this.closeRemote(true);
        return "";
      }
      this.subscribeToRemote();
      for (const samples of this.recording) {
        if (this.discarded || this.retryCancelled) {
          break;
        }
        this.queueAudio(samples, false);
      }
      await this.appendChain;
      if (this.discarded || this.retryCancelled) {
        await this.closeRemote(true);
        return "";
      }
      const transcript = await this.finish(true);
      if (this.discarded || this.retryCancelled) {
        return "";
      }
      if (transcript) {
        this.dismissFailure?.();
        this.dismissFailure = undefined;
      }
      return transcript;
    } catch (error) {
      if (!this.discarded && !this.retryCancelled && !isAbortError(error)) {
        this.reportFailure(formatDictationError(error));
      }
      await this.closeRemote(true);
      return "";
    } finally {
      if (this.retryGeneration === generation) {
        this.retryGeneration = undefined;
        this.retrying = false;
        this.callbacks.onTranscriptChange();
      }
    }
  }

  cancelRetryAttempt(): void {
    if (!this.retrying || this.retryCancelled) {
      return;
    }
    this.retryCancelled = true;
    this.settleLateFinalDrain?.(true);
    void this.appendChain.finally(() => this.closeRemote(true));
    this.callbacks.onTranscriptChange();
  }

  async cancel(): Promise<void> {
    this.discarded = true;
    this.retryCancelled = true;
    this.recovery = false;
    this.recording.length = 0;
    this.dismissFailure?.();
    this.dismissFailure = undefined;
    this.settleLateFinalDrain?.(true);
    this.callbacks.onTranscriptChange();
    await this.stopAndClose(false);
  }

  private async stopAndClose(reportStartFailure: boolean): Promise<void> {
    try {
      await this.stopCapture();
      // Startup may already be waiting for a normal close; discard must interrupt it.
      if (!this.discarded || !this.sessionId) {
        await this.startPromise?.catch((error: unknown) => {
          if (reportStartFailure && !isAbortError(error)) {
            this.reportFailure(formatDictationError(error));
          }
        });
      }
      if (!this.discarded) {
        await this.appendChain;
      }
    } finally {
      // Even a failed local AudioContext close must not let an attempt's Gateway
      // session survive the join that gates a later retry.
      await this.closeRemote();
    }
  }

  markGatewayDisconnected(): boolean {
    this.gatewayDisconnected = true;
    this.settleLateFinalDrain?.(false);
    return this.hasTranscript();
  }

  private detectSilence(samples: Float32Array): void {
    if (!this.options?.silenceTimeoutMs || !this.callbacks.onSilence) {
      return;
    }
    if (measureRealtimeTalkAudioFrame(samples).rms >= 0.015) {
      this.heardSpeech = true;
      this.silentSamples = 0;
    } else if (this.heardSpeech) {
      this.silentSamples += samples.length;
      if (this.silentSamples >= (this.options.silenceTimeoutMs * DICTATION_SAMPLE_RATE_HZ) / 1000) {
        this.heardSpeech = false;
        this.callbacks.onSilence();
      }
    }
  }

  private queueAudio(samples: Float32Array, retain = true): void {
    if (!this.sessionId) {
      return;
    }
    const sessionId = this.sessionId;
    if (retain && !this.retrying) {
      this.recording.push(samples.slice());
    }
    const audioBase64 = bytesToBase64(floatToG711Ulaw(samples));
    this.appendChain = this.appendChain
      .then(async () => {
        if (this.discarded) {
          return;
        }
        await this.client.request("talk.session.appendAudio", { sessionId, audioBase64 });
      })
      .catch((error: unknown) => {
        this.reportFailure(formatDictationError(error));
      });
  }

  private reportFailure(message: string): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.settleLateFinalDrain?.(false);
    this.dismissFailure?.();
    this.dismissFailure = this.callbacks.onError(message, this.hasTranscript()) || undefined;
  }

  private hasTranscript(): boolean {
    return this.finalTranscripts.length > 0 || Boolean(this.currentPartial);
  }

  private async stopCapture(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.input.stop();
    this.inputPump.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.inputMeter?.stop();
    this.inputMeter = null;
    await this.context?.close();
    this.context = null;
  }

  private closeRemote(forceDiscard = false): Promise<void> {
    if (!this.sessionId) {
      return Promise.resolve();
    }
    const discard = forceDiscard || this.discarded || this.retryCancelled;
    if (!this.closeRequest || (discard && !this.closeRequest.discard)) {
      // Buffered STT finalizes during close; its media owner bounds the request.
      // The browser's late-event grace starts only after that work completes.
      this.pauseFinalDrain?.();
      const promise = this.client
        .request(
          "talk.session.close",
          { sessionId: this.sessionId, ...(discard ? { discard } : {}) },
          { timeoutMs: null },
        )
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => this.resumeFinalDrain?.());
      this.closeRequest = { discard, promise };
    }
    return this.closeRequest.promise;
  }

  private waitForLateFinal(): Promise<string> {
    return new Promise((resolve) => {
      const initialTranscript = this.transcriptSnapshot();
      const transcripts: string[] = [...this.finalTranscripts];
      let partial = this.currentPartial;
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      let unsubscribe = () => {};
      const finish = (text: string) => {
        globalThis.clearTimeout(timer);
        unsubscribe();
        this.settleLateFinalDrain = null;
        this.pauseFinalDrain = null;
        this.resumeFinalDrain = null;
        resolve(text);
      };
      const transcript = () => [...transcripts, partial].filter(Boolean).join(" ").trim();
      this.pauseFinalDrain = () => globalThis.clearTimeout(timer);
      this.resumeFinalDrain = () => {
        timer = globalThis.setTimeout(() => finish(transcript()), FINAL_TRANSCRIPT_MAX_WAIT_MS);
      };
      this.resumeFinalDrain();
      unsubscribe = this.client.addEventListener((frame) => {
        const payload = eventPayload(frame);
        if (!payload || payload.transcriptionSessionId !== this.transcriptionSessionId) {
          return;
        }
        if (
          payload.type === "transcript" &&
          payload.final === true &&
          typeof payload.text === "string" &&
          payload.text.trim()
        ) {
          transcripts.push(payload.text.trim());
          partial = "";
        } else if (payload.type === "error" || payload.type === "close") {
          if (payload.type === "error" || payload.reason === "error") {
            this.reportFailure(
              formatUiExternalText(
                typeof payload.message === "string" ? payload.message : undefined,
                t("chat.composer.dictationFailed"),
              ),
            );
          } else {
            finish(transcript());
          }
        }
      });
      // Failed finalization retains the preview, not its provisional result.
      this.settleLateFinalDrain = (discard) =>
        finish(discard ? "" : this.failed ? initialTranscript : transcript());
    });
  }
}
