import subprocess, sys, json, struct, math
FF='/data/data/com.termux/files/usr/bin/'
def probe(f):
    out=subprocess.check_output([FF+'ffprobe','-v','error','-show_entries','stream=index,codec_type,codec_name,profile,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,start_time,sample_rate,channels,bit_rate:format=duration,start_time,size','-of','json',f]); return json.loads(out)
def vtimes(f):
    out=subprocess.check_output([FF+'ffprobe','-v','error','-select_streams','v:0','-show_entries','packet=pts_time','-of','csv=p=0',f]).decode().split()
    return sorted(float(x.rstrip(',')) for x in out)
def vframes(f, w, h, extra=()):
    cmd=[FF+'ffmpeg','-v','error','-i',f]+list(extra)+['-f','rawvideo','-pix_fmt','yuv420p','-']
    raw=subprocess.check_output(cmd)
    fs=w*h*3//2
    return [raw[i*fs:(i+1)*fs] for i in range(len(raw)//fs)]
def srctime(fr,w,h):
    def mean(x0,x1,y0,y1):
        s=0;n=0
        for y in range(y0,y1,4):
            row=fr[y*w:(y+1)*w]
            for x in range(x0,x1,4): s+=row[x];n+=1
        return s/n
    L=mean(int(w*.06),int(w*.44),int(h*.3),int(h*.7)); R=mean(int(w*.56),int(w*.94),int(h*.3),int(h*.7))
    coarse=(L-20)/21; f=(R-20)/210
    k=round(coarse-f); return k+f
def pcm(f, ch=1, rate=48000):
    raw=subprocess.check_output([FF+'ffmpeg','-v','error','-i',f,'-vn','-f','s16le','-ac',str(ch),'-ar',str(rate),'-'])
    n=len(raw)//2
    return struct.unpack('<%dh'%n,raw[:n*2])
def dft_peak(x, rate, lo=100, hi=2000, step=2):
    # simple goertzel scan
    best=(0,0)
    N=len(x)
    if N==0: return 0
    w=[0.5-0.5*math.cos(2*math.pi*i/N) for i in range(N)]
    xs=[x[i]*w[i] for i in range(N)]
    for f in range(lo,hi,step):
        c=2*math.cos(2*math.pi*f/rate); s1=s2=0.0
        for v in xs:
            s0=v+c*s1-s2; s2=s1; s1=s0
        p=s1*s1+s2*s2-c*s1*s2
        if p>best[0]: best=(p,f)
    return best[1]
def rms_db(x):
    if not x: return -999
    m=sum(v*v for v in x)/len(x)
    return 10*math.log10(m/32768**2+1e-20)
def rms_windows(x, rate, ms=20):
    n=int(rate*ms/1000); return [rms_db(x[i:i+n]) for i in range(0,len(x)-n+1,n)]
