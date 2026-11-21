import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import {
  resolveTelegramConversationRoute,
  resolveTelegramTargetSession,
} from "../../../extensions/telegram/src/conversation-route.js";
import {
  resolveTelegramTestUpload,
  useTelegramHttpFixture,
} from "../../../extensions/telegram/src/send.telegram-http.test-support.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createMessageToolAsync } from "../../agents/tools/message-tool-execution.js";
import { stubMessageSecrets } from "../../agents/tools/message-tool-execution.test-support.js";
import { getRequesterProfile } from "../../auto-reply/requester-profile.js";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "../../channels/message-access/host-ingress.test-support.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { attributeDelegatedSessionCreator } from "../../config/sessions/session-entry-provenance.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../../state/user-channel-identities.js";
import { publishCanonicalUserChannelPolicy } from "../../state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../message-action-turn-capability.js";
import { pairedOperator, recoveryFixture } from "../operator-run-recovery.test-support.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createRequestGatewayMethodRegistry } from "../server-methods.js";
import { withInProcessGatewayRead } from "../server-plugin-in-process-dispatch.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { createSessionTargetPolicyAuthorizer } from "../session-sharing-authorization.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionAgentRun,
} from "../session-sharing-policy.js";
import { sendHandlers } from "./send.js";

const agentId = "member-tg";
const sessionId = "member-telegram-source";
const accountId = "work";
const senderId = "4242";
const telegramHttp = useTelegramHttpFixture();
const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "api.ts",
});

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

