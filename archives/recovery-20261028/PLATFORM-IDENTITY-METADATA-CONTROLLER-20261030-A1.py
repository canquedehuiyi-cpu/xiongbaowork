import errno, json, math, os, signal, stat, subprocess, sys, time
from pathlib import Path

PROJECT=Path("/sys/fs/cgroup/xiongbaowork.slice")
PARENT=PROJECT/"xiongbaowork-metadata.slice"
KEYS=("memory.max","memory.swap.max","memory.oom.group")
ORDINARY=67108864
PROJECT_CAP=536870912
ADMIN_CAP=16777216
DATA_CAP=33554432
STAGES=("metadata",)

def now(): return time.monotonic()
def remaining(deadline):
    value=deadline-now()
    if value<=0: raise TimeoutError("same absolute deadline exhausted")
    return value

def read_small(path,cap=16384):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd)
        assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=cap
        data=os.read(fd,cap+1)
        assert len(data)<=cap
        return data
    finally: os.close(fd)

def record(path,value):
    # Root-owned tmpfs only; caller supervises this operation via fork.
    raw=(json.dumps(value,sort_keys=True,separators=(",",":"))+"\n").encode()
    assert len(raw)<=16384
    temp=path.with_name(path.name+"."+str(os.getpid())+".tmp")
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        assert os.write(fd,raw)==len(raw)
    finally: os.close(fd)
    os.replace(temp,path)

def fixed_write(path,text):
    # O_NONBLOCK bypasses synchronous memory.max reclaim. A successful write
    # alone is NOT a workload-empty or timely restore witness.
    fd=os.open(path,os.O_WRONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        raw=text.encode()
        assert os.write(fd,raw)==len(raw)
    finally: os.close(fd)

def limits(path):
    return {key:(path/key).read_text().strip() for key in KEYS}

def empty(path):
    if not path.exists(): return None
    return dict(line.split() for line in (path/"cgroup.events").read_text().splitlines())["populated"]=="0"

def call_bounded(fn,deadline):
    # Small COW child, not another Python interpreter. It reads no metadata collector.
    # All descendants of an operation have their own session for hard kill.
    remaining(deadline)
    readfd,writefd=os.pipe2(os.O_NONBLOCK|os.O_CLOEXEC)
    pid=os.fork()
    if pid==0:
        os.close(readfd)
        try:
            os.setsid()
            value=fn()
            raw=json.dumps({"ok":True,"value":value},separators=(",",":")).encode()
            assert len(raw)<=8192
            os.write(writefd,raw)
            os._exit(0)
        except BaseException as error:
            try: os.write(writefd,json.dumps({"ok":False,"error":type(error).__name__,"detail":str(error)[:800]}).encode())
            except BaseException: pass
            if os.getpgrp()==os.getpid():
                os.killpg(os.getpid(),signal.SIGKILL)
            os._exit(1)
    os.close(writefd)
    data=bytearray()
    try:
        while True:
            try:
                part=os.read(readfd,8192-len(data))
                data.extend(part)
            except BlockingIOError: pass
            assert len(data)<8192
            ended,status=os.waitpid(pid,os.WNOHANG)
            if ended:
                try: data.extend(os.read(readfd,8192-len(data)))
                except BlockingIOError: pass
                value=json.loads(data)
                assert os.WIFEXITED(status) and os.WEXITSTATUS(status)==0 and value["ok"],value
                remaining(deadline)
                return value["value"]
            if now()>=deadline:
                try: os.killpg(pid,signal.SIGKILL)
                except ProcessLookupError:
                    try: os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError: pass
                os.waitpid(pid,os.WNOHANG)
                raise TimeoutError("operation completion UNKNOWN at absolute deadline")
            time.sleep(max(0.0,min(0.01,deadline-now())))
    finally: os.close(readfd)

def command(args,deadline):
    # Runs only inside a supervised operation child/session.
    proc=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                          env={"PATH":"/usr/bin:/bin","LC_ALL":"C"})
    try:
        out,err=proc.communicate(timeout=remaining(deadline))
    except subprocess.TimeoutExpired:
        proc.kill()
        raise TimeoutError("management command UNKNOWN")
    assert len(out)+len(err)<=8192
    assert proc.returncode==0,{"command":args[:2],"exit":proc.returncode,"stderr":err[-500:].decode(errors="replace")}
    return out.decode()

def unit_name(cfg,stage): return cfg["stem"]+"-"+stage+".service"

def restore_observation(cfg):
    fixed_write(PROJECT/"memory.max",str(PROJECT_CAP))
    fixed_write(PROJECT/"memory.swap.max","0")
    fixed_write(PROJECT/"memory.oom.group","1")
    assert limits(PROJECT)==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"]))
    fixed_write(PARENT/"memory.max",str(ORDINARY))
    fixed_write(PARENT/"memory.swap.max","0")
    fixed_write(PARENT/"memory.oom.group","1")
    actual=limits(PARENT)
    assert actual==dict(zip(KEYS,[str(ORDINARY),"0","1"]))
    return {"limits":actual,"project_limits":limits(PROJECT),"observed_at":now(),"absolute_deadline":cfg["outer"]}

