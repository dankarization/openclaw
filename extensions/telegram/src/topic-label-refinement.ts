import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveAgentDir } from "./bot-message-dispatch.agent.runtime.js";
import { generateTopicLabel } from "./bot-message-dispatch.runtime.js";
import { getTelegramRuntime } from "./runtime.js";
import { getTopicName, updateTopicName } from "./topic-name-cache.js";

/**
 * Durable, bounded state for the opt-in one-time DM topic label refinement.
 * Keyed by `<chatId>:<threadId>`; the entry only exists for labels this bot
 * generated, which doubles as the manual-rename guard (user-renamed topics are
 * detected by comparing the live cached name with the generated label).
 */
type TopicLabelRefinementEntry = {
  /** Label this bot generated for the first turn. */
  label: string;
  /** User task messages observed after the label was generated. */
  count: number;
  /** True once the single refinement has run (successfully or not). */
  done: boolean;
};

const REFINEMENT_STORE_NAMESPACE = "telegram.topic-label-refinement";
const REFINEMENT_STORE_MAX_ENTRIES = 2_048;
const REFINEMENT_SOURCE_MAX_CHARS = 500;

function refinementKey(chatId: number | string, threadId: number): string {
  return `${chatId}:${threadId}`;
}

async function loadRefinementStore() {
  return getTelegramRuntime().state.openKeyedStore<TopicLabelRefinementEntry>({
    namespace: REFINEMENT_STORE_NAMESPACE,
    maxEntries: REFINEMENT_STORE_MAX_ENTRIES,
  });
}

/** Records that this bot generated the initial label; arms the refinement counter. */
export async function armTopicLabelRefinement(
  chatId: number | string,
  threadId: number,
  label: string,
): Promise<void> {
  try {
    const store = await loadRefinementStore();
    await store.register(refinementKey(chatId, threadId), {
      label,
      count: 0,
      done: false,
    });
  } catch (err) {
    console.warn(`auto-topic-label: refinement arming failed: ${String(err)}`);
  }
}

/**
 * Counts one later user turn toward the threshold and, exactly once, refines
 * the auto label. Never touches topics whose names the bot did not generate,
 * and never renames a topic that was manually renamed after generation.
 */
export async function maybeRefineTopicLabel(params: {
  bot: {
    api: {
      editForumTopic: (
        chatId: number | string,
        threadId: number,
        opts: { name: string },
      ) => Promise<unknown>;
    };
  };
  cfg: Parameters<typeof resolveAgentDir>[0];
  agentId: string;
  chatId: number | string;
  threadId: number;
  userMessage: string;
  afterMessages: number;
  logVerbose: (message: string) => void;
}): Promise<void> {
  try {
    const key = refinementKey(params.chatId, params.threadId);
    const store = await loadRefinementStore();
    const entry = await store.get(key);
    if (!entry || entry.done) {
      return;
    }
    const next: TopicLabelRefinementEntry = { ...entry, count: entry.count + 1 };
    if (next.count < params.afterMessages) {
      await store.register(key, next);
      return;
    }
    // Manual-rename guard: refine only while the topic still carries our label.
    const currentName = await getTopicName(params.chatId, params.threadId);
    if (currentName && currentName !== entry.label) {
      await store.register(key, { ...next, done: true });
      params.logVerbose("auto-topic-label: refinement skipped (topic renamed manually)");
      return;
    }
    const excerpt = truncateUtf16Safe(params.userMessage, REFINEMENT_SOURCE_MAX_CHARS);
    if (!excerpt.trim()) {
      return;
    }
    let label: string | undefined;
    try {
      label = await generateTopicLabel({
        userMessage: [entry.label, excerpt].filter(Boolean).join("\n---\n"),
        maxLength: 128,
        cfg: params.cfg,
        agentId: params.agentId,
        agentDir: resolveAgentDir(params.cfg, params.agentId),
      });
    } catch (err) {
      // Exactly-once: a failed generation still consumes the single attempt.
      params.logVerbose(`auto-topic-label: refinement failed: ${String(err)}`);
      await store.register(key, { ...next, done: true });
      return;
    }
    if (!label) {
      params.logVerbose("auto-topic-label: refinement produced empty label");
      await store.register(key, { ...next, done: true });
      return;
    }
    if (label === entry.label) {
      await store.register(key, { ...next, done: true });
      return;
    }
    await params.bot.api.editForumTopic(params.chatId, params.threadId, { name: label });
    await updateTopicName(params.chatId, params.threadId, { name: label });
    await store.register(key, { ...next, label, done: true });
    params.logVerbose(
      `auto-topic-label: refined topic ${params.chatId}/${params.threadId} (len=${label.length})`,
    );
  } catch (err) {
    params.logVerbose(`auto-topic-label: refinement failed: ${String(err)}`);
  }
}
