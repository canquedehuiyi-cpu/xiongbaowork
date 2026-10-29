import os, sys, time
from pathlib import Path

PROJECT=Path("/sys/fs/cgroup/xiongbaowork.slice")
SHARED=PROJECT/"xiongbaowork-data.slice"
KEYS=("memory.max","memory.swap.max","memory.oom.group")
EXPECTED_PROJECT=dict(zip(KEYS,("536870912","0","1")))
EXPECTED_SHARED=dict(zip(KEYS,("67108864","0","1")))
EXPECTED_ADMIN=dict(zip(KEYS,("16777216","0","1")))
EXPECTED_CHILD=dict(zip(KEYS,("50331648","0","1")))
PRIOR_RAW_RUN=40912579798
PRIOR_RAW_JOB=123584189279
def emit(prefix,value):
    import json
    text=json.dumps(value,sort_keys=True,separators=(",",":"))
    assert len(text)<24000
    print(prefix+" "+text,flush=True)
def limits(path):
    return {key:(path/key).read_text().strip() for key in KEYS}
def populated(path):
    if not path.exists():return None
    return dict(line.split() for line in (path/"cgroup.events").read_text().splitlines())["populated"]
def fixed(path,value):
    fd=os.open(path,os.O_WRONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        raw=value.encode();assert os.write(fd,raw)==len(raw)
    finally:os.close(fd)
def cg_observation(path):
    value={"path":str(path),"exists":False,"limits":{}}
    try:
        info=path.stat();value.update(exists=True,dev=str(info.st_dev),ino=str(info.st_ino))
    except BaseException as exc:
        value["stat_error"]=type(exc).__name__;return value
    for key in KEYS:
        try:value["limits"][key]=(path/key).read_text().strip()
        except BaseException as exc:value["limits"][key]={"error":type(exc).__name__}
    try:value["populated"]=populated(path)
    except BaseException as exc:value["populated_error"]=type(exc).__name__
    return value
def unit_observation(unit,deadline):
    import subprocess
    try:
        left=deadline-time.monotonic();assert left>0
        proc=subprocess.run(["systemctl","show",unit,"--property=ActiveState","--property=LoadState",
             "--property=Job","--property=ControlGroup","--property=StopWhenUnneeded",
             "--property=MemoryMax","--property=MemorySwapMax"],stdin=subprocess.DEVNULL,
             stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=min(2,left),
             env={"PATH":"/usr/bin:/bin","LC_ALL":"C"})
        assert len(proc.stdout)+len(proc.stderr)<8192
        return {"exit":proc.returncode,"properties":dict(line.split("=",1)
            for line in proc.stdout.decode("utf-8","strict").splitlines() if "=" in line)}
    except BaseException as exc:return {"error":type(exc).__name__}
def observe(runid,attempt,deadline):
    admin="xb-a11-admin-"+runid+"-"+attempt+".service"
    child="xb-a11-data-"+runid+"-"+attempt+".service"
    result={"monotonic":time.monotonic(),
        "project":cg_observation(PROJECT),"shared":cg_observation(SHARED),
        "admin_cgroup":cg_observation(SHARED/admin),"child_cgroup":cg_observation(SHARED/child),
        "units":{unit:unit_observation(unit,deadline) for unit in
                 ("xiongbaowork.slice","xiongbaowork-data.slice",admin,child)}}
    result["completed_monotonic"]=time.monotonic()
    return result
def child(unit,inner):
    assert os.geteuid()!=0 and time.monotonic()<inner
    assert Path("/proc/self/cgroup").read_text().strip()=="0::/xiongbaowork.slice/xiongbaowork-data.slice/"+unit
    assert limits(SHARED/unit)==EXPECTED_CHILD and limits(SHARED)==EXPECTED_SHARED and limits(PROJECT)==EXPECTED_PROJECT
    assert os.getgroups()==[] and len(set(os.getresuid()))==1 and len(set(os.getresgid()))==1
    assert Path("/proc/self/oom_score_adj").read_text().strip()=="0"
    emit("A11_TEARDOWN_CHILD_GATE",{"child":cg_observation(SHARED/unit),
         "shared":cg_observation(SHARED),"project":cg_observation(PROJECT),
         "scope":"RESOURCE_CONTROL_ONLY_NO_CODEC_NO_TOKEN_NO_LOG_OR_SOURCE_READ",
         "prior_raw_run":PRIOR_RAW_RUN,"prior_raw_job":PRIOR_RAW_JOB,"raw_validation_repeated":False})
def admin(base,runid,attempt,uid,gid,started):
    import json, math, subprocess
    assert os.geteuid()==0 and uid>0 and gid>0 and runid.isdecimal() and attempt.isdecimal()
    inner=started+120;outer=started+150
    assert time.monotonic()<inner
    root=Path("/run")/("xb-a11-data-"+runid+"-"+attempt);root.mkdir(mode=0o755)
    adminunit="xb-a11-admin-"+runid+"-"+attempt+".service"
    childunit="xb-a11-data-"+runid+"-"+attempt+".service"
    assert Path("/proc/self/cgroup").read_text().strip()=="0::/xiongbaowork.slice/xiongbaowork-data.slice/"+adminunit
    assert limits(SHARED/adminunit)==EXPECTED_ADMIN
    def restore():
        for path,expected in ((PROJECT,EXPECTED_PROJECT),(SHARED,EXPECTED_SHARED)):
            for key,value in expected.items():fixed(path/key,value)
            assert limits(path)==expected
    def command(args,deadline):
        remaining=deadline-time.monotonic();assert remaining>0
        return subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            timeout=remaining,env={"PATH":"/usr/bin:/bin","LC_ALL":"C"})
    def record(value):
        raw=(json.dumps(value,sort_keys=True)+"\n").encode();assert len(raw)<24000
        fd=os.open(root/"terminal.json",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,"wb") as out:out.write(raw)
    code=None;error=None;proc=None;complete=False;before=None;before_restore=None;after_restore=None
    try:
        restore()
        before=observe(runid,attempt,inner)
        emit("A11_TEARDOWN_BEFORE_CHILD",before)
        wrapper=r"""
import os,sys,time
from pathlib import Path
controller,unit,uid,gid,inner=sys.argv[1:]
uid=int(uid);gid=int(gid);inner=float(inner)
assert os.geteuid()==0 and uid>0 and gid>0 and time.monotonic()<inner
project=Path('/sys/fs/cgroup/xiongbaowork.slice');shared=project/'xiongbaowork-data.slice'
assert Path('/proc/self/cgroup').read_text().strip()=='0::/xiongbaowork.slice/xiongbaowork-data.slice/'+unit
keys=('memory.max','memory.swap.max','memory.oom.group')
def actual(path):return {k:(path/k).read_text().strip() for k in keys}
assert actual(shared/unit)==dict(zip(keys,('50331648','0','1')))
for path,cap in ((project,'536870912'),(shared,'67108864')):
    (path/'memory.oom.group').write_text('1')
    assert actual(path)==dict(zip(keys,(cap,'0','1')))
Path('/proc/self/oom_score_adj').write_text('0')
os.setgroups([]);os.setresgid(gid,gid,gid);os.setresuid(uid,uid,uid)
assert os.getresuid()==(uid,uid,uid) and os.getresgid()==(gid,gid,gid) and os.getgroups()==[]
assert Path('/proc/self/oom_score_adj').read_text().strip()=='0'
assert actual(shared/unit)==dict(zip(keys,('50331648','0','1')))
assert actual(shared)==dict(zip(keys,('67108864','0','1'))) and actual(project)==dict(zip(keys,('536870912','0','1')))
assert time.monotonic()<inner
os.execve('/usr/bin/python3',['/usr/bin/python3','-I','-B',controller,'child',unit,str(inner)],{'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
"""
        runtime=max(1,math.floor(inner-time.monotonic()-2))
        proc=subprocess.Popen(["systemd-run","--wait","--pipe","--unit="+childunit,
            "--slice=xiongbaowork-data.slice","--property=Type=exec","--property=MemoryMax=50331648",
            "--property=MemorySwapMax=0","--property=OOMPolicy=kill","--property=KillMode=control-group",
            "--property=RuntimeMaxSec="+str(runtime),"--property=TimeoutStartSec=1","--property=TimeoutStopSec=1",
            "--property=SendSIGKILL=yes","--property=KillSignal=SIGKILL","--property=FinalKillSignal=SIGKILL",
            "/usr/bin/python3","-I","-B","-c",wrapper,str(Path(__file__)),childunit,str(uid),str(gid),str(inner)],
            stdin=subprocess.DEVNULL,env={"PATH":"/usr/bin:/bin","LC_ALL":"C"})
        try:code=proc.wait(timeout=max(0.01,inner-time.monotonic()))
        except subprocess.TimeoutExpired:code=124
    except BaseException as exc:error=type(exc).__name__+":"+str(exc)[:500]
    finally:
        try:
            cg=SHARED/childunit
            if cg.exists():fixed(cg/"cgroup.kill","1")
            stopped=command(["systemctl","stop",childunit],outer-8)
            state=unit_observation(childunit,outer-7)
            props=state.get("properties",{})
            assert stopped.returncode in (0,5) and state.get("exit") in (0,1)
            assert props.get("ActiveState") in ("inactive","failed") and "Job" in props and props["Job"] in ("","0")
            assert props.get("LoadState") in ("loaded","not-found")
            if stopped.returncode or state["exit"]:assert props["LoadState"]=="not-found" and not cg.exists()
            assert populated(cg) in ("0",None)
            if proc is not None and proc.poll() is None:
                proc.kill();proc.wait(timeout=max(0.01,outer-time.monotonic()-7))
            before_restore=observe(runid,attempt,outer-6)
            emit("A11_TEARDOWN_AFTER_CHILD_BEFORE_RESTORE",before_restore)
            restore()
            assert populated(SHARED/adminunit)=="1" and limits(SHARED/adminunit)==EXPECTED_ADMIN
            after_restore=observe(runid,attempt,outer-3)
            emit("A11_TEARDOWN_AFTER_RESTORE_ADMIN_STILL_ACTIVE",after_restore)
            assert limits(SHARED)==EXPECTED_SHARED and limits(PROJECT)==EXPECTED_PROJECT and time.monotonic()<outer
            complete=True
            terminal={"status":"CONTROL_LIFECYCLE_COMPLETE" if code==0 and error is None else "FAILED_OR_UNKNOWN",
                "child_exit":code,"error":error,"started":started,"inner":inner,"outer":outer,
                "elapsed":time.monotonic()-started,"absolute_seconds":150,
                "restore_proven":False,"child_empty_and_limits_restored":True,
                "full_parent_empty_witness":"PENDING_EXTERNAL_AFTER_ADMIN_EXIT",
                "before":before,"after_child_before_restore":before_restore,"after_restore":after_restore,
                "prior_raw_validation":{"run":PRIOR_RAW_RUN,"job":PRIOR_RAW_JOB,
                    "status":"FOUR_RAW_BYTES_VERIFIED_IN_PRIOR_RUN_ONLY","repeated":False},
                "source_adopted":False}
            record(terminal);emit("A11_TEARDOWN_ADMIN_TERMINAL",terminal)
        except BaseException as exc:
            emit("A11_TEARDOWN_ADMIN_UNKNOWN",{"restore_proven":False,
                 "error":type(exc).__name__,"child_exit":code,"source_adopted":False})
    if not complete or code!=0 or error is not None:raise SystemExit(1)
