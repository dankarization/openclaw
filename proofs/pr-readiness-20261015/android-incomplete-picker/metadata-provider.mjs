// Disclosed deterministic model fixture. Never substitutes Gateway acceptance.
import fs from 'node:fs';import http from 'node:http';
if(process.env.OC_ANDROID_INCOMPLETE_PROOF!=='1')throw Error('Explicit QA fixture activation required');
const out='/QA_ROOT/android-proof/live';let count=0;
http.createServer(async(req,res)=>{
 if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.statusCode=404;res.end();return;}
 try{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString());const n=++count;
  fs.appendFileSync(`${out}/metadata-model-requests.private.ndjson`,JSON.stringify({ts:new Date().toISOString(),n,body})+'\n',{mode:0o600});
  const base={id:`chatcmpl-qa-medium-${n}`,created:Math.floor(Date.now()/1000),model:'proof-model'};
  const content=`QA_CANONICAL_MEDIUM_ACK_${n}`;
  if(body.stream){
   res.setHeader('content-type','text/event-stream');res.setHeader('cache-control','no-cache');
   res.write('data: '+JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})+'\n\n');
   res.write('data: '+JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})+'\n\n');res.end('data: [DONE]\n\n');
  }else{res.setHeader('content-type','application/json');res.end(JSON.stringify({...base,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}));}
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
}).listen(18944,'127.0.0.1');
