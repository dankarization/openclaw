from pathlib import Path
import subprocess,xml.etree.ElementTree as E,re,sys,json,time
r=Path('/QA_ROOT');d=r/'android-proof';out=d/'live'
adb=[str(r/'android-tools/sdk/platform-tools/adb'),'-s','emulator-5560']
step=sys.argv[1];assert step in ['compose-direct','send-direct','compose-queued','send-queued']
kind=step.split('-')[1];message=f'QA_MEDIUM_{kind.upper()}_20261015'
def dump(name):
 subprocess.run(['python3',str(d/'ui.py'),name],check=True,stdout=subprocess.DEVNULL)
 return [x.attrib for x in E.parse(out/f'{name}.xml').iter('node')]
def tap(a):
 n=list(map(int,re.findall(r'\d+',a['bounds'])))
 subprocess.run(adb+['shell','input','tap',str((n[0]+n[2])//2),str((n[1]+n[3])//2)],check=True)
nodes=dump(f'incomplete-{step}-entry')
if step.startswith('compose'):
 if any(x.get('text')=='Overview' for x in nodes):
  tap(next(x for x in nodes if x.get('text')=='Main thread'))
  nodes=dump(f'incomplete-{kind}-chat-open')
 if any(x.get('text')=='Effort' for x in nodes):
  subprocess.run(adb+['shell','input','tap','500','500'],check=True)
  nodes=dump(f'incomplete-{kind}-picker-dismissed')
 edits=[x for x in nodes if x.get('class')=='android.widget.EditText']
 assert len(edits)==1,[(x.get('text'),x.get('bounds')) for x in edits]
 assert not edits[0].get('text'), 'Preserve unexpected draft rather than replace'
 tap(edits[0]);subprocess.run(adb+['shell','input','text',message],check=True)
 nodes=dump(f'incomplete-{kind}-composed')
 assert any(x.get('text')==message for x in nodes), 'Actual composed message not visible'
else:
 assert any(x.get('text')==message for x in nodes),'Expected composed message missing'
 buttons=[x for x in nodes if x.get('content-desc') in ['Send','Send message','Queue message']]
 assert len(buttons)==1,[(x.get('content-desc'),x.get('text')) for x in nodes if x.get('content-desc')]
 assert buttons[0].get('enabled')=='true',buttons[0]
 tap(buttons[0]);dump(f'incomplete-{kind}-send-tapped')
with (out/'incomplete-ui-actions.private.ndjson').open('a') as f:f.write(json.dumps({'ts':time.time(),'event':step,'message':message})+'\n')
print(json.dumps({'step':step,'message':message,'visibleTexts':[x.get('text') for x in nodes if x.get('text')],'controls':[x.get('content-desc') for x in nodes if x.get('content-desc')]}))
