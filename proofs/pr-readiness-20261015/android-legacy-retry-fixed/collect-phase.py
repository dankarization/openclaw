# Endpoint/root literals are redacted placeholders; restore your QA values before execution.
from pathlib import Path
import json,urllib.request,time,datetime,sys,subprocess
r=Path('<QA_ROOT>');d=r/'groups-proof-20261015/retry-fixed';phase=sys.argv[1];assert phase in ['readonly-import','write-retry','post-consumption-relaunch']
s=json.loads((d/(phase+'-start.private.json')).read_text());s['finishedAt']=time.time()
a=json.load(urllib.request.urlopen(urllib.request.Request('<QA_RELAY_CONTROL_URL>/rpc',data=json.dumps({'method':'sessions.groups.list','params':{}}).encode(),headers={'content-type':'application/json'})));assert a['ok'];s['after']=a['payload'];events=[]
for line in (d.parent/'live/relay-current-main-events.ndjson').read_text().splitlines():
 e=json.loads(line);ts=datetime.datetime.fromisoformat(e['ts'].replace('Z','+00:00')).timestamp()
 if s['startedAt']<=ts<=s['finishedAt'] and e.get('method','').startswith('sessions.groups.') and e.get('event') in ['android-request','android-native-result']:events.append(e)
s['nativeEvents']=events
puts=[e for e in events if e.get('event')=='android-request' and e.get('method')=='sessions.groups.put']
if phase=='post-consumption-relaunch':
 assert not puts
 expected=json.loads((d/'write-retry-result.private.json').read_text())['after'];assert s['after']==expected
else:
 assert len(puts)==1 and puts[0]['params']=={'names':['QAFIX_RETRY'],'appendOnly':True}
 result=next(e for e in events if e.get('event')=='android-native-result' and e.get('id')==puts[0]['id'])
 if phase=='readonly-import':
  assert result['ok']==False and result['error']['code']=='FORBIDDEN';assert s['after']==s['before']
 else:
  assert result['ok']==True;before=json.loads((d/'readonly-import-result.private.json').read_text())['after']
  assert [g['name'] for g in s['after']['groups']]==[g['name'] for g in before['groups']]+['QAFIX_RETRY']
  assert s['after']['sectionOrder']==before['sectionOrder']
s['passed']=True;(d/(phase+'-result.private.json')).write_text(json.dumps(s,indent=2));print(json.dumps({'phase':phase,'actualAndroidPuts':len(puts),'nativeResultQualified':True,'sectionOrder':s['after']['sectionOrder']}))
