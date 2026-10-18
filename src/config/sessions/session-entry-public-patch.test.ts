import { describe, expect, it } from "vitest";
import { preserveGenerationPrivateFields } from "./session-entry-public-patch.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

describe("preserveGenerationPrivateFields", () => {
  it("restores titleRefinement across same-session plugin upserts (4304147107)", () => {
    const persistedEntry: InternalSessionEntry = {
      sessionId: "session-1",
      updatedAt: 123,
      lifecycleRevision: "rev-1",
      titleRefinement: {
        sessionId: "session-1",
        generatedName: "Planning",
        taskMessagesSinceTitle: 3,
        refinementDone: false,
        recentMessages: ["task excerpt"],
      },
    };
    // A plugin/SDK upsert projects titleRefinement away before it reaches the
    // store; a same-generation upsert patch must carry the refinement state
    // forward or the bounded refinement loses its count and armed marker.
    const publicPatch: Partial<SessionEntry> = { displayName: "Planning" };
    const patch = preserveGenerationPrivateFields(persistedEntry, publicPatch);
    expect(patch.titleRefinement).toEqual(persistedEntry.titleRefinement);
    expect(patch.displayName).toBe("Planning");
  });

  it("does not restore private fields when the session rotates", () => {
    const persistedEntry: InternalSessionEntry = {
      sessionId: "session-1",
      updatedAt: 123,
      lifecycleRevision: "rev-1",
      titleRefinement: {
        sessionId: "session-1",
        generatedName: "Planning",
        taskMessagesSinceTitle: 1,
        refinementDone: false,
      },
    };
    const patch = preserveGenerationPrivateFields(persistedEntry, {
      sessionId: "session-2",
      lifecycleRevision: "rev-2",
    });
    expect(patch.titleRefinement).toBeUndefined();
  });
});
