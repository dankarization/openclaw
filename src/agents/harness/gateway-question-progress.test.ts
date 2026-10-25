import { describe, expect, it, vi } from "vitest";
import { resolveAgentQuestionTextProgress } from "./gateway-question-progress.js";

describe("resolveAgentQuestionTextProgress", () => {
  it("uses a plain reply for the next unanswered question", async () => {
    const questionId = "ask_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const sessionKey = "agent:main:telegram:direct:42";
    const callQuestion = vi.fn(async (method: string) => {
      if (method === "question.get") {
        return {
          question: {
            id: questionId,
            sessionKey,
            status: "pending",
            draftRevision: 0,
            draftCompletedIds: [],
          },
        };
      }
      return { status: "pending" };
    });
    const result = await resolveAgentQuestionTextProgress({
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Where?",
          options: [{ label: "Staging" }, { label: "Review" }],
        },
        {
          id: "details",
          header: "Details",
          question: "What?",
          options: [{ label: "Logs" }, { label: "Screenshots" }],
        },
      ],
      text: "Staging",
      questionId,
      sessionKey,
      callQuestion,
    });
    expect(result).toEqual({ consumed: true, keepPending: true });
    expect(callQuestion).toHaveBeenCalledWith("question.resolve", {
      id: questionId,
      draftAnswers: { answers: { target: ["Staging"] } },
      expectedRevision: 0,
      completeQuestionId: "target",
    });
  });
});
