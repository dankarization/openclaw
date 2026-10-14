// Deterministic QA orchestration only. Never opens or reads an attachment.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';

const workspace = path.resolve(process.argv[2] ?? '');
const receiptPath = path.resolve(process.argv[3] ?? '');
if (!workspace.startsWith('/QA_ROOT/media-lane/proof/full-gateway/') || receiptPath !== path.dirname(workspace) + '/provider-receipt.private.jsonl') throw Error('Use the owned proof workspace/receipt');
let requests = 0;
const attempt = new Date().toISOString().replaceAll(/[^0-9A-Za-z]/g, '-');
const plain = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => plain(v?.text ?? v?.content ?? '')).join('\n') : '';
const digest = value => createHash('sha256').update(value).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const record = value => appendFile(receiptPath, JSON.stringify({ at: new Date().toISOString(), fixtureRevision: 4, attempt, ...value }) + '\n', { mode: 0o600 });
// Native wire IDs may be rewritten to opaque call IDs. Pair exact IDs and native exec names within the current user turn.
export function resolveCurrentTurn(messages) {
  // Native transport can put framed runtime context after the tool result.
  // A new user turn must never reuse an older turn's attachment or checksum.
  const isRuntime = m => /^(?:OpenClaw runtime context:|<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>)/.test(plain(m?.content).trimStart());
  const start = messages.findLastIndex(m => m.role === 'user' && !isRuntime(m));
  if (start < 0) throw Error('No actual user turn in native model request');
  const current = messages.slice(start);
  const calls = current.flatMap(m => m.role === 'assistant' ? m.tool_calls ?? [] : []);
  const result = [...current].reverse().find(m => m.role === 'tool' && calls.some(c => c.id === m.tool_call_id && c.function?.name === 'exec'));
  if (result) {
    if (!calls.some(c => c.id === result.tool_call_id && c.function?.name === 'exec')) throw Error('Native exec result has no paired fixture call');
    return { result };
  }
  const pending = calls.find(c => c.function?.name === 'exec');
  if (pending) throw Error('Native exec was requested but no paired result reached this request; refusing duplicate execution');
  const attachment = [...current].reverse().find(m => ['user', 'developer'].includes(m.role) && /\[media attached(?: \d+\/\d+)?:/.test(plain(m.content)));
  if (!attachment) throw Error('Current native user turn has no attachment marker; older attachments cannot be reused');
  return { attachment };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') { res.end('QA provider ready'); return; }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    if (++requests > 12) throw Error('Bounded QA request budget exhausted');
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw Error('QA request too large'); chunks.push(chunk); }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (requests <= 12) {
      const directory = path.dirname(receiptPath) + '/raw-model-requests';
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(`${directory}/${attempt}-${requests}.private.json`, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
    }
    const messages = request.messages ?? [];
    const turn = resolveCurrentTurn(messages);
    const offeredExec = (request.tools ?? []).find(t => t.type === 'function' && t.function?.name === 'exec');
    let message; let finish = 'stop';
    if (turn.result) {
      const output = plain(turn.result.content);
      const checksum = /\b([a-f0-9]{64})\s+[^\r\n]+/.exec(output)?.[1];
      const size = /^\s*(\d+)\s+[^\r\n]+$/m.exec(output)?.[1];
      if (!checksum || !size || /permission denied|missing scope|approval required/i.test(output)) throw Error('Native exec supplied no completed byte-count/checksum result');
      message = { role: 'assistant', content: `QA_NATIVE_MEDIA_PROOF bytes=${size} sha256=${checksum}` };
      await record({ event: 'native_tool_result_observed', requestNumber: requests, toolCallId: turn.result.tool_call_id, bytes: Number(size), sha256: checksum, outputSha256: digest(output), trailingRole: messages.at(-1)?.role });
    } else {
      const user = turn.attachment;
      if (!user || !offeredExec) throw Error('Real model request has no attachment marker or native exec tool');
      const markers = [...plain(user.content).matchAll(/\[media attached(?: \d+\/\d+)?:\s*([^\]\n]+)\]/g)];
      const attachment = markers.map(m => m[1].split(' | ')[0].replace(/\s+\([^)]*\)$/, '').trim()).find(p => p.endsWith('.bin'));
      if (!attachment || !path.isAbsolute(attachment) || !path.resolve(attachment).startsWith(workspace + path.sep)) throw Error('No actual staged workspace attachment path in model request');
      const command = `wc -c -- ${quote(attachment)} && sha256sum -- ${quote(attachment)}`;
      const id = `qamediaexec${requests}`;
      message = { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'exec', arguments: JSON.stringify({ command, workdir: workspace, timeoutSeconds: 90, yieldMs: 10000 }) } }] };
      finish = 'tool_calls';
      await record({ event: 'native_exec_requested', requestNumber: requests, toolCallId: id, requestSha256: digest(JSON.stringify(request)), stagedPathSha256: digest(attachment), tool: 'exec', pathSource: 'actual user attachment marker in native model request' });
    }
    const completion = { id: `qa_media_${requests}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: request.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    if (request.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const base = { id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: request.model };
      const delta = { role: 'assistant', ...(message.content ? { content: message.content } : {}), ...(message.tool_calls ? { tool_calls: message.tool_calls.map((c, index) => ({ index, ...c })) } : {}) };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: completion.usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(completion)); }
  } catch (error) {
    await record({ event: 'fixture_setup_or_contract_error', requestNumber: requests, error: String(error) });
    if (!res.headersSent) res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: String(error), type: 'qa_fixture_contract' } }));
  }
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(18949, '127.0.0.1', () => console.log('QA_MEDIA_PROVIDER_READY port=18949 fixtureRevision=3'));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
