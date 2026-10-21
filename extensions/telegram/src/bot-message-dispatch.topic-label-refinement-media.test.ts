import { beforeEach, expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  loadSessionStore,
} from "./bot-message-dispatch.test-harness.js";

const naming = vi.hoisted(() => ({
  arm: vi.fn(async () => {}),
  attach: vi.fn(async () => {}),
  refine: vi.fn(async () => {}),
}));
// mock-isolation: this suite owns dispatch-to-naming selection; durable claims
// and rename guards are covered by the refinement owner's tests.
vi.mock("./topic-label-refinement.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./topic-label-refinement.js")>()),
  armTopicLabelRefinement: naming.arm,
  attachTopicLabelRefinementLabel: naming.attach,
  maybeRefineTopicLabel: naming.refine,
}));
// mock-isolation: do not open a topic-cache database for dispatcher selection.
vi.mock("./topic-name-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./topic-name-cache.js")>()),
  updateTopicName: vi.fn(async () => {}),
}));

describeTelegramDispatch("DM topic naming for captionless media", () => {
  beforeEach(() => {
    naming.arm.mockClear();
    naming.attach.mockClear();
    naming.refine.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Task reply" }, { kind: "final" });
      return { queuedFinal: true };
    });
  });

  it.each(["image", "document", "audio"] as const)(
    "counts a captionless %s follow-up using current media facts",
    async (kind) => {
      const context = createContext();
      context.ctxPayload.RawBody = "";
      context.ctxPayload.Body = "Envelope containing old quoted text";
      context.ctxPayload.media = [{ kind, path: "/private/current-file" }];
      loadSessionStore.mockReturnValue({ [context.ctxPayload.SessionKey!]: { systemSent: true } });
      await dispatchWithContext({
        context,
        telegramCfg: { autoTopicLabel: { refine: true, refineAfterMessages: 1 } },
      });
      await vi.waitFor(() => {
        expect(naming.refine).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ userMessage: `<media:${kind}>`, afterMessages: 1 }),
        );
      });
    },
  );

  it("names the first captionless media turn before attaching refinement provenance", async () => {
    const context = createContext();
    context.ctxPayload.RawBody = "";
    context.ctxPayload.media = [{ kind: "image" }];
    const bot = createBot();
    const editForumTopic = vi.fn<typeof bot.api.editForumTopic>().mockResolvedValue(true);
    bot.api.editForumTopic = editForumTopic;
    await dispatchWithContext({
      context,
      bot,
      telegramCfg: { autoTopicLabel: { refine: true, refineAfterMessages: 1 } },
    });
    await vi.waitFor(() => expect(naming.attach).toHaveBeenCalledTimes(1));
    expect(editForumTopic).toHaveBeenCalledWith(123, 777, { name: "Topic label" });
    expect(naming.arm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ label: "" }));
  });
});
