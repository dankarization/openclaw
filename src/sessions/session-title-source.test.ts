import { describe, expect, it } from "vitest";
import { resolveSessionTitleSource } from "./session-title-source.js";

describe("session title task source", () => {
  it("retains an absolute file task while ignoring commands without task skills", () => {
    expect(resolveSessionTitleSource("/tmp/report.csv summarize")).toBe(
      "/tmp/report.csv summarize",
    );
    for (const command of ["/status", "/model next", "/unknown task"]) {
      expect(resolveSessionTitleSource(command)).toBeNull();
    }
  });
  it("uses registered skill arguments without including the command token", () => {
    expect(
      resolveSessionTitleSource("/review signing", [
        { name: "review", skillName: "review", description: "Review a task" },
      ]),
    ).toBe("signing");
  });
});
