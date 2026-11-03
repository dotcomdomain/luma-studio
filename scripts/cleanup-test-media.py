"""Remove only the exact gallery fixtures generated in this session."""
import subprocess,shlex,re,json,pathlib
names={'Luma_1793434005347.jpg','Luma_1793434442835.jpg','Luma_1793434605061.jpg','Luma_1793434621561.png','Luma-test-12mp.jpg','Luma_1793434148351.mp4','Luma_1793434160525.mp4','Luma_1793434746821.mp4','Luma_1793434795856.mp4'}
def root(args):return subprocess.check_output(['su','2000','-c',shlex.join(args)],text=True,stderr=subprocess.STDOUT)
removed=[]
where='_display_name IN ('+','.join("'"+name+"'" for name in sorted(names))+')'
for kind in ['images','video']:
    uri='content://media/external/'+kind+'/media'
    result=root(['content','query','--uri',uri,'--projection','_id:_display_name','--where',where])
    for row in result.splitlines():
        match=re.search(r'_id=(\d+), _display_name=(.*)$',row)
        if match and match[2] in names:
            root(['content','delete','--uri',uri+'/'+match[1]])
            check=root(['content','query','--uri',uri+'/'+match[1],'--projection','_id'])
            if 'No result' not in check: raise RuntimeError('Fixture deletion did not complete: '+check)
            removed.append(match[2])
pathlib.Path('artifacts/cleaned-test-media.json').write_text(json.dumps(removed,indent=2))
print('Removed',len(removed),'generated test media entries; review copies remain in artifacts/.')
