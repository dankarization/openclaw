import { describe, expect, it } from "vitest";
import { buildAgentHarnessQuestionPromptPayload } from "../../../src/agents/harness/user-input-bridge.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import { canonicalizeTelegramPresentationPayload } from "./interactive-fallback.js";
import { buildTelegramQuestionRichMessage } from "./question-rich-message.js";

const questionId = "ask_0123456789abcdef0123456789abcdef";

describe("rich question buttons", () => {
  it("keeps callback identity for a multi-select question within its own message", () => {
    const prompt = buildAgentHarnessQuestionPromptPayload({
      questionId,
      questionIndex: 1,
      questions: [
        {
          id: "details",
          header: "Details",
          question: "Choose details",
          options: [{ label: "Logs" }, { label: "Screenshots" }],
          multiSelect: true,
          isOther: true,
        },
      ],
    });
    const canonical = canonicalizeTelegramPresentationPayload(prompt, { richTables: true });
    const telegram = canonical.channelData?.telegram as
      | { buttons?: Parameters<typeof resolveTelegramInlineButtons>[0]["buttons"] }
      | undefined;
    const rich = buildTelegramQuestionRichMessage({
      payload: prompt,
      buttons: resolveTelegramInlineButtons({ buttons: telegram?.buttons }),
    });
    expect(rich?.blocks[0]).toEqual({ type: "paragraph", text: "Choose details" });
    expect(rich?.blocks.filter((block) => block.type === "buttons")).toMatchObject([
      { buttons: [{ text: "Logs", callback_data: `tgq2:${questionId}:1:0:a` }] },
      { buttons: [{ text: "Screenshots", callback_data: `tgq2:${questionId}:1:1:a` }] },
      { buttons: [{ text: "Done" }] },
      { buttons: [{ text: "Other…" }] },
    ]);
  });

  it("never turns an unrelated message into a rich question", () => {
    expect(
      buildTelegramQuestionRichMessage({
        payload: { text: "Hi" },
        buttons: [[{ text: "A", callback_data: "a" }]],
      }),
    ).toBeUndefined();
  });
});