it.each([
  "linked",
  "unattributed",
  "wrong-account",
  "raw-linked",
  "raw-view",
  "raw-agent-denied",
  "raw-sandbox-denied",
  "raw-restricted",
  "raw-revoked-at-commit",
  "raw-role-revoked-at-commit",
  "raw-replaced-at-admission",
] as const)(
  "handles a member-specific Telegram source attachment with %s creator identity",
  async (scenario) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const rawScenario = scenario.startsWith("raw-");
      const expectedDenied =
        scenario === "raw-agent-denied" ||
        scenario === "raw-sandbox-denied" ||
        scenario === "raw-restricted" ||
        scenario === "raw-revoked-at-commit" ||
        scenario === "raw-role-revoked-at-commit" ||
        scenario === "raw-replaced-at-admission";
      const person = ensureProfileForEmail("member-202741@example.test");
      const snapshotPerson = ensureProfileForEmail("snapshot-admin-202741@example.test");
      const storePath = path.join(state.stateDir, "agents", agentId, "sessions", "sessions.json");
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {}, [agentId]: {} },
          defaults: { workspace: state.workspaceDir },
        },
        session: { store: storePath, dmScope: "per-channel-peer" },
        bindings: [{ agentId, match: { channel: "telegram", accountId } }],
        channels: {
          telegram: {
            enabled: true,
            apiRoot: telegramHttp.cfg.channels.telegram.apiRoot,
            accounts: {
              work: {
                enabled: true,
                botToken: "123456:synthetic-fixture-token",
                apiRoot: telegramHttp.cfg.channels.telegram.apiRoot,
              },
              other: {
                enabled: true,
                botToken: "654321:synthetic-fixture-token",
                apiRoot: telegramHttp.cfg.channels.telegram.apiRoot,
              },
            },
          },
        },
        gateway: {
          roles: {
            default: "staff",
            definitions: {
              staff: {
                agents: ["main"],
                scopes: [
                  "operator.read",
                  "operator.write",
                  "operator.approvals",
                  "operator.questions",
                ],
                sessions: { others: "none" },
              },
              member: {
                agents: scenario === "raw-agent-denied" ? [] : [agentId],
                ...(scenario === "raw-sandbox-denied" ? { sandbox: "required" as const } : {}),
                scopes: [
                  "operator.read",
                  "operator.write",
                  "operator.approvals",
                  "operator.questions",
                ],
                sessions: { others: scenario === "raw-view" ? "view" : "none" },
              },
              admin: { agents: "*", scopes: ["operator.admin"], sessions: { others: "write" } },
            },
          },
        },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg, cfg);
      // Mirror Gateway startup: the channel identity owner only issues a recovery
      // reference against the currently published gateway policy.
      await publishCanonicalUserChannelPolicy(cfg.gateway, cfg.commands?.ownerAllowFrom);
      const nativeRoute = await resolveTelegramConversationRoute({
        cfg,
        accountId,
        chatId: Number(senderId),
        isGroup: false,
        threadSpec: { id: 77, scope: "dm" },
        senderId,
      });
      expect(nativeRoute.route.agentId).toBe(agentId);
      const key = resolveTelegramTargetSession({
        cfg,
        route: nativeRoute.route,
        bindingMode: nativeRoute.bindingMode,
        chatId: Number(senderId),
        isGroup: false,
        senderId,
        dmThreadId: 77,
        botHasTopicsEnabled: true,
      });
      expect(key).toBe(`agent:${agentId}:telegram:direct:${senderId}:thread:${senderId}:77`);
      setUserProfileRole(snapshotPerson.id, "admin");
      const recovery = await recoveryFixture(state.stateDir, snapshotPerson.id, {
        config: cfg,
        device: pairedOperator(),
        scopes: ["operator.read", "operator.write", "operator.admin"],
      });
      expect(recovery.snapshot.assignedRole).toBe("admin");
      expect(recovery.snapshot.scopes).toContain("operator.admin");
      setUserProfileRole(person.id, "member");
      linkUserChannelIdentity(person.id, {
        channelId: "telegram",
        accountId: scenario === "wrong-account" ? "other" : accountId,
        senderId,
      });
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      context.resolveGatewayContext = () => context;
      context.validateAgentRuntimeApprovalAuthority =
        createAgentRuntimeApprovalAuthorityValidator();
      const host = createHostIngressFixture("telegram", cfg, context);
      const message = ingressMessage("telegram", key, senderId, {
        accountId,
        route: { agentId, routeSessionKey: key },
        conversation: { kind: "direct", id: senderId, threadId: "77" },
        reply: { to: `telegram:${senderId}`, messageThreadId: 77 },
      });
      const ingress = await host.ingress.resolveStable(
        ingressInput(message, { identity: { authentication: "verified" } }),
      );
      const channelContext = host.buildContext({ ...message, channelIngress: ingress });
      const linked = getRequesterProfile(channelContext);
      expect(linked?.id === person.id).toBe(scenario !== "wrong-account");
      const creator = { type: "human", source: "channel", id: `telegram:${senderId}` } as const;
      const attributed =
        scenario === "linked" ? attributeDelegatedSessionCreator(creator, linked?.id) : creator;
      const scope = { agentId, sessionKey: key, sessionId, storePath };
      await replaceSessionEntry(scope, {
        sessionId,
        updatedAt: 1,
        createdVia: "channel",
        createdActor: attributed,
        ...(scenario === "raw-restricted" ? { access: { mode: "creator" as const } } : {}),
        delivery: normalizeSessionDeliveryState({
          route: {
            channel: "telegram",
            accountId,
            target: { to: `telegram:${senderId}`, chatType: "direct" },
            thread: { id: 77, kind: "topic", source: "turn" },
          },
          context: { channel: "telegram", to: `telegram:${senderId}`, accountId, threadId: "77" },
          origin: {
            provider: "telegram",
            from: `telegram:direct:${senderId}`,
            to: `telegram:${senderId}`,
            accountId,
            chatType: "direct",
            threadId: 77,
          },
        }),
      });
      await patchSessionEntryCore(
        scope,
        () => ({ operatorSources: { [snapshotPerson.id]: recovery.snapshot } }),
        { skipMaintenance: true },
      );
      const client = createOperatorClient({
        profileId: person.id,
        scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
      });
      const projection = await createSessionRowProjection({
        cfg,
        context,
        getModelCatalog: async () => undefined,
      });
      bindSessionRowProjection(context, () => projection);
      const plugin: ChannelPlugin = {
        ...telegramPlugin,
        actions: {
          ...telegramPlugin.actions!,
          // Keep the real gateway execution mode, then use the canonical Telegram
          // adapter and its real HTTP transport against the loopback Bot API.
          supportsAction: () => false,
          handleAction: async () => {
            throw new Error("unexpected native Telegram action transport");
          },
        },
        outbound: {
          ...telegramPlugin.outbound!,
          deliveryMode: "direct",
          sendPayload: undefined,
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]),
      );
      const agentWorkspace = resolveAgentWorkspaceDir(cfg, agentId);
      const mediaPath = path.join(agentWorkspace, "fixture-202741.png");
      await fs.mkdir(agentWorkspace, { recursive: true });
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
        "base64",
      );
      await fs.writeFile(mediaPath, pngBytes);
      const runId = "member-source-attachment";
      const run = createOperationalRunInstanceRef(runId);
      const delegated = claimAgentRunDelegatedAuthority(run);
      const capability = mintMessageActionTurnCapability({
        agentId,
        runId,
        sessionId,
        sessionKey: key,
        sourceReplySessionKey: key,
        requesterAccountId: accountId,
        requesterSenderId: senderId,
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: senderId,
          currentMessagingTarget: senderId,
          currentChatType: "direct",
          currentThreadTs: "77",
        },
      });
      try {
        await projection.ensureMaterialized();
        const stored = await readSessionEntryReadOnlyInWorker(scope);
        expect(stored?.sessionId).toBe(sessionId);
        expect(stored?.createdActor).toEqual(attributed);
        expect(stored?.operatorSources?.[snapshotPerson.id]?.scopes).toContain("operator.admin");
        expect(projection.capture({ key, agentId })).toBeDefined();
        if (scenario === "raw-linked") {
          // Exercise the real policy boundary with a forced source candidate: the
          // incognito refusal must happen before the candidate is consulted.
          const sourceCandidate = vi.fn(() => true);
          const incognitoTarget = {
            agentId,
            canonicalKey: key,
            storeKey: key,
            storeKeys: [key],
            storePath,
            entry: { ...expectDefined(stored, "stored session"), incognito: true as const },
          };
          const authorizer = createSessionTargetPolicyAuthorizer({
            params: {
              client,
              context,
              method: "message.action",
              requestParams: { sessionKey: key },
              nativeSourceSend: sourceCandidate,
            },
            authorizesAgentRun: true,
            authorizesRead: false,
            targetOwnership: { requireOwner: false },
            sessionCap: () => "none",
            resolveMembership: () => false,
          });
          const expected = authorizeIncognitoSessionTarget({
            client,
            sessionKey: key,
            target: incognitoTarget,
          });
          expect(expected).not.toBeNull();
          expect(authorizer({ sessionKey: key, agentId }, incognitoTarget, cfg, undefined)).toEqual(
            expected,
          );
          expect(sourceCandidate).not.toHaveBeenCalled();
        }
        if (scenario === "raw-agent-denied" || scenario === "raw-sandbox-denied") {
          const sourceCandidate = vi.fn(() => true);
          const deniedTarget = {
            agentId,
            canonicalKey: key,
            storeKey: key,
            storeKeys: [key],
            storePath,
            entry: expectDefined(stored, "stored session"),
          };
          const expected = authorizeSessionAgentRun({ cfg, client, target: deniedTarget });
          expect(expected).toMatchObject({ code: "FORBIDDEN" });
          const authorizer = createSessionTargetPolicyAuthorizer({
            params: {
              client,
              context,
              method: "message.action",
              requestParams: { sessionKey: key },
              nativeSourceSend: sourceCandidate,
            },
            authorizesAgentRun: true,
            authorizesRead: false,
            targetOwnership: { requireOwner: false },
            sessionCap: () => "none",
            resolveMembership: () => false,
          });
          expect(authorizer({ sessionKey: key, agentId }, deniedTarget, cfg, undefined)).toEqual(
            expected,
          );
          expect(sourceCandidate).not.toHaveBeenCalled();
        }
        const requestScope = {
          context,
          client,
          resolveGatewayContext: () => context,
          isWebchatConnect: () => false,
        };
        const read = () =>
          withPluginRuntimeGatewayRequestScope(requestScope, () =>
            withInProcessGatewayRead(
              {
                method: "sessions.get",
                requestParams: { key },
                scope: requestScope,
                resolveGatewayContext: () => context,
                callerAuthorityError: "expired",
              },
              async (resolved, assertCurrent) => {
                expect(resolved.client?.authenticatedUserProfile?.profileId).toBe(person.id);
                expect(resolved.client?.connect.scopes).not.toContain("operator.admin");
                assertCurrent();
                return "visible";
              },
            ),
          );
        if (scenario === "wrong-account" || scenario === "unattributed") {
          await expect(read()).rejects.toThrow(/not found/i);
          expect(telegramHttp.requests).toHaveLength(0);
          return;
        }
        // Raw channel attribution is the observed current shape. Use only the
        // separately admitted, revocable member authority from this ingress.
        const hostAuthority = rawScenario
          ? expectDefined(linked?.operatorAuthority, "host-admitted channel operator")
          : undefined;
        hostAuthority?.assertCurrent();
        if (hostAuthority) {
          expect(hostAuthority.profileId).toBe(person.id);
          expect(hostAuthority.scopes).not.toContain("operator.admin");
          expect(hostAuthority.channelRecoverySource?.reference).toBeDefined();
          expect(stored?.createdActor?.delegatedBy).toBeUndefined();
        }
        let revokedAtCommit = false;
        const messageAction = expectDefined(sendHandlers["message.action"], "message.action");
        const gatewayAction = vi.fn(async (args: Parameters<typeof messageAction>[0]) => {
          if (scenario === "raw-replaced-at-admission") {
            revokedAtCommit = true;
            await replaceSessionEntry(
              { ...scope, sessionId: "replacement-session" },
              { ...expectDefined(stored, "stored session"), sessionId: "replacement-session" },
            );
            return messageAction(args);
          }
          if (scenario !== "raw-revoked-at-commit" && scenario !== "raw-role-revoked-at-commit") {
            return messageAction(args);
          }
          const guard = expectDefined(args.sessionMutationCommitGuard, "session commit guard");
          return messageAction({
            ...args,
            sessionMutationCommitGuard: () => {
              if (!revokedAtCommit) {
                revokedAtCommit = true;
                if (scenario === "raw-role-revoked-at-commit") {
                  setUserProfileRole(person.id, "staff");
                } else {
                  expect(
                    unlinkUserChannelIdentity(person.id, {
                      channelId: "telegram",
                      accountId,
                      senderId,
                    }),
                  ).toBe(true);
                }
              }
              guard();
            },
          });
        });
        const registry = createRequestGatewayMethodRegistry({ "message.action": gatewayAction });
        context.getGatewayMethodRegistry = () => registry;
        stubMessageSecrets();
        await withPluginRuntimeGatewayRequestScope(requestScope, () =>
          withGatewayToolCallerIdentity(
            {
              agentId,
              sessionKey: key,
              operationalRunInstance: run,
              gatewayContextResolver: () => context,
              ...(hostAuthority
                ? {
                    operatorAuthority: hostAuthority,
                    requesterOrigin: {
                      sessionKey: key,
                      operatorProfileId: person.id,
                      messageProvider: "telegram",
                      accountId,
                      chatType: "direct" as const,
                      conversationId: senderId,
                      senderId,
                      messageThreadId: 77,
                    },
                  }
                : {}),
              receiptAuthority: () => validateAgentRunDelegatedAuthority(delegated),
            },
            async () => {
              const tool = await createMessageToolAsync({
                config: cfg,
                agentId,
                agentSessionKey: key,
                runSessionKey: key,
                sessionId,
                runId,
                currentChannelProvider: "telegram",
                currentChannelId: senderId,
                currentMessagingTarget: senderId,
                currentChatType: "direct",
                agentAccountId: accountId,
                agentThreadId: 77,
                senderIsOwner: false,
                messageActionTurnCapability: capability,
              });
              const send = () =>
                tool.execute("nonowner-attachment", {
                  action: "send",
                  target: senderId,
                  message: "nonowner attachment",
                  media: mediaPath,
                });
              if (expectedDenied) {
                await expect(send()).rejects.toThrow();
                return;
              }
              await send();
              if (scenario === "raw-linked") {
                await expect(
                  tool.execute("wrong-topic", {
                    action: "send",
                    target: senderId,
                    threadId: "78",
                    message: "must not escape",
                    media: mediaPath,
                  }),
                ).rejects.toThrow(/not found/i);
                await expect(
                  tool.execute("wrong-peer", {
                    action: "send",
                    target: "4243",
                    threadId: "77",
                    message: "must not escape",
                    media: mediaPath,
                  }),
                ).rejects.toThrow(/not found/i);
              }
              await expect(
                tool.execute("wrong-account", {
                  action: "send",
                  target: senderId,
                  accountId: "other",
                  message: "must not escape",
                  media: mediaPath,
                }),
              ).rejects.toThrow(/account.*trusted|trusted.*account/i);
              if (scenario === "raw-linked") {
                expect(
                  unlinkUserChannelIdentity(person.id, {
                    channelId: "telegram",
                    accountId,
                    senderId,
                  }),
                ).toBe(true);
                await expect(
                  tool.execute("revoked-link", {
                    action: "send",
                    target: senderId,
                    message: "must not escape",
                    media: mediaPath,
                  }),
                ).rejects.toThrow();
              }
            },
          ),
        );
        if (expectedDenied) {
          if (
            [
              "raw-revoked-at-commit",
              "raw-role-revoked-at-commit",
              "raw-replaced-at-admission",
            ].includes(scenario)
          ) {
            expect(gatewayAction).toHaveBeenCalledOnce();
            expect(revokedAtCommit).toBe(true);
          }
          expect(telegramHttp.requests).toHaveLength(0);
          return;
        }
        if (scenario === "linked") await expect(read()).resolves.toBe("visible");
        if (scenario === "raw-linked") await expect(read()).rejects.toThrow(/not found/i);
        // The raw-linked case intentionally exercises message.action directly;
        // ordinary sessions.get remains governed by the existing sharing policy.
        expect(gatewayAction).toHaveBeenCalledOnce();
        const request = expectDefined(gatewayAction.mock.calls[0]?.[0], "gateway action");
        expect(request.params).toMatchObject({
          sessionKey: key,
          sessionId,
          agentId,
          senderIsOwner: false,
        });
        expect(request.client?.connect.scopes).not.toContain("operator.admin");
        expect(telegramHttp.requests).toHaveLength(1);
        const outbound = expectDefined(telegramHttp.requests[0], "Bot API request");
        expect(outbound.method).toBe("sendPhoto");
        expect(String(outbound.fields.chat_id)).toBe(senderId);
        expect(String(outbound.fields.message_thread_id)).toBe("77");
        expect(telegramHttp.endpoints).toEqual(["/bot123456:synthetic-fixture-token/sendPhoto"]);
        const upload = resolveTelegramTestUpload(outbound.fields, "photo");
        expect(Buffer.from(await upload.arrayBuffer())).toEqual(pngBytes);
      } finally {
        revokeMessageActionTurnCapability(capability);
        releaseAgentRunDelegatedAuthority(delegated);
        projection.dispose();
        host.retire();
      }
    }),
  120_000,
);
