import sys, subprocess
sys.path.insert(0, __import__("os").path.dirname(__file__))
import an
f=sys.argv[1]; p=an.probe(f); v=[s for s in p['streams'] if s['codec_type']=='video'][0]; w,h=v['width'],v['height']
raw=subprocess.check_output([an.FF+'ffmpeg','-v','error','-i',f,'-f','rawvideo','-pix_fmt','rgb24','-'])
fs=w*h*3; n=len(raw)//fs
t=an.vtimes(f)
def sat(fr,y):
    best=None
    out=[]
    for x in (int(w*.2),int(w*.3),int(w*.7),int(w*.8)):
        o=(int(h*y)*w+x)*3; r,g,b=fr[o:o+3]; out.append((r,g,b))
    r=sum(c[0] for c in out)/4; g=sum(c[1] for c in out)/4; b=sum(c[2] for c in out)/4
    return 'R' if r>180 and g<90 and b<90 else 'G' if g>180 and r<90 and b<90 else 'B' if b>180 and r<90 and g<90 else '.'
rows=[]
for i in range(n):
    fr=raw[i*fs:(i+1)*fs]
    rows.append(sat(fr,.25)+sat(fr,.5)+sat(fr,.75))
# group runs
cur=None; start=0
for i,r in enumerate(rows+['END']):
    if r!=cur:
        if cur is not None: print('frames %d-%d  t=%.3f..%.3f  A/B/C(red/green/blue)=%s'%(start,i-1,t[start],t[i-1],cur))
        cur=r; start=i
print('n frames',n,'dur',p['format']['duration'])
