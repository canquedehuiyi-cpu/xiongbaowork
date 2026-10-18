import hashlib,json,os,signal,subprocess,time
from pathlib import Path
import shutil
ROOT=Path(__file__).resolve().parent
START=json.loads((ROOT/'preflight.json').read_text())['time']
MAX_BYTES=2*1024**3
MIN_FREE=1024**3
def allocated():
    total=0
    for base,dirs,files in os.walk(ROOT,followlinks=False):
        for name in files+dirs:
            try: total+=(Path(base)/name).lstat().st_blocks*512
            except FileNotFoundError: pass
    return total
def resource():
    return {'time':time.time(),'allocatedBytes':allocated(),'diskFreeBytes':shutil.disk_usage(ROOT).free}
def run(name,args,cwd=ROOT,limit=None,env=None):
    budget=min(1200-(time.time()-START),limit if limit is not None else 1200)
    if budget<=0: raise RuntimeError('SETUP_DEADLINE')
    before=resource()
    if before['allocatedBytes']>=MAX_BYTES or before['diskFreeBytes']<MIN_FREE:
        raise RuntimeError('RESOURCE_CAP_BEFORE_'+name)
    record={'step':name,'command':args,'cwd':str(cwd),'before':before,'budgetSeconds':budget}
    with (ROOT/(name+'.log')).open('xb') as log, (ROOT/(name+'.resource.jsonl')).open('x') as metrics:
        child=subprocess.Popen(args,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        record['pid']=child.pid
        stop=None
        try:
            until=time.monotonic()+budget
            while child.poll() is None:
                r=resource();metrics.write(json.dumps(r)+'\n');metrics.flush()
                if r['allocatedBytes']>=MAX_BYTES: stop='OWN_DIRECTORY_2_GIB_CAP'
                if r['diskFreeBytes']<MIN_FREE: stop='ROOT_FREE_1_GIB_CAP'
                if time.monotonic()>=until: stop='HARD_TIMEOUT'
                if stop:
                    os.killpg(child.pid,signal.SIGTERM)
                    try: child.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid,signal.SIGKILL);child.wait()
                    break
                time.sleep(0.25)
            record.update(exitCode=child.wait(),stopReason=stop,after=resource())
        finally:
            if child.poll() is None:
                os.killpg(child.pid,signal.SIGKILL);child.wait()
    (ROOT/(name+'.result.json')).write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps(record),flush=True)
    if stop or record['exitCode']!=0: raise RuntimeError('STAGE_FAILED_'+name)
    return (ROOT/(name+'.log')).read_text(errors='replace')

if __name__=='__main__':
    (ROOT/'active.lock').open('x').write('root-r2-ui-appbounded-6230530625\n')
    run('git-init',['git','init','source'])
    source=ROOT/'source'
    run('git-remote',['git','remote','add','origin','https://github.com/xiongpinji/xiongbao-Wake-.git'],source)
    run('git-fetch',['git','-c','core.autocrlf=false','fetch','--depth=1','origin','2a44a26f1ba824948d1a6197addaed29deb17281'],source)
    run('git-checkout',['git','-c','core.autocrlf=false','-c','core.eol=lf','checkout','--detach','FETCH_HEAD'],source)
    run('bun-download',['curl','--fail','--location','--silent','--show-error','--max-time','180','--output','bun-linux-x64.zip','https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip'])
    digest=hashlib.sha256((ROOT/'bun-linux-x64.zip').read_bytes()).hexdigest()
    if digest!='951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f': raise RuntimeError('OFFICIAL_BUN_SHA256_MISMATCH')
    import zipfile
    with zipfile.ZipFile(ROOT/'bun-linux-x64.zip') as archive:
        if archive.namelist()!=['bun-linux-x64/','bun-linux-x64/bun']:
            if set(archive.namelist())!={'bun-linux-x64/bun'}: raise RuntimeError('UNEXPECTED_BUN_ARCHIVE_ENTRIES')
        archive.extractall(ROOT)
    bun=ROOT/'bun-linux-x64/bun';bun.chmod(0o755)
    version=run('bun-version',[str(bun),'--version'])
    if version.strip()!='1.3.14': raise RuntimeError('WRONG_BUN_VERSION')
    helptext=run('bun-install-help',[str(bun),'install','--help'])
    if not all(x in helptext for x in ['--filter','--frozen-lockfile','--ignore-scripts']): raise RuntimeError('REQUIRED_INSTALL_OPTIONS_UNSUPPORTED')
    print('PREPARED_SOURCE_BUN_HELP_ONLY',flush=True)
