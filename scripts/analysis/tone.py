import sys; sys.path.insert(0, __import__("os").path.dirname(__file__))
import an, math
f=sys.argv[1]; a=an.pcm(f); r=48000
print("samples",len(a),"dur %.3f"%(len(a)/r))
for t in (0.5,len(a)/r/2,len(a)/r-0.6):
    i=int(t*r); print(" t=%.2f peak"%t, an.dft_peak(a[i:i+9600],r,400,480,1),"rms %.1f"%an.rms_db(a[i:i+9600]))
w=an.rms_windows(a,r,20); core=w[5:-5]
print("20ms rms dB core: min %.1f max %.1f head:%s tail:%s"%(min(core),max(core),[round(x) for x in w[:5]],[round(x) for x in w[-5:]]))
mid=a[int(r*.1):-int(r*.1)]
amp=max(abs(x) for x in mid); d=max(abs(mid[i+1]-mid[i]) for i in range(len(mid)-1))
print("peak amp",amp,"max sample step",d,"expected max step for 440Hz ~",round(amp*2*math.pi*440/r))
def zc(x): return sum(1 for i in range(1,len(x)) if (x[i-1]<0)!=(x[i]<0))/2/(len(x)/r)
z=[round(zc(a[i:i+4800])) for i in range(4800,len(a)-4800,4800)]
print("zc freq per 100ms min/max",min(z),max(z))
