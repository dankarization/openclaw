import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withEnv, withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertA2aOutboundAgentAllowed } from "./outbound-acl.js";
import { sendA2aChannelText } from "./outbound.js";
import type { A2aCoreConfig, A2aPeerConfig } from "./types.js";

const PEER_URL = "https://hermes.example/a2a/v1";
const MAIN_SESSION = "agent:main:telegram:group:1";
const YOUGILE_SESSION = "agent:yougile:telegram:group:1";

const createConfig = (peer: A2aPeerConfig): A2aCoreConfig => ({
  channels: { a2a: { enabled: true, peers: { hermes: peer } } },
});

const denied = /limited to main/;

const send = (peer: A2aPeerConfig, sessionKey?: string, to = "hermes") =>
  sendA2aChannelText({ cfg: createConfig(peer), to, text: "hello", sessionKey });

beforeEach(() => {
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async (params) => ({
    response: Response.json({ jsonrpc: "2.0", result: { task: { id: "task-1" } } }),
    finalUrl: params.url,
    release: async () => {},
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A2A outbound source-agent authorization", () => {
  it("keeps account-level behavior when the peer does not opt in", async () => {
    await expect(send({ token: "t", url: PEER_URL })).resolves.toMatchObject({
      messageId: "task-1",
    });
    await expect(send({ token: "t", url: PEER_URL }, YOUGILE_SESSION)).resolves.toMatchObject({
      messageId: "task-1",
    });
  });

  it("allows a listed source agent", async () => {
    await expect(
      send({ token: "t", url: PEER_URL, allowedAgents: ["main"] }, MAIN_SESSION),
    ).resolves.toMatchObject({ messageId: "task-1" });
    expect(ssrfRuntime.fetchWithSsrFGuard).toHaveBeenCalledOnce();
  });

  it("refuses an unlisted source agent before any provider I/O", async () => {
    await expect(
      send({ token: "t", url: PEER_URL, allowedAgents: ["main"] }, YOUGILE_SESSION),
    ).rejects.toThrow(denied);
    expect(ssrfRuntime.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("refuses a peer that lists another agent", async () => {
    await expect(
      send({ token: "t", url: PEER_URL, allowedAgents: ["wiki"] }, MAIN_SESSION),
    ).rejects.toThrow(/limited to wiki/);
    expect(ssrfRuntime.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it.each([
    ["no session at all", undefined],
    ["an unscoped session key", "telegram:group:1"],
    ["a whitespace session key", "   "],
  ])("fails closed for %s while the peer lists agents", async (_label, sessionKey) => {
    await expect(
      send({ token: "t", url: PEER_URL, allowedAgents: ["main"] }, sessionKey),
    ).rejects.toThrow(denied);
    expect(ssrfRuntime.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("accepts an empty allowlist as not opting in", () => {
    expect(() =>
      assertA2aOutboundAgentAllowed({ peerName: "hermes", peer: { allowedAgents: [] } }),
    ).not.toThrow();
  });

  it("never reads the origin from a caller-supplied peer target", () => {
    // Authorization depends on the agent-scoped session key alone; a target that
    // happens to be named after an allowed agent cannot grant authority.
    expect(() =>
      assertA2aOutboundAgentAllowed({
        peerName: "main",
        peer: { allowedAgents: ["main"] },
        sessionKey: YOUGILE_SESSION,
      }),
    ).toThrow(denied);
  });

  it("keeps the credential failure ahead of the source-agent decision", async () => {
    await withStateDirEnv("a2a-outbound-acl-", async ({ stateDir }) => {
      const configPath = path.join(stateDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          channels: {
            a2a: {
              peers: {
                hermes: {
                  token: "inbound-token",
                  url: PEER_URL,
                  outboundToken: "${OPENCLAW_A2A_ACL_TEST_UNSET}",
                  allowedAgents: ["main"],
                },
              },
            },
          },
        }),
      );
      const cfg = withEnv(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_A2A_ACL_TEST_UNSET: undefined },
        () => getRuntimeConfig({ pin: false }),
      );

      await expect(
        sendA2aChannelText({ cfg, to: "hermes", text: "hello", sessionKey: YOUGILE_SESSION }),
      ).rejects.toThrow(/outboundToken reference did not resolve/);
      expect(ssrfRuntime.fetchWithSsrFGuard).not.toHaveBeenCalled();
    });
  });

  it("still refuses an unknown peer before any provider I/O", async () => {
    await expect(
      send({ token: "t", url: PEER_URL, allowedAgents: ["main"] }, MAIN_SESSION, "unknown-peer"),
    ).rejects.toThrow(/no url configured/);
    expect(ssrfRuntime.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
