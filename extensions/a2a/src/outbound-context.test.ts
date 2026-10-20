import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendA2aChannelText } from "./outbound.js";
import type { A2aCoreConfig } from "./types.js";

const PEER_URL = "https://hermes.example/a2a/v1";
const cfg: A2aCoreConfig = {
  channels: { a2a: { enabled: true, peers: { hermes: { token: "t", url: PEER_URL } } } },
};

const bodies: Record<string, unknown>[] = [];
let peerContextId: string | undefined;

function readSentContextId(index: number): string {
  const params = bodies[index]?.params as { message?: { contextId?: string } } | undefined;
  const contextId = params?.message?.contextId;
  if (!contextId) {
    throw new Error(`send ${index} had no contextId`);
  }
  return contextId;
}

beforeEach(() => {
  bodies.length = 0;
  peerContextId = undefined;
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async (params) => {
    const body = params.init?.body;
    bodies.push(JSON.parse(typeof body === "string" ? body : "{}") as Record<string, unknown>);
    return {
      response: Response.json({
        jsonrpc: "2.0",
        result: {
          task: {
            id: "task-1",
            ...(peerContextId === undefined ? {} : { contextId: peerContextId }),
          },
        },
      }),
      finalUrl: PEER_URL,
      release: async () => {},
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A2A outbound task context isolation", () => {
  it("gives two independent new tasks their own remote context", async () => {
    const first = await sendA2aChannelText({ cfg, to: "hermes", text: "one" });
    const second = await sendA2aChannelText({ cfg, to: "hermes", text: "two" });

    expect(readSentContextId(0)).toMatch(/^ctx-oc-hermes-/);
    expect(readSentContextId(1)).toMatch(/^ctx-oc-hermes-/);
    expect(readSentContextId(0)).not.toBe(readSentContextId(1));
    expect(first.contextId).toBe(readSentContextId(0));
    expect(second.contextId).toBe(readSentContextId(1));
  });

  it("keeps an explicit continuation context for a new task in the same conversation", async () => {
    const sent = await sendA2aChannelText({
      cfg,
      to: "hermes",
      text: "continue",
      contextId: "ctx-existing-1",
    });

    expect(readSentContextId(0)).toBe("ctx-existing-1");
    expect(sent.contextId).toBe("ctx-existing-1");
  });

  it("prefers the peer-reported context for later receipt reads", async () => {
    peerContextId = "ctx-peer-1";

    const sent = await sendA2aChannelText({
      cfg,
      to: "hermes",
      text: "hello",
      contextId: "ctx-existing-2",
    });

    expect(sent.contextId).toBe("ctx-peer-1");
  });
});
