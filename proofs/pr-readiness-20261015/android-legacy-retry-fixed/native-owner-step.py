# Endpoint/root literals are redacted placeholders; restore your QA values before execution.
from pathlib import Path
import subprocess,shlex,time,json,sys
r=Path('<QA_ROOT>');d=r/'groups-proof-20261015/retry-fixed';app='ai.openclaw.app.debug';adb=[str(r/'android-tools/sdk/platform-tools/adb'),'-s','emulator-5560'];mode=sys.argv[1]
assert mode in ['save','export','groups-state']
subprocess.run(adb+['shell','am','force-stop',app],check=True)
def shell(cmd,check=True):return subprocess.run(adb+['shell','run-as',app,'sh','-c',shlex.quote(cmd)],check=check,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
if mode=='save':
 subprocess.run(adb+['push',str(d/'android-grant.private.json'),'/data/local/tmp/pr164857-grant.private.json'],check=True,stdout=subprocess.DEVNULL)
 shell('cp /data/local/tmp/pr164857-grant.private.json files/qa-native-fixture/grant.private.json && chmod 0600 files/qa-native-fixture/grant.private.json')
 subprocess.run(adb+['shell','rm','/data/local/tmp/pr164857-grant.private.json'],check=True)
cmd='CLASSPATH=/data/user/0/ai.openclaw.app.debug/files/pr164857-legacy-native-fixture.jar app_process /system/bin OpenClawNativeCredentialFixture '+mode+' > files/qa-native-fixture/step-'+mode+'.log 2>&1 < /dev/null & echo $!'
pid=int(shell(cmd).stdout.decode().strip());deadline=time.monotonic()+25
while time.monotonic()<deadline:
 log=shell('cat files/qa-native-fixture/step-'+mode+'.log',False).stdout.decode(errors='replace')
 if 'Native DeviceAuthStore committed' in log or 'Synthetic Android identity exported' in log or 'Native SecurePrefs group state read' in log:break
 time.sleep(.5)
else:raise RuntimeError('Native owner did not complete; private log retained')
time.sleep(2.8)
proc=shell('cat /proc/'+str(pid)+'/cmdline',False)
if proc.returncode==0 and b'OpenClawNativeCredentialFixture' in proc.stdout:shell('kill -TERM '+str(pid))
print(json.dumps({'mode':mode,'nativeOwnerCompleted':True,'nativeLog':log.strip(),'pid':pid}))
