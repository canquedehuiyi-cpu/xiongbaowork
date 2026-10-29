import os, sys, time
from pathlib import Path
PROJECT=Path("/sys/fs/cgroup/xiongbaowork.slice")
SHARED=PROJECT/"xiongbaowork-data.slice"
KEYS=("memory.max","memory.swap.max","memory.oom.group")
CAP64=dict(zip(KEYS,("67108864","0","1")))
CAP16=dict(zip(KEYS,("16777216","0","1")))
CAP48=dict(zip(KEYS,("50331648","0","1")))
CAP512=dict(zip(KEYS,("536870912","0","1")))
def emit(prefix,value):
    import json
    raw=json.dumps(value,sort_keys=True,separators=(",",":"))
    assert len(raw)<30000
    print(prefix+" "+raw,flush=True)
def limits(path):return {k:(path/k).read_text().strip() for k in KEYS}
def populated(path):
    if not path.exists():return None
    return dict(l.split() for l in (path/"cgroup.events").read_text().splitlines())["populated"]
def procs(path):return (path/"cgroup.procs").read_text().split()
def snapshot(path):
    value={"path":str(path),"exists":False,"limits":{}}
    try:
        info=path.stat();value.update(exists=True,dev=str(info.st_dev),ino=str(info.st_ino))
    except BaseException as exc:
        value["stat_error"]=type(exc).__name__;return value
    for key in KEYS:
        try:value["limits"][key]=(path/key).read_text().strip()
        except BaseException as exc:value["limits"][key]={"error":type(exc).__name__}
    for key,fn in (("populated",populated),("procs",procs)):
        try:value[key]=fn(path)
        except BaseException as exc:value[key+"_error"]=type(exc).__name__
    return value
