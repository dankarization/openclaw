import json,pathlib,subprocess,sys,xml.etree.ElementTree as ET
root=pathlib.Path('/QA_ROOT')
adb=[str(root/'android-tools/sdk/platform-tools/adb'),'-s','emulator-5560']
subprocess.run(adb+['shell','uiautomator','dump','/sdcard/qa-ui.xml'],stdout=subprocess.DEVNULL,check=True)
xml=subprocess.check_output(adb+['shell','cat','/sdcard/qa-ui.xml'])
if len(sys.argv)>1:
 name=sys.argv[1]
 if not name.replace('-','').replace('_','').isalnum():raise ValueError('name')
 out=root/'groups-proof-20261015/live'
 (out/f'{name}.xml').write_bytes(xml)
 (out/f'{name}.png').write_bytes(subprocess.check_output(adb+['exec-out','screencap','-p']))
for e in ET.fromstring(xml).iter('node'):
 a=e.attrib
 if a.get('class')=='android.widget.EditText' and len(a.get('text',''))>80:
  a['text']='[private setup input]'
 if a.get('text') or a.get('content-desc') or a.get('class')=='android.widget.EditText':
  print(json.dumps({k:a[k] for k in ['text','content-desc','class','clickable','enabled','bounds'] if k in a}))