def cleanup(cfg,stage,deadline,proc=None):
    unit=unit_name(cfg,stage)
    cg=PARENT/unit
    token=Path(cfg["admin"])/(stage+".permit")
    def operation():
        # Revoke before stopping; a late activation must fail its immutable epoch gate.
        token.unlink(missing_ok=True)
        if cg.exists(): fixed_write(cg/"cgroup.kill","1")
        # TryStopUnit: never-created/unloaded unit may return5. Require an
        # independent exact LoadState/Job/absence observation in that case.
        stop=subprocess.Popen(["systemctl","stop",unit],stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={"PATH":"/usr/bin:/bin","LC_ALL":"C"})
        stop_out,stop_err=stop.communicate(timeout=remaining(deadline))
        assert len(stop_out)+len(stop_err)<=8192 and stop.returncode in (0,5)
        show=subprocess.Popen(["systemctl","show",unit,"--property=ActiveState","--property=Job","--property=LoadState"],
                              stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                              env={"PATH":"/usr/bin:/bin","LC_ALL":"C"})
        out,err=show.communicate(timeout=remaining(deadline))
        assert len(out)+len(err)<=8192 and show.returncode in (0,1)
        observed=out.decode()
        props=dict(line.split("=",1) for line in observed.splitlines() if "=" in line)
        assert props.get("ActiveState") in ("inactive","failed")
        assert "Job" in props and props["Job"] in ("","0")
        assert props.get("LoadState") in ("loaded","not-found")
        if stop.returncode!=0 or show.returncode!=0:
            assert props["LoadState"]=="not-found" and not cg.exists()
        populated=empty(cg)
        assert populated is None or populated
        return {"unit":unit,"stop_completed":True,"job":props.get("Job"),"load_state":props.get("LoadState"),
                "collector_populated0":populated is True,"cgroup_absent_after_stop":populated is None}
    observed=call_bounded(operation,deadline)
    if proc is not None:
        while proc.poll() is None:
            if now()>=deadline: raise TimeoutError("launcher reap UNKNOWN")
            time.sleep(min(0.01,remaining(deadline)))
    call_bounded(lambda:record(Path(cfg["admin"])/(stage+".cleanup.json"),
                               {**observed,"observed_at":now(),"outer":cfg["outer"]}),deadline)
    return observed

def check_all_collector_empty(cfg):
    values={}
    for stage in STAGES:
        cg=PARENT/unit_name(cfg,stage)
        value=empty(cg)
        assert value is None or value
        values[stage]="absent" if value is None else "populated0"
    return values


def control_unit(cfg,role):
    assert role in ("supervisor","fallback")
    return cfg["stem"]+"-"+role+(".scope" if role=="supervisor" else ".service")
def root_gate(cfg,role):
    remaining(cfg["outer"]-5)
    assert os.geteuid()==0
    cg=PARENT/control_unit(cfg,role)
    assert Path("/proc/self/cgroup").read_text().strip()=="0::/"+str(cg.relative_to(Path("/sys/fs/cgroup")))
    assert (cg/"memory.max").read_text().strip()==str(ADMIN_CAP) and (cg/"memory.swap.max").read_text().strip()=="0"
    assert limits(PARENT)["memory.max"]==str(ORDINARY) and limits(PARENT)["memory.swap.max"]=="0"
    assert limits(PROJECT)["memory.max"]==str(PROJECT_CAP) and limits(PROJECT)["memory.swap.max"]=="0"
    fixed_write(cg/"memory.oom.group","1")
    fixed_write(PARENT/"memory.oom.group","1");fixed_write(PROJECT/"memory.oom.group","1")
    fixed_write(Path("/proc/self/oom_score_adj"),"-1000")
    assert limits(cg)==dict(zip(KEYS,[str(ADMIN_CAP),"0","1"]))
    assert limits(PARENT)==dict(zip(KEYS,[str(ORDINARY),"0","1"]))
    assert limits(PROJECT)==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"]))
    assert Path("/proc/self/oom_score_adj").read_text().strip()=="-1000"
    return cg

def fixed_pid1_metadata_snapshot(cfg,root,unit):
    # Sole privileged metadata exception within the already-admitted collector32.
    # Fixed normal public PID1 exe interface only; no ptrace/CAP/LSM/proc change,
    # no other PID/env/cmdline and no disk binary substituted for running PID1.
    import hashlib
    remaining(cfg["inner"])
    assert read_small(root/"metadata.permit").decode()==cfg["epoch"] and not (root/"abort.json").exists()
    assert os.geteuid()==0
    cg=PARENT/unit
    assert Path("/proc/self/cgroup").read_text().strip()=="0::/"+str(cg.relative_to(Path("/sys/fs/cgroup")))
    assert limits(cg)==dict(zip(KEYS,[str(DATA_CAP),"0","1"]))
    assert limits(PARENT)==dict(zip(KEYS,[str(ORDINARY),"0","1"])) and limits(PROJECT)==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"]))
    value={"schema":"xiongbaowork-fixed-pid1-metadata/v1","source":"ROOT_ADMITTED_COLLECTOR_FIXED_PROC1_EXE",
        "run_id":cfg["runid"],"attempt":cfg["attempt"],"head_sha":cfg["target"],
        "epoch":cfg["epoch"],"metadata_not_resource_restoration_proof":True,
        "acquisition_uid":os.geteuid(),"resource_gate":{"collector":limits(cg),"shared":limits(PARENT),"project":limits(PROJECT)}}
    allowed=("/usr/lib/systemd/systemd","/lib/systemd/systemd",
             "/usr/lib/systemd/systemd (deleted)","/lib/systemd/systemd (deleted)")
    try:
        link=os.readlink("/proc/1/exe")
        if link not in allowed:
            value["readlink"]={"status":"UNKNOWN_NON_ALLOWLISTED_PID1_PATH"}
            value["identity"]={"status":"UNKNOWN_NON_ALLOWLISTED_PID1_PATH"}
        else:
            value["readlink"]={"status":"CAPTURED","path":link}
            value["identity"]=binary_identity("/proc/1/exe",cfg["inner"],follow_proc=True)
    except BaseException as error:
        value["readlink"]={"status":"UNKNOWN_"+type(error).__name__}
        value["identity"]={"status":"UNKNOWN_"+type(error).__name__}
    remaining(cfg["inner"])
    assert limits(cg)==dict(zip(KEYS,[str(DATA_CAP),"0","1"]))
    assert limits(PARENT)==dict(zip(KEYS,[str(ORDINARY),"0","1"])) and limits(PROJECT)==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"]))
    assert read_small(root/"metadata.permit").decode()==cfg["epoch"] and not (root/"abort.json").exists()
    value["captured_at"]=now()
    path=root/"pid1.metadata.json";assert not path.exists()
    record(path,value)
    item=path.stat();assert item.st_uid==0 and stat.S_IMODE(item.st_mode)==0o600 and item.st_nlink==1
    raw=(json.dumps(value,sort_keys=True,separators=(",",":"))+"\n").encode()
    assert len(raw)<8192 and read_small(path)==raw
    print("PLATFORM_PID1_ADMITTED_METADATA "+raw.decode().rstrip("\n"),flush=True)
    print("PLATFORM_PID1_ADMITTED_METADATA_IDENTITY "+json.dumps({"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest(),
        "complete":True,"run_id":cfg["runid"],"attempt":cfg["attempt"],"source":value["source"],
        "metadata_not_resource_restoration_proof":True}),flush=True)
    remaining(cfg["inner"])

