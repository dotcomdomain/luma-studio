import sys, subprocess, struct, math, json
sys.path.insert(0, __import__("os").path.dirname(__file__))
import an
f=sys.argv[1]
p=an.probe(f)
au=[s for s in p['streams'] if s['codec_type']=='audio']
if not au: print(f.split('/')[-1],'NO AUDIO STREAM; streams:',[s['codec_type'] for s in p['streams']]); sys.exit()
s=au[0]; ch=int(s['channels']); rate=int(s['sample_rate'])
raw=subprocess.check_output([an.FF+'ffmpeg','-v','error','-i',f,'-vn','-f','s16le','-ac',str(ch),'-ar',str(rate),'-'])
n=len(raw)//2; x=struct.unpack('<%dh'%n,raw[:n*2])
chans=[x[c::ch] for c in range(ch)]
res=[]
for c,d in enumerate(chans):
    seg=d[rate:rate+9600]
    res.append(dict(ch=c,peak=an.dft_peak(seg,rate,300,1000,2),rms=round(an.rms_db(d[rate//2:-rate//2]),2)))
print(f.split('/')[-1],'rate',rate,'channels',ch,'br',s.get('bit_rate'),'dur',s.get('duration'),res)
