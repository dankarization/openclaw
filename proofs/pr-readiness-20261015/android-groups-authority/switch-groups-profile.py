from pathlib import Path
import subprocess,shlex,os,json,time,sys,urllib.request
r=Path('/QA_ROOT');d=r/'groups-proof-20261015';out=d/'live';app='ai.openclaw.app.debug';adb=[str(r/'android-tools/sdk/platform-tools/adb'),'-s','emulator-5560']
profile=sys.argv[1];assert profile in ['readonly','write']
subprocess.run(adb+['shell','am','force-stop',app],check=True,stdout=subprocess.DEVNULL)
env=os.environ.copy();env['TSX_TSCONFIG_PATH']=str(r/'android-lane/tsconfig.json')
p=subprocess.run([str(r/'runtime/node-v24.21.0-linux-x64/bin/node'),'--import','./node_modules/tsx/dist/loader.mjs',str(d/'grant-groups-current.mjs'),profile],cwd=r/'android-lane',env=env,check=True,capture_output=True,text=True)
def shell(cmd,**kw):return subprocess.run(adb+['shell','run-as',app,'sh','-c',shlex.quote(cmd)],check=True,capture_output=True,timeout=30,**kw)
shell('cat > files/qa-native-fixture/grant.private.json',input=(out/'android-grant.private.json').read_bytes())
s=shell('CLASSPATH=/data/user/0/ai.openclaw.app.debug/files/pr164857-native-fixture-v2.jar app_process /system/bin OpenClawNativeCredentialFixture save').stdout.decode()
subprocess.run(adb+['shell','am','start','-n',app+'/ai.openclaw.app.MainActivity'],check=True,stdout=subprocess.DEVNULL)
expected=['operator.read'] if profile=='readonly' else ['operator.read','operator.write']
for i in range(30):
 status=json.load(urllib.request.urlopen('http://127.0.0.1:18946/status'))
 peers=[v for v in status['peers'] if v['role']=='operator' and v['connected']]
 if peers and peers[-1]['scopes']==expected:break
 time.sleep(1)
else:raise RuntimeError('Actual Android connection did not acquire expected scopes')
receipt={'profile':profile,'nativeCredentialLog':s,'actualOperator':peers[-1],'completedAt':time.time()}
(out/f'groups-{profile}-profile-receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
