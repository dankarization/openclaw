import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import { resolveCronOperatorExecutionRevision } from "../../../../src/cron/service/jobs-tool-policy.js";
import { writeToolCall } from "../../../../src/gateway/gateway-provider-fixture.test-support.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../../../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../../src/state/openclaw-state-db.paths.js";
import { ensureProfileForEmail } from "../../../../src/state/user-profiles.js";
import { writeOpenAiResponsesText } from "../../../helpers/openai-responses-sse.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  createTelegramApi,
  telegramGatewayOptions,
  telegramRequestHandler,
  readTelegramRequest,
  settleTelegramCleanup,
  succeedTelegram,
} from "./telegram-gateway.test-support.js";

const root = path.resolve("/tmp/openclaw-upgrade-20261121-personal-reminder-main-nonowner");
const repoRoot = path.resolve(".");
const tokens = { proof: "424242:" + "A".repeat(35), other: "424243:" + "B".repeat(35) };
const chat = { id: -1002468135790, type: "supergroup", title: "Reminder proof", is_forum: true };
const alice = 1357,
  bob = 2468;

test(
  "linked nonowner creates a personal reminder; shared-topic nonowner and revoked source are refused",
  { timeout: 360_000 },
  async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "input.txt"), "QA_READ_SENTINEL");
    const apis = Object.fromEntries(
      Object.entries(tokens).map(([account, token]) => [
        account,
        createTelegramApi({
          token,
          bot: {
            id: Number(token.split(":")[0]),
            is_bot: true,
            first_name: "QA",
            username: "qa_reminder_bot",
          },
          chat,
          messageId: (n) => 9000 + n,
          now: () => Math.floor(Date.now() / 1000),
        }),
      ]),
    );
    const mock = await startQaMockOpenAiServer();
    const owner = createQaGatewayChild();
    let gateway: QaGatewayChild | undefined;
    const commands = new Map<
      string,
      {
        args: Record<string, unknown>;
        issued: boolean;
        addIssued?: boolean;
        result?: unknown;
        unavailable?: boolean;
      }
    >();
    const evidence: Record<string, unknown> = {
      head: "a48440bbdf3e1f827e72eb7d674b63bcbb2fe4cf + local main authority port",
      transport: "maintained local Telegram Bot API replay, no external Telegram sends",
      provider: "local deterministic Responses replay; real OpenClaw harness/tool dispatch",
      creationAuthority: "linked member sender is not in the synthetic command-owner allowlist",
    };
    const providerTrace: Array<{ path: string; markers: string[] }> = [];
    let activeLabel: string | undefined;
    let updates = 0,
      scheduledRequests = 0;
    const provider = async (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => {
      const raw = await readTelegramRequest(req);
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const markers = [...raw.matchAll(/REMINDER_PROOF_([A-Z0-9_]+)/g)].map((match) => match[1]!);
      providerTrace.push({ path: pathname, markers });
      if (pathname.endsWith("/responses")) {
        const body = JSON.parse(raw) as {
          input?: Array<{ role?: string; type?: string; output?: unknown }>;
          tools?: unknown[];
        };
        const label = activeLabel && markers.includes(activeLabel) ? activeLabel : undefined;
        const command = label ? commands.get(label) : undefined;
        if (command) {
          if (!command.issued) {
            command.issued = true;
            if (!JSON.stringify(body.tools).includes('"automations"')) {
              command.unavailable = true;
              command.result = { error: "automations not in actual tool surface" };
            } else {
              if (label?.startsWith("CREATE")) {
                writeToolCall(res, "automations", {
                  action: "plan",
                  names: ["QA member source negatives"],
                });
              } else {
                writeToolCall(res, "automations", command.args);
              }
              return;
            }
          } else if (label?.startsWith("CREATE") && !command.addIssued) {
            command.addIssued = true;
            writeToolCall(res, "automations", command.args);
            return;
          } else {
            const output = [...(body.input ?? [])]
              .reverse()
              .find((item) => item.type === "function_call_output")?.output;
            if (typeof output === "string") {
              try {
                command.result = JSON.parse(output);
              } catch {
                command.result = { text: output };
              }
            } else {
              command.result = output;
            }
          }
          writeOpenAiResponsesText(res, {
            text: "DONE REMINDER_PROOF_" + label,
            messageId: crypto.randomUUID(),
            responseId: crypto.randomUUID(),
          });
          return;
        }
        if (!activeLabel && raw.includes("SCHEDULED_REMINDER_PROOF")) {
          scheduledRequests++;
          evidence.scheduledToolNames = (body.tools ?? []).map((tool) => JSON.stringify(tool));
          writeOpenAiResponsesText(res, {
            text: "SCHEDULED_REMINDER_PROOF_OK",
            messageId: crypto.randomUUID(),
            responseId: crypto.randomUUID(),
          });
          return;
        }
      }
      const response = await fetch(mock.baseUrl + pathname, {
        method: req.method,
        headers: { "content-type": "application/json" },
        ...(raw ? { body: raw } : {}),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    };
    try {
      await withServer(
        telegramRequestHandler(async (req, res) => {
          const token = new URL(req.url ?? "/", "http://127.0.0.1").pathname
            .split("/")[1]
            ?.slice(3);
          const account = Object.entries(tokens).find(([, value]) => value === token)?.[0];
          if (!account) {
            res.writeHead(404).end();
            return;
          }
          if (req.url?.endsWith("/sendMessage")) {
            const body = JSON.parse(await readTelegramRequest(req)) as Record<string, unknown>;
            apis[account]!.calls.push({ method: "sendMessage", body });
            succeedTelegram(res, {
              message_id: 9000 + apis[account]!.calls.length,
              date: Math.floor(Date.now() / 1000),
              chat,
              text: body.text,
              message_thread_id: body.message_thread_id,
              is_topic_message: true,
            });
            return;
          }
          await apis[account]!.handle(req, res);
        }),
        async (apiRoot) =>
          await withServer(telegramRequestHandler(provider), async (providerRoot) => {
            gateway = await owner.start(
              telegramGatewayOptions({
                apiRoot,
                providerMode: "mock-openai",
                providerBaseUrl: providerRoot + "/v1",
                forcedRuntime: "openclaw",
                command: {
                  executablePath: process.execPath,
                  argsPrefix: [path.join(repoRoot, "dist/index.js")],
                  tempParentDir: root,
                },
                initializeCurrentRuntimeState: true,
                mockAuthAgentIds: ["qa"],
                telegram: {
                  enabled: true,
                  defaultAccount: "proof",
                  groupPolicy: "allowlist",
                  groupAllowFrom: [String(alice), String(bob)],
                  groups: { [String(chat.id)]: { requireMention: false } },
                  accounts: Object.fromEntries(
                    Object.entries(tokens).map(([id, botToken]) => [
                      id,
                      {
                        enabled: true,
                        botToken,
                        apiRoot,
                        commands: { native: false },
                        streaming: { mode: "off" },
                      },
                    ]),
                  ),
                },
                messages: { groupChat: { visibleReplies: "automatic" } },
                mutateConfig: (cfg) => {
                  cfg.bindings = Object.keys(tokens).map((accountId) => ({
                    agentId: "qa",
                    match: { channel: "telegram", accountId },
                  }));
                  cfg.commands = { ownerAllowFrom: ["telegram:999999"] };
                  cfg.tools = {
                    allow: ["automations", "read", "exec"],
                    codeMode: { enabled: false },
                    toolSearch: false,
                  };
                  cfg.gateway!.roles = {
                    default: "member",
                    definitions: {
                      member: {
                        scopes: ["operator.write", "operator.cron"],
                        agents: "*",
                        sessions: { others: "view" },
                      },
                      observer: {
                        scopes: ["operator.read"],
                        agents: "*",
                        sessions: { others: "view" },
                      },
                      revoked: {
                        scopes: ["operator.read"],
                        agents: [],
                        sessions: { others: "none" },
                      },
                    },
                  };
                  cfg.logging = { level: "debug", file: path.join(root, "gateway.log") };
                  return cfg;
                },
              }),
            );
            const people: Record<string, string> = {};
            // Match the existing requester-profile fixture: create only personal profile prerequisites
            // while the owned Gateway is stopped; roles and channel links use running Gateway RPCs.
            await gateway.restartAfterStateMutation(async ({ runtimeEnv }) => {
              for (const name of ["alice", "bob"])
                people[name] = ensureProfileForEmail(name + "@reminder-proof.example.test", {
                  env: runtimeEnv,
                }).id;
              await closeOpenClawStateDatabaseByPathAsync(
                resolveOpenClawStateSqlitePath(runtimeEnv),
              );
            });
            for (const [name, senderId] of [
              ["alice", alice],
              ["bob", bob],
            ] as const) {
              await gateway.call("users.setRole", { profileId: people[name], role: "member" });
              for (const accountId of Object.keys(tokens))
                await gateway.call("users.linkChannelIdentity", {
                  profileId: people[name],
                  identity: { channelId: "telegram", accountId, senderId: String(senderId) },
                });
            }
            const send = async (
              label: string,
              args: Record<string, unknown>,
              senderId = alice,
              topic = 99,
              account = "proof",
            ) => {
              const command = { args, issued: false } as {
                args: Record<string, unknown>;
                issued: boolean;
                addIssued?: boolean;
                result?: unknown;
                unavailable?: boolean;
              };
              commands.set(label, command);
              activeLabel = label;
              const api = apis[account]!;
              const before = api.calls.length;
              api.updates.enqueue({
                update_id: ++updates,
                message: {
                  message_id: updates,
                  date: Math.floor(Date.now() / 1000),
                  chat,
                  from: {
                    id: senderId,
                    is_bot: false,
                    first_name: senderId === alice ? "Alice" : "Bob",
                  },
                  message_thread_id: topic,
                  is_topic_message: true,
                  text: "REMINDER_PROOF_" + label,
                },
              });
              await expect
                .poll(
                  () =>
                    api.calls
                      .slice(before)
                      .some(
                        (call) =>
                          call.method === "sendMessage" &&
                          String(call.body.text).includes("DONE REMINDER_PROOF_" + label),
                      ),
                  { timeout: 35_000, interval: 100 },
                )
                .toBe(true);
              evidence[label] = command.result;
              await fs.writeFile(
                path.join(root, "progress.json"),
                JSON.stringify(evidence, null, 2),
              );
              return command.result as Record<string, unknown>;
            };
            const added = await send("CREATE", {
              action: "add",
              job: {
                name: "QA member source negatives",
                enabled: true,
                deleteAfterRun: true,
                schedule: { kind: "at", at: "2030-01-01T00:00:00Z" },
                sessionTarget: "current",
                payload: { kind: "agentTurn", message: "SCHEDULED_REMINDER_PROOF", toolsAllow: [] },
              },
            });
            expect(added).toMatchObject({ id: expect.any(String) });
            const id = String(added.id);
            const stored = () =>
              JSON.parse(
                execFileSync(
                  "/home/dankar/.local/share/openclaw-qa-runtime/24.22.1/bin/node",
                  [
                    "--no-warnings",
                    "-e",
                    `const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare("select job_json from cron_jobs where job_id=?").get(process.argv[2]);if(!r)process.exit(2);process.stdout.write(r.job_json)`,
                    path.join(gateway!.runtimeEnv.OPENCLAW_STATE_DIR!, "state/openclaw.sqlite"),
                    id,
                  ],
                  { encoding: "utf8" },
                ),
              ) as Record<string, any>;
            const before = stored();
            expect(before.ownerProfileId).toBe(people.alice);
            expect(before.operatorSource?.source?.kind).toBe("channel");
            expect(before.operatorSource?.source?.snapshot?.profileId).toBe(people.alice);
            expect(before.payload.toolsAllow).toEqual([]);
            expect(before.delivery).toMatchObject({
              channel: "telegram",
              accountId: "proof",
              threadId: 99,
            });
            for (const action of ["get", "remove"] as const) {
              const denied = await send(`BOB_${action.toUpperCase()}`, { action, id }, bob);
              expect(JSON.stringify(denied)).toMatch(/not found|denied|unavailable|error/i);
            }
            expect(stored()).toEqual(before);
            const positive = await send("CREATE_POSITIVE", {
              action: "add",
              job: {
                name: "QA member source negatives",
                enabled: true,
                deleteAfterRun: true,
                schedule: { kind: "at", at: "2030-01-03T00:00:00Z" },
                sessionTarget: "current",
                payload: { kind: "agentTurn", message: "SCHEDULED_REMINDER_PROOF", toolsAllow: [] },
              },
            });
            expect(positive).toMatchObject({ id: expect.any(String) });
            activeLabel = undefined;
            const positiveRequests = scheduledRequests;
            const positiveTelegramStart = apis.proof!.calls.length;
            await gateway.call("cron.run", { id: String(positive.id), mode: "force" });
            await expect
              .poll(() => scheduledRequests, { timeout: 35_000, interval: 100 })
              .toBeGreaterThan(positiveRequests);
            await expect
              .poll(
                () =>
                  apis
                    .proof!.calls.slice(positiveTelegramStart)
                    .some(
                      (call) =>
                        call.method === "sendMessage" &&
                        String(call.body.text).includes("SCHEDULED_REMINDER_PROOF_OK"),
                    ),
                { timeout: 35_000, interval: 200 },
              )
              .toBe(true);
            const scheduledSurface = JSON.stringify(evidence.scheduledToolNames);
            expect(scheduledSurface).not.toMatch(/"name"\s*:\s*"(?:read|exec)"/);
            evidence.positive = {
              providerRequestsBefore: positiveRequests,
              providerRequestsAfter: scheduledRequests,
            };
            const natural = await send("CREATE_NATURAL", {
              action: "add",
              job: {
                name: "QA member source negatives",
                enabled: true,
                deleteAfterRun: true,
                schedule: { kind: "at", at: new Date(Date.now() + 90_000).toISOString() },
                sessionTarget: "current",
                payload: { kind: "agentTurn", message: "SCHEDULED_REMINDER_PROOF", toolsAllow: [] },
              },
            });
            expect(natural).toMatchObject({ id: expect.any(String) });
            activeLabel = undefined;
            const naturalRequests = scheduledRequests;
            const naturalTelegramStart = apis.proof!.calls.length;
            await expect
              .poll(() => scheduledRequests, { timeout: 125_000, interval: 200 })
              .toBeGreaterThan(naturalRequests);
            await expect
              .poll(
                () =>
                  apis
                    .proof!.calls.slice(naturalTelegramStart)
                    .some(
                      (call) =>
                        call.method === "sendMessage" &&
                        String(call.body.text).includes("SCHEDULED_REMINDER_PROOF_OK"),
                    ),
                { timeout: 35_000, interval: 200 },
              )
              .toBe(true);
            evidence.natural = {
              providerRequestsBefore: naturalRequests,
              providerRequestsAfter: scheduledRequests,
              deliveryObserved: true,
            };
            await gateway.call("cron.update", {
              id,
              patch: { schedule: { kind: "at", at: "2030-01-02T00:00:00Z" } },
            });
            const afterTiming = stored();
            expect(afterTiming.operatorSource?.source).toEqual(before.operatorSource.source);
            expect(afterTiming.operatorSource?.executionRevision).toBe(
              resolveCronOperatorExecutionRevision(afterTiming as never),
            );
            await gateway.call("users.setRole", { profileId: people.alice, role: "revoked" });
            activeLabel = undefined;
            const beforeRequests = scheduledRequests;
            await gateway.call("cron.run", { id, mode: "force" });
            await expect
              .poll(
                async () => JSON.stringify(await gateway!.call("cron.runs", { id, limit: 5 })),
                { timeout: 35_000, interval: 100 },
              )
              .toMatch(/error|blocked|denied|revok/i);
            expect(scheduledRequests).toBe(beforeRequests);
            expect(stored().operatorSource).toEqual(afterTiming.operatorSource);
            evidence.sameJobRevoked = {
              providerRequestsBefore: beforeRequests,
              providerRequestsAfter: scheduledRequests,
            };
            evidence.passed = true;
          }),
      );
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (gateway) await fs.writeFile(path.join(root, "gateway-output.log"), gateway.logs());
      await settleTelegramCleanup(
        () => stopQaGatewayFixture(owner, { keepTemp: true }),
        () => mock.stop(),
      );
      evidence.providerTrace = providerTrace;
      evidence.commands = Object.fromEntries(commands);
      evidence.telegramCalls = Object.fromEntries(
        Object.entries(apis).map(([account, api]) => [account, api.calls]),
      );
      evidence.cleanup = "QA Gateway owner and local mock provider stopped";
      await fs.writeFile(path.join(root, "result.json"), JSON.stringify(evidence, null, 2));
    }
  },
);
