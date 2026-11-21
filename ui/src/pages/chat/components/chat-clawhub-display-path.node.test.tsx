/* @vitest-environment jsdom */

// Node-driven integration: real Gateway transcript producers feed the UI reducer
// and renderer. Its server/state imports must not enter the browser module graph.

import { readFile } from "node:fs/promises";
import { For } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { projectChatDisplayMessagesWithState } from "../../../../../src/gateway/chat-display-projection.js";
import { projectSessionMessagePayload } from "../../../../../src/gateway/session-transcript-message.js";
import { createNestedToolActivity } from "../../../../../src/sessions/nested-tool-activity.js";
import { i18n } from "../../../i18n/index.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createClient } from "../../plugins/plugins-page.test-support.ts";
import { createInitializationContext } from "../chat-application-context.test-support.ts";
import { attachHistoryActivity } from "../chat-history-snapshot.ts";
import { createSessionEventState, emitGatewayEvent } from "../chat-state.test-support.ts";
import { buildItems } from "../chat-thread.test-support.ts";
import { AgentRunFrame } from "./chat-agent-run-frame.tsx";
import { projectTranscriptChain } from "./chat-transcript-message-index.ts";

// mock-isolation: Assistant-only producer proof must not initialize the unrelated profile database.
vi.mock("../../../../../src/gateway/current-user-profile-display.js", () => ({
  resolveCurrentUserProfileDisplay: () => ({ kind: "unresolved" }),
}));

beforeEach(async () => {
  await i18n.setLocale("en");
});

it.each(["history", "live", "live-before-run-adoption"])(
  "renders a persisted intermediate message-tool plugin recommendation through %s",
  async (path) => {
    const recommendation = {
      type: "clawhub",
      kind: "plugin",
      id: "ch_b3BlbmNsYXctdHJhdmVsLXRoZW1lcw",
      name: "Travel Themes",
      description: "Light and dark travel themes.",
      installed: false,
      official: false,
    };
    const text = (value: string) => ({ type: "text", text: value });
    const row = (seq: number, extra: Record<string, unknown>) => ({
      role: "assistant",
      timestamp: 1_780_000_000_000 + seq,
      stopReason: "stop",
      __openclaw: { id: `message-${seq}`, seq, runId: "setup-run" },
      ...extra,
    });
    // Synthetic persisted shape: the message tool stores model text separately
    // from display-only blocks, and final:false is an intermediate source reply.
    const persisted = [
      row(57, {
        content: [
          text("Expedia is installed but disabled; ask me to enable it when you are ready."),
        ],
      }),
      row(58, {
        api: "openclaw-transcript",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [],
        openclawDisplayContent: [recommendation],
        openclawDeliveryMirror: { kind: "message-tool-source-reply", final: false },
        openclawDelivery: { mediaUrls: [] },
      }),
      {
        ...createNestedToolActivity({
          runId: "setup-run",
          scopeId: "exec-scope",
          afterEntryId: "message-57",
          startOrder: 0,
          parentToolCallId: "exec-call",
          toolCallId: "message-call",
          toolName: "message",
          input: { action: "send", final: false, clawhub: { plugin: "openclaw-travel-themes" } },
          result: { content: [text("Sent.")] },
          isError: false,
          startedAt: 1_780_000_000_058,
          timestamp: 1_780_000_000_059,
        }),
        __openclaw: { id: "message-59", seq: 59, runId: "setup-run" },
      },
      row(62, {
        content: [
          {
            ...text("Where would you like to go?"),
            textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
          },
        ],
      }),
    ];
    const history = attachHistoryActivity(projectChatDisplayMessagesWithState(persisted));
    let messages: unknown[] = history.messages;
    if (path !== "history") {
      const { state } = createSessionEventState({
        sessionKey: "agent:travel-copilot:main",
        chatRunId: path === "live" ? "setup-run" : null,
      });
      for (const message of persisted) {
        const metadata = message["__openclaw"];
        const { payload } = projectSessionMessagePayload({
          message,
          messageId: metadata.id,
          messageSeq: metadata.seq,
          sessionKey: state.sessionKey,
          runId: "setup-run",
          sessionSnapshot: { hasActiveRun: metadata.seq !== 62 },
        });
        if (payload) {
          emitGatewayEvent(state, "session.message", payload);
        }
      }
      emitGatewayEvent(state, "chat", {
        sessionKey: state.sessionKey,
        runId: "setup-run",
        seq: 63,
        state: "final",
        message: persisted.at(-1),
      });
      messages = state.chatMessages;
    }
    const frames = projectTranscriptChain(
      buildItems({ sessionKey: "agent:travel-copilot:main", messages }),
      {
        sessionKey: "agent:travel-copilot:main",
        runWorking: false,
        searchActive: false,
        messages,
      },
    ).transcriptItems;

    const { client, request } = createClient(async (method) => {
      if (method === "plugins.catalog.get") {
        return {
          plugin: {
            id: recommendation.id,
            catalog: { name: recommendation.name, official: false, categories: [] },
            local: { installed: false, action: "install" },
          },
        };
      }
      throw new Error("Unexpected RPC: " + method);
    });
    const context = createInitializationContext(client);
    context.gateway.snapshot.hello = gatewayHelloForMethods(["plugins.catalog.get"]);
    const view = mountSolid(
      () => (
        <For each={frames}>
          {(frame) =>
            frame.kind === "agent-run-frame" ? (
              <AgentRunFrame
                frame={frame}
                options={{
                  streamOptions: {},
                  partDependencies: (part) => [part],
                  renderGroupOptions: () => ({ agentId: "travel-copilot", showReasoning: false }),
                  isWorkExpanded: () => false,
                  onToggleWork: () => {},
                }}
              />
            ) : undefined
          }
        </For>
      ),
      { wrapper: createSolidApplicationContextProvider(context).wrapper },
    );
    await waitForSolid(() =>
      expect(view.container.querySelectorAll("openclaw-chat-clawhub-card")).toHaveLength(1),
    );
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-clawhub-card__install")).not.toBeNull(),
    );
    expect(view.container.querySelector(".chat-clawhub-card__name")?.textContent).toContain(
      "Travel Themes",
    );
    expect(view.container.querySelector(".plugin-official-badge")).toBeNull();
    expect(view.container.querySelector(".chat-clawhub-card__install")?.textContent).toBe(
      "Install",
    );
    expect(view.container.textContent).toContain("Where would you like to go?");
    expect(view.container.textContent).not.toContain("Travel Themes: Available to install.");
    expect(request.mock.calls.map(([method, params]) => [method, params])).toContainEqual([
      "plugins.catalog.get",
      { id: recommendation.id },
    ]);
  },
);

