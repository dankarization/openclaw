#!/usr/bin/python3
# Deterministic test STT, not an acoustic recognition proof.
import hashlib,json,pathlib,sys,time
base=pathlib.Path(__file__).resolve().parent
content=pathlib.Path(sys.argv[1]).read_bytes()
expected=json.loads((base/'synthetic-audio.json').read_text())
actual=hashlib.sha256(content).hexdigest()
if actual != expected['sha256']:
 raise SystemExit('QA_SYNTHETIC_AUDIO_HASH_MISMATCH')
with (base/'stt-calls.private.jsonl').open('a') as out:
 out.write(json.dumps({'time':time.time(),'sha256':actual,'bytes':len(content)})+'\n')
print(expected['transcript'])

