# Endpoint/root literals are redacted placeholders; restore your QA values before execution.

from pathlib import Path
import subprocess,os,time,json,xml.etree.ElementTree as E
r=Path('<QA_ROOT>');d=r/'groups-proof-20261015/retry-fixed';adb=[str(r/'android-tools/sdk/platform-tools/adb'),'-s','emulator-5560']
deadline=time.monotonic()+75
while time.monotonic()<deadline:
 p=subprocess.run(adb+['shell','getprop','sys.boot_completed'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 if p.returncode==0 and p.stdout.strip()==b'1':break
 time.sleep(.5)
else:raise RuntimeError('Fresh test AVD not ready')
with (d/'stable-install.log').open('wb') as log:subprocess.run(adb+['install','--no-streaming','-r',str(r/'android-stable-2026.10.3/apps/android/app/build/outputs/apk/play/debug/openclaw-2026.8.2-debug-play-debug.apk')],check=True,stdout=log,stderr=log)
subprocess.run(['python3',str(d/'init-native-owners.py')],check=True)
env=os.environ.copy();env['TSX_TSCONFIG_PATH']=str(r/'groups-current-native/tsconfig.json')
with (d/'initial-write-grant.private.log').open('wb') as log:subprocess.run([str(r/'runtime/node-v24.21.0-linux-x64/bin/node'),'--import','./node_modules/tsx/dist/loader.mjs',str(d/'grant-native.mjs'),'write'],cwd=r/'groups-current-native',env=env,check=True,stdout=log,stderr=log)
subprocess.run(['python3',str(d/'native-owner-step.py'),'save'],check=True)
subprocess.run(adb+['shell','am','start','-n','ai.openclaw.app.debug/ai.openclaw.app.MainActivity'],stdout=subprocess.DEVNULL,check=True)
def ui(mode,value,name):
 out=subprocess.check_output(['python3',str(d/'ui-action.py'),mode,value,name],text=True)
 (d/(name+'.driver.log')).write_text(out)
 return out
ui('desc','Show Sidebar','fixed-stock-sidebar')
ui('text','Threads','fixed-stock-threads')
ui('capture','none','fixed-stock-thread-list')
x=E.parse(d/'fixed-stock-thread-list.xml')
row=next(n.get('text') for n in x.iter('node') if n.get('text','').startswith('OpenClaw App'))
ui('long',row,'fixed-stock-session-menu')
ui('text','Move to group','fixed-stock-move-menu')
ui('text','New group…','fixed-stock-seed-dialog')
ui('input','QAFIXSEED','fixed-stock-seed-input')
ui('text','Create','fixed-stock-seed-create')
ui('long','QAFIXSEED','fixed-stock-seed-menu')
ui('text','New group…','fixed-stock-empty-dialog')
ui('input','QAFIX_RETRY','fixed-stock-empty-input')
ui('text','Create','fixed-stock-empty-create')
ui('capture','none','fixed-stock-authored')
subprocess.run(['python3',str(d/'native-owner-step.py'),'groups-state'],check=True)
raw=subprocess.check_output(adb+['shell','run-as','ai.openclaw.app.debug','cat','files/qa-native-fixture/groups-state.private.json'])
(d/'stable-authored-native-state.json').write_bytes(raw)
state=json.loads(raw);assert state['localNames']==['QAFIXSEED','QAFIX_RETRY'] and state['legacyConsumed'] is None
print(json.dumps({'stableUiAuthored':state,'groupNamesNeverInjected':True,'existingSystemImageReused':True}))
