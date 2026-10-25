import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { TelegramInlineButtons } from "./button-types.js";
import type { TelegramInputRichMessage } from "./rich-message.js";

/** Move a question's existing, authorized callbacks into the rich message body. */
export function buildTelegramQuestionRichMessage(params: {
  payload: ReplyPayload;
  buttons: TelegramInlineButtons | undefined;
}): TelegramInputRichMessage | undefined {
  const askUser = params.payload.channelData?.askUser as { questionId?: unknown } | undefined;
  if (typeof askUser?.questionId !== "string" || !params.buttons?.length) {
    return undefined;
  }
  const presentation = normalizeMessagePresentation(params.payload.presentation);
  const question = presentation?.blocks.find((block) => block.type === "text")?.text.trim();
  if (!question) {
    return undefined;
  }
  const rows = params.buttons
    .map((row) => ({
      type: "buttons" as const,
      buttons: row.map((button) => ({
        text: button.text,
        ...(button.callback_data ? { callback_data: button.callback_data } : {}),
        ...(button.url ? { url: button.url } : {}),
        ...(button.web_app ? { web_app: button.web_app } : {}),
        ...(button.style ? { style: button.style } : {}),
      })),
    }))
    .filter((row) => row.buttons.length > 0 && row.buttons.length <= 8);
  if (!rows.length) {
    return undefined;
  }
  return { blocks: [{ type: "paragraph", text: question }, ...rows] };
}
