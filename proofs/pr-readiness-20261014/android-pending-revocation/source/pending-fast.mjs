import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';

// QA fixture only. No APK, native Gateway handler, or auth-policy changes.
// Start with the picker already open; pass actual visible High/Ultra coordinates.
const root = '/PATH/TO/OWN/QA-TASK';
const run = `${root}/android-proof/live`;
const exec = promisify(execFile);
const [contractPath] = process.argv.slice(2);
if (process.env.OC_ANDROID_PENDING_FAST !== '1' || !contractPath) {
  throw new Error('Requires root-approved OC_ANDROID_PENDING_FAST=1 and UI contract JSON');
}
const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
for (const name of ['firstTaps', 'secondTaps']) {
  if (!Array.isArray(contract[name]) || contract[name].length < 1 || contract[name].length > 3) throw new Error(name);
  for (const point of contract[name]) {
    if (!Array.isArray(point) || point.length !== 2 || point.some(n => !Number.isInteger(n) || n < 0 || n > 4096)) throw new Error('Invalid coordinates');
  }
}
const adb = `${root}/android-tools/sdk/platform-tools/adb`;
const logPath = `${run}/relay-events.ndjson`;
const trace = [];
const start = performance.now();
const record = (event, data = {}) => trace.push({ ts: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start), event, ...data });
const control = async path => {
  const response = await fetch(`http://127.0.0.1:18946/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Relay ${path}: ${response.status}`);
  return response.json();
};
const taps = async points => {
  // All values validated as integers. One adb roundtrip per UI intent sequence.
  const command = points.map(([x, y]) => `input tap ${x} ${y}`).join('; sleep 0.15; ');
  await exec(adb, ['-s', 'emulator-5560', 'shell', command], { timeout: 3500, maxBuffer: 8192 });
};
const readEvents = async () => (await fs.readFile(logPath, 'utf8')).slice(logOffset).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const identity = JSON.parse(await fs.readFile(`${run}/android-identity.private.json`, 'utf8'));
const token = (await fs.readFile(`${run}/admin.token`, 'utf8')).trim();
process.env.OPENCLAW_STATE_DIR = `${run}/state`;
process.env.OPENCLAW_CONFIG_PATH = `${run}/openclaw.json`;
const { GatewayClient } = await import(`${root}/repo/src/gateway/client.ts`);
let client;
const logOffset = (await fs.readFile(logPath, 'utf8')).length;
const output = `${run}/pending-fast-${Date.now()}.private.json`;
let armed = false;
let receipt = { status: 'NOT_RUN', contract: { firstTaps: contract.firstTaps, secondTaps: contract.secondTaps }, trace };
try {
  const hello = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native admin connect timeout')), 25000);
    client = new GatewayClient({ url: 'ws://127.0.0.1:18943', token, clientName: 'cli', mode: 'cli', clientDisplayName: 'Android bounded pending fixture', requestTimeoutMs: 15000, scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.pairing'], onHelloOk: h => { clearTimeout(timer); resolve(h); }, onConnectError: e => { clearTimeout(timer); reject(e); } });
    client.start();
  });
  record('native-admin-preconnected', { scopes: hello.auth?.scopes });
  if (!hello.auth?.scopes?.includes('operator.admin')) throw new Error('Admin scope not granted');
  const status = await control('status');
  if (status.held || !status.peers.some(p => p.connected && p.role === 'operator' && p.scopes?.includes('operator.write'))) throw new Error('Need fresh native Android write connection, and no held ACK');
  receipt.before = await client.request('sessions.list', {});
  const target = receipt.before.sessions?.find(s => s.key === 'agent:main:main');
  if (target?.thinkingLevel === 'high') throw new Error('First High must differ from current level; reset manually before running');
  await control('hold-next-patch'); armed = true;
  record('hold-armed');
  await taps(contract.firstTaps); record('first-high-ui-tap-complete');
  const waitStart = performance.now();
  let heldEvent;
  while (performance.now() - waitStart < 35000) {
    heldEvent = (await readEvents()).find(e => e.event === 'patch-ack-held');
    if (heldEvent) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!heldEvent) throw new Error('No native patch ACK held within 35 seconds');
  const firstRequest = (await readEvents()).find(e => e.event === 'android-request' && e.id === heldEvent.id);
  if (firstRequest?.thinkingLevel !== 'high') throw new Error('Held request was not High');
  record('first-high-native-ack-held', { id: heldEvent.id });
  const criticalStart = performance.now();
  await taps(contract.secondTaps); record('second-ultra-ui-tap-complete');
  // Admin is already authenticated. Revoke before releasing the first real ACK.
  record('native-revoke-issued');
  receipt.revoke = await client.request('device.token.revoke', { deviceId: identity.deviceId, role: 'operator' });
  receipt.detectedHoldToRevokeCompleteMs = Math.round(performance.now() - criticalStart);
  receipt.heldToRevokeCompleteMs = Number.isFinite(Date.parse(heldEvent.ts)) ? Date.now() - Date.parse(heldEvent.ts) : null;
  record('native-revoke-complete', { heldToRevokeCompleteMs: receipt.heldToRevokeCompleteMs });
  await control('release'); armed = false; record('first-native-ack-released');
  await new Promise(resolve => setTimeout(resolve, 1500));
  receipt.after = await client.request('sessions.list', {});
  receipt.relayEvents = await readEvents();
  receipt.status = receipt.heldToRevokeCompleteMs !== null && receipt.heldToRevokeCompleteMs < 5000 ? 'CAPTURED_REQUIRES_BEHAVIORAL_REVIEW' : 'INVALID_TIMING_OVER_5_SECONDS';
  // UI taps are intent evidence, not proof the native queue accepted the second
  // intent. Review relay/UI/state together; never infer denied RPC from silence.
} catch (error) {
  receipt.status = 'FAILED_OR_INCOMPLETE'; receipt.error = String(error);
} finally {
  if (armed) { try { await control('release'); record('cleanup-release'); } catch (error) { record('cleanup-release-failed', { error: String(error) }); } }
  try { receipt.relayEvents ??= await readEvents(); } catch {}
  await fs.writeFile(output, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  await client?.stopAndWait();
  console.log(JSON.stringify({ status: receipt.status, output, heldToRevokeCompleteMs: receipt.heldToRevokeCompleteMs }));
}
