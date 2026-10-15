import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const root='/QA_ROOT',run=`${root}/groups-proof-20261015/live`;
Object.assign(process.env,{OPENCLAW_STATE_DIR:`${run}/state`,OPENCLAW_CONFIG_PATH:`${run}/openclaw.json`});
const identity=JSON.parse(await fs.readFile(`${run}/android-identity.private.json`,'utf8'));
const deviceIdentity={deviceId:identity.deviceId,privateKeyPem:crypto.createPrivateKey({key:Buffer.from(identity.privateKeyPkcs8Base64,'base64'),format:'der',type:'pkcs8'}).export({type:'pkcs8',format:'pem'}),publicKeyPem:crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(identity.publicKeyRawBase64,'base64')]),format:'der',type:'spki'}).export({type:'spki',format:'pem'})};
const {GatewayClient}=await import(`${root}/android-lane/src/gateway/client.ts`);
const profile=process.argv[2]||'readonly';
if(!['readonly','write'].includes(profile))throw Error('bad profile');
const scopes=profile==='readonly'?['operator.read']:['operator.read','operator.write'];
let client;
async function connect(auth){return await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('native connect timeout')),40000);client=new GatewayClient({url:'ws://127.0.0.1:18943',...auth,deviceIdentity,clientName:'openclaw-android',mode:'ui',platform:'android',deviceFamily:'Android',clientDisplayName:'Synthetic Android acceptance',role:'operator',scopes,requestTimeoutMs:120000,onHelloOk:h=>{clearTimeout(t);resolve(h)},onConnectError:e=>{clearTimeout(t);reject(e)}});client.start();});}
const admin=(await fs.readFile(`${run}/admin.token`,'utf8')).trim();
let hello=await connect({token:admin});
if(JSON.stringify(hello.auth?.scopes?.toSorted())!==JSON.stringify(scopes.toSorted()))throw Error('unexpected granted scopes');
const deviceToken=hello.auth?.deviceToken;
if(!deviceToken)throw Error('native Gateway omitted device grant');
await client.stopAndWait();
hello=await connect({deviceToken});
if(JSON.stringify(hello.auth?.scopes?.toSorted())!==JSON.stringify(scopes.toSorted()))throw Error('device token grant mismatch');
const grant={gatewayId:'manual|[QA_HOST]|18945',deviceId:identity.deviceId,token:deviceToken,scopes};
await fs.writeFile(`${run}/android-grant.private.json`,JSON.stringify(grant),{mode:0o600});
const evidence={profile,grantedScopes:hello.auth.scopes,authMethod:hello.auth.method,health:null,before:null,mutation:null,after:null};
try{
 evidence.health=Boolean((await client.request('health',{})).ok);
 const settings=async()=>await client.request('sessions.groups.list',{});
 evidence.before=await settings();
 if(profile==='readonly')try{await client.request('sessions.groups.put',{names:['QA_READONLY_MUST_NOT_EXIST'],appendOnly:true});evidence.mutation={accepted:true};}catch(error){evidence.mutation={accepted:false,error:String(error)};}
 evidence.after=await settings();
 await fs.writeFile(`${run}/groups-${profile}-native-rpc.json`,JSON.stringify(evidence,null,2),{mode:0o600});
 console.log(JSON.stringify(evidence));
 if(profile==='readonly'&&(evidence.mutation.accepted||JSON.stringify(evidence.before)!==JSON.stringify(evidence.after)))throw Error('read-only mutation invariant failed');
}finally{await client.stopAndWait();}