def witness(runid,attempt):
    import json,stat
    assert os.geteuid()==0 and runid.isdecimal() and attempt.isdecimal()
    # Observation-only: no stop/kill/restore, no new grace, no original DATA access.
    observed=observe(runid,attempt,time.monotonic()+8)
    root=Path("/run")/("xb-a11-data-"+runid+"-"+attempt)
    terminal=None;terminal_error=None
    try:
        fd=os.open(root/"terminal.json",os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            st=os.fstat(fd);assert stat.S_ISREG(st.st_mode) and st.st_uid==0 and st.st_nlink==1 and st.st_size<24000
            raw=os.read(fd,24001);assert len(raw)<=24000
        finally:os.close(fd)
        terminal=json.loads(raw)
    except BaseException as exc:terminal_error=type(exc).__name__
    emit("A11_TEARDOWN_ALWAYS_ACTUAL_PRE_ASSERT",{"actual":observed,
         "terminal_present":terminal is not None,"terminal_error":terminal_error,
         "terminal":terminal,"read_only_no_new_cleanup":True,"source_adopted":False})
    def quiet(unit):
        state=observed["units"][unit];props=state.get("properties",{})
        return state.get("exit") in (0,1) and props.get("ActiveState") in ("inactive","failed") and \
               props.get("LoadState") in ("loaded","not-found") and "Job" in props and props["Job"] in ("","0")
    adminunit="xb-a11-admin-"+runid+"-"+attempt+".service";childunit="xb-a11-data-"+runid+"-"+attempt+".service"
    checks={"project_exists":observed["project"]["exists"],"shared_exists":observed["shared"]["exists"],
        "project_limits":observed["project"]["limits"]==EXPECTED_PROJECT,
        "shared_limits":observed["shared"]["limits"]==EXPECTED_SHARED,
        "project_populated0":observed["project"].get("populated")=="0",
        "shared_populated0":observed["shared"].get("populated")=="0",
        "admin_empty":(not observed["admin_cgroup"]["exists"] and observed["admin_cgroup"].get("stat_error")=="FileNotFoundError") or observed["admin_cgroup"].get("populated")=="0",
        "child_empty":(not observed["child_cgroup"]["exists"] and observed["child_cgroup"].get("stat_error")=="FileNotFoundError") or observed["child_cgroup"].get("populated")=="0",
        "admin_stopped_no_job":quiet(adminunit),"child_stopped_no_job":quiet(childunit),
        "project_slice_active":observed["units"]["xiongbaowork.slice"].get("properties",{}).get("ActiveState")=="active",
        "shared_slice_active":observed["units"]["xiongbaowork-data.slice"].get("properties",{}).get("ActiveState")=="active",
        "admin_terminal":terminal is not None and terminal.get("status")=="CONTROL_LIFECYCLE_COMPLETE",
        "same_budget":terminal is not None and terminal.get("inner")==terminal.get("started",0)+120 and
            terminal.get("outer")==terminal.get("started",0)+150 and terminal.get("elapsed",999)<150,
        "within_original_deadline":terminal is not None and observed["completed_monotonic"]<terminal.get("outer",0)}
    passed=all(checks.values())
    emit("A11_TEARDOWN_ALWAYS_TERMINAL",{"status":"CONTROL_TEARDOWN_WITNESS_MATCHED" if passed else "FAILED_OR_UNKNOWN",
         "checks":checks,"restore_proven":passed,"source_adopted":False,
         "raw_validation_repeated":False,"prior_raw_run":PRIOR_RAW_RUN,"prior_raw_job":PRIOR_RAW_JOB})
    if not passed:raise SystemExit(1)
if __name__=="__main__":
    if sys.argv[1]=="admin":admin(sys.argv[2],sys.argv[3],sys.argv[4],int(sys.argv[5]),int(sys.argv[6]),float(sys.argv[7]))
    elif sys.argv[1]=="child":child(sys.argv[2],float(sys.argv[3]))
    elif sys.argv[1]=="witness":witness(sys.argv[2],sys.argv[3])
    else:raise ValueError("unknown fixed diagnostic mode")
