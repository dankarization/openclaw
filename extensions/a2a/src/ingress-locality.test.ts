import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { VERSION } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginRuntimeStateForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { a2aChannelPlugin } from "./channel.js";
import { createA2aGatewayFixture } from "./gateway.test-support.js";
import { isLoopbackRemoteAddress } from "./ingress-locality.js";
import type { A2aChannelConfig } from "./types.js";

const activeAccounts: Array<{ controller: AbortController; lifecycle: Promise<unknown> }> = [];

afterEach(async () => {
  for (const { controller, lifecycle } of activeAccounts.splice(0)) {
    controller.abort();
    await lifecycle;
  }
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

async function startHarness(a2aConfig: Partial<A2aChannelConfig>, cfg: OpenClawConfig = {}) {
  const { registry, controller, ctx } = createA2aGatewayFixture({
    cfg,
    version: VERSION,
    config: { peers: { alpha: { token: "alpha-secret" } }, ...a2aConfig },
  });
  const lifecycle = Promise.resolve(a2aChannelPlugin.gateway!.startAccount!(ctx));
  activeAccounts.push({ controller, lifecycle });
  const handler = registry.httpRoutes.find((route) => route.path === "/a2a/v1")?.handler;
  if (!handler) {
    throw new Error("A2A account did not register its HTTP route");
  }
  return handler;
}

async function post(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>,
  remoteAddress: string,
) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "ingress-1",
    method: "GetTask",
    params: { id: "task-not-found" },
  });
  const request = createMockIncomingRequest([body]);
  request.method = "POST";
  request.url = "/a2a/v1";
  request.headers = {
    host: "gateway.example.test",
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    authorization: "Bearer alpha-secret",
  };
  Object.defineProperty(request.socket, "remoteAddress", { value: remoteAddress });
  const response = createMockServerResponse();
  const events = new EventEmitter();
  response.once = events.once.bind(events) as ServerResponse["once"];
  const originalEnd = response.end.bind(response);
  response.end = ((value?: string) => {
    originalEnd(value);
    events.emit("finish");
    return response;
  }) as ServerResponse["end"];

  await handler(request, response);
  return {
    status: response.statusCode,
    json: async (): Promise<unknown> => JSON.parse(response.body ?? ""),
  };
}

describe("A2A inbound locality", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.0.0.53", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["192.168.2.5", false],
    ["203.0.113.9", false],
    ["::ffff:192.168.2.5", false],
    ["", false],
    [undefined, false],
  ])("classifies %s as loopback=%s", (address, expected) => {
    expect(isLoopbackRemoteAddress(address as string | undefined)).toBe(expected);
  });

  it("keeps accepting any reachable peer when locality is not requested", async () => {
    const handler = await startHarness({});

    const reply = await post(handler, "203.0.113.9");

    // The peer token authenticated the request; the route answered the RPC.
    expect(reply.status).toBe(200);
    await expect(reply.json()).resolves.toMatchObject({ jsonrpc: "2.0" });
  });

  it("refuses a non-loopback peer before handling the request", async () => {
    const handler = await startHarness({ localIngressOnly: true });

    const reply = await post(handler, "203.0.113.9");

    expect(reply.status).toBe(403);
    await expect(reply.json()).resolves.toMatchObject({
      error: "A2A ingress is restricted to loopback",
    });
  });

  it("still serves the loopback peer when locality is requested", async () => {
    const handler = await startHarness({ localIngressOnly: true });

    const reply = await post(handler, "127.0.0.1");

    expect(reply.status).toBe(200);
    await expect(reply.json()).resolves.toMatchObject({ jsonrpc: "2.0" });
  });
});
