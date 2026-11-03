#!/data/data/com.termux/files/usr/bin/python
"""Create or stop a root-owned offscreen Android test display; never mirrors display 0."""
import pathlib, subprocess, shlex, sys, time, os
root=pathlib.Path(__file__).resolve().parents[1]
out=root/'artifacts'; out.mkdir(exist_ok=True)
sdk=pathlib.Path('/data/data/com.termux/files/home/android-sdk/platforms/android-36/android.jar')
def run(args, **kw): return subprocess.run(args,check=True,**kw)
action=sys.argv[1] if len(sys.argv)>1 else 'start'
if action=='stop':
    pidfile=out/'display-pid'
    if pidfile.exists():
        pid=int(pidfile.read_text().strip())
        cmdline=subprocess.check_output(['su','-c',f'cat /proc/{pid}/cmdline'],stderr=subprocess.DEVNULL)
        if b'studio.luma.VirtualDisplay' in cmdline: run(['su','-c',f'kill {pid}'])
        pidfile.unlink(missing_ok=True); (out/'display-id').unlink(missing_ok=True)
    print('Virtual test display stopped.');sys.exit()
if (out/'display-pid').exists():
    pid=int((out/'display-pid').read_text().strip())
    if subprocess.run(['su','-c',f'kill -0 {pid}'],stderr=subprocess.DEVNULL).returncode==0:
        print('Display ID:',(out/'display-id').read_text().strip());sys.exit()
classes=root/'build/virtual/classes'; dex=root/'build/virtual/dex'
classes.mkdir(parents=True,exist_ok=True);dex.mkdir(exist_ok=True)
run(['javac','-classpath',str(sdk),'-d',str(classes),str(root/'scripts/VirtualDisplay.java')])
run(['jar','cf',str(root/'build/virtual/classes.jar'),'-C',str(classes),'.'])
run(['d8','--lib',str(sdk),'--output',str(dex),str(root/'build/virtual/classes.jar')])
(out/'display-id').unlink(missing_ok=True)
command='CLASSPATH='+shlex.quote(str(dex/'classes.dex'))+' '+shlex.join(['app_process','/system/bin','studio.luma.VirtualDisplay',str(out)])
(out/'virtual-display.log').unlink(missing_ok=True)
log=open(out/'virtual-display.log','w')
subprocess.Popen(['su','-c',command],stdout=log,stderr=log,start_new_session=True)
for _ in range(100):
    if (out/'display-id').exists():
        display=(out/'display-id').read_text().strip()
        print('Display ID:',display)
        print('Launch with: adb -s 127.0.0.1:5555 shell am start --display',display,'-n studio.luma.editor/studio.luma.MainActivity')
        print('Capture: create artifacts/capture.request, then interact with the app. Screenshot appears at artifacts/display.png.')
        break
    time.sleep(.1)
else: raise SystemExit((out/'virtual-display.log').read_text())
