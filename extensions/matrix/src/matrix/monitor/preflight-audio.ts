import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createChannelPreflightAudio,
  type ChannelPreflightAudioResult,
} from "openclaw/plugin-sdk/media-understanding-runtime";

export function isMatrixAudioContent(params: { msgtype?: string; mimetype?: string }): boolean {
  if (params.msgtype === "m.audio") {
    return true;
  }
  if (params.msgtype === "m.file" && typeof params.mimetype === "string") {
    return params.mimetype.toLowerCase().startsWith("audio/");
  }
  return false;
}

const matrixPreflightAudio = createChannelPreflightAudio({
  channel: "matrix",
  isAudio: isMatrixAudioContent,
});

export async function resolveMatrixPreflightAudioTranscript(params: {
  mediaPath: string;
  mediaContentType?: string;
  cfg: OpenClawConfig;
  accountId: string;
  chatType: "channel" | "direct";
  originatingTo: string;
  messageThreadId?: string;
  sessionKey: string;
  abortSignal?: AbortSignal;
}): Promise<ChannelPreflightAudioResult | undefined> {
  return await matrixPreflightAudio.resolveDetailed({
    request: {
      ctx: {
        media: [{ path: params.mediaPath, contentType: params.mediaContentType }],
        Provider: "matrix",
        Surface: "matrix",
        OriginatingChannel: "matrix",
        OriginatingTo: params.originatingTo,
        AccountId: params.accountId,
        MessageThreadId: params.messageThreadId,
        ChatType: params.chatType,
        SessionKey: params.sessionKey,
      },
      cfg: params.cfg,
    },
    abortSignal: params.abortSignal,
  });
}

export async function sendMatrixPreflightAudioTranscriptEcho(params: {
  transcript: string;
  identity?: ChannelPreflightAudioResult["identity"];
  cfg: OpenClawConfig;
  accountId: string;
  originatingTo: string;
  messageThreadId?: string;
}): Promise<void> {
  await matrixPreflightAudio.send(params);
}