def fixed(path,value):
    fd=os.open(path,os.O_WRONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        raw=value.encode();assert os.write(fd,raw)==len(raw)
    finally:os.close(fd)
def unit_state(unit,deadline):
    import subprocess
    try:
        left=deadline-time.monotonic();assert left>0
        result=subprocess.run(["systemctl","show",unit,"--property=ActiveState","--property=SubState",
            "--property=LoadState","--property=Job","--property=ControlGroup","--property=Delegate",
            "--property=MainPID","--property=ControlPID","--property=ExecMainCode","--property=ExecMainStatus",
            "--property=RemainAfterExit","--property=MemoryMax","--property=MemorySwapMax"],
            stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=min(2,left),
            env={"PATH":"/usr/bin:/bin","LC_ALL":"C"})
        assert len(result.stdout)+len(result.stderr)<8192
        return {"exit":result.returncode,"properties":dict(l.split("=",1) for l in result.stdout.decode().splitlines() if "=" in l)}
    except BaseException as exc:return {"error":type(exc).__name__}
def identity(s):return (s.get("dev"),s.get("ino"))
def admin(base,runid,attempt,uid,gid,started):
    import json,signal
    assert os.geteuid()==0 and uid>0 and gid>0 and runid.isdecimal() and attempt.isdecimal()
    inner=started+120;outer=started+150;assert time.monotonic()<inner
    unit="xb-a11-delegated-"+runid+"-"+attempt+".service"
    recorddir=Path("/run")/("xb-a11-delegated-"+runid+"-"+attempt);recorddir.mkdir(mode=0o755)
    root=None;target=None;boot=None;admincg=None;childcg=None
    childpid=None;child_status=None;delegated_verified=False
    before=None;after=None;error=None;protocol_complete=False;removed=[]
    def require_time(deadline=outer):assert time.monotonic()<deadline,"same absolute deadline exhausted"
    def managed_root_gate():
        require_time(inner)
        state=unit_state(unit,inner);props=state.get("properties",{})
        assert state.get("exit")==0 and props.get("Delegate")=="yes" and props.get("RemainAfterExit")=="yes"
        cg=props.get("ControlGroup");assert isinstance(cg,str) and cg.startswith("/") and ".." not in cg.split("/")
        path=Path("/sys/fs/cgroup")/cg.lstrip("/")
        assert path.parent==SHARED and path.name==unit and path.resolve(strict=True)==path
        assert Path("/proc/self/cgroup").read_text().strip()=="0::"+cg
        assert os.getxattr(path,"user.delegate",follow_symlinks=False)==b"1"
        assert limits(path)==CAP64
        assert limits(PROJECT)["memory.max"]=="536870912" and limits(PROJECT)["memory.swap.max"]=="0"
        assert limits(SHARED)["memory.max"]=="67108864" and limits(SHARED)["memory.swap.max"]=="0"
        assert procs(path)==[str(os.getpid())]
        return path,state
    def owned(path,cap):
        require_time()
        assert root is not None and path.is_relative_to(root) and path!=root
        assert not path.exists();path.mkdir(mode=0o700)
        for key,value in cap.items():fixed(path/key,value)
        assert limits(path)==cap
    def enter(path):
        require_time()
        fixed(path/"cgroup.procs",str(os.getpid()))
        expected="0::/"+str(path.relative_to(Path("/sys/fs/cgroup")))
        assert Path("/proc/self/cgroup").read_text().strip()==expected
        assert procs(path)==[str(os.getpid())]
    def child_reap(deadline):
        nonlocal childpid,child_status
        if childpid is None:return
        while True:
            require_time(deadline)
            ended,status=os.waitpid(childpid,os.WNOHANG)
            if ended:
                child_status=status;childpid=None;return
            time.sleep(min(0.01,max(0,deadline-time.monotonic())))
    def save(value):
        raw=(json.dumps(value,sort_keys=True)+"\n").encode();assert len(raw)<30000
        fd=os.open(recorddir/"terminal.json",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,"wb") as out:out.write(raw)
    try:
        root,state=managed_root_gate();delegated_verified=True
        # Only delegated descendants are created. Unit-root resource attributes
        # remain systemd-owned and are read-only here. subtree_control is the
        # documented delegation interface explicitly available to the delegate.
        boot=root/"bootstrap";assert not boot.exists();boot.mkdir(mode=0o700)
        fixed(boot/"cgroup.procs",str(os.getpid()))
        assert Path("/proc/self/cgroup").read_text().strip()=="0::/"+str(boot.relative_to(Path("/sys/fs/cgroup")))
        assert procs(root)==[] and procs(boot)==[str(os.getpid())]
        assert "memory" in (root/"cgroup.controllers").read_text().split()
        fixed(root/"cgroup.subtree_control","+memory")
        assert "memory" in (root/"cgroup.subtree_control").read_text().split()
        for key,value in CAP16.items():fixed(boot/key,value)
        assert limits(boot)==CAP16 and limits(root)==CAP64
        target=root/"target";owned(target,CAP64)
        assert procs(target)==[]
        fixed(target/"cgroup.subtree_control","+memory")
        assert "memory" in (target/"cgroup.subtree_control").read_text().split()
        admincg=target/"admin";owned(admincg,CAP16)
        childcg=target/"noop";owned(childcg,CAP48)
        enter(admincg)
        assert populated(boot)=="0" and procs(boot)==[]
        boot.rmdir();removed.append("bootstrap")
        before={"root":snapshot(root),"target":snapshot(target),"admin":snapshot(admincg),
                "child":snapshot(childcg),
                "legacy_project":snapshot(PROJECT),"legacy_shared":snapshot(SHARED),
                "unit":state,"root_uid":os.getresuid(),"root_gid":os.getresgid()}
        readfd,writefd=os.pipe2(os.O_CLOEXEC)
        childpid=os.fork()
        if childpid==0:
            os.close(writefd)
            try:
                permit=os.read(readfd,128);os.close(readfd)
                expected=(runid+":"+attempt+":"+str(started)).encode()
                assert permit==expected and time.monotonic()<inner
                assert Path("/proc/self/cgroup").read_text().strip()=="0::/"+str(childcg.relative_to(Path("/sys/fs/cgroup")))
                assert limits(childcg)==CAP48 and limits(target)==CAP64 and limits(root)==CAP64
                assert Path("/proc/self/oom_score_adj").read_text().strip()=="0"
                os.setgroups([]);os.setresgid(gid,gid,gid);os.setresuid(uid,uid,uid)
                assert os.getresuid()==(uid,uid,uid) and os.getresgid()==(gid,gid,gid) and os.getgroups()==[]
                assert limits(childcg)==CAP48 and limits(target)==CAP64 and limits(root)==CAP64
                assert time.monotonic()<inner
                # No Subject, network, token, logs, codec, SQL, SDK, package or test.
                os._exit(0)
            except BaseException:os._exit(1)
        os.close(readfd)
        try:
            fixed(childcg/"cgroup.procs",str(childpid))
            assert Path("/proc/"+str(childpid)+"/cgroup").read_text().strip()=="0::/"+str(childcg.relative_to(Path("/sys/fs/cgroup")))
            assert str(childpid) in procs(childcg)
            permit=(runid+":"+attempt+":"+str(started)).encode()
            assert os.write(writefd,permit)==len(permit)
        finally:os.close(writefd)
        child_reap(inner)
        assert os.WIFEXITED(child_status) and os.WEXITSTATUS(child_status)==0
        assert populated(childcg)=="0" and procs(childcg)==[]
        protocol_complete=True
    except BaseException as exc:error=type(exc).__name__+":"+str(exc)[:500]
    finally:
        # Failure cleanup is bounded by the same outer. Never create a fallback
        # in an undelegated slice, never touch Subject or managed-root limits.
        if delegated_verified:
            try:
                if childcg is not None and childcg.exists():
                    fixed(childcg/"cgroup.kill","1")
                if childpid is not None:
                    child_reap(outer-8)
                assert admincg is not None and admincg.exists()
                assert Path("/proc/self/cgroup").read_text().strip()=="0::/"+str(admincg.relative_to(Path("/sys/fs/cgroup")))
                assert limits(admincg)==CAP16 and procs(admincg)==[str(os.getpid())]
                if childcg is not None and childcg.exists() and populated(childcg)=="0" and procs(childcg)==[]:
                    childcg.rmdir();removed.append("target/noop")
                if boot is not None and boot.exists() and populated(boot)=="0" and procs(boot)==[]:
                    boot.rmdir();removed.append("bootstrap")
                assert target is not None
                for key,value in CAP64.items():fixed(target/key,value)
                assert limits(target)==CAP64 and limits(root)==CAP64
                assert populated(target)=="1" and procs(target)==[]
                assert snapshot(target)["ino"]==before["target"]["ino"]
                assert not childcg.exists() and populated(admincg)=="1"
                assert limits(admincg)==CAP16 and limits(target)==CAP64
                after={"root":snapshot(root),"target":snapshot(target),"admin":snapshot(admincg),
                    "legacy_project":snapshot(PROJECT),"legacy_shared":snapshot(SHARED),
                    "unit":unit_state(unit,outer-3)}
                require_time(outer-1)
            except BaseException as exc:
                error=(error+"; " if error else "")+"cleanup:"+type(exc).__name__+":"+str(exc)[:500]
        try:
            require_time()
            terminal={"status":"DELEGATED_CONTROL_PREPARED_FOR_EXTERNAL_EMPTY_WITNESS" if protocol_complete and error is None else "FAILED_OR_UNKNOWN",
                "started":started,"inner":inner,"outer":outer,"elapsed":time.monotonic()-started,
                "root_cgroup":str(root) if root else None,"before":before,"after":after,
                "delegation_verified":delegated_verified,"error":error,"removed_empty_groups":removed,
                "retained_for_empty_evidence":["target","target/admin"],
                "root_process_must_exit":True,"restore_proven":False,"legacy_gate":"PENDING_EXTERNAL_NOT_REPLACED",
                "prototype_only":True,"source_adopted":False,"prior_raw_run":40912579798,"prior_raw_job":123584189279,
                "raw_validation_repeated":False}
            save(terminal)
        except BaseException:pass
    if error is not None or not protocol_complete:raise SystemExit(1)
def witness(runid,attempt):
    import json,stat
    assert os.geteuid()==0 and runid.isdecimal() and attempt.isdecimal()
    unit="xb-a11-delegated-"+runid+"-"+attempt+".service"
    state=unit_state(unit,time.monotonic()+3);props=state.get("properties",{})
    cg=props.get("ControlGroup")
    root=None
    if isinstance(cg,str) and cg.startswith("/") and ".." not in cg.split("/"):
        candidate=Path("/sys/fs/cgroup")/cg.lstrip("/")
        if candidate.parent==SHARED and candidate.name==unit:root=candidate
    terminal=None;terminal_error=None
    try:
        file=Path("/run")/("xb-a11-delegated-"+runid+"-"+attempt)/"terminal.json"
        fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd);assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1 and info.st_size<30000
            raw=os.read(fd,30001);assert len(raw)<=30000
        finally:os.close(fd)
        terminal=json.loads(raw)
    except BaseException as exc:terminal_error=type(exc).__name__
    observed={"monotonic":time.monotonic(),"unit":state,"root":snapshot(root) if root else None,
        "target":snapshot(root/"target") if root else None,
        "admin":snapshot(root/"target/admin") if root else None,"noop":snapshot(root/"target/noop") if root else None,
        "bootstrap":snapshot(root/"bootstrap") if root else None,
        "legacy_project":snapshot(PROJECT),"legacy_shared":snapshot(SHARED),
        "legacy_project_unit":unit_state("xiongbaowork.slice",time.monotonic()+2),
        "legacy_shared_unit":unit_state("xiongbaowork-data.slice",time.monotonic()+2)}
    observed["completed_monotonic"]=time.monotonic()
    emit("A11_DELEGATED_ALWAYS_ACTUAL_PRE_ASSERT",{"actual":observed,"terminal":terminal,
        "terminal_error":terminal_error,"read_only_no_new_restore_budget":True})
    def absent(value):return value is not None and value.get("exists") is False and value.get("stat_error")=="FileNotFoundError"
    def empty(value):return value is not None and value.get("exists") is True and value.get("populated")=="0" and value.get("procs")==[]
    target=observed["target"];rootvalue=observed["root"]
    checks={"terminal":terminal is not None and terminal.get("status")=="DELEGATED_CONTROL_PREPARED_FOR_EXTERNAL_EMPTY_WITNESS",
        "delegate":props.get("Delegate")=="yes","remain_after_exit":props.get("RemainAfterExit")=="yes",
        "service_active_exited":props.get("ActiveState")=="active" and props.get("SubState")=="exited",
        "no_service_pid_or_job":props.get("MainPID")=="0" and props.get("ControlPID")=="0" and "Job" in props and props["Job"] in ("","0"),
        "service_success":props.get("ExecMainCode")=="1" and props.get("ExecMainStatus")=="0",
        "root_cap64":rootvalue is not None and rootvalue.get("limits")==CAP64,
        "whole_service_root_pop0":empty(rootvalue),"target_cap64":target is not None and target.get("limits")==CAP64,
        "target_pop0":empty(target),"admin_pop0":empty(observed["admin"]),
        "admin_cap16":observed["admin"] is not None and observed["admin"].get("limits")==CAP16,"noop_removed":absent(observed["noop"]),"bootstrap_removed":absent(observed["bootstrap"]),
        "same_target_identity":terminal is not None and terminal.get("before") is not None and target is not None and identity(target)==identity(terminal["before"]["target"]),
        "same_root_identity":terminal is not None and terminal.get("before") is not None and rootvalue is not None and identity(rootvalue)==identity(terminal["before"]["root"]),
        "same_original_budget":terminal is not None and terminal.get("inner")==terminal.get("started",0)+120 and terminal.get("outer")==terminal.get("started",0)+150 and observed["completed_monotonic"]<terminal.get("outer",0)}
    prototype=all(checks.values())
    legacy={"project_limits":observed["legacy_project"]["limits"]==CAP512,
        "shared_limits":observed["legacy_shared"]["limits"]==CAP64,
        "project_pop0":empty(observed["legacy_project"]),"shared_pop0":empty(observed["legacy_shared"])}
    legacy_ok=all(legacy.values())
    emit("A11_DELEGATED_ALWAYS_TERMINAL",{"prototype_status":"DELEGATED_OWNED_SUBTREE_CONTROL_VERIFIED" if prototype else "FAILED_OR_UNKNOWN",
        "prototype_checks":checks,"legacy_checks":legacy,"legacy_gate":"RESTORED" if legacy_ok else "NOT_RESTORED_OR_UNKNOWN",
        "overall":"CONTROL_PROTOTYPE_AND_LEGACY_GATES_VERIFIED" if prototype and legacy_ok else "FAILED_OR_UNKNOWN",
        "restore_proven":prototype and legacy_ok,"prototype_is_project_migration_permission":False,
        "source_adopted":False,"raw_validation_repeated":False,"prior_raw_run":40912579798,"prior_raw_job":123584189279})
    if not prototype or not legacy_ok:raise SystemExit(1)
if __name__=="__main__":
    if sys.argv[1]=="admin":admin(sys.argv[2],sys.argv[3],sys.argv[4],int(sys.argv[5]),int(sys.argv[6]),float(sys.argv[7]))
    elif sys.argv[1]=="witness":witness(sys.argv[2],sys.argv[3])
    else:raise ValueError("unknown fixed prototype mode")
