# Synthetic Gateway follow-up custody proof (#200155)

Run from the repository root with Node 24 and installed dependencies:

```sh
node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway-server-isolated.config.ts --maxWorkers=1 src/gateway/sessions-send-followup-terra-private.proof.test.ts
```

The forked Gateway project supplies the SQLite broker needed by this fixture. The test uses a temporary state directory, a synthetic named staff identity, and a loopback OpenAI Responses provider. No live account or external model is required.

One isolated Gateway run passed against the candidate runtime underlying `c531330ae9232c26f96a95052dc7ee4c81bcfb68`: the actual visible child reached the provider, a positive follow-up reached it, and changing child access at the dispatch boundary produced the expected normalized revocation denial and parent chat-history explanation. The revoked-child marker was absent from user-role provider inputs observed through parent completion. The test checks error fields, not `instanceof`; it does not assert zero provider calls or independently inspect an internal structured tool-result wrapper.

This is synthetic Gateway proof, not rendered-browser, live-provider, deployment, hosted-CI, or upstream-review evidence. The shared Gateway fixture delegates its reply mock to the real implementation because the visible child starts through `sessions.create` and `chat.send`.
