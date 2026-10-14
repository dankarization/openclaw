import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import { createMediaAttachmentCache } from "./runner.js";
import type { MediaAttachment } from "./types.js";

const MAX_ENTRIES = 128;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const RESULT_TTL_MS = 30_000;

type Entry = {
  promise: Promise<string | undefined>;
  expiresAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
};
const entries = new Map<string, Entry>();

export type TelegramVoiceIdentity = { chatId: string; messageId: string };

/** A failed or unhashable candidate falls back to ordinary per-account transcription. */
export async function telegramVoiceShareKey(params: {
  identity: TelegramVoiceIdentity;
  attachment: MediaAttachment;
  cfg: OpenClawConfig;
  sessionKey?: string;
  chatType?: string;
  localPathRoots: readonly string[];
}): Promise<string | undefined> {
  const { identity, attachment } = params;
  if (!identity.chatId || !identity.messageId || !attachment.path || attachment.url) {
    return undefined;
  }
  try {
    const config = JSON.stringify(params.cfg);
    if (!config) {
      return undefined;
    }
    const media = createMediaAttachmentCache([attachment], {
      localPathRoots: params.localPathRoots,
      includeDefaultLocalPathRoots: false,
    });
    let audioHash: string;
    try {
      const { buffer } = await media.getBuffer({
        attachmentIndex: attachment.index,
        maxBytes: MAX_AUDIO_BYTES,
        timeoutMs: 10_000,
      });
      if (!buffer.length) {
        return undefined;
      }
      audioHash = createHash("sha256").update(buffer).digest("hex");
    } finally {
      await media.cleanup();
    }
    // Hash the complete config, including provider/auth/privacy options. Never store
    // raw config, paths, chat IDs, or audio bytes in the process cache.
    return createHash("sha256")
      .update(
        JSON.stringify([
          "telegram",
          identity.chatId,
          identity.messageId,
          params.sessionKey,
          params.chatType,
          attachment.index,
          attachment.mime,
          attachment.kind,
          attachment.fileName,
          path.extname(attachment.path).toLowerCase(),
          audioHash,
          createHash("sha256").update(config).digest("hex"),
          createHash("sha256").update(JSON.stringify(process.env)).digest("hex"),
        ]),
      )
      .digest("hex");
  } catch {
    return undefined;
  }
}

/** Shares only the pure STT result; callers still own echo, media state, and admission. */
export function shareTelegramVoiceTranscript(
  key: string,
  transcribe: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const now = Date.now();
  for (const [candidate, entry] of entries) {
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
      clearTimeout(entry.expiryTimer);
      entries.delete(candidate);
    }
  }
  const existing = entries.get(key);
  if (existing) {
    return existing.promise;
  }
  if (entries.size >= MAX_ENTRIES) {
    return transcribe();
  }
  const entry: Entry = {
    promise: Promise.resolve().then(transcribe),
  };
  entries.set(key, entry);
  entry.promise = entry.promise.then(
    (transcript) => {
      if (entries.get(key) === entry) {
        if (transcript) {
          entry.expiresAt = Date.now() + RESULT_TTL_MS;
          entry.expiryTimer = setTimeout(() => {
            if (entries.get(key) === entry) {
              entries.delete(key);
            }
          }, RESULT_TTL_MS);
          entry.expiryTimer.unref();
        } else {
          entries.delete(key);
        }
      }
      return transcript;
    },
    (error: unknown) => {
      if (entries.get(key) === entry) {
        entries.delete(key);
      }
      throw error;
    },
  );
  return entry.promise;
}
