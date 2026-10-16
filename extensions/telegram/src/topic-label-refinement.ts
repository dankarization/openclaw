import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { AUTO_TOPIC_LABEL_REFINE_PROMPT } from "./auto-topic-label-config.js";
import { resolveAgentDir } from "./bot-message-dispatch.agent.runtime.js";
import { generateTopicLabel } from "./bot-message-dispatch.runtime.js";
import { getTelegramRuntime } from "./runtime.js";
import { getTopicName, updateTopicName } from "./topic-name-cache.js";

/**
 * Durable, bounded state for the opt-in one-time DM topic label refinement.
 * Keyed by `<accountId>:<chatId>:<threadId>` so multi-account deployments with
 * colliding chat/topic IDs never share state; the entry only exists for labels
 * this bot generated, which doubles as the manual-rename guard (user-renamed
 * topics are detected by comparing the live cached name with the label).
 */
type TopicLabelRefinementEntry = {
  /** Label this bot generated for the first turn. */
  label: string;
  /** User task messages observed after the label was generated. */
  count: number;
  /** True once the single attempt has been claimed (see claim semantics). */
  done: boolean;
  /** Outcome of a claimed attempt, recorded best-effort after the effect. */
  outcome?: "renamed" | "failed";
};

const REFINEMENT_STORE_NAMESPACE = "telegram.topic-label-refinement";
const REFINEMENT_STORE_MAX_ENTRIES = 2_048;
const REFINEMENT_SOURCE_MAX_CHARS = 500;

function refinementKey(params: {
  accountId: string;
  chatId: number | string;
  threadId: number;
}): string {
  return `${params.accountId}:${params.chatId}:${params.threadId}`;
}

async function loadRefinementStore() {
  return getTelegramRuntime().state.openKeyedStore<TopicLabelRefinementEntry>({
    namespace: REFINEMENT_STORE_NAMESPACE,
    maxEntries: REFINEMENT_STORE_MAX_ENTRIES,
  });
}

/** Records that this bot generated the initial label; arms the refinement counter. */
export async function armTopicLabelRefinement(params: {
  accountId: string;
  chatId: number | string;
  threadId: number;
  label: string;
}): Promise<void> {
  try {
    const store = await loadRefinementStore();
    await store.register(refinementKey(params), {
      label: params.label,
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
  accountId: string;
  bot: {
    api: {
      editForumTopic: (
        chatId: number | string,
        threadId: number,
        opts: { name: string },
      ) => Promise<unknown>;
    };
  };
  /** Fails when the owning account/service was stopped or replaced. */
  assertServiceCurrent: () => void;
  cfg: Parameters<typeof resolveAgentDir>[0];
  agentId: string;
  chatId: number | string;
  threadId: number;
  userMessage: string;
  afterMessages: number;
  logVerbose: (message: string) => void;
}): Promise<void> {
  try {
    const key = refinementKey(params);
    const store = await loadRefinementStore();
    const entry = await store.lookup(key);
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
      await store.register(key, { ...next, done: true, outcome: "failed" });
      params.logVerbose("auto-topic-label: refinement skipped (topic renamed manually)");
      return;
    }
    const excerpt = truncateUtf16Safe(params.userMessage, REFINEMENT_SOURCE_MAX_CHARS);
    if (!excerpt.trim()) {
      return;
    }
    // Durable attempt claim BEFORE any external effect: a crash after the Bot
    // API edit (or a rejected edit) must never re-run the LLM and re-rename on
    // a later turn. Outcome is recorded best-effort afterwards.
    await store.register(key, { ...next, done: true, outcome: "failed" });
    params.assertServiceCurrent();
    let label: string | null;
    try {
      label = await generateTopicLabel({
        userMessage: [entry.label, excerpt].filter(Boolean).join("\n---\n"),
        prompt: AUTO_TOPIC_LABEL_REFINE_PROMPT,
        maxLength: 128,
        cfg: params.cfg,
        agentId: params.agentId,
        agentDir: resolveAgentDir(params.cfg, params.agentId),
      });
    } catch (err) {
      // The attempt was already consumed above; failure only logs.
      params.logVerbose(`auto-topic-label: refinement failed: ${String(err)}`);
      return;
    }
    if (!label) {
      params.logVerbose("auto-topic-label: refinement produced empty label");
      return;
    }
    if (label === entry.label) {
      await store.register(key, { ...next, done: true, outcome: "renamed" });
      return;
    }
    // Revalidate service authority immediately before the Bot API effect so a
    // stopped/reloaded account never renames after shutdown.
    params.assertServiceCurrent();
    await params.bot.api.editForumTopic(params.chatId, params.threadId, { name: label });
    await updateTopicName(params.chatId, params.threadId, { name: label });
    await store.register(key, { ...next, label, done: true, outcome: "renamed" });
    params.logVerbose(
      `auto-topic-label: refined topic ${params.chatId}/${params.threadId} (len=${label.length})`,
    );
  } catch (err) {
    params.logVerbose(`auto-topic-label: refinement failed: ${String(err)}`);
  }
}
