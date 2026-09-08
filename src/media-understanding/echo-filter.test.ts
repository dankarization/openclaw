// Echo filter tests cover backend identity matching for transcript echo
// gating: catch-all, provider/model/backend equality, and empty-match safety.
import { describe, expect, it } from "vitest";
import { matchesAudioEchoIdentity } from "./echo-filter.js";

describe("matchesAudioEchoIdentity", () => {
  it("matches everything when no match config is present (legacy behavior)", () => {
    expect(
      matchesAudioEchoIdentity({
        identity: { provider: "groq", model: "whisper-large-v3" },
      }),
    ).toBe(true);
  });

  it("matches local whisper CLI by provider", () => {
    expect(
      matchesAudioEchoIdentity({
        match: { provider: "whisper" },
        identity: { provider: "whisper", model: "whisper", requestedBackend: undefined },
      }),
    ).toBe(true);
  });

  it("does not match a cloud provider when local whisper is configured", () => {
    expect(
      matchesAudioEchoIdentity({
        match: { provider: "whisper" },
        identity: { provider: "groq", model: "whisper-large-v3" },
      }),
    ).toBe(false);
  });

  it("matches by model id for provider backends", () => {
    expect(
      matchesAudioEchoIdentity({
        match: { model: "gigaam-rnnt" },
        identity: { provider: "salute", model: "gigaam-rnnt" },
      }),
    ).toBe(true);
    expect(
      matchesAudioEchoIdentity({
        match: { model: "gigaam-rnnt" },
        identity: { provider: "salute", model: "gigaam-v2" },
      }),
    ).toBe(false);
  });

  it("matches by requested backend", () => {
    expect(
      matchesAudioEchoIdentity({
        match: { requestedBackend: "cpu" },
        identity: { provider: "whisper-cli", requestedBackend: "cpu", observedBackend: "cpu" },
      }),
    ).toBe(true);
    expect(
      matchesAudioEchoIdentity({
        match: { requestedBackend: "cpu" },
        identity: { provider: "whisper-cli", requestedBackend: "cuda" },
      }),
    ).toBe(false);
  });

  it("matches by observed backend", () => {
    expect(
      matchesAudioEchoIdentity({
        match: { observedBackend: "cuda" },
        identity: { provider: "whisper", observedBackend: "cuda" },
      }),
    ).toBe(true);
  });

  it("requires all configured fields to match", () => {
    expect(
      matchesAudioEchoIdentity({
        match: { provider: "whisper", requestedBackend: "cpu" },
        identity: { provider: "whisper", requestedBackend: "cpu", observedBackend: "cpu" },
      }),
    ).toBe(true);
    expect(
      matchesAudioEchoIdentity({
        match: { provider: "whisper", requestedBackend: "cpu" },
        identity: { provider: "whisper", requestedBackend: "cuda" },
      }),
    ).toBe(false);
  });

  it("matches nothing when the match object has no criteria (fail closed)", () => {
    expect(
      matchesAudioEchoIdentity({
        match: {},
        identity: { provider: "whisper" },
      }),
    ).toBe(false);
  });

  it("does not match when a configured field is absent from the identity", () => {
    expect(
      matchesAudioEchoIdentity({
        match: { requestedBackend: "cpu" },
        identity: { provider: "groq" },
      }),
    ).toBe(false);
  });

  it("compares case-insensitively", () => {
    expect(
      matchesAudioEchoIdentity({
        match: { provider: "Whisper" },
        identity: { provider: "WHISPER" },
      }),
    ).toBe(true);
  });
});
