"""Diagnostic paired raw/high-pass decodes for the four known failed mixtures."""
import sys,json,wave,time,subprocess,hashlib
from pathlib import Path
import numpy as np
from stationary_noise import mix_noise,balance_volume,windows,covered_context
from live_runtime import Locator
from pywhispercpp.model import Model
root=Path(sys.argv[1]);out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
model=Model(str(root/'models/whisper/ggml-large-v3-turbo-q5_0.bin'),params_sampling_strategy=0,n_threads=4,print_progress=False,print_realtime=False,print_timestamps=False,no_context=True,no_timestamps=True,temperature=0.0,temperature_inc=0.0,context_params={'use_gpu':True},redirect_whispercpp_logs_to=None)
locator=Locator(root);results=[]
rows={r['id']:r for r in json.loads((root/'segmentation-regression-corpus.json').read_text())+json.loads((root/'segmentation-paired-corpus.json').read_text())}
try:
 for ident,hum,index in [('0001',False,8),('0001',True,8),('segment-012',False,4),('segment-016',False,8)]:
  assert hashlib.sha256((root/'audio'/f'{ident}.wav').read_bytes()).hexdigest()==rows[ident]['sha256']
  with wave.open(str(root/'audio'/f'{ident}.wav')) as f: clean=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2').astype(np.float32)/32768
  audio=mix_noise(clean,10 if hum else 20,20261102+index,hum)
  first,end,_=windows(audio,float(np.sqrt(np.mean(audio[:16000]**2))))[0]
  for cutoff in [0,120,200]:
   t=time.perf_counter()
   filtered=audio[:end]
   if cutoff:
    filtered=np.frombuffer(subprocess.run(['ffmpeg','-v','error','-f','f32le','-ar','16000','-ac','1','-i','pipe:0','-af',f'highpass=f={cutoff}','-f','f32le','pipe:1'],input=filtered.astype('<f4').tobytes(),capture_output=True,check=True).stdout,dtype='<f4')
   payload=filtered[first:end] if cutoff==0 else balance_volume(filtered)[first:end]
   text=''.join(s.text for s in model.transcribe(payload,language='zh',audio_ctx=covered_context(len(payload))));reference=locator.locate(text)
   row={'id':ident,'hum':hum,'cutoff':cutoff,'text':text,'reference':reference,'processing_ms':(time.perf_counter()-t)*1000};results.append(row);print(row,flush=True)
finally:locator.close()
(out/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