def wrapper():
    root=Path(sys.argv[2]);cfg=json.loads(read_small(root/"config.json"));stage=sys.argv[3]
    assert stage=="metadata" and cfg["admin"]==str(root)
    remaining(cfg["inner"]);assert os.geteuid()==0 and cfg["uid"]>0 and cfg["gid"]>0
    unit=unit_name(cfg,stage);cg=PARENT/unit
    assert Path("/proc/self/cgroup").read_text().strip()=="0::/"+str(cg.relative_to(Path("/sys/fs/cgroup")))
    assert limits(cg)==dict(zip(KEYS,[str(DATA_CAP),"0","1"]))
    assert read_small(root/(stage+".permit")).decode()==cfg["epoch"] and not (root/"abort.json").exists()
    assert limits(PARENT)["memory.max"]==str(ORDINARY) and limits(PARENT)["memory.swap.max"]=="0"
    assert limits(PROJECT)["memory.max"]==str(PROJECT_CAP) and limits(PROJECT)["memory.swap.max"]=="0"
    fixed_write(PARENT/"memory.oom.group","1");fixed_write(PROJECT/"memory.oom.group","1")
    assert limits(PARENT)==dict(zip(KEYS,[str(ORDINARY),"0","1"]))
    assert limits(PROJECT)==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"]))
    fixed_pid1_metadata_snapshot(cfg,root,unit)
    fixed_write(Path("/proc/self/oom_score_adj"),"0")
    assert read_small(root/(stage+".permit")).decode()==cfg["epoch"] and not (root/"abort.json").exists()
    os.setgroups([]);os.setresgid(cfg["gid"],cfg["gid"],cfg["gid"]);os.setresuid(cfg["uid"],cfg["uid"],cfg["uid"])
    assert os.getresuid()==(cfg["uid"],)*3 and os.getresgid()==(cfg["gid"],)*3 and os.getgroups()==[]
    assert Path("/proc/self/oom_score_adj").read_text().strip()=="0"
    assert limits(cg)==dict(zip(KEYS,[str(DATA_CAP),"0","1"]))
    assert limits(PARENT)==dict(zip(KEYS,[str(ORDINARY),"0","1"])) and limits(PROJECT)==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"]))
    remaining(cfg["inner"])
    args=["/usr/bin/python3","-I","-B",str(root/"controller.py"),"collect",str(root),unit,
        str(cfg["uid"]),str(cfg["gid"]),str(cfg["started"]),str(cfg["inner"]),str(cfg["outer"]),
        cfg["runid"],cfg["attempt"],cfg["target"]]
    os.execve(args[0],args,{"PATH":"/usr/bin:/bin","LC_ALL":"C","PYTHONDONTWRITEBYTECODE":"1"})
