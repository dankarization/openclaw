import assert from "node:assert/strict";
import { expect, onTestFinished } from "vitest";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { retainedOperatorFixture } from "./subagent-registry.completed-followup-authority.test-support.js";
import type { RequesterWakeFixture } from "./subagent-registry.requester-wake-session.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

export async function admitRequesterWakeFixture({
  createGatewayContext,
  getFixture,
  requesterSessionKey,
  spawnVisibleChild,
  children,
  requesterTurnRunId,
}: Pick<
  RequesterWakeFixture,
  "createGatewayContext" | "getFixture" | "requesterSessionKey" | "spawnVisibleChild"
> & {
  children: ReadonlyArray<
    Omit<Parameters<RequesterWakeFixture["spawnVisibleChild"]>[0], "requesterTurnRunId">
  >;
  requesterTurnRunId: string;
}) {
  const gateway = createGatewayContext();
  const requester = await retainedOperatorFixture(
    "requester-wake-owner",
    gateway,
    gateway.resolveGatewayContext,
  );
  let originalHoldReleased = false;
  const releaseOriginalHold = () => {
    if (!originalHoldReleased) {
      originalHoldReleased = true;
      requester.source.release();
    }
  };
  onTestFinished(releaseOriginalHold);
  const requesterProfileId = requester.client.authenticatedUserProfile?.profileId;
  assert(requesterProfileId, "expected admitted requester profile");
  const requesterSession = {
    agentId: "main",
    sessionKey: requesterSessionKey,
    storePath: getFixture().sessionStorePath,
  };
  const originalRequester = getFixture().sessionStore[requesterSessionKey];
  assert(originalRequester, "expected requester session");
  await replaceSessionEntry(requesterSession, {
    ...originalRequester,
    createdActor: { type: "human", source: "profile", id: requesterProfileId },
  });
  getFixture().sessionStore[requesterSessionKey] =
    loadExactSessionEntryReadOnly(requesterSession)!.entry;
  const inRequesterScope = <T>(work: () => T) =>
    withPluginRuntimeGatewayRequestScope(
      {
        client: requester.client,
        context: requester.context,
        resolveGatewayContext: requester.resolveGatewayContext,
        isWebchatConnect: () => false,
      },
      work,
    );
  await inRequesterScope(async () => {
    for (const child of children) {
      await spawnVisibleChild({ ...child, requesterTurnRunId });
    }
  });
  for (const child of children) {
    const entry = registry.getSubagentRunByRunId(child.runId);
    assert(entry, "expected admitted child");
    subagentRuns.runWithCompletionAuthority(entry, () => {
      const retained =
        getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
      expect(retained?.source).toBe(requester.source.authority.source);
      expect(retained?.invocation).toBe(requester.source.authority.invocation);
    });
  }
  return { inRequesterScope, releaseOriginalHold };
}
