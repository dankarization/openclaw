// Echo filter resolves whether a successful audio transcription result should
// be echoed back to the originating chat, based on execution identity.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { MediaAudioEchoMatchConfig } from "../config/types.tools.js";

/** Identity of the executed audio transcription backend. */
export type AudioTranscriptionIdentity = {
  provider?: string;
  model?: string;
  requestedBackend?: string;
  observedBackend?: string;
};

function matchesField(expected: string | undefined, actual: string | undefined): boolean {
  const normalizedExpected = normalizeOptionalLowercaseString(expected);
  if (!normalizedExpected) {
    return true;
  }
  const normalizedActual = normalizeOptionalLowercaseString(actual);
  return normalizedActual === normalizedExpected;
}

/**
 * True when every configured match field equals the executed backend identity.
 * An absent match config is a catch-all; an empty match object matches nothing
 * to avoid echoing on unverified identity.
 */
export function matchesAudioEchoIdentity(params: {
  match?: MediaAudioEchoMatchConfig;
  identity: AudioTranscriptionIdentity;
}): boolean {
  const { match, identity } = params;
  if (!match) {
    return true;
  }
  const hasCriteria = Boolean(
    match.provider ?? match.model ?? match.requestedBackend ?? match.observedBackend,
  );
  if (!hasCriteria) {
    return false;
  }
  return (
    matchesField(match.provider, identity.provider) &&
    matchesField(match.model, identity.model) &&
    matchesField(match.requestedBackend, identity.requestedBackend) &&
    matchesField(match.observedBackend, identity.observedBackend)
  );
}
