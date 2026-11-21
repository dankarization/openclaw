import { expect, it } from "vitest";
import {
  filterPersonalReminderOwnerDeny,
  resolvePersonalReminderSubagentPolicy,
} from "./tool-resolution.personal-reminder.js";

it("removes only the built-in automations denial for an admitted reminder", () => {
  const policy = { deny: ["automations", "gateway", "message"] };
  expect(resolvePersonalReminderSubagentPolicy(policy, [], true)?.deny).toEqual([
    "gateway",
    "message",
  ]);
  expect(resolvePersonalReminderSubagentPolicy(policy, ["automations"], true)?.deny).toEqual(
    policy.deny,
  );
  expect(resolvePersonalReminderSubagentPolicy(policy, [], false)?.deny).toEqual(policy.deny);
  expect(filterPersonalReminderOwnerDeny(["automations", "other"], true)).toEqual(["other"]);
  expect(filterPersonalReminderOwnerDeny(["automations", "other"], false)).toEqual([
    "automations",
    "other",
  ]);
});
