import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import * as chatAttachments from "../chat-attachments.js";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  createAttachments,
  createClientInfo,
  createUserTurnInputController,
} from "./chat-send-user-turn.test-support.js";

const { transcribeFirstAudio } = vi.hoisted(() => ({ transcribeFirstAudio: vi.fn() }));
vi.mock("../../media-understanding/audio-preflight.js", () => ({ transcribeFirstAudio }));

describe("prepareChatSendUserTurn audio", () => {
  it("persists a configured WebChat audio echo without outbound delivery", async () => {
    const persist = vi
      .spyOn(chatAttachments, "persistInboundImagesForTranscript")
      .mockResolvedValueOnce({
        entries: [
          {
            id: "voice.ogg",
            path: "/state/media/inbound/voice.ogg",
            sourceIndex: 0,
            fact: { url: "media://inbound/voice.ogg", contentType: "audio/ogg", kind: "audio" },
          },
        ],
        omission: "none",
      });
    transcribeFirstAudio.mockResolvedValueOnce("transcribed voice");
    try {
      const { controller, readInput } = createUserTurnInputController();
      prepareChatSendUserTurn({
        request: {
          inboundMessage: "",
          clientInfo: createClientInfo({
            id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          }),
          suppressCommandInterpretation: false,
          systemInputProvenance: undefined,
          systemProvenanceReceipt: undefined,
        },
        session: {
          agentId: "main",
          clientRunId: "run-voice",
          sessionKey: "agent:main:main",
          cfg: {
            tools: {
              media: { audio: { echoTranscript: true, echoFormat: "Heard: {transcript}" } },
            },
          },
        },
        admission: {
          originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
        },
        attachments: createAttachments({
          offloadedRefs: [
            {
              mediaRef: "media://inbound/voice.ogg",
              id: "voice.ogg",
              path: "/state/media/inbound/voice.ogg",
              kind: "audio",
              mimeType: "audio/ogg",
              label: "voice.ogg",
              sizeBytes: 12,
              sourceIndex: 0,
            },
          ],
        }),
        client: null,
        logGateway: { warn: vi.fn() } as never,
        userTurn: controller,
      });
      await expect(readInput()).resolves.toMatchObject({
        text: "raw message\nHeard: transcribed voice",
      });
      expect(transcribeFirstAudio).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: expect.objectContaining({
            tools: expect.objectContaining({
              media: expect.objectContaining({
                audio: expect.objectContaining({ echoTranscript: false }),
              }),
            }),
          }),
        }),
      );
    } finally {
      persist.mockRestore();
      transcribeFirstAudio.mockReset();
    }
  });
});
