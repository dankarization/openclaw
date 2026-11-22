import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { isInternalRuntimeContextCarrierText } from "../../extensions/qa-lab/api.js";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  getSubagentRunByChildSessionKey,
  isSubagentSessionRunActive,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import * as followup from "../agents/tools/sessions-send-followup.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  closeProvider,
  listenProvider,
  writeToolCallResponse,
} from "./gateway-provider-fixture.test-support.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import * as inProcess from "./server-plugin-in-process-dispatch.js";
import {
  BROWSER_ORIGIN,
  CONTROL_UI_CLIENT,
  TRUSTED_BROWSER_HEADERS,
  browserProxyAuth,
  configureBrowserAuth,
  connectReq,
  openWs,
  rpcReq,
} from "./server.auth.test-helpers.js";
import { findSubagentSpawnReceipt } from "./server.subagent-stop-settlement.product.test-support.js";
import * as sessionSharingPolicy from "./session-sharing-policy.js";
import { agentCommandMock, gatewayReplyMock } from "./test-helpers.runtime-state.js";
import { startServer } from "./test-helpers.server.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

// Diagnostic only: observe the host owner and forward the original execution unchanged.
const gatewayRunOwnerTrace = vi.hoisted(() => [] as Array<{ child: boolean }>);
vi.mock("./agent-turn/agent-run-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-turn/agent-run-dispatch.js")>();
  return {
    ...actual,
    dispatchAgentRunFromGateway: (...args: Parameters<typeof actual.dispatchAgentRunFromGateway>) => {
      gatewayRunOwnerTrace.push({ child: args[0].ingressOpts.sessionKey?.includes(":subagent:") === true });
      return actual.dispatchAgentRunFromGateway(...args);
    },
  };
});

// Forward actual owners and capture only operation kind and synthetic child classification.
const spawnBoundaryTrace = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../agents/subagents/spawn/subagent-spawn-gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/subagents/spawn/subagent-spawn-gateway.js")>();
  return {
    ...actual,
    callNativeSubagentGateway: async (...args: Parameters<typeof actual.callNativeSubagentGateway>) => {
      const request = args[0];
      spawnBoundaryTrace.push({ stage: "native-gateway", method: request.method, child: typeof request.params.sessionKey === "string" && request.params.sessionKey.includes(":subagent:") });
      return await actual.callNativeSubagentGateway(...args);
    },
  };
});
vi.mock("./agent-turn/agent-run-execution-phase.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-turn/agent-run-execution-phase.js")>();
  return {
    ...actual,
    startAgentRunExecution: (...args: Parameters<typeof actual.startAgentRunExecution>) => {
      spawnBoundaryTrace.push({ stage: "start-execution", child: args[0].resolvedSessionKey?.includes(":subagent:") === true });
      return actual.startAgentRunExecution(...args);
    },
  };
});

type InputItem = {
  type?: string;
  role?: string;
  call_id?: string;
  output?: string;
  content?: unknown;
};
type ProviderRequest = {
  model?: string;
  input?: InputItem[];
  tools?: Array<{ type?: string; name?: string; function?: { name?: string } }>;
};
const MAIN_KEY = "agent:main:main";
const SPAWN_ID = "call_spawn_qa";
const SEND_ID = "call_send_before_revoke_qa";
const SEND_REVOKED_ID = "call_send_after_revoke_qa";

function inputText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value)
    ? value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
    : "";
}
function toolCall(
  response: import("node:http").ServerResponse,
  name: string,
  id: string,
  args: Record<string, unknown>,
) {
  writeToolCallResponse(
    response,
    {
      type: "function_call",
      id: "fc_" + id,
      call_id: id,
      name,
      arguments: JSON.stringify(args),
    },
    "resp_" + id,
    8,
    3,
  );
}
function parsedOutput(item: InputItem | undefined): Record<string, unknown> | undefined {
  if (!item?.output) return;
  return JSON.parse(item.output) as Record<string, unknown>;
}