def run_stage(cfg,stage,cleaned):
    cutoff=cfg["inner"];assert remaining(cutoff)>2 and not (Path(cfg["admin"])/"abort.json").exists()
    call_bounded(lambda:restore_observation(cfg),cutoff)
    root=Path(cfg["admin"]);permit=root/(stage+".permit")
    def write_permit():
        fd=os.open(permit,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:assert os.write(fd,cfg["epoch"].encode())==len(cfg["epoch"])
        finally:os.close(fd)
        return True
    call_bounded(write_permit,cutoff)
    unit=unit_name(cfg,stage);runtime=max(1,math.floor(remaining(cutoff)-1))
    args=["systemd-run","--wait","--pipe","--unit="+unit,"--slice=xiongbaowork-metadata.slice",
        "--property=Type=exec","--property=MemoryMax="+str(DATA_CAP),"--property=MemorySwapMax=0",
        "--property=OOMPolicy=kill","--property=OOMScoreAdjust=0","--property=KillMode=control-group",
        "--property=KillSignal=SIGKILL","--property=FinalKillSignal=SIGKILL","--property=SendSIGKILL=yes",
        "--property=Restart=no","--property=RuntimeMaxSec="+str(runtime),
        "--property=TimeoutStartSec=1","--property=TimeoutStopSec=1",
        "--property=TimeoutStartFailureMode=kill","--property=TimeoutStopFailureMode=kill",
        "/usr/bin/python3","-I","-B",str(root/"controller.py"),"wrapper",str(root),stage]
    process=None;code=None
    call_bounded(lambda:record(root/(stage+".started.json"),{"stage":stage,"epoch":cfg["epoch"],"inner":cutoff}),cutoff)
    try:
        # This systemd-run client inherits supervisor.scope16; its STDIO is the
        # scope's inherited Actions descriptor. No outside DATA-forwarder exists.
        process=subprocess.Popen(args,stdin=subprocess.DEVNULL,env={"PATH":"/usr/bin:/bin","LC_ALL":"C"})
        while process.poll() is None:
            if now()>=cutoff:raise TimeoutError("metadata270 exhausted")
            time.sleep(min(0.02,remaining(cutoff)))
        remaining(cutoff);code=process.returncode
    finally:
        if process is not None and process.poll() is None:process.kill()
        receipt=cleanup(cfg,stage,cfg["outer"]-6,process);cleaned.add(stage)
        restored=call_bounded(lambda:restore_observation(cfg),cfg["outer"]-6)
        call_bounded(lambda:record(root/(stage+".terminal.json"),{"stage":stage,"exit":code,"cleanup":receipt,
            "restore":restored,"status":"PASSED" if code==0 else "FAILED_OR_UNKNOWN"}),cfg["outer"]-6)
    assert code==0,{"stage":stage,"exit":code}
def supervisor(cfg):
    root_gate(cfg,"supervisor");root=Path(cfg["admin"])
    start=Path("/proc/self/stat").read_text().rsplit(")",1)[1].split()[19]
    call_bounded(lambda:record(root/"supervisor.pid.json",{"pid":os.getpid(),"starttime":start}),cfg["inner"])
    cleaned=set();error=None
    try:
        while not (root/"fallback.ready.json").exists():time.sleep(min(0.01,remaining(cfg["inner"])))
        ready=json.loads(read_small(root/"fallback.ready.json"));assert ready["epoch"]==cfg["epoch"]
        run_stage(cfg,"metadata",cleaned)
    except BaseException as caught:error={"type":type(caught).__name__,"detail":str(caught)[:800]}
    finally:
        collectors=call_bounded(lambda:check_all_collector_empty(cfg),cfg["outer"]-6)
        restored=call_bounded(lambda:restore_observation(cfg),cfg["outer"]-6)
        call_bounded(lambda:record(root/"supervisor.terminal.json",{"status":"SUCCESS_PENDING_FINAL_WITNESS" if error is None else "FAILED",
            "error":error,"cleaned":sorted(cleaned),"collectors":collectors,"restore":restored,
            "actual_parent_empty_claim":False,"observed_at":now(),"outer":cfg["outer"]}),cfg["outer"]-6)
    if error is not None:raise RuntimeError("metadata/supervisor failed; no retry")
def fallback(cfg):
    root_gate(cfg,"fallback");root=Path(cfg["admin"]);death=False
    call_bounded(lambda:record(root/"fallback.ready.json",{"ready_at":now(),"outer":cfg["outer"],"epoch":cfg["epoch"]}),cfg["inner"])
    while now()<cfg["inner"]:
        if (root/"supervisor.terminal.json").exists() or (root/"abort.json").exists():break
        if (root/"supervisor.pid.json").exists():
            pinned=json.loads(read_small(root/"supervisor.pid.json"))
            try:observed=Path("/proc/"+str(pinned["pid"])+"/stat").read_text().rsplit(")",1)[1].split()[19]
            except FileNotFoundError:death=True;break
            if observed!=pinned["starttime"]:death=True;break
        time.sleep(max(0.0,min(0.02,cfg["inner"]-now())))
    def abort():
        if not (root/"abort.json").exists():record(root/"abort.json",{"reason":"FALLBACK_FINALIZATION_OR_RECOVERY","at":now(),"outer":cfg["outer"]})
        return True
    call_bounded(abort,cfg["outer"]-5);errors=[]
    for stage in STAGES:
        try:
            call_bounded(lambda stage=stage:(root/(stage+".permit")).unlink(missing_ok=True),cfg["outer"]-5)
            cg=PARENT/unit_name(cfg,stage);receipt=root/(stage+".cleanup.json")
            if receipt.exists():
                prior=json.loads(read_small(receipt));assert prior["unit"]==unit_name(cfg,stage) and empty(cg) in (True,None)
            elif (root/(stage+".started.json")).exists():cleanup(cfg,stage,cfg["outer"]-5)
        except BaseException as error:errors.append({"stage":stage,"type":type(error).__name__})
    collectors=call_bounded(lambda:check_all_collector_empty(cfg),cfg["outer"]-5)
    restored=call_bounded(lambda:restore_observation(cfg),cfg["outer"]-5)
    call_bounded(lambda:record(root/"fallback.terminal.json",{"status":"COLLECTOR_EMPTY_LIMITS_OBSERVED" if not errors else "FAILED_OR_UNKNOWN",
        "supervisor_death":death,"errors":errors,"collectors":collectors,"restore":restored,
        "parent_populated0_claim":False,"observed_at":now(),"outer":cfg["outer"]}),cfg["outer"]-5)
    if errors:raise RuntimeError("fallback cleanup UNKNOWN")

def trusted_tool(path):
    value=Path(path);actual=value.resolve(strict=True)
    item=actual.stat()
    assert stat.S_ISREG(item.st_mode) and item.st_uid==0 and stat.S_IMODE(item.st_mode)&0o022==0
    assert stat.S_IMODE(item.st_mode)&0o111
    return str(value)
def bounded_query(argv,deadline):
    import selectors,hashlib
    try:
        assert isinstance(argv,list) and argv and all(isinstance(s,str) and "\0" not in s for s in argv)
        trusted_tool(argv[0]);stop=min(deadline,now()+5.0);remaining(stop)
        process=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            env={"PATH":"/usr/bin:/bin","LC_ALL":"C"},start_new_session=True)
        selector=selectors.DefaultSelector()
        selector.register(process.stdout,selectors.EVENT_READ,"stdout")
        selector.register(process.stderr,selectors.EVENT_READ,"stderr")
        output={"stdout":bytearray(),"stderr":bytearray()};caps={"stdout":8192,"stderr":2048}
        try:
            while selector.get_map():
                left=stop-now()
                if left<=0:raise TimeoutError("bounded metadata command timeout")
                for key,_ in selector.select(min(0.05,left)):
                    part=os.read(key.fileobj.fileno(),65536)
                    if not part:selector.unregister(key.fileobj);continue
                    if len(output[key.data])+len(part)>caps[key.data]:raise ValueError("metadata output cap")
                    output[key.data].extend(part)
            code=process.wait(timeout=remaining(stop))
        except BaseException as error:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            try:process.wait(timeout=min(0.1,max(0.001,deadline-now())))
            except subprocess.TimeoutExpired:pass
            return {"status":"UNKNOWN_"+type(error).__name__,"argv":argv,"complete":False}
        finally:
            selector.close();process.stdout.close();process.stderr.close()
        result={"status":"CAPTURED" if code==0 else "UNKNOWN_EXIT","argv":argv,"exit":code,"complete":True}
        for key,raw in output.items():
            result[key+"_bytes"]=len(raw);result[key+"_sha256"]=hashlib.sha256(raw).hexdigest()
            result[key]=bytes(raw).decode("utf-8","strict")
        return result
    except BaseException as error:return {"status":"UNKNOWN_"+type(error).__name__,"argv":argv,"complete":False}
