/**
 * Runtime SDK subpath for media understanding, image description, and audio transcription.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import {
  type AudioTranscriptionIdentity,
  matchesAudioEchoIdentity,
} from "../media-understanding/echo-filter.js";
import { sendTranscriptEcho } from "../media-understanding/echo-transcript.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

type TranscribeFirstAudio =
  typeof import("../media-understanding/audio-preflight.js").transcribeFirstAudio;
type ResolveAudioPreflight =
  typeof import("../media-understanding/audio-preflight.js").resolveAudioPreflight;
type SendTranscriptEcho = typeof sendTranscriptEcho;

const DEFAULT_ECHO_TRANSCRIPT_FORMAT = '📝 "{transcript}"';
const loadAudioPreflightRuntime = createLazyRuntimeModule(
  () => import("../media-understanding/audio-preflight.js"),
);

export type ChannelPreflightAudioResult = {
  transcript: string;
  identity?: AudioTranscriptionIdentity;
};

export function formatAudioTranscriptForAgent(transcript: string): string {
  return `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`;
}

/** Creates shared preflight transcription and deferred-echo behavior for a channel. */
export function createChannelPreflightAudio<TAudio>(params: {
  channel: string;
  isAudio: (value: TAudio) => boolean;
  deferTranscriptEcho?: boolean;
  transcribeFirstAudio?: TranscribeFirstAudio;
  resolveAudioPreflight?: ResolveAudioPreflight;
  sendTranscriptEcho?: SendTranscriptEcho;
}) {
  const deferTranscriptEcho = params.deferTranscriptEcho ?? true;

  const suppress = (cfg: OpenClawConfig): OpenClawConfig => {
    if (!deferTranscriptEcho) {
      return cfg;
    }
    const audio = cfg.tools?.media?.audio;
    if (!audio?.echoTranscript) {
      return cfg;
    }
    return {
      ...cfg,
      tools: {
        ...cfg.tools,
        media: {
          ...cfg.tools?.media,
          audio: {
            ...audio,
            echoTranscript: false,
          },
        },
      },
    };
  };

  const format = (transcript: string, formatTemplate: string): string => {
    // Function replacement preserves literal `$` sequences in provider output.
    return formatTemplate.replace("{transcript}", () => transcript);
  };

  const resolveDetailed = async (resolveParams: {
    request: Parameters<TranscribeFirstAudio>[0];
    abortSignal?: AbortSignal;
  }): Promise<ChannelPreflightAudioResult | undefined> => {
    if (resolveParams.abortSignal?.aborted) {
      return undefined;
    }
    try {
      let result: ChannelPreflightAudioResult | undefined;
      if (params.resolveAudioPreflight) {
        result = await params.resolveAudioPreflight({
          ...resolveParams.request,
          deferTranscriptEcho,
        });
      } else if (params.transcribeFirstAudio) {
        const transcript = await params.transcribeFirstAudio({
          ...resolveParams.request,
          cfg: suppress(resolveParams.request.cfg),
        });
        result = transcript ? { transcript } : undefined;
      } else {
        const runtime = await loadAudioPreflightRuntime();
        result = await runtime.resolveAudioPreflight({
          ...resolveParams.request,
          deferTranscriptEcho,
        });
      }
      return resolveParams.abortSignal?.aborted ? undefined : result;
    } catch (err) {
      logVerbose(`${params.channel}: audio preflight transcription failed: ${String(err)}`);
      return undefined;
    }
  };

  return {
    isAudio: params.isAudio,
    suppress,
    format,

    async resolve(resolveParams: {
      request: Parameters<TranscribeFirstAudio>[0];
      abortSignal?: AbortSignal;
    }): Promise<string | undefined> {
      return (await resolveDetailed(resolveParams))?.transcript;
    },

    resolveDetailed,

    async send(sendParams: {
      transcript: string;
      identity?: AudioTranscriptionIdentity;
      cfg: OpenClawConfig;
      accountId: string;
      originatingTo: string;
      messageThreadId?: string;
    }): Promise<void> {
      const audio = sendParams.cfg.tools?.media?.audio;
      if (
        !audio?.echoTranscript ||
        !matchesAudioEchoIdentity({
          match: audio.echo?.match,
          identity: sendParams.identity ?? {},
        })
      ) {
        return;
      }
      await (params.sendTranscriptEcho ?? sendTranscriptEcho)({
        ctx: {
          Provider: params.channel,
          Surface: params.channel,
          OriginatingChannel: params.channel,
          OriginatingTo: sendParams.originatingTo,
          AccountId: sendParams.accountId,
          MessageThreadId: sendParams.messageThreadId,
        },
        cfg: sendParams.cfg,
        transcript: sendParams.transcript,
        format: audio.echoFormat ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT,
        logSuccess: false,
        failureLogPrefix: `${params.channel}: audio transcript echo failed`,
      });
    },
  };
}

export {
  describeImageFile,
  describeImageFileWithModel,
  describeVideoFile,
  extractStructuredWithModel,
  runMediaUnderstandingFile,
  transcribeAudioFile,
  type ExtractStructuredWithModelParams,
  type RunMediaUnderstandingFileParams,
  type RunMediaUnderstandingFileResult,
} from "../media-understanding/runtime.js";
