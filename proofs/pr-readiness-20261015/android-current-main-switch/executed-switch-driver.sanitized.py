import os
import json,urllib.request,subprocess,time,pathlib,re,xml.etree.ElementTree as E,datetime
r=pathlib.Path(os.environ['QA_ROOT']);out=r/'groups-proof-20261015/live'
adb=[str(r/'android-tools/sdk/platform-tools/adb'),'-s','emulator-5560']
def a(*args):return subprocess.check_output(adb+['shell',*args],text=True).strip()
def rpc(p,path,data={}):return json.load(urllib.request.urlopen(urllib.request.Request(os.environ['QA_A_CONTROL' if p==18946 else 'QA_B_CONTROL']+path,data=json.dumps(data).encode(),headers={'content-type':'application/json'}),timeout=12))
def ui(name):
 a('rm','-f','/sdcard/live-switch-ui.xml')
 a('uiautomator','dump','/sdcard/live-switch-ui.xml')
 x=a('cat','/sdcard/live-switch-ui.xml');(out/(name+'.xml')).write_text(x);return E.fromstring(x)
d={'startedAt':time.time(),'appPidBefore':a('pidof','ai.openclaw.app.debug'),'origin':'current-main','destination':'released','group':'QALIVESW','source':'f6477fc1ffda8c737d476f9323bcbf866c93afe7','nativeSource':'b9ae116f6d158d785e03afca19204295545a6e6c','apkSha256':'34ef789c870006e2d8caf183d41ccfc0e4f0160b6a367b5ebbe394fd5abb98ab'}
d['before']={str(p):rpc(p,'/rpc',{'method':'sessions.groups.list','params':{}}) for p in [18946,18951]}
held=False
try:
 rpc(18946,'/hold-next-groups-list');a('input','tap','805','985')
 deadline=time.monotonic()+6
 while time.monotonic()<deadline:
  if rpc(18946,'/status')['held']:held=True;break
  time.sleep(.15)
 assert held,'No native response held'
 d['heldAt']=time.time();time.sleep(1.2)
 a('input','tap','320','2210')
 x=ui('live-switch-selector')
 assert any(n.get('text')=='Gateways' for n in x.iter('node')),'Real selector did not open'
 target=next(n for n in x.iter('node') if n.get('text')==os.environ['QA_B_UI_LABEL'])
 b=list(map(int,re.findall(r'\d+',target.get('bounds'))));a('input','tap',str((b[0]+b[2])//2),str((b[1]+b[3])//2))
 d['selectedDestinationAt']=time.time();time.sleep(.8)
 x=ui('live-switch-selected-before-release')
 assert any(n.get('text')==os.environ['QA_B_UI_LABEL'] for n in x.iter('node')),'Destination footer absent'
 assert not any(n.get('text')=='Gateways' for n in x.iter('node')),'Selector still open'
 d['statusBeforeRelease']={str(p):rpc(p,'/status') for p in [18946,18951]}
 d['releasedAt']=time.time();rpc(18946,'/release');held=False;time.sleep(1.5)
 d['appPidAfter']=a('pidof','ai.openclaw.app.debug')
 d['after']={str(p):rpc(p,'/rpc',{'method':'sessions.groups.list','params':{}}) for p in [18946,18951]}
 d['finishedAt']=time.time()
 d['samePid']=d['appPidBefore']==d['appPidAfter'];d['catalogEqual']=all(d['before'][p]['payload']==d['after'][p]['payload'] for p in ['18946','18951'])
 writes=[]
 for file in ['relay-current-main-events.ndjson','relay-released-events.ndjson']:
  for line in (out/file).read_text().splitlines():
   e=json.loads(line);t=datetime.datetime.fromisoformat(e['ts'].replace('Z','+00:00')).timestamp()
   if d['startedAt']<=t<=d['finishedAt'] and e.get('event')=='android-request' and e.get('method') in ['sessions.groups.put','sessions.patch']:writes.append({'lane':file,'event':e})
 d['androidWrites']=writes
 assert d['samePid'] and d['catalogEqual'] and not writes,'Owner replacement qualification failed'
 d['passed']=True
except BaseException as e:
 d['passed']=False;d['failure']=str(e);d['finishedAt']=time.time();raise
finally:
 if held:rpc(18946,'/release')
 (out/'current-main-live-inprocess-switch.private.json').write_text(json.dumps(d,indent=2))
print(json.dumps({'passed':d['passed'],'samePid':d['samePid'],'catalogEqual':d['catalogEqual'],'androidWrites':len(d['androidWrites']),'heldSeconds':d['releasedAt']-d['heldAt'],'originPeersBeforeRelease':d['statusBeforeRelease']['18946']['peers']}))

