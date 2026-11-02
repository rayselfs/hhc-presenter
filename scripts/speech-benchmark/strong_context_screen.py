"""Diagnostic only: compare sample-covering contexts on a fixed failed command."""
import sys,json,wave,time,hashlib
from pathlib import Path
import numpy as np
from stationary_noise import mix_noise,balance_volume,windows
from live_runtime import Locator
from pywhispercpp.model import Model
root=Path(sys.argv[1]); out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
rows=json.loads((root/'segmentation-regression-corpus.json').read_text())
row=next(r for r in rows if r['id']=='0001')
assert hashlib.sha256((root/'audio/0001.wav').read_bytes()).hexdigest()==row['sha256']
model=Model(str(root/'models/whisper/ggml-large-v3-turbo-q5_0.bin'),params_sampling_strategy=0,n_threads=4,print_progress=False,print_realtime=False,print_timestamps=False,no_context=True,no_timestamps=True,temperature=0.0,temperature_inc=0.0,context_params={'use_gpu':True},redirect_whispercpp_logs_to=None)
locator=Locator(root);results=[]
try:
 for hum in [False,True]:
  with wave.open(str(root/'audio/0001.wav')) as f: clean=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2').astype(np.float32)/32768
  audio=mix_noise(clean,10 if hum else 20,20261102+8,hum)
  spans=windows(audio,float(np.sqrt(np.mean(audio[:16000]**2))))
  for first,end,_ in spans:
   payload=balance_volume(audio[:end])[first:end]
   for context in [768,512,0]:
    assert context==0 or len(payload)<=context*320
    t=time.perf_counter();text=''.join(s.text for s in model.transcribe(payload,language='zh',audio_ctx=context));reference=locator.locate(text)
    row={'hum':hum,'context':context,'text':text,'reference':reference,'processing_ms':(time.perf_counter()-t)*1000};results.append(row);print(row,flush=True)
finally:locator.close()
(out/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
