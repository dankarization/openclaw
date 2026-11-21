import { expect, it, vi } from "vitest";
import { createCronTool } from "./cron-tool.js";
import * as gateway from "./gateway.js";

const personalReminder = {
  profileId: "alice",
  agentId: "main",
  sessionKey: "agent:main:chat",
  sessionId: "session-1",
  accountId: "default",
  to: "chat",
  threadId: 9,
};
it.each(["update", "run", "bind", "runs", "history"])(
  "does not invoke Gateway for personal reminder action %s",
  async (action) => {
    const spy = vi.spyOn(gateway, "callGatewayTool");
    try {
      const tool = createCronTool({ personalReminder });
      await expect(tool.execute("denied", { action, id: "other-job" })).rejects.toThrow(
        "Personal reminders allow only",
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  },
);
it("allows local plan before requiring a live Gateway requester grant", async () => {
  const spy = vi.spyOn(gateway, "callGatewayTool");
  try {
    const tool = createCronTool({ personalReminder, requireCreationPlan: true });
    await expect(
      tool.execute("plan", { action: "plan", names: ["Reminder"] }),
    ).resolves.toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
