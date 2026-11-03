import sys; sys.path.insert(0, __import__("os").path.dirname(__file__))
import an
f=sys.argv[1]; a=an.pcm(f); r=48000
# envelope in 1 ms blocks, beep = block rms > -25 dB
b=48; env=[an.rms_db(a[i:i+b]) for i in range(0,len(a)-b,b)]
on=[];off=[];state=False
for i,e in enumerate(env):
    if e>-25 and not state: on.append(i); state=True
    elif e<=-25 and state: off.append(i); state=False
print('audio total ms',len(a)/r*1000)
print('beep on(ms)',on); print('beep off(ms)',off)
