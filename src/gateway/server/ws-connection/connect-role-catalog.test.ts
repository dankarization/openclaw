import { describe, expect, test } from "vitest";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import type { HelloOk } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import type { UsersListResult } from "../../../../packages/gateway-protocol/src/schema/users.js";
import { issueDeviceBootstrapToken } from "../../../infra/device-bootstrap.js";
import { revokeDeviceToken } from "../../../infra/device-pairing-tokens.js";
import { getPairedDevice } from "../../../infra/device-pairing.js";
import {
  CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
} from "../../../shared/device-bootstrap-profile.js";
import { setUserProfileRole } from "../../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { loadDeviceIdentity, openTrackedWs } from "../../device-authz.test-helpers.js";
import {
  BROWSER_ORIGIN,
  configureBrowserAuth,
  CONTROL_UI_CLIENT,
} from "../../server.auth.test-helpers.js";
import {
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "../../test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
await import("../../server.js");

describe("definitions-only operator admission", () => {
  test("keeps owner authority and leaves nonmember profile roles unenforced without a default", async () => {
    const origin = BROWSER_ORIGIN;
    const auth = { mode: "token", token: "definitions-only-secret" } as const;
    await configureBrowserAuth(auth, {
      roles: {
        definitions: {
          guest: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    });
    const started = await startServerWithClient(undefined, {
      auth,
      controlUiEnabled: true,
      wsHeaders: { origin },
    });
    try {
      const issued = await issueDeviceBootstrapToken({
        profile: CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
      });
      const loaded = loadDeviceIdentity("definitions-only-bootstrap");
      const options = {
        role: "operator",
        scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: loaded.identityPath,
      };
      const bootstrap = await connectReq(started.ws, {
        ...options,
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
      });
      expect(bootstrap.ok, JSON.stringify(bootstrap)).toBe(true);
      const deviceToken = (bootstrap.payload as HelloOk).auth.deviceToken;
      expect(deviceToken).toBeTruthy();
      const reconnect = await openTrackedWs(started.port, { origin });
      const connected = await connectReq(reconnect, {
        ...options,
        skipDefaultAuth: true,
        deviceToken,
      });
      expect(connected.ok, JSON.stringify(connected)).toBe(true);
      expect((connected.payload as HelloOk).auth.sessionCap).toBeUndefined();
      const person = ensureProfileForEmail("definitions-only@example.test");
      setUserProfileRole(person.id, "guest");
      const listed = await rpcReq<UsersListResult>(reconnect, "users.list", {});
      expect(listed.ok).toBe(true);
      const listedPerson = listed.payload?.profiles.find((p) => p.id === person.id);
      expect(listedPerson).toMatchObject({ role: "guest", roleSource: "default" });
      expect(listedPerson?.effectiveRole).toBeUndefined();
      const assigned = await rpcReq(reconnect, "users.setRole", {
        profileId: person.id,
        role: "guest",
      });
      expect(assigned).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: expect.stringContaining("gateway.roles.default"),
        },
      });
      expect(
        (await rpcReq(reconnect, "users.setRole", { profileId: person.id, role: null })).ok,
      ).toBe(true);
      reconnect.close();
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});

test("named default role admits paired credentials only within their grants", async () => {
  const origin = BROWSER_ORIGIN;
  const auth = { mode: "token", token: "paired-default-role-secret" } as const;
  await configureBrowserAuth(auth, {
    roles: {
      default: "guest",
      definitions: { guest: { sessions: { others: "none" }, agents: [], scopes: [] } },
    },
  });
  const started = await startServerWithClient(undefined, {
    auth,
    controlUiEnabled: true,
    wsHeaders: { origin },
  });
  const sockets: Awaited<ReturnType<typeof openTrackedWs>>[] = [];
  try {
    const issued = await issueDeviceBootstrapToken({ profile: CONTROL_UI_OWNER_BOOTSTRAP_PROFILE });
    const loaded = loadDeviceIdentity("default-role-bootstrap-owner");
    const scopes = [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES];
    const options = {
      role: "operator" as const,
      client: CONTROL_UI_CLIENT,
      deviceIdentityPath: loaded.identityPath,
      skipDefaultAuth: true,
      prePairDevice: false,
    };
    const bootstrap = await connectReq(started.ws, {
      ...options,
      scopes,
      bootstrapToken: issued.token,
    });
    expect(bootstrap.ok, JSON.stringify(bootstrap)).toBe(true);
    expect((bootstrap.payload as HelloOk).auth.scopes).toEqual([]);
    const token = (bootstrap.payload as HelloOk).auth.deviceToken;
    expect(token).toBeTruthy();
    expect((await getPairedDevice(loaded.identity.deviceId))?.approvedScopes).toEqual(scopes);
    expect(await rpcReq(started.ws, "sessions.list", {})).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    const reconnect = await openTrackedWs(started.port, { origin });
    sockets.push(reconnect);
    const connected = await connectReq(reconnect, { ...options, scopes, deviceToken: token });
    expect(connected.ok, JSON.stringify(connected)).toBe(true);
    expect((connected.payload as HelloOk).auth.scopes).toEqual([]);
    expect(await rpcReq(reconnect, "sessions.list", {})).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    reconnect.close();
    const limited = loadDeviceIdentity("default-role-limited-device");
    const provision = await openTrackedWs(started.port, { origin });
    sockets.push(provision);
    const provisioned = await connectReq(provision, {
      role: "operator",
      client: CONTROL_UI_CLIENT,
      deviceIdentityPath: limited.identityPath,
      token: auth.token,
      scopes: ["operator.read"],
    });
    expect(provisioned.ok, JSON.stringify(provisioned)).toBe(true);
    const limitedToken = (provisioned.payload as HelloOk).auth.deviceToken;
    expect(limitedToken).toBeTruthy();
    provision.close();
    const escalation = await openTrackedWs(started.port, { origin });
    sockets.push(escalation);
    expect(
      await connectReq(escalation, {
        role: "operator",
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: limited.identityPath,
        skipDefaultAuth: true,
        prePairDevice: false,
        deviceToken: limitedToken,
        scopes: ["operator.write"],
      }),
    ).toMatchObject({
      ok: false,
      error: { details: { code: ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH } },
    });
    expect((await getPairedDevice(limited.identity.deviceId))?.approvedScopes).toEqual([
      "operator.read",
    ]);
    await revokeDeviceToken({ deviceId: loaded.identity.deviceId, role: "operator" });
    const revoked = await openTrackedWs(started.port, { origin });
    sockets.push(revoked);
    expect(await connectReq(revoked, { ...options, scopes, deviceToken: token })).toMatchObject({
      ok: false,
      error: { details: { code: ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH } },
    });
  } finally {
    for (const socket of sockets) socket.close();
    started.ws.close();
    await started.server.close();
    started.envSnapshot.restore();
  }
});
