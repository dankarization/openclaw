import { describe, expect, it, vi } from "vitest";
import {
  assertUpdatePreviousBootAttestationBinding,
  createUpdatePreviousBootAttestation,
  UpdatePreviousBootAttestationSchema,
  type UpdatePreviousBootAttestation,
  type UpdatePreviousBootAttestationPaths,
} from "./update-previous-boot-attestation.js";

const oldBootId = "11111111-1111-4111-8111-111111111111";
const currentBootId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const paths: UpdatePreviousBootAttestationPaths = {
  installRoot: "/opt/openclaw",
  anchorPath: "/opt/.openclaw-anchor",
  controlPath: "/opt/.openclaw-anchor.control",
  journalPath: "/backup/operation.sqlite",
  helperPath: "/backup/recovery.mjs",
  archivePath: "/backup/recovery.tar",
  serviceUnit: "openclaw-gateway.service",
  launchers: [{ path: "/opt/openclaw/bin/openclaw", argv0: "/opt/openclaw/bin/openclaw" }],
};
const artifact = (filename: string) => ({
  path: filename,
  sha256: "a".repeat(64),
  dev: 1,
  ino: 2,
  size: 3,
});
const attestation = (): UpdatePreviousBootAttestation =>
  UpdatePreviousBootAttestationSchema.parse({
    version: 1,
    operationId,
    oldBootId,
    currentBootId,
    issuerUid: 0,
    serviceUid: 1000,
    serviceGid: 1000,
    installRoot: paths.installRoot,
    anchorPath: paths.anchorPath,
    controlPath: paths.controlPath,
    anchorIdentity: { path: paths.anchorPath, dev: 1, ino: 4, uid: 1000, gid: 1000, mode: 0o700 },
    controlIdentity: { path: paths.controlPath, dev: 1, ino: 5, uid: 1000, gid: 1000, mode: 0o700 },
    journal: artifact(paths.journalPath),
    helper: artifact(paths.helperPath),
    archive: artifact(paths.archivePath),
    serviceUnit: paths.serviceUnit,
    launchers: [{ ...artifact(paths.launchers[0]!.path), argv0: paths.launchers[0]!.argv0 }],
    issuedAtMs: 10,
    nonce: "44444444-4444-4444-8444-444444444444",
  });

describe("previous-boot operator attestation", () => {
  it("requires a privileged Linux producer before reading supplied artifacts", () => {
    const readJournalBootIds = vi.fn(() => [oldBootId, currentBootId]);
    expect(() =>
      createUpdatePreviousBootAttestation(
        {
          operationId,
          oldBootId,
          serviceUid: 1000,
          serviceGid: 1000,
          paths,
        },
        { effectiveUid: () => 1000, readJournalBootIds },
      ),
    ).toThrow(/effective UID 0/u);
    expect(readJournalBootIds).not.toHaveBeenCalled();
  });

  it("refuses same-boot assertions and journal history that cannot corroborate both IDs", () => {
    const base = {
      operationId,
      oldBootId,
      serviceUid: 1000,
      serviceGid: 1000,
      paths,
    };
    const overrides = {
      effectiveUid: () => 0,
      readBootId: () => currentBootId,
      now: () => 10,
      nonce: () => "44444444-4444-4444-8444-444444444444",
    };
    expect(() =>
      createUpdatePreviousBootAttestation(
        { ...base, oldBootId: currentBootId },
        { ...overrides, readJournalBootIds: () => [currentBootId] },
      ),
    ).toThrow(/must differ/u);
    expect(() =>
      createUpdatePreviousBootAttestation(base, {
        ...overrides,
        readJournalBootIds: () => [oldBootId],
      }),
    ).toThrow(/current boot ID is absent/u);
  });

  it("rejects malformed, replay-shaped, and same-boot records", () => {
    expect(() =>
      UpdatePreviousBootAttestationSchema.parse({
        ...attestation(),
        currentBootId: oldBootId,
      }),
    ).toThrow();
    expect(() =>
      UpdatePreviousBootAttestationSchema.parse({
        ...attestation(),
        unexpectedAuthority: true,
      }),
    ).toThrow();
  });

  it("binds an attestation to one operation, boot, service, installation, and launcher set", () => {
    const valid = attestation();
    expect(() =>
      assertUpdatePreviousBootAttestationBinding(
        valid,
        {
          expectedOperationId: operationId,
          expectedServiceUid: 1000,
          expectedServiceGid: 1000,
          expectedPaths: paths,
        },
        currentBootId,
      ),
    ).not.toThrow();
    expect(() =>
      assertUpdatePreviousBootAttestationBinding(
        valid,
        {
          expectedOperationId: "55555555-5555-4555-8555-555555555555",
          expectedServiceUid: 1000,
          expectedServiceGid: 1000,
          expectedPaths: paths,
        },
        currentBootId,
      ),
    ).toThrow(/does not match/u);
    expect(() =>
      assertUpdatePreviousBootAttestationBinding(
        valid,
        {
          expectedOperationId: operationId,
          expectedServiceUid: 1000,
          expectedServiceGid: 1000,
          expectedPaths: { ...paths, launchers: [] },
        },
        currentBootId,
      ),
    ).toThrow(/does not match/u);
    expect(() =>
      assertUpdatePreviousBootAttestationBinding(
        valid,
        {
          expectedOperationId: operationId,
          expectedServiceUid: 1000,
          expectedServiceGid: 1000,
          expectedPaths: paths,
        },
        oldBootId,
      ),
    ).toThrow(/does not match/u);
  });
});
