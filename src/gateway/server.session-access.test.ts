import path from "node:path";
import { beforeEach, expect, test } from "vitest";
import type { WebSocket } from "ws";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  BROWSER_ORIGIN,
  browserProxyAuth,
  configureBrowserAuth,
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  testState,
  TRUSTED_BROWSER_HEADERS,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

beforeEach(async () => {
  // Match the session-create harness: lazy family loading is not RPC execution.
  await import("./server-methods/sessions-create.js");
});

test("enforces confidential access across authenticated sockets without visual Draft", async () => {
  await configureBrowserAuth(browserProxyAuth(), {
    roles: {
      default: "staff",
      definitions: {
        staff: {
          agents: ["main"],
          scopes: ["operator.read", "operator.write"],
          sessions: { others: "write" },
        },
        admin: { agents: "*", scopes: ["operator.admin"], sessions: { others: "write" } },
      },
    },
  });
  const emails = {
    creator: "acl-creator@example.test",
    selected: "acl-selected@example.test",
    outsider: "acl-outsider@example.test",
    admin: "acl-admin@example.test",
  };
  const creator = ensureProfileForEmail(emails.creator);
  const selected = ensureProfileForEmail(emails.selected);
  await setUserProfileRole(ensureProfileForEmail(emails.admin).id, "admin");
  testState.sessionConfig = {
    sharing: {
      accessPolicy: {
        default: "creator",
        groups: [
          { agentId: "main", channel: "telegram", peerId: "-100123", profileIds: [selected.id] },
        ],
      },
    },
  };
  await withGatewayServer(async ({ port }) => {
    const sockets: WebSocket[] = [];
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("Gateway fixture must own an isolated state directory");
    }
    const connect = async (email?: string) => {
      const socket = await openWs(port, {
        ...TRUSTED_BROWSER_HEADERS,
        "x-forwarded-user": email ?? "",
      });
      sockets.push(socket);
      const response = await connectReq(socket, {
        client: CONTROL_UI_CLIENT,
        browserOrigin: BROWSER_ORIGIN,
        skipDefaultAuth: true,
        prePairDevice: true,
        deviceIdentityPath: path.join(
          stateDir,
          "acl-identities",
          email ?? "unknown",
          "client",
          "credentials.sqlite",
        ),
        scopes: email === emails.admin ? ["operator.admin"] : ["operator.read", "operator.write"],
      });
      return { socket, response };
    };
    try {
      const people = new Map<string, WebSocket>();
      for (const [actor, email] of Object.entries(emails)) {
        const connected = await connect(email);
        expect(connected.response.ok, JSON.stringify(connected.response.error)).toBe(true);
        people.set(actor, connected.socket);
      }
      expect((await connect()).response.ok).toBe(false);
      const owner = people.get("creator")!;
      const preclaimKey = "agent:main:telegram:group:-100123:topic:99";
      for (const actor of ["selected", "outsider"]) {
        const socket = people.get(actor)!;
        for (const method of ["sessions.create", "sessions.patch", "chat.send"]) {
          const params =
            method === "chat.send"
              ? {
                  sessionKey: preclaimKey,
                  message: "must not start a run",
                  idempotencyKey: "native-preclaim-" + actor,
                }
              : { key: preclaimKey, ...(method === "sessions.patch" ? { label: "preclaim" } : {}) };
          console.info("[session-access proof] preclaim", actor, method);
          const denied = await rpcReq(socket, method, params);
          expect(denied.ok, actor + " " + method).toBe(false);
        }
        const absent = await rpcReq<{ session?: unknown }>(owner, "sessions.describe", {
          key: preclaimKey,
        });
        expect(absent.payload?.session).toBeUndefined();
      }
      const member = people.get("selected")!;
      const privateKey = "agent:main:dashboard:acl-web-private";
      console.info("[session-access proof] create private web session");
      const created = await rpcReq(owner, "sessions.create", {
        key: privateKey,
        visibility: "shared",
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      const groupKey = "agent:main:telegram:group:-100123:topic:7";
      const scope = { agentId: "main", sessionKey: groupKey, sessionId: "acl-ws-group" };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        visibility: "shared",
        access: { mode: "source" },
        createdActor: { type: "human", source: "profile", id: creator.id },
      });
      const text = "confidential websocket fixture";
      await appendTranscriptMessage(scope, {
        eventId: "acl-ws-seed",
        message: { role: "user", content: text, timestamp: Date.now() },
      });
      for (const [actor, socket] of people) {
        console.info("[session-access proof] audience matrix", actor);
        const allowed = actor !== "outsider";
        const list = await rpcReq<{ sessions: Array<{ key: string }> }>(socket, "sessions.list", {
          archived: "all",
        });
        expect(list.ok, JSON.stringify(list.error)).toBe(true);
        expect(
          list.payload?.sessions.some((row) => row.key === groupKey),
          actor,
        ).toBe(allowed);
        expect(
          list.payload?.sessions.some((row) => row.key === privateKey),
          actor,
        ).toBe(actor === "creator" || actor === "admin");
        const described = await rpcReq<{ session: { key: string } | null }>(
          socket,
          "sessions.describe",
          { key: groupKey },
        );
        expect(described.payload?.session?.key === groupKey, actor).toBe(allowed);
        const history = await rpcReq(socket, "chat.history", { sessionKey: groupKey, limit: 10 });
        expect(JSON.stringify(history.payload ?? {}).includes(text), actor).toBe(allowed);
        const search = await rpcReq(socket, "sessions.search", {
          query: "confidential",
          limit: 25,
          scope: { archived: "all" },
        });
        expect(search.ok, JSON.stringify(search.error)).toBe(true);
        expect(JSON.stringify(search.payload).includes(groupKey), actor).toBe(allowed);
        expect(
          (await rpcReq(socket, "sessions.patch", { key: groupKey, label: "acl-write-" + actor }))
            .ok,
          actor,
        ).toBe(allowed);
        if (!allowed) {
          expect(
            (
              await rpcReq(socket, "chat.send", {
                sessionKey: groupKey,
                message: "forbidden",
                idempotencyKey: "acl-outsider-send",
              })
            ).ok,
          ).toBe(false);
        }
      }
      const access = {
        key: groupKey,
        expectedSessionId: scope.sessionId,
        access: { mode: "creator" },
      };
      expect((await rpcReq(member, "sessions.patch", access)).ok).toBe(false);
      console.info("[session-access proof] revoke selected audience");
      const revoked = await rpcReq(owner, "sessions.patch", access);
      expect(revoked.ok, JSON.stringify(revoked.error)).toBe(true);
      const afterDescribe = await rpcReq<{ session: { key: string } | null }>(
        member,
        "sessions.describe",
        { key: groupKey },
      );
      expect(afterDescribe.payload?.session?.key === groupKey).toBe(false);
      const history = await rpcReq(member, "chat.history", { sessionKey: groupKey, limit: 10 });
      expect(JSON.stringify(history.payload ?? {}).includes(text)).toBe(false);
      expect((await rpcReq(member, "sessions.patch", { key: groupKey, label: "revoked" })).ok).toBe(
        false,
      );
      expect(
        (
          await rpcReq(member, "chat.send", {
            sessionKey: groupKey,
            message: "revoked",
            idempotencyKey: "acl-revoked-send",
          })
        ).ok,
      ).toBe(false);
    } finally {
      for (const socket of sockets) socket.terminate();
    }
  });
});