// Only inspect the public fixture tool response, never request text or arbitrary nested fields.
function safePublicSpawnError(value: unknown): { code?: string; message?: string } | undefined {
  let code: string | undefined;
  let message: string | undefined;
  const clean = (raw: string): string | undefined => {
    // Reject whole oversized/structured fields rather than dumping unknown sections.
    if (raw.length > 1024 || /[\r\n{}\[\]]/.test(raw)) return undefined;
    return raw
      .replace(/\b(?:bearer|basic)\s+\S+/gi, "[redacted-auth]")
      .replace(
        /\b(?:api[_-]?key|token|password|secret|authorization|session[_-]?key)\s*[:=]\s*\S+/gi,
        "[redacted-secret]",
      )
      .replace(/\b(?:sk|pk|ghp|github_pat)-[A-Za-z0-9_-]+/gi, "[redacted-token]")
      .replace(/\bagent:[^\s,;]+/gi, "[redacted-session]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
      .replace(/https?:\/\/\S+/gi, "[redacted-url]")
      .replace(/(?:\/[^\s,;]+){2,}/g, "[redacted-path]")
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[redacted-id]")
      .replace(/\b[A-Za-z0-9_=-]{40,}\b/g, "[redacted-token]")
      .slice(0, 512);
  };
  const visit = (node: unknown, depth: number, errorContext = false): void => {
    if (depth > 4 || !node) return;
    if (typeof node === "string") {
      if (node.length > 4096) return;
      try {
        visit(JSON.parse(node) as unknown, depth + 1, errorContext);
      } catch {
        if (errorContext) message ??= clean(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const part of node.slice(0, 8)) visit(part, depth + 1, errorContext);
      return;
    }
    if (typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    if (typeof item.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(item.code))
      code ??= item.code;
    if (typeof item.error === "string") message ??= clean(item.error);
    const isError = errorContext || item.status === "error" || item.isError === true;
    if (isError && typeof item.message === "string") {
      message ??= clean(item.message);
    }
    // These are the fixture's documented tool-result wrappers; skip all other fields.
    for (const key of ["details", "error", "content", "text"]) {
      visit(item[key], depth + 1, isError || key === "error");
    }
  };
  visit(value, 0);
  return code || message ? { code, message } : undefined;
}

function safeRefusalShape(value: unknown): Record<string, unknown> {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  const denial = record?.denial;
  const safeDenial =
    denial && typeof denial === "object" ? (denial as Record<string, unknown>) : undefined;
  return {
    typeof: typeof value,
    constructorName:
      record?.constructor && typeof record.constructor === "function"
        ? record.constructor.name
        : undefined,
    ownKeys: record ? Object.keys(record).sort() : [],
    namePresent: typeof record?.name === "string",
    messageLength: typeof record?.message === "string" ? record.message.length : undefined,
    code: typeof record?.code === "string" ? record.code : undefined,
    denial: safeDenial
      ? {
          phase: safeDenial.phase,
          endpoint: safeDenial.endpoint,
          code: safeDenial.code,
        }
      : undefined,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayTestState();
});

it(
  "surfaces normalized child revocation through a named trusted-proxy real Gateway turn",
  { timeout: 120_000 },
  async () => {
    const home = await setupGatewayTempHome({ prefix: "openclaw-200155-real-gateway-proxy-" });
    const configPath = await createGatewayConfigPath(home.tempHome);
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    const providerRequests: ProviderRequest[] = [];
    const providerTrace: string[] = [];
    const gatewayDispatchTrace: string[] = [];
    const harnessTrace: Array<Record<string, unknown>> = [];
    let proofComplete = false;
    let realIngressCalls = 0;
    const policyTrace: Array<{
      incognito: boolean;
      actorKind?: string;
      actorProfileId?: string;
      code?: string;
    }> = [];
    const profileEmail = `qa-200155-${process.pid}-${randomUUID()}@example.test`;
    let profileId: string | undefined;
    let childKey: string | undefined;
    let childRunId: string | undefined;
    let childSessionId: string | undefined;
    let registryTurnSeen = false;
    let revokedRegistryTurnSeen = false;
    let childAgentDispatchSeen = false;
    let revokedChildDispatches = 0;
    let childAdmissionRefusal: unknown;
    let childAdmissionRefusalShape: Record<string, unknown> | undefined;
    let sendToolResult: Record<string, unknown> | undefined;
    let sendToolDetails: Record<string, unknown> | undefined;
    let sendToolTextPayload: Record<string, unknown> | undefined;
    let finalUserMessage = "";
    let mutated = false;
    let armRevocation = false;
    let sessionChangePublished = false;
    let gateway: Awaited<ReturnType<typeof startServer>> | undefined;
    let browserSocket: Awaited<ReturnType<typeof openWs>> | undefined;
    const providerServer = createServer((request, response) => {
      void (async () => {
        const body = JSON.parse(await readRequestText(request)) as ProviderRequest;
        providerRequests.push(body);
        const input = body.input ?? [];
        const userTexts = input
          .filter((item) => item.role === "user")
          .map((item) => inputText(item.content));
        const userText =
          userTexts.findLast((text) => !isInternalRuntimeContextCarrierText(text)) ?? "";
        const qaMarkers = [
          "QA_SPAWN_CHILD_200155",
          "QA_SEND_CHILD_POSITIVE_200155",
          "QA_SEND_REVOKED_CHILD_200155",
          "QA_CHILD_TASK_200155",
          "QA_CHILD_POSITIVE_CONTROL_200155",
          "QA_CHILD_AFTER_REVOCATION_200155",
        ].filter((marker) => userTexts.some((text) => text.includes(marker)));
        const toolNames = (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name);
        providerTrace.push(JSON.stringify({ qaMarkers }));
        harnessTrace.push({
          event: "provider-request",
          modelIsFixture: body.model === "qa-200155-real",
          qaMarkers,
          selectedQaMarkers: qaMarkers.filter((marker) => userText.includes(marker)),
          lastUserIsInternalCarrier:
            userTexts.length > 0 &&
            isInternalRuntimeContextCarrierText(userTexts[userTexts.length - 1]!),
          toolCount: toolNames.length,
          spawnOffered: toolNames.includes("sessions_spawn"),
          sendOffered: toolNames.includes("sessions_send"),
          dispatchActionOffered: toolNames.includes("dispatch_action"),
          outputIds: input
            .filter((item) => item.type === "function_call_output")
            .map((item) => item.call_id)
            .filter((id) => id === SPAWN_ID || id === SEND_ID || id === SEND_REVOKED_ID),
        });
        const outputFor = (callId: string) =>
          parsedOutput(
            input.findLast(
              (item) => item.type === "function_call_output" && item.call_id === callId,
            ),
          );
        if (userText.includes("QA_SEND_") && userText.includes("200155")) {
          const revokedAttempt = userText.includes("QA_SEND_REVOKED_CHILD_200155");
          const sendCallId = revokedAttempt ? SEND_REVOKED_ID : SEND_ID;
          const sendOutput = outputFor(sendCallId);
          if (sendOutput) {
            sendToolResult = sendOutput;
            sendToolDetails = (sendToolResult.details ?? sendToolResult) as Record<string, unknown>;
            const parts = sendToolResult.content as
              | Array<{ type?: string; text?: string }>
              | undefined;
            // Responses transports serialize tool content directly as output;
            // some test transports retain the original content wrapper instead.
            const jsonText = parts?.find((part) => part.type === "text")?.text ??
              input.findLast((item) => item.type === "function_call_output" && item.call_id === sendCallId)?.output;
            sendToolTextPayload = jsonText
              ? (JSON.parse(jsonText) as Record<string, unknown>)
              : undefined;
            const access = sendToolDetails.followupAccess as { code?: string } | undefined;
            finalUserMessage = revokedAttempt
              ? "Continuation denied (" +
                String(access?.code ?? "unknown") +
                "). " +
                String(sendToolDetails.error ?? "The continuation was refused.")
              : "Positive continuation completed.";
            writeOpenAiResponsesText(response, {
              text: finalUserMessage,
              messageId: randomUUID(),
              responseId: randomUUID(),
            });
            return;
          }
          if (!childKey) throw new Error("Missing actual sessions_spawn receipt");
          toolCall(response, "sessions_send", sendCallId, {
            sessionKey: childKey,
            message: revokedAttempt
              ? "QA_CHILD_AFTER_REVOCATION_200155"
              : "QA_CHILD_POSITIVE_CONTROL_200155",
            mode: "followup",
            timeoutSeconds: 30,
            watch: true,
          });
          return;
        }
        if (userText.includes("QA_SPAWN_CHILD_200155")) {
          const spawnOutput = outputFor(SPAWN_ID);
          if (spawnOutput) {
            const spawnReceipt = findSubagentSpawnReceipt(spawnOutput);
            const serialized = JSON.stringify(spawnOutput).toLowerCase();
            harnessTrace.push({
              event: "spawn-output",
              receiptFound: Boolean(spawnReceipt),
              topLevelKeys: Object.keys(spawnOutput).sort(),
              hasError: serialized.includes("error"),
              hasDenied: /denied|forbidden|not authorized|not allowed/.test(serialized),
              hasUnknownTool: /unknown tool|tool not found|not available/.test(serialized),
              hasSchemaError: /invalid|validation|schema/.test(serialized),
              hasAccepted: serialized.includes("accepted"),
              publicError: safePublicSpawnError(spawnOutput),
            });
            childKey = spawnReceipt?.childSessionKey;
            childRunId = spawnReceipt?.runId;
            writeOpenAiResponsesText(response, {
              text: "The isolated child is ready.",
              messageId: randomUUID(),
              responseId: randomUUID(),
            });
            return;
          }
          toolCall(response, "sessions_spawn", SPAWN_ID, {
            task: "QA_CHILD_TASK_200155",
            label: "qa-200155-child",
            context: "isolated",
            visible: true,
            mode: "run",
            expectsCompletionMessage: false,
          });
          return;
        }
        if (userText.includes("QA_CHILD_TASK_200155")) {
          writeOpenAiResponsesText(response, {
            text: "Child task ready.",
            messageId: randomUUID(),
            responseId: randomUUID(),
          });
          return;
        }
        if (userText.includes("QA_CHILD_POSITIVE_CONTROL_200155")) {
          writeOpenAiResponsesText(response, {
            text: "Positive child continuation executed.",
            messageId: randomUUID(),
            responseId: randomUUID(),
          });
          return;
        }
        writeOpenAiResponsesText(response, {
          text: "No scripted QA turn matched.",
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
      })().catch((error: unknown) => {
        harnessTrace.push({
          event: "provider-error",
          errorType: error instanceof Error ? error.name : typeof error,
        });
        if (!response.headersSent) response.writeHead(500);
        response.end("QA provider fixture failed");
      });
    });

    try {
      const provider = buildMockOpenAiResponsesProvider(
        await listenProvider(providerServer),
        "qa-200155-real",
      );
      const auth = browserProxyAuth();
      const roles = {
        default: "staff",
        definitions: {
          staff: {
            sessions: { others: "none" as const },
            agents: "*" as const,
            scopes: ["operator.read", "operator.write"],
          },
        },
      };
      await configureBrowserAuth(auth, { roles });
      const profile = ensureProfileForEmail(profileEmail);
      await setUserProfileRole(profile.id, "staff");
      profileId = profile.id;
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: home.workspaceDir,
            skipBootstrap: true,
            model: { primary: provider.modelRef },
            subagents: { allowAgents: ["*"] },
          },
        },
        gateway: {
          auth,
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
          roles,
        },
        hooks: { enabled: false },
        models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
        plugins: { slots: { memory: "none" }, enabled: false },
        session: { mainKey: "main", scope: "per-sender" },
        tools: {
          profile: "coding",
          toolSearch: false,
          agentToAgent: { enabled: true },
          sessions: { visibility: "all" },
        },
      };
      const { writeConfigFile } = await import("../config/config.js");
      await writeConfigFile(cfg);
      // test-helpers.server installs a no-op command mock. Delegate its full
      // Gateway ingress arguments to the real command for this proof only.
      const realCommand =
        await vi.importActual<typeof import("../commands/agent.js")>("../commands/agent.js");
      agentCommandMock.mockImplementation(async (...args) => {
        realIngressCalls += 1;
        harnessTrace.push({
          event: "real-command-ingress",
          child: args[0]?.sessionKey?.includes(":subagent:") === true,
        });
        return await realCommand.agentCommandFromGatewayIngress(
          ...(args as unknown as Parameters<typeof realCommand.agentCommandFromGatewayIngress>),
        );
      });
      // Visible sessions create their opening turn through chat.send, whose
      // shared fixture defaults to a no-op reply. Retain the real reply owner.
      const realReply = await vi.importActual<
        typeof import("../auto-reply/reply/get-reply-from-config.runtime.js")
      >("../auto-reply/reply/get-reply-from-config.runtime.js");
      gatewayReplyMock.mockImplementation((...args) => realReply.getReplyFromConfig(...args));
      gateway = await startServer(undefined, { auth, bind: "loopback" });
      await gateway.server.startupSettled;
      browserSocket = await openWs(gateway.port, {
        ...TRUSTED_BROWSER_HEADERS,
        "x-forwarded-user": profileEmail,
      });
      const connected = await connectReq(browserSocket, {
        prePairDevice: true,
        client: CONTROL_UI_CLIENT,
        browserOrigin: BROWSER_ORIGIN,
        skipDefaultAuth: true,
        scopes: ["operator.read", "operator.write"],
      });
      expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
      expect((connected.payload as { auth?: { scopes?: string[] } }).auth?.scopes).toEqual([
        "operator.read",
        "operator.write",
      ]);
      const self = await rpcReq<UsersSelfResult>(browserSocket, "users.self");
      expect(self.ok, JSON.stringify(self.error)).toBe(true);
      expect(self.payload?.profile).toMatchObject({ id: profileId, role: "staff" });

      const originalIncognitoAuthorization = sessionSharingPolicy.authorizeIncognitoSessionTarget;
      vi.spyOn(sessionSharingPolicy, "authorizeIncognitoSessionTarget").mockImplementation(
        (params) => {
          const error = originalIncognitoAuthorization(params);
          const targetEntry = params.target?.entry;
          if (
            childSessionId &&
            params.sessionKey === childKey &&
            targetEntry?.sessionId === childSessionId
          ) {
            const actor = params.client?.internal?.operatorRoleActor;
            policyTrace.push({
              incognito: targetEntry.incognito === true,
              actorKind: actor?.kind,
              actorProfileId: actor?.kind === "operator" ? actor.profileId : undefined,
              code: error?.code,
            });
          }
          return error;
        },
      );

      const originalDispatch = inProcess.dispatchGatewayMethodInProcess;
      const dispatchSpy = vi
        .spyOn(inProcess, "dispatchGatewayMethodInProcess")
        .mockImplementation(async (method, params, options) => {
          if (armRevocation && method === "agent" && params.sessionKey === childKey) {
            revokedChildDispatches += 1;
          }
          gatewayDispatchTrace.push(
            JSON.stringify({
              method,
              sessionKey: params.sessionKey,
              hasSessionMutationCommitGuard:
                typeof options?.sessionMutationCommitGuard === "function",
            }),
          );
          let dispatchOptions = options;
          if (armRevocation && !mutated && method === "agent" && params.sessionKey === childKey) {
            childAgentDispatchSeen = true;
            const commitGuard = options?.sessionMutationCommitGuard;
            expect(commitGuard).toBeTypeOf("function");
            const entry = loadSessionEntryReadOnly({
              agentId: "main",
              sessionKey: childKey!,
            });
            expect(entry).toBeDefined();
            expect(entry?.spawnedBy).toBeTypeOf("string");
            expect(entry?.spawnedBy).not.toBe(childKey);
            let published = false;
            const stopPublication = sessionChanges.subscribeProjection((change) => {
              if (!("all" in change) && change.sessionKey === childKey) {
                published = true;
              }
            });
            try {
              const updated = await patchSessionEntryCore(
                { agentId: "main", sessionKey: childKey! },
                (current) =>
                  current.sessionId === childSessionId
                    ? { incognito: true, updatedAt: Date.now() + 1 }
                    : null,
                { requireWriteSuccess: true, preserveActivity: true },
              );
              expect(updated?.incognito).toBe(true);
              expect(published).toBe(true);
              sessionChangePublished = published;
            } finally {
              stopPublication();
            }
            mutated = true;
            dispatchOptions = {
              ...options,
              sessionMutationCommitGuard: () => {
                try {
                  commitGuard();
                } catch (error) {
                  childAdmissionRefusal = error;
                  childAdmissionRefusalShape = safeRefusalShape(error);
                  throw error;
                }
              },
            };
          }
          try {
            const result = await originalDispatch(method, params, dispatchOptions);
            if (mutated && method === "agent" && params.sessionKey === childKey) {
              childAdmissionRefusal = result;
            }
            return result;
          } catch (error) {
            if (mutated && method === "agent" && params.sessionKey === childKey) {
              childAdmissionRefusal = error;
            }
            throw error;
          }
        });
      const originalFollowup = followup.dispatchSessionsSendFollowup;
      vi.spyOn(followup, "dispatchSessionsSendFollowup").mockImplementation(async (...args) => {
        const options = args[2];
        registryTurnSeen ||= Boolean(
          options.requesterTurnRunId && options.ownChild && options.nativeChild && options.watch,
        );
        if (armRevocation) {
          revokedRegistryTurnSeen ||= Boolean(
            options.requesterTurnRunId && options.ownChild && options.nativeChild && options.watch,
          );
        }
        return await originalFollowup(...args);
      });

      const runTurn = async (message: string) => {
        const id = randomUUID();
        const accepted = await rpcReq<{ runId?: string; status?: string }>(
          browserSocket!,
          "agent",
          {
            sessionKey: MAIN_KEY,
            message,
            deliver: false,
            idempotencyKey: id,
          },
        );
        harnessTrace.push({
          event: "agent-accepted",
          turn: message,
          ok: accepted.ok,
          status: accepted.payload?.status,
          errorCode: accepted.error?.code,
        });
        expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
        expect(accepted.payload?.status).toBe("accepted");
        const done = await rpcReq<{ status?: string }>(
          browserSocket!,
          "agent.wait",
          {
            runId: accepted.payload?.runId ?? id,
            timeoutMs: 45_000,
          },
          50_000,
        );
        harnessTrace.push({
          event: "agent-wait",
          turn: message,
          ok: done.ok,
          status: done.payload?.status,
          errorCode: done.error?.code,
        });
        expect(done.ok, JSON.stringify(done.error)).toBe(true);
        expect(done.payload?.status).toBe("ok");
      };

      await runTurn("QA_SPAWN_CHILD_200155");
      expect(realIngressCalls).toBeGreaterThan(0);
      expect(childKey, "spawn receipt missing; see QA_200155_TRACE in finally").toBeTypeOf(
        "string",
      );
      expect(childKey).toMatch(/^agent:main:/);
      expect(childKey).not.toBe(MAIN_KEY);
      expect(childRunId).toBeTypeOf("string");
      const registryRun = await getSubagentRunByChildSessionKey(childKey!, "main");
      expect(registryRun).toMatchObject({ runId: childRunId, childSessionKey: childKey });
      expect(registryRun?.requesterSessionKey).not.toBe(childKey);
      const parentEntry = loadSessionEntryReadOnly({ agentId: "main", sessionKey: MAIN_KEY });
      const spawnedChildEntry = loadSessionEntryReadOnly({
        agentId: "main",
        sessionKey: childKey!,
      });
      childSessionId = spawnedChildEntry?.sessionId;
      expect(parentEntry?.createdActor).toMatchObject({
        type: "human",
        source: "profile",
        id: profileId,
      });
      expect(spawnedChildEntry?.createdActor).toMatchObject({
        type: "agent",
        id: "main",
        delegatedBy: { type: "human", source: "profile", id: profileId },
      });
      expect(childSessionId).toBeTypeOf("string");
      expect(spawnedChildEntry?.incognito).not.toBe(true);

      // The spawn receipt and parent completion do not prove the child is idle.
      // Wait for the child's own Gateway run and verify terminal registry state before
      // arming revocation, so sessions_send cannot take the active-run fallback.
      const childDone = await rpcReq<{ status?: string }>(
        browserSocket!,
        "agent.wait",
        {
          runId: childRunId!,
          timeoutMs: 45_000,
        },
        50_000,
      );
      expect(childDone.ok, JSON.stringify(childDone.error)).toBe(true);
      expect(childDone.payload?.status).toBe("ok");
      const terminalChildRun = await getSubagentRunByChildSessionKey(childKey!, "main");
      expect(terminalChildRun?.execution.endedAt).toBeTypeOf("number");
      expect(isSubagentSessionRunActive(childKey!, "main")).toBe(false);
      expect(
        providerTrace.some((trace) => trace.includes("QA_CHILD_TASK_200155")),
        JSON.stringify({ providerTrace, terminalChildRun }),
      ).toBe(true);

      // A named, non-admin profile must first demonstrate real access to its spawned child.
      await runTurn("QA_SEND_CHILD_POSITIVE_200155");
      expect(sendToolDetails).toBeDefined();
      expect(sendToolDetails?.followupAccess).toBeUndefined();
      expect(
        providerTrace.some((trace) => trace.includes("QA_CHILD_POSITIVE_CONTROL_200155")),
      ).toBe(true);
      expect(
        policyTrace.some(
          (item) =>
            !item.incognito &&
            item.actorKind === "operator" &&
            item.actorProfileId === profileId &&
            !item.code,
        ),
        JSON.stringify(policyTrace),
      ).toBe(true);
      expect(isSubagentSessionRunActive(childKey!, "main")).toBe(false);
      sendToolResult = undefined;
      sendToolDetails = undefined;
      sendToolTextPayload = undefined;

      armRevocation = true;
      await runTurn("QA_SEND_REVOKED_CHILD_200155");

      expect(registryTurnSeen).toBe(true);
      expect(revokedRegistryTurnSeen).toBe(true);
      expect(childAgentDispatchSeen).toBe(true);
      expect(
        mutated,
        JSON.stringify({ gatewayDispatchTrace, sendToolResult, registryTurnSeen, providerTrace }),
      ).toBe(true);
      expect(sessionChangePublished).toBe(true);
      expect(revokedChildDispatches).toBe(1);
      // The retained custody owner can reject its changed source before a
      // separate incognito-policy helper is called again. Assert that actual
      // commit-boundary denial, and retain the public/side-effect checks below.
      expect(childAdmissionRefusal).toMatchObject({
        phase: "revocation",
        endpoint: "child",
        code: "INVALID_REQUEST",
      });
      const revokedEntry = loadSessionEntryReadOnly({ agentId: "main", sessionKey: childKey! });
      expect(revokedEntry?.incognito).toBe(true);
      expect(revokedEntry?.createdActor).toMatchObject({
        type: "agent",
        id: "main",
        delegatedBy: { type: "human", source: "profile", id: profileId },
      });
      expect(
        providerTrace.some((trace) => trace.includes("QA_CHILD_AFTER_REVOCATION_200155")),
      ).toBe(false);

      // Assert the actual model-visible JSON output and normalized denial.
      expect(sendToolDetails).toMatchObject({
        status: "error",
        followupAccess: { phase: "revocation", endpoint: "child", code: "INVALID_REQUEST" },
      });
      expect(sendToolTextPayload).toMatchObject(sendToolDetails);
      expect(JSON.stringify({ details: sendToolDetails, text: sendToolTextPayload })).toContain(
        '"code":"INVALID_REQUEST"',
      );
      expect(JSON.stringify({ details: sendToolDetails, text: sendToolTextPayload })).not.toContain(
        "sessionKey",
      );
      expect(JSON.stringify({ details: sendToolDetails, text: sendToolTextPayload })).not.toContain(
        profileId!,
      );
      expect(finalUserMessage).toContain(
        "authorized operator to check continuation access for both conversations",
      );
      expect(finalUserMessage).toContain("INVALID_REQUEST");

      const history = await rpcReq<{
        messages?: Array<{ role?: unknown; content?: unknown }>;
      }>(browserSocket!, "chat.history", {
        sessionKey: MAIN_KEY,
        limit: 100,
      });
      expect(history.ok, JSON.stringify(history.error)).toBe(true);
      const visibleAssistantText = (history.payload?.messages ?? [])
        .filter((message) => message.role === "assistant")
        .map((message) => inputText(message.content))
        .join("\n");
      expect(visibleAssistantText).toContain(finalUserMessage);
      expect(providerRequests.length).toBeGreaterThan(3);
      dispatchSpy.mockRestore();
      proofComplete = true;
    } finally {
      if (!proofComplete) {
        // Test-generated markers and booleans only: no prompts, session keys, IDs, or tool payloads.
        console.error(
          "QA_200155_TRACE",
          JSON.stringify({
            harnessTrace,
            providerRequestCount: providerRequests.length,
            agentCommandCalls: agentCommandMock.mock.calls.length,
            hostRunOwnerCalls: gatewayRunOwnerTrace,
            spawnBoundaryTrace,
            realIngressCalls,
            childReceiptFound: Boolean(childKey && childRunId),
            childSessionFound: Boolean(childSessionId),
            registryTurnSeen,
            revokedRegistryTurnSeen,
            childAgentDispatchSeen,
            mutated,
            sessionChangePublished,
            refusalShape: childAdmissionRefusalShape,
          }),
        );
      }
      browserSocket?.close();
      if (gateway) {
        await gateway.server
          .close({ reason: "PR 200155 isolated real-Gateway proof" })
          .catch(() => undefined);
        gateway.envSnapshot.restore();
      }
      await closeProvider(providerServer);
      agentCommandMock.mockReset().mockResolvedValue(undefined);
      gatewayReplyMock.mockReset().mockResolvedValue(undefined);
      home.envSnapshot.restore();
      await removeGatewayTempHome(home.tempHome);
    }
  },
);
