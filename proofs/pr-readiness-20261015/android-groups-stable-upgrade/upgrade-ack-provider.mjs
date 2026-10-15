import http from 'node:http';import fs from 'node:fs';
const dir='/QA_ROOT/groups-proof-20261015/live';
http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);let input={};try{input=JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{}
const matched=JSON.stringify(input.messages||input.input||input.prompt||[]).includes('QAQUEUE');
fs.appendFileSync(`${dir}/upgrade-provider-events.jsonl`,JSON.stringify({at:new Date().toISOString(),method:req.method,path:req.url,containsQueueText:matched,stream:input.stream===true})+'\n',{mode:0o600});
if(req.url?.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'list',data:[{id:'proof-model',object:'model',owned_by:'qa'}]}));return}
const content=matched?'QA_UPGRADE_QUEUE_RECEIVED':'QA_UPGRADE_SYNTHETIC_ACK';const base={id:'qa-upgrade-native',model:'proof-model',created:Math.floor(Date.now()/1000)};
if(input.stream){res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')}
else{res.setHeader('content-type','application/json');res.end(JSON.stringify({...base,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}))}
}).listen(18944,'127.0.0.1');
