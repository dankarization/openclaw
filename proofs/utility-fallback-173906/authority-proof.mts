/**
 * Real-behavior authority proof for the utility fallback chain (openclaw#173906).
 *
 * Drives the PRODUCTION utility owner (`runUtilityCompletion` -> `runWithModelFallback`)
 * with a real `AdmittedRunOperatorAuthority` produced by the host-only factory, and a
 * recording HTTP endpoint that stands in for provider transport. Every dispatch is
 * recorded both at the owner boundary (`onAttempt`) and as a real network hit.
 *
 * Scenarios:
 *   S1  A utility candidate denied by the operator model policy receives ZERO
 *       provider I/O and ZERO dispatch attempts; the allowed backup is used.
 *   S2  Requester revocation between attempts stops ALL further dispatch: after the
 *       primary attempt fails, the revoked authority aborts the chain before the
 *       backup candidate can reach the provider.
 *
 * Run: node --import ./scripts/tsx.mjs proofs/utility-fallback-173906/authority-proof.mts
 */
import http from "node:http";
import { createAdmittedRunOperatorAuthority } from "../../src/agents/admitted-run-context.js";
import { FailoverError } from "../../src/agents/failover-error.js";
import { prepareOperatorModelPolicy } from "../../src/agents/operator-model-policy.js";
import { runUtilityCompletion } from "../../src/agents/utility-completion.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

type Hit = { path: string; authorization: string | undefined };
type Dispatch = { provider: string; model: string; authProfileId?: string };
type Attempt = { provider: string; model: string; authProfileId?: string };

const hits: Hit[] = [];
const server = http.createServer((req, res) => {
  hits.push({ path: req.url ?? "", authorization: req.headers.authorization });
  res.writeHead(503, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "synthetic provider outage" } }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: "main/large", fallbacks: ["main/expensive"] },
      utilityModel: { primary: "denied/primary", fallbacks: ["allowed/backup"] },
    },
  },
};

const request = (operatorAuthority: ReturnType<typeof createAdmittedRunOperatorAuthority>) => ({
  config: cfg,
  agentId: "main",
  provider: "denied",
  model: "primary",
  useUtilityModel: true as const,
  prompt: "Synthetic utility task",
  systemPrompt: "Return a short result.",
  timeoutMs: 2000,
  operatorAuthority,
});

function makeRecorder(dispatches: Dispatch[], attempts: Attempt[], revokeAfterFirst = false) {
  let calls = 0;
  let revoke: (() => void) | undefined;
  const providerCall = (body: unknown) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/chat/completions`,
        { method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  const run = async (candidate: Dispatch & { provider: string; model: string }) => {
    calls += 1;
    const { provider, model, authProfileId } = candidate;
    dispatches.push({ provider, model, authProfileId });
    await providerCall({ provider, model });
    if (revokeAfterFirst && calls === 1) {
      revoke?.();
    }
    throw new FailoverError("Synthetic provider outage", { reason: "timeout" });
  };
  return {
    run,
    onAttempt: (a: Attempt) =>
      attempts.push({ provider: a.provider, model: a.model, authProfileId: a.authProfileId }),
    setRevoke: (fn: () => void) => {
      revoke = fn;
    },
  };
}

const results: Record<string, unknown> = {};
let failures = 0;
function check(name: string, condition: boolean, detail: unknown) {
  results[name] = { ok: condition, detail };
  if (!condition) {
    failures += 1;
  }
}

// ---- S1: denied candidate receives no provider I/O -------------------------------
{
  hits.length = 0;
  const dispatches: Dispatch[] = [];
  const attempts: Attempt[] = [];
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "proof",
    scopes: ["operator.write"],
    assertCurrent() {},
    modelPolicy: prepareOperatorModelPolicy({
      cfg,
      policy: { allow: ["allowed/*"], deny: ["denied/*"] },
      manifestPlugins: [],
    }),
  });
  const rec = makeRecorder(dispatches, attempts);
  await runUtilityCompletion(request(authority), rec.run as never).catch(() => undefined);
  check(
    "S1_no_dispatch_to_denied_candidate",
    !dispatches.some((d) => d.provider === "denied"),
    dispatches,
  );
  check(
    "S1_no_provider_io_for_denied_candidate",
    hits.length === dispatches.length && hits.length <= 1,
    {
      hits,
      dispatches,
    },
  );
  check(
    "S1_allowed_backup_dispatched",
    dispatches.some((d) => d.provider === "allowed" && d.model === "backup"),
    dispatches,
  );
  check(
    "S1_owner_attempt_never_saw_denied",
    !attempts.some((a) => a.provider === "denied"),
    attempts,
  );
}

// ---- S2: requester revocation between attempts stops dispatch --------------------
{
  hits.length = 0;
  const dispatches: Dispatch[] = [];
  const attempts: Attempt[] = [];
  let revoked = false;
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "proof",
    scopes: ["operator.write"],
    assertCurrent() {
      if (revoked) {
        throw new Error("requester authority revoked");
      }
    },
    modelPolicy: prepareOperatorModelPolicy({
      cfg,
      policy: { allow: ["denied/*", "allowed/*"] },
      manifestPlugins: [],
    }),
  });
  const rec = makeRecorder(dispatches, attempts, true);
  rec.setRevoke(() => {
    revoked = true;
  });
  let error: unknown;
  await runUtilityCompletion(request(authority), rec.run as never).catch((e) => {
    error = e;
  });
  check("S2_primary_dispatched_once", dispatches.length === 1, dispatches);
  check(
    "S2_backup_not_dispatched_after_revocation",
    !dispatches.some((d) => d.model === "backup"),
    dispatches,
  );
  check("S2_no_second_provider_io", hits.length === 1, hits);
  check(
    "S2_chain_aborted_with_revocation",
    error instanceof Error && /revoked/.test(error.message),
    String(error),
  );
}

server.close();

console.log(
  JSON.stringify({ head: process.env.PROOF_HEAD ?? "unknown", results, failures }, null, 2),
);
if (failures > 0) {
  process.exitCode = 1;
}
