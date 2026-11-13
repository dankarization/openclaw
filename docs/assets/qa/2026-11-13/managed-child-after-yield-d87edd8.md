# Managed Codex child after parent yield — deployed build d87edd8

On 2026-11-13 we checked the newly deployed operator build `d87edd89be1e3fce38607c00afa2e460a6033254` (OpenClaw 2026.11.3). This is an integrated build with local patches, not clean upstream main.

The test used an owner Dashboard-to-Gateway request and an OpenClaw-managed Codex child on `openai/gpt-6.1-terra`. We read the child and parent histories independently and checked that the child's history belonged to the session returned by `sessions.describe`.

The first phase asked for tool aliases that this runtime does not expose. The child reported that problem and the parent woke automatically. We do not count that phase as successful command execution.

For the second phase we explicitly continued the same child once, using its registered Gateway tools. The parent yielded again. No extra user prompt or manual parent wake was sent while that phase ran.

| UTC | Actual history event |
| --- | --- |
| 01:11:23.494 | Parent's `sessions_yield` returned. |
| 01:11:30.050 | Child called registered `exec` with a 55-second delay and a random test nonce. |
| 01:11:34.305 onward | Child collected the process through registered `process` calls. |
| 01:12:28.510 | Process result contained the expected nonce and exit 0. |
| 01:12:35.045 | Child wrote its final result. |
| 01:12:51.596 | Parent automatically returned the matching result. |

The nonce's SHA-256 was `ddb5e42462829a2b7d470e1d5fce99cfff8eb5b99b8661f302222d8cd9db0476`. The child finished with status `done`.

This verifies registered Gateway command execution after yield, continuation in the same managed child, and automatic return on this installed build. A later attempt to read `/etc/os-release` was rejected by the path guard; we did not weaken the guard or count that file-read subcase as a pass.

This is not a new reproduction of the old failure on current main. It does not certify every native Codex helper, delegated channel permission, revocation case, or historical task recovery. There is no new Telegram client screenshot for this Dashboard check; the existing real Telegram captures remain linked in #197335.
