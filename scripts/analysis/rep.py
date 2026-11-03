import sys; sys.path.insert(0, __import__("os").path.dirname(__file__))
import an
f=sys.argv[1]; seg=float(sys.argv[2]) if len(sys.argv)>2 else 0
p=an.probe(f)
for s in p['streams']:
    print({k:s.get(k) for k in ('codec_type','codec_name','profile','width','height','r_frame_rate','nb_frames','duration','start_time','sample_rate','channels','bit_rate')})
print('format',p['format'])
v=[s for s in p['streams'] if s['codec_type']=='video'][0]
w,h=v['width'],v['height']
t=an.vtimes(f)
d=[b-a for a,b in zip(t,t[1:])]
print('video pkts',len(t),'first',t[0],'last',t[-1],'dt min/max %.4f %.4f'%(min(d),max(d)))
fr=an.vframes(f,w,h)
st=[an.srctime(x,w,h) for x in fr]
print('frames',len(fr),'src time first 3',[round(x,3) for x in st[:3]],'last 2',[round(x,3) for x in st[-2:]])
# source-time per output-time slope
if len(st)>10:
    k=len(st)//2; print('src-time slope per output frame (mid)',round(st[k+5]-st[k],4)/5)
if any(s['codec_type']=='audio' for s in p['streams']):
    a=an.pcm(f); r=48000
    print('audio samples',len(a),'dur %.3f'%(len(a)/r))
    n=int(r*seg) if seg else 0; out=[]
    for i in (range(0,len(a)-n+1,n) if n else []):
        out.append((round(i/r,2),an.dft_peak(a[i:i+n],r,100,2000,5),round(an.rms_db(a[i:i+n]),1)))
    print('segments (t,freq,rms dB):',out)
    w20=an.rms_windows(a,r,20); print('20ms windows: min %.1f max %.1f, count<-40dB: %d of %d'%(min(w20),max(w20),sum(1 for x in w20 if x<-40),len(w20)), 'first -40dB idx',[i for i,x in enumerate(w20) if x<-40][:10])