it.each(["live", "reload"])(
  "renders a provisional local reply once after external delivery fails through %s",
  async (path) => {
    const sessionKey = "agent:main:telegram:group:-100123:thread:topic:991:sender:42";
    const runId = "telegram-error-run";
    const answer = "Visible even when Telegram is unavailable.";
    const persisted = {
      role: "assistant",
      api: "openclaw-transcript",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: answer }],
      openclawDeliveryMirror: { kind: "message-tool-source-reply", final: false },
      timestamp: 1_780_000_000_000,
      __openclaw: { id: "local-receipt", seq: 2, runId },
    };
    let messages: unknown[];
    if (path === "live") {
      const { state } = createSessionEventState({ sessionKey, chatRunId: runId });
      const { payload } = projectSessionMessagePayload({
        message: persisted,
        messageId: "local-receipt",
        messageSeq: 2,
        sessionKey,
        runId,
        sessionSnapshot: { hasActiveRun: true },
      });
      expect(payload).toBeDefined();
      emitGatewayEvent(state, "session.message", payload);
      // There is no successful message-tool result when the adapter throws.
      messages = state.chatMessages;
    } else {
      messages = attachHistoryActivity(projectChatDisplayMessagesWithState([persisted])).messages;
    }
    const frames = projectTranscriptChain(buildItems({ sessionKey, messages }), {
      sessionKey,
      runWorking: false,
      searchActive: false,
      messages,
    }).transcriptItems;
    const { client } = createClient(async () => {
      throw new Error("Unexpected RPC");
    });
    const context = createInitializationContext(client);
    const view = mountSolid(
      () => (
        <For each={frames}>
          {(frame) =>
            frame.kind === "agent-run-frame" ? (
              <AgentRunFrame
                frame={frame}
                options={{
                  streamOptions: {},
                  partDependencies: (part) => [part],
                  renderGroupOptions: () => ({ agentId: "main", showReasoning: false }),
                  isWorkExpanded: () => false,
                  onToggleWork: () => {},
                }}
              />
            ) : undefined
          }
        </For>
      ),
      { wrapper: createSolidApplicationContextProvider(context).wrapper },
    );
    await waitForSolid(() => expect(view.container.textContent).toContain(answer));
    expect(view.container.textContent?.split(answer)).toHaveLength(2);
  },
);

it.skipIf(!process.env.OPENCLAW_TERRA_198785_PROOF)(
  "renders the real Gateway WebSocket receipt and actual RPC reload exactly once",
  async () => {
    const proof = JSON.parse(await readFile(process.env.OPENCLAW_TERRA_198785_PROOF!, "utf8")) as {
      sessionKey: string;
      runId: string;
      text: string;
      event: unknown;
      history: unknown[];
    };
    const { state } = createSessionEventState({
      sessionKey: proof.sessionKey,
      chatRunId: proof.runId,
    });
    emitGatewayEvent(state, "session.message", proof.event);
    for (const messages of [state.chatMessages, proof.history]) {
      const frames = projectTranscriptChain(
        buildItems({ sessionKey: proof.sessionKey, messages }),
        {
          sessionKey: proof.sessionKey,
          runWorking: false,
          searchActive: false,
          messages,
        },
      ).transcriptItems;
      const { client } = createClient(async () => {
        throw new Error("Unexpected RPC");
      });
      const context = createInitializationContext(client);
      const view = mountSolid(
        () => (
          <For each={frames}>
            {(frame) =>
              frame.kind === "agent-run-frame" ? (
                <AgentRunFrame
                  frame={frame}
                  options={{
                    streamOptions: {},
                    partDependencies: (part) => [part],
                    renderGroupOptions: () => ({ agentId: "main", showReasoning: false }),
                    isWorkExpanded: () => false,
                    onToggleWork: () => {},
                  }}
                />
              ) : undefined
            }
          </For>
        ),
        { wrapper: createSolidApplicationContextProvider(context).wrapper },
      );
      await waitForSolid(() => expect(view.container.textContent).toContain(proof.text));
      expect(view.container.textContent?.split(proof.text)).toHaveLength(2);
      view.unmount();
    }
  },
);
