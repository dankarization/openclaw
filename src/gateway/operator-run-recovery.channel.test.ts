import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { captureScheduledOperatorSource } from "../agents/operator-run-recovery-source.js";
import { getCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import { prepareInternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { withAdminIngress } from "../channels/message-access/operator-authority.test-support.js";
import { readCronOperatorSnapshot } from "../cron/operator-source-snapshot.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { changeCanonicalUserChannelIdentity } from "../state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import {
  decodeQueuedOperatorRecoverySource,
  decodeGatewayOperatorRecoverySource,
} from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import {
  restoreGatewayQueuedOperatorRecovery,
  restorePersistedOperatorSource,
} from "./operator-run-recovery.js";

it.each([
  ["queued", "unlink"],
  ["queued", "reassign"],
  ["scheduled", "unlink"],
  ["scheduled", "reassign"],
] as const)(
  "recovers a persisted %s channel member and fences final I/O after %s",
  (kind, change) =>
    withAdminIngress(async ({ admins, context, gateway, retire, state }) => {
      const member = expectDefined(admins[0], "linked member");
      setUserProfileRole(member.profile.id, "member");
      const turn = await context(member.identity.senderId);
      expect(getCommandOwnerAuthority(turn)?.operatorAuthority).toBeUndefined();
      const original = expectDefined(
        prepareInternalGetReplyOptions(undefined, turn)?.operatorAuthority,
        "verified channel member authority",
      );
      const queuedPath = path.join(state.stateDir, "queued-member.json");
      const captured = expectDefined(
        kind === "scheduled"
          ? captureScheduledOperatorSource({
              authority: original,
              agentId: "main",
              sessionKey: turn.SessionKey!,
              entry: { sessionId: "queued-member-session", updatedAt: 1 },
              sourceRunId: "member-create",
            })
          : captureQueuedOperatorRecoverySource(original),
        "captured channel member source",
      );
      expect(captured.kind).toBe("channel");
      if (kind === "scheduled") {
        expect(
          readCronOperatorSnapshot({
            operatorSource: {
              source: decodeGatewayOperatorRecoverySource(captured),
              executionRevision: "test",
            },
          }),
        ).toBeUndefined();
      }
      await writeFile(queuedPath, JSON.stringify(captured));
      retire();
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
      const stored: unknown = JSON.parse(await readFile(queuedPath, "utf8"));
      const restore = () =>
        kind === "scheduled"
          ? restorePersistedOperatorSource({
              source: decodeGatewayOperatorRecoverySource(stored),
              context: gateway,
              assertCurrent: () => {},
            })
          : restoreGatewayQueuedOperatorRecovery({
              source: decodeQueuedOperatorRecoverySource(stored),
              context: gateway,
              assertCurrent: () => {},
            });
      const restored = await restore();
      try {
        expect(restored.authority).toMatchObject({
          profileId: member.profile.id,
          scopes: ["operator.read", "operator.write"],
        });
        expect(restored.controlUiAdmin).toBe(false);
        await changeCanonicalUserChannelIdentity("unlink", member.profile.id, member.identity);
        if (change === "reassign") {
          const other = expectDefined(admins[1], "replacement owner");
          await changeCanonicalUserChannelIdentity("link", other.profile.id, member.identity);
        }
        await expect(restore()).rejects.toThrow("Queued channel operator authority changed");
      } finally {
        restored.release();
      }
    }),
);
