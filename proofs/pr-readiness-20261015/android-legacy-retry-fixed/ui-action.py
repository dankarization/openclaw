# Endpoint/root literals are redacted placeholders; restore your QA values before execution.
from pathlib import Path
import subprocess,sys,xml.etree.ElementTree as E,re,json,time,hashlib
r=Path('<QA_ROOT>');d=r/'groups-proof-20261015/retry-fixed';adb=[str(r/'android-tools/sdk/platform-tools/adb'),'-s','emulator-5560']
def a(*s):return subprocess.check_output(adb+['shell',*s],text=True).strip()
mode,value,name=sys.argv[1:4]
for attempt in range(3):
 a('rm','-f','/sdcard/legacy-retry-ui.xml');a('uiautomator','dump','/sdcard/legacy-retry-ui.xml')
 result=subprocess.run(adb+['shell','cat','/sdcard/legacy-retry-ui.xml'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
 if result.returncode==0 and '<hierarchy' in result.stdout:
  xml=result.stdout;break
 time.sleep(.5)
else:raise RuntimeError('No current native accessibility root after three observations')
(d/(name+'.xml')).write_text(xml)
x=E.fromstring(xml)
if mode=='capture':
 (d/(name+'.png')).write_bytes(subprocess.check_output(adb+['exec-out','screencap','-p']))
 print(json.dumps([{'text':n.get('text'),'desc':n.get('content-desc'),'bounds':n.get('bounds')} for n in x.iter('node') if n.get('text') or n.get('content-desc')]))
else:
 nodes=[n for n in x.iter('node') if (n.get('text')==value if mode in ['text','long'] else n.get('content-desc')==value if mode=='desc' else n.get('class')=='android.widget.EditText')]
 assert len(nodes)==1, (mode,value,len(nodes))
 n=nodes[0];assert n.get('enabled')=='true';b=list(map(int,re.findall(r'\d+',n.get('bounds'))));cx=str((b[0]+b[2])//2);cy=str((b[1]+b[3])//2)
 if mode=='long':a('input','swipe',cx,cy,cx,cy,'750')
 else:a('input','tap',cx,cy)
 if mode=='input':a('input','text',value);a('input','keyevent','4')
 receipt={'mode':mode,'value':value,'observedBounds':n.get('bounds'),'observedXmlSha256':hashlib.sha256(xml.encode()).hexdigest(),'at':time.time()}
 (d/(name+'.action.json')).write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
