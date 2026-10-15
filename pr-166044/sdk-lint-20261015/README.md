# PR #166044: selected extension lint SDK preparation

The CI failure on `a29246c1e63568cef6fc065bf9af4f72fb192d29` occurred before extension lint: the complete SDK declaration build exceeded its existing 300000 ms limit in job `116109829497`, run `38638705521`.

The repair routes package-selected lint through the existing boundary discovery owner. It retains packaged entrypoints and adds all selected package TypeScript, JavaScript and JSX sources, including tests and unexported helpers. The actual lint shard targets and timeout remain unchanged. SDK declaration receipts, ambient roots, diagnostics and transitive producer discovery retain their existing owners.

## Source identity

- Public parent: `a29246c1e63568cef6fc065bf9af4f72fb192d29`
- Native repair commit: `3dcfa7f1d6f990a6aee27e131f3d5ab6b52c122e`
- Resulting tree: `856006f0e3b0d6f1908e309bb13c7fa86754eb2a`
- Four source files; 81 additions, 9 deletions.

## Reproduction and repair proof

The repaired actual extension stripe ran on the public parent plus these four files, using Node.js 24.21.0 on Linux. It selected telegram, prepared 156 SDK roots and emitted 12,548 files within the unchanged SDK deadline. Type-aware lint checked 505 files in 47.1 seconds with zero warnings or errors. Total wall time was 4:16.91, exit 0. See [captured excerpts](exact-extension-stripe.log).

Portable failing-stripe entry point:

```sh
CI=true OPENCLAW_LOCAL_CHECK=0 node --import ./scripts/tsx.mjs scripts/run-oxlint-shards.mts --only=extensions --extension-stripe=1/6 --threads=1 --extension-roots-json '["extensions/codex","extensions/slack","extensions/telegram"]'
```

A real native regression failed before the repair because a test-only SDK declaration was absent. After repair it passed for imports in both TypeScript and JavaScript tests, while an unrelated invalid SDK root remained outside compilation. Existing ambient, receipt reuse, transitive producer and lint selection cases also passed: 13 focused tests across two files. See [native regression evidence](native-regression.log).

Targeted type-aware lint of the three changed script owners passed with zero warnings and errors; see [lint output](targeted-owner-lint.log). Formatting and `git diff --check` passed. Independent Codex review of the exact four-file projection completed scoped-clean for P0-P2 with no findings. This proof does not claim a post-publication hosted CI result or a separate full typecheck.

## File SHA-256

- `scripts/lib/extension-boundary-projects.mts`: `1842f6cdafc7c1beec4bcca2fa96989cc71c466ae2fb1ba5acf1a112c6abcee2`
- `scripts/prepare-extension-package-boundary-artifacts.mts`: `a23d709fbb0281ba6d914bd1393ae8550cf4dc26fc8fd489fd776559781bf216`
- `scripts/run-oxlint-shards.mts`: `152a49066cf3ae3bd49d4de0517b29e94c482737e1260bf9660ef33ef39b47e2`
- `test/scripts/prepare-extension-package-boundary-artifacts.native.test.ts`: `372060ca7286ed183836d768c3fcfda6c306ddbca932f619da962d9212349b54`
