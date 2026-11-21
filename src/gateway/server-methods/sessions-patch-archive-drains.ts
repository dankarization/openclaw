import { releaseSessionPatchArchive } from "./sessions-patch-archive.js";
import type { PreparedPatchTarget } from "./sessions-patch-types.js";

export async function releaseSessionPatchArchiveDrains(targets: PreparedPatchTarget[]) {
  await Promise.all(targets.map((target) => releaseSessionPatchArchive(target.archivePreparation)));
}