def binary_identity(path,deadline,follow_proc=False):
    import hashlib
    try:
        fd=os.open(path,os.O_RDONLY|(0 if follow_proc else os.O_NOFOLLOW))
        try:
            before=os.fstat(fd)
            assert stat.S_ISREG(before.st_mode) and before.st_uid==0
            assert stat.S_IMODE(before.st_mode)&0o022==0 and before.st_size<=16777216
            digest=hashlib.sha256();count=0
            while True:
                remaining(deadline);block=os.read(fd,65536)
                if not block:break
                count+=len(block);assert count<=16777216;digest.update(block)
            after=os.fstat(fd);named=os.stat(path)
            fields=("st_dev","st_ino","st_size","st_mode","st_uid","st_gid","st_mtime_ns","st_ctime_ns")
            assert tuple(getattr(before,k) for k in fields)==tuple(getattr(after,k) for k in fields)==tuple(getattr(named,k) for k in fields)
            assert count==before.st_size
            return {"status":"CAPTURED","path":str(path),"bytes":count,"sha256":digest.hexdigest(),
                "dev":str(before.st_dev),"ino":str(before.st_ino),"uid":before.st_uid,
                "mode":oct(stat.S_IMODE(before.st_mode)),"fd_named_stable":True}
        finally:os.close(fd)
    except BaseException as error:return {"status":"UNKNOWN_"+type(error).__name__,"path":str(path)}
