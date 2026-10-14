from pathlib import Path
import subprocess,shlex,time,json
r=Path('/QA_ROOT');out=r/'android-proof/live';app='ai.openclaw.app.debug'
adb=[str(r/'android-tools/sdk/platform-tools/adb'),'-s','emulator-5560']
subprocess.run(adb+['shell','am','force-stop',app],check=True,stdout=subprocess.DEVNULL)
def shell(command,**kwargs):return subprocess.run(adb+['shell','run-as',app,'sh','-c',shlex.quote(command)],check=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,**kwargs)
grant=(out/'android-grant.private.json').read_bytes()
shell('cat > files/qa-native-fixture/grant.private.json',input=grant)
shell('chmod 600 files/qa-native-fixture/grant.private.json')
command='CLASSPATH=/data/user/0/ai.openclaw.app.debug/files/pr163516-native-fixture.jar app_process /system/bin OpenClawNativeCredentialFixture save > files/qa-native-fixture/incomplete-save.log 2>&1 < /dev/null & echo $!'
pid=int(shell(command).stdout.decode().strip())
log=''
for _ in range(8):
 log=shell('cat files/qa-native-fixture/incomplete-save.log').stdout.decode();
 if 'Native DeviceAuthStore committed' in log:break
 time.sleep(1)
assert 'Native DeviceAuthStore committed' in log,log
# Helper deliberately has no System.exit: stop only this successfully committed
# invocation, leaving native persisted credentials for the ordinary APK.
shell(f'kill -TERM {pid}')
(out/'incomplete-credential-save.private.json').write_text(json.dumps({'helperPid':pid,'nativeCommitLog':log,'stoppedAfterCommit':True},indent=2))
subprocess.run(adb+['shell','am','start','-n',app+'/ai.openclaw.app.MainActivity'],check=True,stdout=subprocess.PIPE)
print(json.dumps({'nativeCredentialCommitObserved':True,'helperStopped':True,'appLaunched':True}))
