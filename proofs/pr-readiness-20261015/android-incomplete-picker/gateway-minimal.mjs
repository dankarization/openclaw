import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const root = '/QA_ROOT';
const run = `${root}/android-proof/live`;
await fs.mkdir(run, {recursive:true,mode:0o700});
await fs.mkdir(`${run}/state`, {recursive:true,mode:0o700});
await fs.mkdir(`${run}/home`, {recursive:true,mode:0o700});
Object.assign(process.env, {
  OPENCLAW_STATE_DIR:`${run}/state`, OPENCLAW_CONFIG_PATH:`${run}/minimal-fixture-config.candidate.private.json`,
  HOME:`${run}/home`, OPENCLAW_SKIP_BROWSER_CONTROL_SERVER:'1',
  OPENCLAW_SKIP_CANVAS_HOST:'1', OPENCLAW_SKIP_CHANNELS:'1',
  OPENCLAW_SKIP_CRON:'1', OPENCLAW_SKIP_GMAIL_WATCHER:'1',
});
let token;
try { token = (await fs.readFile(`${run}/admin.token`,'utf8')).trim(); }
catch { token = crypto.randomBytes(32).toString('hex'); await fs.writeFile(`${run}/admin.token`,token,{mode:0o600}); }
const config = {
 gateway:{mode:'local',port:18943,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}},
 agents:{defaults:{workspace:`${run}/workspace`,model:{primary:'qa/proof-model'},thinkingDefault:'medium'}},
 models:{providers:{qa:{baseUrl:'http://127.0.0.1:18944/v1',apiKey:'synthetic-qa-not-a-real-key',api:'openai-completions',models:[{id:'proof-model',name:'Synthetic QA model',reasoning:true,input:['text'],contextWindow:32000,maxTokens:2000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}},
};
try { await fs.access(`${run}/minimal-fixture-config.candidate.private.json`); }
catch { await fs.writeFile(`${run}/minimal-fixture-config.candidate.private.json`,JSON.stringify(config,null,2),{mode:0o600}); }
const {validateConfigObject,captureRuntimeConfigAsyncReader} = await import(`${root}/repo/src/config/config.ts`);
const validated = validateConfigObject(JSON.parse(await fs.readFile(`${run}/minimal-fixture-config.candidate.private.json`,'utf8')));
if(!validated.ok) throw new Error(JSON.stringify(validated.issues));
await captureRuntimeConfigAsyncReader()();
const {startGatewayServer} = await import(`${root}/repo/src/gateway/server.ts`);
const server = await startGatewayServer(18943,{bind:'loopback',controlUiEnabled:false});
await server.startupSettled;
console.log('ANDROID_PROOF_GATEWAY_READY port=18943');
const stop = async () => { await server.close({reason:'isolated Android proof finished'}); process.exit(0); };
process.on('SIGTERM',stop); process.on('SIGINT',stop);
