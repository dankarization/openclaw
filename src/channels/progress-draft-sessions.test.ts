import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { projectAgentToolActivity } from "../infra/agent-activity-events.js";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("compacts identical Sessions limits while preserving labels and boundaries", async () => {
  const progress = createChannelProgressDraftCompositor({
    active: true,
    mode: "progress",
    seed: "sessions",
    preparedItems: true,
    compactToolRuns: true,
    entry: {
      streaming: { mode: "progress", progress: { label: false, toolProgress: true, maxLines: 3 } },
    },
    update: vi.fn(),
  });
  onTestFinished(() => progress.cancel());
  const sessions = (id: string, limit: number, isError = false) =>
    progress.pushItemEvent(
      projectAgentToolActivity({
        toolCallId: id,
        name: "sessions_list",
        args: { limit },
        phase: "result",
        isError,
      }),
    );
  await sessions("one", 30);
  await sessions("two", 30);
  expect(progress.getSnapshot().lines[0]).toMatchObject({ text: "Sessions: 30 ×2" });
  await sessions("other", 10);
  await sessions("fresh", 30);
  expect(progress.getSnapshot().lines).toHaveLength(3);
  expect(JSON.stringify(progress.getSnapshot().lines.slice(-2))).not.toContain("×2");
  await sessions("error", 30, true);
  expect(progress.getSnapshot().lines.at(-1)).toMatchObject({ status: "failed" });
});
