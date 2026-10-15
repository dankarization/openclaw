# Endpoint/root literals are redacted placeholders; restore your QA values before execution.
from pathlib import Path
import subprocess,shlex,time,json
r=Path('<QA_ROOT>');d=r/'groups-proof-20261015/retry-fixed';app='ai.openclaw.app.debug'
adb=[str(r/'android-tools/sdk/platform-tools/adb'),'-s','emulator-5560']
def shell(cmd,check=True):
 return subprocess.run(adb+['shell','run-as',app,'sh','-c',shlex.quote(cmd)],check=check,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
subprocess.run(adb+['push',str(d/'native-owner-setup-fixture.jar'),'/data/local/tmp/pr164857-legacy-native-fixture.jar'],check=True,stdout=subprocess.DEVNULL)
shell('mkdir -p files/qa-native-fixture && cp /data/local/tmp/pr164857-legacy-native-fixture.jar files/pr164857-legacy-native-fixture.jar && chmod 0400 files/pr164857-legacy-native-fixture.jar')
evidence=[]
for mode,marker in [('configure','Native SecurePrefs committed task QA endpoint setup'),('export','Synthetic Android identity exported to app-private fixture file')]:
 cmd='CLASSPATH=/data/user/0/ai.openclaw.app.debug/files/pr164857-legacy-native-fixture.jar app_process /system/bin OpenClawNativeCredentialFixture '+mode+' > files/qa-native-fixture/legacy-'+mode+'.log 2>&1 < /dev/null & echo $!'
 pid=int(shell(cmd).stdout.decode().strip());deadline=time.monotonic()+30;log=''
 while time.monotonic()<deadline:
  log=shell('cat files/qa-native-fixture/legacy-'+mode+'.log',False).stdout.decode(errors='replace')
  if marker in log:break
  time.sleep(.5)
 if marker not in log:
  (d/('helper-'+mode+'-failure.log')).write_text(log);raise RuntimeError('Native '+mode+' marker absent; inspect private failure log')
 time.sleep(2.8)
 proc=shell('cat /proc/'+str(pid)+'/cmdline',False)
 if proc.returncode==0 and b'OpenClawNativeCredentialFixture' in proc.stdout:shell('kill -TERM '+str(pid))
 evidence.append({'mode':mode,'pid':pid,'nativeMarkerObserved':True,'onlyNativeOwnerSetup':True})
raw=shell('cat files/qa-native-fixture/identity.private.json').stdout;x=json.loads(raw);assert all(k in x for k in ['deviceId','publicKeyRawBase64','privateKeyPkcs8Base64'])
p=d/'android-identity.private.json';p.write_bytes(raw);p.chmod(0o600)
(d/'initial-native-setup.private.json').write_text(json.dumps({'steps':evidence,'identityStoredPrivately':True,'legacyGroupsSeeded':False},indent=2))
print(json.dumps({'nativeOwnerSetup':evidence,'identityStoredPrivately':True,'legacyGroupsSeeded':False}))

