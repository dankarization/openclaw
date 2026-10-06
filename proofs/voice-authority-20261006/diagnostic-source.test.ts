import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { transcribeOpenAiAudioWithContext } from "../../../extensions/openai/audio-transcription.js";
import * as processExec from "../../process/exec.js";
import { setVerbose } from "../../globals.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import { createAttachments, createClientInfo, createUserTurnInputController } from "./chat-send-user-turn.test-support.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../../packages/gateway-protocol/src/client-info.js";

// This is an execution diagnostic, not additional product regression coverage.
// The endpoint supplies synthetic STT output; HTTP/auth/ffmpeg/CLI boundaries are real.
describe("priority voice real final-effect diagnostic", () => {
  it("observes selected-agent HTTP credentials and revoked upload/conversion", async () => {
    setVerbose(true);
    const state = await createOpenClawTestState({ layout: "state-only", prefix: "voice-authority-proof-", env: { OPENAI_API_KEY: undefined, OPENAI_API_KEYS: undefined } });
    const requests: Array<{ bytes: number; selectedAgentCredential: boolean; defaultAgentCredential: boolean; bodySha256: string }> = [];
    const traces: Array<Record<string, unknown>> = [];
    const mainKey = "synthetic-proof-main-not-a-real-api-key";
    const supportKey = "synthetic-proof-support-not-a-real-api-key";
    const profileId = "openai:voice-authority-proof";
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      requests.push({ bytes: body.length, selectedAgentCredential: req.headers.authorization === `Bearer ${supportKey}`, defaultAgentCredential: req.headers.authorization === `Bearer ${mainKey}`, bodySha256: createHash("sha256").update(body).digest("hex") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "synthetic transcript observed at the real transport boundary" }));
    });
    const execTrace: string[] = [];
    const originalRunExec = processExec.runExec;
    const observation = vi.spyOn(processExec, "runExec").mockImplementation(async (...args) => {
      execTrace.push(path.basename(args[0]));
      return originalRunExec(...args);
    });
    try {
      await fs.mkdir(state.agentDir("support"), { recursive: true });
      await state.writeAuthProfiles({ version: 1, profiles: { [profileId]: { type: "api_key", provider: "openai", key: mainKey } } }, "main");
      await state.writeAuthProfiles({ version: 1, profiles: { [profileId]: { type: "api_key", provider: "openai", key: supportKey } } }, "support");
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a loopback TCP address");
      const wav = Buffer.alloc(32044);
      wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
      const inputPath = path.join(state.workspaceDir, "synthetic-input.ogg");
      await fs.mkdir(state.workspaceDir, { recursive: true });
      await fs.writeFile(inputPath, wav);
      const cliPath = path.join(state.workspaceDir, "whisper-cli");
      const cliReceipt = path.join(state.workspaceDir, "cli-effect.txt");
      await fs.writeFile(cliPath, `#!${process.execPath}\nconst fs = require("node:fs"); const b=fs.readFileSync(process.argv[2]); if (b.subarray(0,4).toString()!=="RIFF") throw Error("Expected real WAV conversion"); fs.appendFileSync(${JSON.stringify(cliReceipt)},"executed\\n"); process.stdout.write("synthetic local transcript");\n`);
      await fs.chmod(cliPath, 0o700);
      const registry = createEmptyPluginRegistry();
      registry.mediaUnderstandingProviders.push({ pluginId: "openai", source: "diagnostic", provider: { id: "openai", capabilities: ["audio"], transcribeAudioWithContext: transcribeOpenAiAudioWithContext } });
      const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [{ id: "openai", contracts: { mediaUnderstandingProviders: ["openai"] } }] });
      await withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry: registry }, async () => {
        for (const route of ["provider", "cli"] as const) {
          for (const revoked of [false, true]) {
            let admitted = true;
            let initialAdmissionObserved = false;
            let checks = 0;
            const beforeRequests = requests.length;
            const beforeExec = execTrace.length;
            const cfg: OpenClawConfig = {
              agents: { defaults: { workspace: state.workspaceDir }, list: [{ id: "main" }, { id: "support", workspace: state.workspaceDir }] },
              models: { providers: { openai: { baseUrl: `http://127.0.0.1:${address.port}/v1`, auth: "api-key", request: { allowPrivateNetwork: true }, models: [] } } },
              tools: { media: { models: route === "provider" ? [{ provider: "openai", model: "whisper-1", profile: profileId, capabilities: ["audio"] }] : [{ type: "cli", command: cliPath, args: ["{{MediaPath}}"], capabilities: ["audio"] }], audio: { enabled: true, echoTranscript: true } } },
            };
            const { controller, readInput } = createUserTurnInputController("synthetic voice caption");
            prepareChatSendUserTurn({
              request: { inboundMessage: "synthetic voice caption", clientInfo: createClientInfo({ id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: GATEWAY_CLIENT_MODES.UI }), suppressCommandInterpretation: false, systemInputProvenance: undefined, systemProvenanceReceipt: undefined },
              session: { agentId: "support", clientRunId: "diagnostic-voice", sessionKey: "agent:support:authority-proof", cfg },
              admission: { originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false }, assertClientUploadAllowed: () => {
                checks++;
                if (!admitted) throw new Error("diagnostic admission revoked during preparation");
                initialAdmissionObserved = true;
                if (revoked && checks === 1) queueMicrotask(() => { admitted = false; });
              } },
              attachments: createAttachments({ parsedMessage: "synthetic voice caption", mediaPathOffloads: [{ path: inputPath, contentType: "audio/ogg", workspaceDir: state.workspaceDir }] }),
              client: null,
              logGateway: createSubsystemLogger("voice-authority-proof"),
              userTurn: controller,
            });
            if (revoked) await expect(readInput()).rejects.toThrow("diagnostic admission revoked during preparation");
            else {
              const input = await readInput();
              expect(input.text).toContain(route === "provider" ? "synthetic transcript observed" : "synthetic local transcript");
            }
            const effects = execTrace.slice(beforeExec);
            const seen = requests.slice(beforeRequests);
            expect(initialAdmissionObserved).toBe(true);
            expect(seen.length).toBe(route === "provider" && !revoked ? 1 : 0);
            if (seen.length) {
              expect(seen[0].selectedAgentCredential).toBe(true);
              expect(seen[0].defaultAgentCredential).toBe(false);
              expect(seen[0].bytes).toBeGreaterThan(wav.length);
            }
            expect(effects.filter(x => x === "ffmpeg").length).toBe(route === "cli" && !revoked ? 1 : 0);
            expect(effects.filter(x => x === "whisper-cli").length).toBe(route === "cli" && !revoked ? 1 : 0);
            traces.push({ route, revokedDuringPreparation: revoked, initialAdmissionObserved, checks, httpRequests: seen.length, selectedAgentCredentialOnWire: seen[0]?.selectedAgentCredential ?? null, defaultAgentCredentialOnWire: seen[0]?.defaultAgentCredential ?? null, uploadBytes: seen[0]?.bytes ?? 0, ffmpegProcesses: effects.filter(x => x === "ffmpeg").length, cliProcesses: effects.filter(x => x === "whisper-cli").length });
          }
        }
      });
      await fs.writeFile(process.env.VOICE_AUTHORITY_PROOF_RECEIPT!, JSON.stringify({ sourceHead: "911e0f238e86451c0d2d24b9efe2b391398305e1", syntheticProfilesOnly: true, httpTransportMocked: false, processExecutionDelegatedToNativeOwner: true, noInstantStopClaim: true, traces }, null, 2));
      console.log("VOICE_AUTHORITY_EFFECTS", JSON.stringify(traces));
    } finally {
      setVerbose(false);
      observation.mockRestore();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await state.cleanup();
    }
  }, 60000);
});
