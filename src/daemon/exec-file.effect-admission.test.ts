import { afterEach, expect, it, vi } from "vitest";
import * as processRunner from "../process/exec.js";
import { execFileUtf8 } from "./exec-file.js";
import * as authority from "./service-update-authority.js";

afterEach(() => vi.restoreAllMocks());

it("refuses an expired forward effect before spawning a native command", async () => {
  vi.spyOn(authority, "getGatewayServiceUpdateNativeCommand").mockReturnValue(undefined);
  vi.spyOn(authority, "assertGatewayServiceUpdateCurrent").mockReturnValue(false);
  const spawn = vi.spyOn(processRunner, "runCommandWithTimeout");
  const expiry = new Error("Doctor parent deadline expired");
  await expect(
    execFileUtf8("synthetic-systemctl", ["stop"], {
      beforeEffect: () => {
        throw expiry;
      },
    }),
  ).rejects.toBe(expiry);
  expect(spawn).not.toHaveBeenCalled();
});

it("rechecks a queued scoped command before releasing its native input", async () => {
  const expiry = new Error("Doctor expired while native custody was prepared");
  let current = true;
  const native = vi.fn<
    NonNullable<ReturnType<typeof authority.getGatewayServiceUpdateNativeCommand>>
  >(async (_argv, options) => {
    await Promise.resolve();
    current = false;
    options.beforeInput?.(123, ["synthetic-systemctl", "stop"]);
    throw new Error("Native effect must not be released");
  });
  vi.spyOn(authority, "getGatewayServiceUpdateNativeCommand").mockReturnValue(native);
  await expect(
    execFileUtf8("synthetic-systemctl", ["stop"], {
      beforeEffect: () => {
        if (!current) {
          throw expiry;
        }
      },
    }),
  ).rejects.toBe(expiry);
  expect(native).toHaveBeenCalledOnce();
});
