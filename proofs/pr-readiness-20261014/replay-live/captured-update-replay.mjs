#!/usr/bin/env node
// QA-only captured-update fixture. Never starts a poller or edits product source.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { Session } from "node:inspector";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith("--") || !process.argv[i + 1]) throw new Error("Expected --key value pairs");
  args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const required = (name) => {
  const value = args.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
};
const repo = await fs.realpath(required("repo"));
const phase = required("phase");
if (!["first", "replay", "fresh", "inspect", "prereq"].includes(phase)) throw new Error("Invalid phase");
const expectedHead = required("expected-head");
const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== expectedHead) throw new Error("Source HEAD mismatch");
const echoSource = await fs.readFile(path.join(repo, "src/media-understanding/echo-transcript.ts"));
const sourceReceipt = { head, echoSourceSha256: createHash("sha256").update(echoSource).digest("hex") };
if (phase === "inspect") {
  for (const file of ["extensions/telegram/src/bot.ts", "src/plugins/loader.ts", "src/cli/local-state-owner.ts", "src/config/runtime-snapshot.ts"]) {
    await fs.access(path.join(repo, file));
  }
  process.stdout.write(`${JSON.stringify({ ...sourceReceipt, inspected: true, runtimeExecuted: false, credentialsRead: false })}\n`);
  process.exit(0);
}
if (phase === "prereq") {
  process.env.OPENCLAW_STATE_DIR = "/home/dankar/openclaw-pr-qa-20261014/replay-proof-fixture/state-prereq";
  process.env.OPENCLAW_CONFIG_PATH = "/home/dankar/openclaw-pr-qa-20261014/replay-proof-fixture/prereq-config.json";
  const prereqRequire = createRequire(path.join(repo, "package.json"));
  const { register } = await import(pathToFileURL(prereqRequire.resolve("tsx/esm/api")).href);
  const stop = register({ tsconfig: path.join(repo, "tsconfig.json") });
  const contracts = {};
  for (const [file, names] of [
    ["src/cli/local-state-owner.ts", ["runWithLocalStateOwner"]],
    ["src/plugins/loader.ts", ["loadAndActivateRootPluginRegistry"]],
    ["extensions/telegram/src/bot.ts", ["createTelegramBot"]],
    ["extensions/telegram/src/bot-deps.ts", ["defaultTelegramBotDeps"]],
    ["src/infra/outbound/delivery-queue-storage.ts", ["findDeliveryIntentOwner"]],
  ]) {
    const module = await import(pathToFileURL(path.join(repo, file)).href);
    for (const name of names) { if (!module[name]) throw new Error(`Missing native export ${name}`); contracts[name] = typeof module[name]; }
  }
  let configValidated = false;
  if (args.get("config")) {
    const { validateConfigObject } = await import(pathToFileURL(path.join(repo, "src/config/config.ts")).href);
    const validated = validateConfigObject(JSON.parse(await fs.readFile(args.get("config"), "utf8")));
    if (!validated.ok) throw new Error(`QA config validation failed: ${JSON.stringify(validated.issues)}`);
    configValidated = true;
  }
  stop();
  process.stdout.write(`${JSON.stringify({ ...sourceReceipt, contracts, configValidated, runtimeImportsExecuted: true, credentialsRead: false, telegramCalled: false })}\n`);
  process.exit(0);
}
if (required("live") !== "authorized") throw new Error("Explicit --live authorized is required");
const qaRoot = "/home/dankar/openclaw-pr-qa-20261014";
const state = path.resolve(required("state"));
if (!state.startsWith(`${qaRoot}/replay-proof-fixture/state-`)) throw new Error("Use a dedicated fixture state root");
const configPath = await fs.realpath(required("config"));
if (!configPath.startsWith(`${qaRoot}/replay-proof-fixture/`)) throw new Error("Fixture config must be task-owned");
const tokenFile = await fs.realpath(required("token-file"));
if (tokenFile !== `${qaRoot}/secrets/telegram-qa.token`) throw new Error("Only the own QA bot credential is allowed");
const receiptPath = path.resolve(required("receipt"));
if (!receiptPath.startsWith(`${qaRoot}/replay-proof-fixture/`)) throw new Error("Receipt must be task-owned");
const updateBytes = await fs.readFile(required("update"));
const update = JSON.parse(updateBytes);
if (!Number.isSafeInteger(update.update_id) || !update.message?.message_id || !update.message?.chat?.id) throw new Error("Expected one real message update");
if (!(update.message.voice || update.message.audio || update.message.document?.mime_type?.startsWith("audio/"))) throw new Error("Expected an audio source message");
if (update.message.caption || update.message.text) throw new Error("Preflight fixture needs audio without caption/text");
process.env.OPENCLAW_STATE_DIR = state;
process.env.OPENCLAW_CONFIG_PATH = configPath;
await fs.mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
await fs.mkdir(state, { recursive: true, mode: 0o700 });
const sourceIdentitySha256 = createHash("sha256").update(JSON.stringify([update.update_id, update.message.chat.id, update.message.message_id])).digest("hex");
const baseline = phase !== "first" ? JSON.parse(await fs.readFile(required("first-receipt"), "utf8")) : undefined;
if (baseline && (baseline.state !== state || baseline.head !== head)) throw new Error("Retain state and exact HEAD");
if (phase === "replay" && baseline.sourceIdentitySha256 !== sourceIdentitySha256) throw new Error("Replay must retain source identity");
if (phase === "fresh" && baseline.sourceIdentitySha256 === sourceIdentitySha256) throw new Error("Fresh positive control must have another source identity");
const policy = args.get("policy") || "candidate";
if (!["candidate", "baseline"].includes(policy)) throw new Error("Invalid policy");
const requireFromRepo = createRequire(path.join(repo, "package.json"));
const { register } = await import(pathToFileURL(requireFromRepo.resolve("tsx/esm/api")).href);
const unregister = register({ tsconfig: path.join(repo, "tsconfig.json") });
const load = (file) => import(pathToFileURL(path.join(repo, file)).href);
const inspector = new Session();
inspector.connect();
const post = (method, params = {}) => new Promise((resolve, reject) => inspector.post(method, params, (error, value) => error ? reject(error) : resolve(value)));
await post("Profiler.enable");
await post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
const cutoff = new Error("QA_PRE_ADOPTION_CUTOFF");
let reached = false;
const { runWithLocalStateOwner } = await load("src/cli/local-state-owner.ts");
await runWithLocalStateOwner({
  method: "qa.telegram-captured-update-replay",
  params: {},
  target: state,
  onForeignOwner: "refuse",
  runLocal: async ({ config, assertCurrent }) => {
    const cfg = config;
    const configuredTokenFile = cfg.channels?.telegram?.accounts?.[args.get("account") || "default"]?.tokenFile ?? cfg.channels?.telegram?.tokenFile;
    if (!configuredTokenFile || await fs.realpath(configuredTokenFile) !== tokenFile) throw new Error("Config must select the task-only tokenFile");
    const { setRuntimeConfigSnapshot } = await load("src/config/runtime-snapshot.ts");
    setRuntimeConfigSnapshot(cfg, cfg);
    const { loadAndActivateRootPluginRegistry } = await load("src/plugins/loader.ts");
    const registry = await loadAndActivateRootPluginRegistry({ config: cfg, onlyPluginIds: ["telegram"], pluginSdkResolution: "src", preferBuiltPluginArtifacts: false, cache: false });
    const { getPluginInstance } = await load("src/plugins/plugin-instance-scope.ts");
    const record = registry.plugins.find((record) => record.id === "telegram");
    const instance = record && getPluginInstance(record);
    if (!instance?.acceptingCalls) throw new Error("Native Telegram plugin instance is not active");
    await instance.runInRegistry(registry, async () => {
    const { readTelegramTokenFile } = await load("extensions/telegram/src/token.ts");
    const credential = readTelegramTokenFile(tokenFile, "channels.telegram.tokenFile");
    if (!credential.token) throw new Error("QA credential unavailable");
    const { defaultTelegramBotDeps } = await load("extensions/telegram/src/bot-deps.ts");
    const { createTelegramBot } = await load("extensions/telegram/src/bot.ts");
    const bot = await createTelegramBot({
      token: credential.token,
      accountId: args.get("account") || "default",
      config: cfg,
      buildContext: async (...input) => {
        const value = await defaultTelegramBotDeps.buildChannelInboundEventContext(...input);
        assertCurrent();
        const sourceMessageSid = value?.MessageSid;
        if (String(sourceMessageSid) !== String(update.message.message_id)) throw new Error("INCONCLUSIVE: native MessageSid does not match captured source");
        const result = await post("Profiler.takePreciseCoverage");
        const owners = result.result.flatMap((script) => script.functions.filter((fn) => ["sendTranscriptEcho", "sendDurableMessageBatchCore", "sendMessageTelegram"].includes(fn.functionName)).map((fn) => ({
          owner: fn.functionName,
          script: script.url.includes(repo) ? script.url.slice(script.url.indexOf(repo) + repo.length + 1) : path.basename(script.url),
          calls: fn.ranges[0]?.count ?? 0,
        })));
        const echoCalls = owners.filter((row) => row.owner === "sendTranscriptEcho").reduce((sum, row) => sum + row.calls, 0);
        if (echoCalls < 1) throw new Error("INCONCLUSIVE: real echo owner was not executed");
        const accountId = args.get("account") || "default";
        const deliveryIntentId = `transcript-echo:v1:${createHash("sha256").update(JSON.stringify([accountId, String(update.message.chat.id), String(update.message.message_id)])).digest("hex")}`;
        const { findDeliveryIntentOwner } = await load("src/infra/outbound/delivery-queue-storage.ts");
        const queueOwner = await findDeliveryIntentOwner(deliveryIntentId, state);
        if (policy === "candidate" && queueOwner?.status !== "completed") throw new Error("INCONCLUSIVE: stable echo delivery receipt is not completed");
        reached = true;
        const receipt = { ...sourceReceipt, phase, policy, pid: process.pid, state, sourceIdentitySha256, sourceMessageSidSha256: createHash("sha256").update(String(sourceMessageSid)).digest("hex"), updateSha256: createHash("sha256").update(updateBytes).digest("hex"), reachedBuildContext: true, echoCalls, owners, deliveryIntentId, queueOwner: queueOwner ? { namespace: queueOwner.namespace, status: queueOwner.status } : null, preAdoption: true, usesCapturedUpdate: true, usesNativePollingSpool: false, createdAt: new Date().toISOString() };
        await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        if (phase === "first") {
          // Parent kills this exact PID only after independently observing one
          // Telegram echo AND inspecting its completed durable queue receipt.
          await new Promise((resolve) => setTimeout(resolve, 300_000));
          throw new Error("First-phase crash barrier expired; this is not a pass");
        }
        // Stop before turn adoption through the native failure/claim rollback.
        // No model reply is needed to prove transcript echo identity replay.
        void value;
        throw cutoff;
      },
    });
    await bot.init();
    // No bot.start(), getUpdates(), manual SQL, guard clearing or fake delivery.
    try { await bot.handleUpdate(update); } catch (error) { if (error !== cutoff) throw error; }
    if (!reached) throw new Error("INCONCLUSIVE: update was rejected before the echo/buildContext boundary");
    if (phase === "first") throw new Error("First phase ended without the required controlled SIGKILL; not a pass");
    try { await bot.stop(); } catch (error) { if (bot.isRunning()) throw error; }
    });
  },
});
await post("Profiler.stopPreciseCoverage");
inspector.disconnect();
unregister();
process.stdout.write(`${JSON.stringify({ phase, reached, sourceIdentitySha256, completed: true })}\n`);
