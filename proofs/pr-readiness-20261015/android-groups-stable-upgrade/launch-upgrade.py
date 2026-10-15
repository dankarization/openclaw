from pathlib import Path
import os,subprocess,socket,json,time
r=Path('/QA_ROOT');d=r/'groups-proof-20261015';repo=r/'android-lane';out=d/'live'
assert subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()=='4f5782b9ff339053d2b94ee4ceb8364116a9b143'
for port in [18943,18944,18945,18946,5560]:
 s=socket.socket();s.settimeout(.3)
 try:s.connect(('127.0.0.1',port));raise RuntimeError(f'Already owned port {port}')
 except ConnectionRefusedError:pass
 finally:s.close()
node=r/'runtime/node-v24.21.0-linux-x64/bin/node'
env=os.environ.copy();env.update(TSX_TSCONFIG_PATH=str(repo/'tsconfig.json'),OC_ANDROID_INCOMPLETE_PROOF='1')
commands=[('gateway',[str(node),'--import','./node_modules/tsx/dist/loader.mjs',str(d/'gateway-current-native.mjs')]),('relay',[str(node),str(d/'relay-groups-negative.mjs')])]
receipt={'startedAt':time.time(),'children':[]}
for name,cmd in commands:
 with (out/f'incomplete-{name}.private.log').open('ab') as log:
  p=subprocess.Popen(cmd,cwd=repo,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
 receipt['children'].append({'name':name,'pid':p.pid})
sdk=r/'android-tools/sdk'
env.update(ANDROID_AVD_HOME=str(r/'android-proof/avd-home'),ANDROID_USER_HOME=str(r/'android-proof/android-home'),ANDROID_SDK_ROOT=str(sdk),ANDROID_HOME=str(sdk))
cmd=[str(sdk/'emulator/emulator'),'-avd','pr163516-20261014','-port','5560','-memory','1536','-cores','2','-no-window','-no-audio','-gpu','swiftshader_indirect','-no-snapshot-load','-no-snapshot-save']
with (out/'incomplete-emulator.private.log').open('ab') as log:
 p=subprocess.Popen(cmd,cwd=d,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
receipt['children'].append({'name':'emulator','pid':p.pid})
(out/'incomplete-launch-receipt.private.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps(receipt))
