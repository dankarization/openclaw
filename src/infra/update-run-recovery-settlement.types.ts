export type UpdateRecoverySettlementInventoryEntry = {
  relativePath: string;
  kind: "directory" | "file" | "symlink";
  nlink: number;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
  size: number;
  sha256: string | null;
};
export type UpdateRecoverySettlementArchive = {
  version: 1;
  runId: string;
  operationId: string;
  rawRecord: string;
  rawSha256: string;
  attestationSha256: string;
  oldBootId: string;
  currentBootId: string;
  installRoot: string;
  anchorQuarantinePath: string;
  controlQuarantinePath: string;
  inventory: {
    anchor: UpdateRecoverySettlementInventoryEntry[];
    control: UpdateRecoverySettlementInventoryEntry[];
  };
  serviceUid: number;
  serviceGid: number;
  serviceUnit: string;
  readiness: {
    version: string;
    buildId: string | null;
    bootId: string;
    readyz: true;
    settled: true;
    pluginsReady: true;
    channelsReady: true;
  };
  archivedAtMs: number;
};
export type UpdateRecoverySettlementArchiveOperations = {
  "updateRecovery.archivePreviousBoot": {
    input: {
      runId: string;
      expectedRawSha256: string;
      expectedUpdatedAtMs: number;
      attestationSha256: string;
      archive: UpdateRecoverySettlementArchive;
    };
    output: { outcome: "archived" | "already-archived"; archiveKey: string };
  };
};

export type UpdatePreviousBootSettlementReceipt = {
  version: 1;
  operationId: string;
  attestationSha256: string;
  phase:
    | "intent-persisted"
    | "control-moved"
    | "control-reserved"
    | "anchor-moved"
    | "inventory-verified"
    | "committed";
  installRoot: string;
  installIdentity: string;
  installFingerprint: { digest: string; identity: string; version: string };
  previousFingerprint: { digest: string; identity: string; version: string };
  launchers: Array<{ name: string; path: string; candidate: string; previous: string | null }>;
  anchorIdentity: string;
  controlIdentity: string;
  quarantineRoot: string;
  packageOperationSha256: string;
  serviceUnit: string;
  inventory?: {
    anchor: UpdateRecoverySettlementInventoryEntry[];
    control: UpdateRecoverySettlementInventoryEntry[];
  };
  updatedAtMs: number;
};
export type UpdatePreviousBootSettlementReceiptOperations = {
  "updateRecovery.previousBootReceipt": {
    input: {
      operationId: string;
      expectedUpdatedAtMs: number | null;
      receipt: UpdatePreviousBootSettlementReceipt;
    };
    output: { updatedAtMs: number };
  };
};
