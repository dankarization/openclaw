import type {
  TelegramAccountConfig,
  TelegramDirectConfig,
} from "openclaw/plugin-sdk/config-contracts";

const AUTO_TOPIC_LABEL_DEFAULT_PROMPT =
  "Generate a very short topic label (2-4 words, max 25 chars) for a chat conversation based on the supplied source message. No emoji. Use the same language as the message, in sentence case: capitalize only the first word and words that language always capitalizes. Be concise and descriptive. Return ONLY the topic name, nothing else.";

const AUTO_TOPIC_LABEL_REFINE_PROMPT =
  "Generate a very short topic label (2-4 words, max 25 chars) for a chat conversation based on the supplied conversation excerpt. Use the language the excerpt is written in, not the language of quoted literals, in sentence case: capitalize only the first word and words that language always capitalizes. No emoji. Return ONLY the topic name, nothing else.";

/** Default task messages after the first turn before the one-time refinement runs. */
export const AUTO_TOPIC_LABEL_REFINE_AFTER_MESSAGES_DEFAULT = 6;

export function resolveAutoTopicLabelRefineConfig(params: {
  directConfig?: TelegramDirectConfig["autoTopicLabel"];
  accountConfig?: TelegramAccountConfig["autoTopicLabel"];
}): { enabled: boolean; afterMessages: number } {
  const read = (
    config: TelegramDirectConfig["autoTopicLabel"] | undefined,
  ): { refine?: boolean; refineAfterMessages?: number } | undefined =>
    config && typeof config === "object" ? config : undefined;
  const direct = read(params.directConfig);
  const account = read(params.accountConfig);
  const refine = direct?.refine ?? account?.refine;
  const rawAfter = direct?.refineAfterMessages ?? account?.refineAfterMessages;
  return {
    enabled: refine === true,
    afterMessages:
      typeof rawAfter === "number" && Number.isInteger(rawAfter) && rawAfter >= 1 && rawAfter <= 100
        ? rawAfter
        : AUTO_TOPIC_LABEL_REFINE_AFTER_MESSAGES_DEFAULT,
  };
}

export function resolveAutoTopicLabelConfig(
  directConfig?: TelegramDirectConfig["autoTopicLabel"],
  accountConfig?: TelegramAccountConfig["autoTopicLabel"],
): { enabled: true; prompt: string } | null {
  const config = directConfig ?? accountConfig;
  if (config === undefined || config === true) {
    return { enabled: true, prompt: AUTO_TOPIC_LABEL_DEFAULT_PROMPT };
  }
  if (config === false || config.enabled === false) {
    return null;
  }
  return {
    enabled: true,
    prompt: config.prompt?.trim() || AUTO_TOPIC_LABEL_DEFAULT_PROMPT,
  };
}
