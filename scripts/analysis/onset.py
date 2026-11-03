import sys; sys.path.insert(0, __import__("os").path.dirname(__file__))
import an
f=sys.argv[1]; thr=int(sys.argv[2]) if len(sys.argv)>2 else 1500
a=an.pcm(f); r=48000
on=next(i for i,x in enumerate(a) if abs(x)>thr)
off=len(a)-1-next(i for i,x in enumerate(reversed(a)) if abs(x)>thr)
print('onset %.1f ms, last loud sample %.1f ms, total %.1f ms'%(on/r*1000,off/r*1000,len(a)/r*1000))
# zero crossing freq in 10ms windows near start
def zc(x):
    c=sum(1 for i in range(1,len(x)) if (x[i-1]<0)!=(x[i]<0)); return c/2/(len(x)/r)
print('zc freq per 10ms from 0:',[(round(i/r*1000),int(zc(a[i:i+480]))) for i in range(0,1200,480)])
n=480
# find transitions: print freq in 10ms windows where it changes
prev=None;ch=[]
for i in range(0,len(a)-n,n):
    z=round(zc(a[i:i+n])/100)*100
    if z!=prev: ch.append((round(i/r*1000),z)); prev=z
print('freq changes (ms, ~Hz):',ch)