def collect():
    import hashlib
    root=Path(sys.argv[2]);unit=sys.argv[3];uid,gid=int(sys.argv[4]),int(sys.argv[5])
    started,inner,outer=map(float,sys.argv[6:9]);runid,attempt,target=sys.argv[9:12]
    assert inner==started+270 and outer==started+300 and now()<inner
    assert os.getresuid()==(uid,)*3 and os.getresgid()==(gid,)*3 and os.getgroups()==[] and uid>0 and gid>0
    assert Path("/proc/self/oom_score_adj").read_text().strip()=="0"
    assert Path("/proc/self/cgroup").read_text().strip()=="0::/"+str((PARENT/unit).relative_to(Path("/sys/fs/cgroup")))
    expected=dict(zip(KEYS,[str(DATA_CAP),"0","1"]))
    assert limits(PARENT/unit)==expected and limits(PARENT)==dict(zip(KEYS,[str(ORDINARY),"0","1"]))
    assert limits(PROJECT)==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"]))
    assert runid.isdecimal() and attempt.isdecimal() and len(target)==40 and all(c in "0123456789abcdef" for c in target)
    report={"schema":"xiongbaowork-platform-version-metadata/v1","run_id":runid,"attempt":attempt,"head_sha":target,
        "scope":"CURRENT_NEW_RUN_ONLY_NOT_PRIOR_RUN_VERSION",
        "resource_gate":{"collector":limits(PARENT/unit),"shared":limits(PARENT),"project":limits(PROJECT)},
        "original_six_subject_stages":"NOT_RUN_NOT_CLAIMED_PASSED","all_commands_unprivileged":True,"source_adopted":False}
    report["running_manager_version"]=bounded_query(["/usr/bin/systemctl","show","--property=Version","--value","--no-pager"],inner)
    try:report["pid1_exe_link"]={"status":"CAPTURED","path":os.readlink("/proc/1/exe")}
    except BaseException as error:report["pid1_exe_link"]={"status":"UNKNOWN_"+type(error).__name__}
    report["pid1_exe_identity"]=binary_identity("/proc/1/exe",inner,follow_proc=True)
    binary=None
    for candidate in ("/usr/lib/systemd/systemd","/lib/systemd/systemd"):
        try:
            resolved=Path(candidate).resolve(strict=True)
            assert str(resolved) in ("/usr/lib/systemd/systemd","/lib/systemd/systemd")
            trusted_tool(str(resolved));binary=str(resolved);break
        except BaseException:pass
    if binary is None:
        report["disk_systemd"]={"status":"UNKNOWN_NO_ALLOWLISTED_BINARY"}
        report["disk_systemd_version"]={"status":"UNKNOWN_NO_ALLOWLISTED_BINARY"}
        report["binary_package_owner"]={"status":"UNKNOWN_NO_ALLOWLISTED_BINARY"}
    else:
        report["disk_systemd"]=binary_identity(binary,inner)
        report["disk_systemd_version"]=bounded_query([binary,"--version"],inner)
        report["binary_package_owner"]={"status":"SEE_VERIFIED_LITERAL_ALIAS_RESULTS"}
    report["binary_owner_aliases"]=[]
    if binary is not None and report["disk_systemd"].get("status")=="CAPTURED":
        for alias in ("/usr/lib/systemd/systemd","/lib/systemd/systemd"):
            try:
                assert str(Path(alias).resolve(strict=True))==binary
                trusted_tool(alias)
                # Only these two fixed OS aliases may be followed, after exact
                # trusted resolution; owner is queried using the literal alias.
                ident=binary_identity(alias,inner,follow_proc=True)
                assert ident.get("status")=="CAPTURED"
                disk_identity=report["disk_systemd"]
                assert all(ident.get(k)==disk_identity.get(k) for k in ("dev","ino","bytes","sha256"))
                owner=bounded_query(["/usr/bin/dpkg-query","-S",alias],inner)
                report["binary_owner_aliases"].append({"literal_alias":alias,"status":"SAME_VERIFIED_BINARY",
                    "identity":ident,"owner_query":owner})
            except BaseException as error:
                report["binary_owner_aliases"].append({"literal_alias":alias,"status":"UNKNOWN_"+type(error).__name__,
                    "owner_query":"NOT_RUN_ALIAS_IDENTITY_NOT_ESTABLISHED"})
    else:
        report["binary_owner_aliases_status"]="UNKNOWN_NO_VERIFIED_BINARY"
    report["systemd_package_identity"]=bounded_query(["/usr/bin/dpkg-query","-W",
        "-f=${binary:Package}\\t${Version}\\t${Architecture}\\t${source:Package}\\t${source:Version}\\t${db:Status-Abbrev}\\n","systemd"],inner)
    report["package_patch_identity_scope"]="FULL_BINARY_SOURCE_VERSION_METADATA_NOT_VENDOR_PATCH_CONTENT_PROOF"
    report["kernel"]={option:bounded_query(["/usr/bin/uname",option],inner) for option in ("-s","-r","-v","-m")}
    try:
        import shlex
        path=Path("/etc/os-release").resolve(strict=True);assert str(path) in ("/etc/os-release","/usr/lib/os-release")
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            before=os.fstat(fd);assert stat.S_ISREG(before.st_mode) and before.st_uid==0 and stat.S_IMODE(before.st_mode)&0o022==0 and before.st_size<=16384
            raw=os.read(fd,16385);assert len(raw)==before.st_size and len(raw)<=16384
            after=os.fstat(fd)
            assert (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
        finally:os.close(fd)
        allowed={"ID","VERSION_ID","VERSION","PRETTY_NAME","BUILD_ID"};fields={}
        for line in raw.decode("utf-8","strict").splitlines():
            if "=" not in line:continue
            key,value=line.split("=",1)
            if key not in allowed:continue
            assert key not in fields
            parsed=shlex.split(value,comments=False,posix=True);assert len(parsed)<=1
            fields[key]=parsed[0] if parsed else ""
        report["os_release"]={"status":"CAPTURED","path":str(path),"fields":fields}
    except BaseException as error:report["os_release"]={"status":"UNKNOWN_"+type(error).__name__}
    live=report["pid1_exe_identity"];disk=report["disk_systemd"]
    report["running_to_disk_binary_hash_match"]=(
        live.get("sha256")==disk.get("sha256") if live.get("status")==disk.get("status")=="CAPTURED" else "UNKNOWN")
    report["running_manager_disk_package_exact_version_match"]="UNKNOWN_REQUIRES_EXACT_FIELD_REVIEW_NOT_OS_NAME_INFERENCE"
    report["runner_image_provisioner"]="COORDINATOR_NATIVE_JOB_SETUP_METADATA_ONLY_NO_ENV_READ"
    report["new_versions_backfill_prior_runs"]=False
    remaining(inner)
    assert limits(PARENT/unit)==expected and limits(PARENT)==dict(zip(KEYS,[str(ORDINARY),"0","1"]))
    assert limits(PROJECT)==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"]))
    report["collector_finished_at"]=now();report["status"]="BOUNDED_METADATA_CAPTURED_EXPLICIT_UNKNOWN_FIELDS"
    raw=(json.dumps(report,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()
    assert len(raw)<=32768,"complete version report over cap; never truncate to pass"
    print("PLATFORM_VERSION_METADATA_REPORT "+raw.decode().rstrip("\n"),flush=True)
    print("PLATFORM_VERSION_METADATA_IDENTITY "+json.dumps({"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest(),
        "complete":True,"run_id":runid,"attempt":attempt,"not_resource_restoration_proof":True}),flush=True)


def fixed_resource_evidence_call(operation,deadline):
    # Dedicated fixed-resource-only COW child: complete<=16KiB receipts/stdout
    # never cross this tiny ACK pipe. No version/Subject or restoration access.
    remaining(deadline)
    readfd,writefd=os.pipe2(os.O_NONBLOCK|os.O_CLOEXEC)
    pid=os.fork()
    if pid==0:
        os.close(readfd)
        try:
            os.setsid()
            passed=bool(operation())
            remaining(deadline)
            ack={"ok":True,"passed":passed,"completed_at":now(),"deadline":deadline}
            raw=json.dumps(ack,separators=(",",":")).encode();assert len(raw)<=1024
            assert os.write(writefd,raw)==len(raw)
            os._exit(0)
        except BaseException as error:
            try:
                raw=json.dumps({"ok":False,"error":type(error).__name__},separators=(",",":")).encode()
                os.write(writefd,raw)
            except BaseException:pass
            if os.getpgrp()==os.getpid():os.killpg(os.getpid(),signal.SIGKILL)
            os._exit(1)
    os.close(writefd);data=bytearray()
    try:
        while True:
            try:data.extend(os.read(readfd,1025-len(data)))
            except BlockingIOError:pass
            assert len(data)<=1024
            ended,status=os.waitpid(pid,os.WNOHANG)
            if ended:
                try:data.extend(os.read(readfd,1025-len(data)))
                except BlockingIOError:pass
                assert len(data)<=1024
                ack=json.loads(data)
                assert os.WIFEXITED(status) and os.WEXITSTATUS(status)==0 and ack.get("ok") is True,ack
                assert ack["deadline"]==deadline and ack["completed_at"]<deadline
                # Actual observe/record/full emit plus ACK/reap must complete
                # inside the very same outer deadline, not just observed_at.
                remaining(deadline)
                return ack
            if now()>=deadline:
                try:os.killpg(pid,signal.SIGKILL)
                except ProcessLookupError:
                    try:os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                os.waitpid(pid,os.WNOHANG)
                raise TimeoutError("resource evidence completion UNKNOWN at same outer deadline")
            time.sleep(max(0.0,min(0.01,deadline-now())))
    finally:os.close(readfd)
def observe_record_emit_resource_terminal(cfg,code):
    root=Path(cfg["admin"])
    result=final_observation(cfg,code)
    result["complete_emit_requires_supervised_ack_and_step_success"]=True
    record(root/"outer.terminal.json",result)
    print("PLATFORM_RESOURCE_OUTER_TERMINAL "+json.dumps(result,sort_keys=True),flush=True)
    remaining(cfg["outer"])
    # This root-owned marker follows the complete emission. The operation ACK
    # and caller's post-reap remaining check additionally bound marker completion.
    record(root/"outer.emission.json",{"epoch":cfg["epoch"],"outer":cfg["outer"],
        "emission_completed_at":now(),"status":result["status"]})
    remaining(cfg["outer"])
    return result["status"]=="RESOURCE_GATE_VERIFIED"

def config(root):
    cfg=json.loads(read_small(root/"config.json"))
    assert cfg["admin"]==str(root) and root.parent==Path("/run") and root.name==cfg["stem"]
    assert cfg["inner"]==cfg["started"]+270 and cfg["outer"]==cfg["started"]+300
    for name in ("runid","attempt"):assert cfg[name].isdecimal()
    assert cfg["stem"]=="xb-platform-"+cfg["runid"]+"-"+cfg["attempt"]
    item=(root/"controller.py").stat()
    assert item.st_uid==0 and stat.S_IMODE(item.st_mode)==0o444 and item.st_nlink==1
    return cfg
def unit_observation(unit,deadline):
    result=command(["systemctl","show",unit,"--property=ActiveState","--property=LoadState",
        "--property=Job","--property=ControlGroup"],deadline)
    # command() requires exit0; systemctl show missing transient unit normally
    # still reports inactive/not-found. Errors remain UNKNOWN, never empty.
    props=dict(line.split("=",1) for line in result.splitlines() if "=" in line)
    return props
def final_observation(cfg,supervisor_code):
    remaining(cfg["outer"])
    observed={"shared":None,"project":None,"shared_populated0":False,"project_populated0":False,
        "controls":{},"collector":{},"supervisor_terminal":None,"fallback_terminal":None,"errors":[]}
    try:
        observed["shared"]=limits(PARENT);observed["shared_populated0"]=empty(PARENT) is True
        observed["project"]=limits(PROJECT);observed["project_populated0"]=empty(PROJECT) is True
    except BaseException as error:observed["errors"].append("parent:"+type(error).__name__)
    for role in ("supervisor","fallback"):
        unit=control_unit(cfg,role)
        try:
            props=unit_observation(unit,cfg["outer"]);value=empty(PARENT/unit)
            observed["controls"][role]={"unit":unit,"properties":props,"actual_empty":value is True,
                "absent_after_exit":value is None,
                "quiet":props.get("ActiveState") in ("inactive","failed") and props.get("LoadState") in ("loaded","not-found") and
                    "Job" in props and props["Job"] in ("","0") and value in (True,None)}
        except BaseException as error:observed["errors"].append(role+":"+type(error).__name__)
    for name in ("supervisor","fallback"):
        try:observed[name+"_terminal"]=json.loads(read_small(Path(cfg["admin"])/(name+".terminal.json")))
        except BaseException as error:observed["errors"].append(name+"receipt:"+type(error).__name__)
    try:observed["collector"]=json.loads(read_small(Path(cfg["admin"])/"metadata.terminal.json"))
    except BaseException as error:observed["errors"].append("metadatareceipt:"+type(error).__name__)
    main=observed["supervisor_terminal"];backup=observed["fallback_terminal"]
    passed=not observed["errors"] and supervisor_code==0
    passed=passed and main is not None and main["status"]=="SUCCESS_PENDING_FINAL_WITNESS"
    passed=passed and backup is not None and backup["status"]=="COLLECTOR_EMPTY_LIMITS_OBSERVED"
    passed=passed and all(observed["controls"].get(role,{}).get("quiet") is True for role in ("supervisor","fallback"))
    passed=passed and observed["shared"]==dict(zip(KEYS,[str(ORDINARY),"0","1"])) and observed["shared_populated0"]
    passed=passed and observed["project"]==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"])) and observed["project_populated0"] and now()<cfg["outer"]
    result={"schema":"xiongbaowork-platform-resource-terminal/v1","status":"RESOURCE_GATE_VERIFIED" if passed else "FAILED_OR_UNKNOWN",
        "actual":observed,"supervisor_scope_command_returncode":supervisor_code,"observed_at":now(),
        "started":cfg["started"],"inner":cfg["inner"],"outer":cfg["outer"],"elapsed":now()-cfg["started"],
        "version_report_is_separate_unprivileged_evidence":True,"source_adopted":False}
    assert len(json.dumps(result).encode())<16000
    return result
def bootstrap():
    root=Path(sys.argv[2]);cfg=config(root)
    assert os.geteuid()==0
    remaining(cfg["outer"])
    # Fixed per-job resource guards only. O_EXCL means collisions fail without
    # overwriting another owner. No manager-global/persistent policy or enable.
    for name,cap in (("xiongbaowork.slice","512M"),("xiongbaowork-metadata.slice","64M")):
        path=Path("/run/systemd/system")/name
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
        with os.fdopen(fd,"w") as out:
            out.write("[Unit]\nDescription=Bounded platform metadata job resource guard\n[Slice]\nMemoryMax="+cap+"\nMemorySwapMax=0\n")
    for args in (["systemctl","daemon-reload"],["systemctl","start","xiongbaowork-metadata.slice"]):
        done=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
            timeout=min(5,remaining(cfg["outer"])),env={"PATH":"/usr/bin:/bin","LC_ALL":"C"})
        assert done.returncode==0
    before={"shared":limits(PARENT),"project":limits(PROJECT),"shared_empty":empty(PARENT),"project_empty":empty(PROJECT)}
    assert before["shared"]["memory.max"]==str(ORDINARY) and before["shared"]["memory.swap.max"]=="0"
    assert before["project"]["memory.max"]==str(PROJECT_CAP) and before["project"]["memory.swap.max"]=="0"
    assert before["shared_empty"] is True and before["project_empty"] is True
    for path in (PROJECT,PARENT):fixed_write(path/"memory.oom.group","1")
    assert limits(PARENT)==dict(zip(KEYS,[str(ORDINARY),"0","1"])) and limits(PROJECT)==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"]))
    record(root/"bootstrap.gate.json",{"before":before,"shared":limits(PARENT),"project":limits(PROJECT),"at":now(),
        "started":cfg["started"],"guard_setup_in_original_budget":True})
    print("PLATFORM_BOOTSTRAP_RESOURCE_GATE "+json.dumps({"shared":limits(PARENT),"project":limits(PROJECT),
        "started":cfg["started"],"inner":cfg["inner"],"outer":cfg["outer"],"before":before}),flush=True)
    runtime=math.floor(remaining(cfg["outer"])-3);assert runtime>2
    fallback_args=["systemd-run","--no-block","--unit="+control_unit(cfg,"fallback"),"--slice=xiongbaowork-metadata.slice",
        "--property=Type=exec","--property=MemoryMax="+str(ADMIN_CAP),"--property=MemorySwapMax=0",
        "--property=OOMPolicy=continue","--property=OOMScoreAdjust=-1000","--property=Restart=no",
        "--property=KillMode=control-group","--property=KillSignal=SIGKILL","--property=FinalKillSignal=SIGKILL",
        "--property=SendSIGKILL=yes","--property=RuntimeMaxSec="+str(runtime),
        "--property=TimeoutStartSec=1","--property=TimeoutStopSec=1",
        "--property=TimeoutStartFailureMode=kill","--property=TimeoutStopFailureMode=kill",
        "/usr/bin/env","-i","PATH=/usr/bin:/bin","LC_ALL=C","PYTHONDONTWRITEBYTECODE=1",
        "/usr/bin/python3","-I","-B",str(root/"controller.py"),"fallback",str(root)]
    done=subprocess.run(fallback_args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
        timeout=min(5,remaining(cfg["outer"])),env={"PATH":"/usr/bin:/bin","LC_ALL":"C"})
    assert done.returncode==0
    runtime=math.floor(remaining(cfg["outer"])-3);assert runtime>2
    # --scope registers its own PID then execs the command: no outside long-lived
    # pipe-forwarder exists. All actual supervisor/client children are in scope16.
    scope_args=["systemd-run","--scope","--unit="+control_unit(cfg,"supervisor"),"--slice=xiongbaowork-metadata.slice",
        "--property=MemoryMax="+str(ADMIN_CAP),"--property=MemorySwapMax=0","--property=OOMPolicy=continue",
        "--property=RuntimeMaxSec="+str(runtime),"--property=KillMode=control-group",
        "--property=KillSignal=SIGKILL","--property=FinalKillSignal=SIGKILL","--property=SendSIGKILL=yes",
        "/usr/bin/python3","-I","-B",str(root/"controller.py"),"supervisor",str(root)]
    process=subprocess.Popen(scope_args,stdin=subprocess.DEVNULL,env={"PATH":"/usr/bin:/bin","LC_ALL":"C"})
    code=None
    try:
        code=process.wait(timeout=remaining(cfg["outer"]))
    except subprocess.TimeoutExpired:
        # Do not kill a PID which may be the actual in-scope supervisor here.
        # Existing independent fallback/manager bounds own cancellation.
        code=None
    # After startup, normal Actions wrapper performs only fixed read-only
    # physical observations. No outside abort/stop/restore writer or extra grace.
    while now()<cfg["outer"]:
        backup=root/"fallback.terminal.json"
        fallback_cg=PARENT/control_unit(cfg,"fallback")
        supervisor_cg=PARENT/control_unit(cfg,"supervisor")
        if backup.exists() and empty(fallback_cg) in (True,None) and empty(supervisor_cg) in (True,None):break
        time.sleep(max(0.0,min(0.02,cfg["outer"]-now())))
    if now()>=cfg["outer"]:
        print("PLATFORM_RESOURCE_UNKNOWN "+json.dumps({"status":"FAILED_OR_UNKNOWN","reason":"same300 exhausted","version_report_separate":True}),flush=True)
        raise SystemExit(1)
    ack=fixed_resource_evidence_call(lambda:observe_record_emit_resource_terminal(cfg,code),cfg["outer"])
    remaining(cfg["outer"])
    if not ack["passed"]:raise SystemExit(1)
def witness_operation(root,cfg):
    actual={"shared":None,"project":None,"shared_populated0":False,"project_populated0":False,"errors":[]}
    try:
        actual["shared"]=limits(PARENT);actual["shared_populated0"]=empty(PARENT) is True
        actual["project"]=limits(PROJECT);actual["project_populated0"]=empty(PROJECT) is True
    except BaseException as error:actual["errors"].append(type(error).__name__)
    terminal=None
    try:terminal=json.loads(read_small(root/"outer.terminal.json"))
    except BaseException as error:actual["errors"].append("terminal:"+type(error).__name__)
    emission=None
    try:emission=json.loads(read_small(root/"outer.emission.json"))
    except BaseException as error:actual["errors"].append("emission:"+type(error).__name__)
    ok=terminal is not None and terminal["status"]=="RESOURCE_GATE_VERIFIED" and terminal["observed_at"]<cfg["outer"]
    ok=ok and emission is not None and emission["epoch"]==cfg["epoch"] and emission["outer"]==cfg["outer"]
    ok=ok and emission["emission_completed_at"]<cfg["outer"] and emission["status"]=="RESOURCE_GATE_VERIFIED"
    ok=ok and actual["shared"]==dict(zip(KEYS,[str(ORDINARY),"0","1"])) and actual["shared_populated0"]
    ok=ok and actual["project"]==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"])) and actual["project_populated0"] and not actual["errors"]
    print("PLATFORM_RESOURCE_ALWAYS_READONLY "+json.dumps({"status":"VERIFIED" if ok else "FAILED_OR_UNKNOWN",
        "actual":actual,"saved_terminal":terminal,"emission":emission,
        "completion_requires_supervised_ack_and_step_success":True,
        "no_restore_or_new_grace":True,"version_report_separate":True},sort_keys=True),flush=True)
    remaining(cfg["outer"])
    return ok
def witness():
    root=Path(sys.argv[2]);cfg=config(root)
    remaining(cfg["outer"])
    ack=fixed_resource_evidence_call(lambda:witness_operation(root,cfg),cfg["outer"])
    remaining(cfg["outer"])
    if not ack["passed"]:raise SystemExit(1)
if __name__=="__main__":
    mode=sys.argv[1]
    if mode=="collect":collect()
    elif mode=="wrapper":wrapper()
    elif mode=="bootstrap":bootstrap()
    elif mode=="witness":witness()
    elif mode in ("supervisor","fallback"):
        root=Path(sys.argv[2]);cfg=config(root)
        if mode=="supervisor":supervisor(cfg)
        else:fallback(cfg)
    else:raise ValueError("unknown fixed administrative role")
