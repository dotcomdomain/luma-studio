import sys,struct
f=open(sys.argv[1],'rb'); import os
L=os.fstat(f.fileno()).st_size; p=0; out=[]
while p+8<=L:
    f.seek(p); s,t=struct.unpack('>I4s',f.read(8))
    if s==1: s=struct.unpack('>Q',f.read(8))[0]
    if s==0: s=L-p
    out.append("%s@%d(%d)"%(t.decode(),p,s))
    if s<8: break
    p+=s
print(' '.join(out))
