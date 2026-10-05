import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
}));

vi.mock("./update-command-terminal.js", () => ({
  withUpdateCommandTerminalResult: async (
    operation: (registerRun: (run: never) => void) => Promise<unknown>,
  ) => await operation(() => {}),
}));
vi.mock("./update-command-executor.js", () => ({
  withUpdateCommandExecutor: async (
    _runId: string,
    operation: (executor: Record<string, never>) => Promise<unknown>,
  ) => await operation({}),
}));
vi.mock("./update-command-service-env.js", () => ({
  resolveUpdateTargetEnv: ({ baseEnv }: { baseEnv: NodeJS.ProcessEnv }) => baseEnv,
  withOwnedManagedUpdateEnv: async (_env: NodeJS.ProcessEnv, operation: () => Promise<unknown>) =>
    await operation(),
  withUpdateInProgressEnv: async (_cwd: string | undefined, operation: () => Promise<unknown>) =>
    await operation(),
}));
vi.mock("./update-command-target.js", () => ({
  resolveUpdateCommandTarget: mocks.resolveTarget,
  resolveFreshUpdateMetadata: vi.fn(),
}));

import { initializeAndRunUpdate } from "./update-command-initialization-run.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("update initialization snapshot scratch propagation", () => {
  it("passes the caller snapshot root to the first target preflight before a run exists", async () => {
    mocks.resolveTarget.mockResolvedValueOnce(undefined);
    const snapshotTempDir = "/verified/caller-scratch";

    await initializeAndRunUpdate(
      { dryRun: false },
      {
        discoveredRoot: "/installed/candidate",
        installKind: "package",
        requestedChannel: null,
        timeoutMs: 12_000,
        shouldRestart: true,
        servicePlan: undefined,
      } as never,
      { triageTarget: { root: "/installed/candidate", env: {} } } as never,
      undefined,
      { TMPDIR: "/managed/service-scratch" },
      vi.fn(),
      snapshotTempDir,
    );

    expect(mocks.resolveTarget).toHaveBeenCalledOnce();
    expect(mocks.resolveTarget.mock.calls[0]?.[6]).toBe(snapshotTempDir);
  });
});
