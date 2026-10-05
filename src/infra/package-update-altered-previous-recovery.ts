import "./sealed-runtime-bootstrap.js";
import { runPackageActivationRecovery } from "./package-update-activation.js";

/** Source operator entry point; the original sealed helper remains immutable. */
export async function runAcknowledgedAlteredPreviousRecovery(args: string[]) {
  if (
    args.length !== 7 ||
    args[0] !== "--anchor" ||
    args[2] !== "--operation" ||
    args[4] !== "--backup-parent" ||
    args[6] !== "--discard-altered-previous-after-verified-backup"
  ) {
    throw new Error(
      "Usage: --anchor absolute-path --operation operation-id --backup-parent absolute-path --discard-altered-previous-after-verified-backup",
    );
  }
  return runPackageActivationRecovery(args[1]!, "retire-altered-previous", args[3]!, {
    acknowledgement: "discard-altered-previous-after-verified-backup",
    backupParent: args[5]!,
  });
}
