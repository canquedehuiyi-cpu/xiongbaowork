import json, os, signal, stat, subprocess, sys, time
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


def unit_name(cfg,stage): return cfg["stem"]+"-"+stage+".service"



PHASE_CONTEXT=None
PHASE_COUNT=0
PHASE_ACTIVE="root_entry"
def phase(name,state):
    global PHASE_COUNT,PHASE_ACTIVE
    assert PHASE_CONTEXT is not None and state in ("STARTED","FINISHED","UNKNOWN")
    assert name in ("root_entry","pid1_snapshot","drop","collector_entry","report",
        "manager_version","disk_version","owner_usr","owner_lib","package_versions",
        "kernel_s","kernel_r","kernel_v","kernel_m")
    PHASE_ACTIVE=name
    remaining(PHASE_CONTEXT["inner"])
    PHASE_COUNT+=1;assert PHASE_COUNT<=64
    value={"schema":"xb-platform-phase/v1","run":PHASE_CONTEXT["runid"],
        "attempt":PHASE_CONTEXT["attempt"],"head":PHASE_CONTEXT["head"],"unit":PHASE_CONTEXT["unit"],
        "seq":PHASE_COUNT,"phase":name,"state":state,"at":now(),"metadata_only":True}
    raw=json.dumps(value,separators=(",",":"),ensure_ascii=True)
    line="PLATFORM_METADATA_PHASE "+raw+"\n"
    assert len(line.encode())<=512
    sys.stdout.write(line);sys.stdout.flush()
    remaining(PHASE_CONTEXT["inner"])

def immutable_collector(root,expected):
    import hashlib
    path=root/"collector.py"
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        before=os.fstat(fd)
        assert stat.S_ISREG(before.st_mode) and before.st_uid==0 and before.st_nlink==1
        assert stat.S_IMODE(before.st_mode)==0o444 and before.st_size<=32768
        digest=hashlib.sha256();count=0
        while True:
            block=os.read(fd,4096)
            if not block:break
            count+=len(block);assert count<=32768;digest.update(block)
        after=os.fstat(fd);named=path.stat()
        fields=("st_dev","st_ino","st_size","st_mode","st_uid","st_gid","st_mtime_ns","st_ctime_ns")
        assert tuple(getattr(before,k) for k in fields)==tuple(getattr(after,k) for k in fields)==tuple(getattr(named,k) for k in fields)
        assert count==before.st_size and digest.hexdigest()==expected
    finally:os.close(fd)

def command_phase(argv):
    if argv==["/usr/bin/systemctl","show","--property=Version","--value","--no-pager"]:return "manager_version"
    if len(argv)==2 and argv[0] in ("/usr/lib/systemd/systemd","/lib/systemd/systemd") and argv[1]=="--version":return "disk_version"
    if len(argv)==3 and argv[:2]==["/usr/bin/dpkg-query","-S"]:
        assert argv[2] in ("/usr/lib/systemd/systemd","/lib/systemd/systemd")
        return "owner_usr" if argv[2].startswith("/usr/") else "owner_lib"
    if len(argv)==4 and argv[:2]==["/usr/bin/dpkg-query","-W"] and argv[3]=="systemd":
        assert argv[2]=="-f=${binary:Package}\\t${Version}\\t${Architecture}\\t${source:Package}\\t${source:Version}\\t${db:Status-Abbrev}\\n"
        return "package_versions"
    assert len(argv)==2 and argv[0]=="/usr/bin/uname" and argv[1] in ("-s","-r","-v","-m")
    return "kernel_"+argv[1][1]

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
    global PHASE_CONTEXT
    root=Path(sys.argv[2]);cfg=json.loads(read_small(root/"config.json"));stage=sys.argv[3]
    assert stage=="metadata" and cfg["admin"]==str(root)
    assert root.parent==Path("/run") and root.name==cfg["stem"]=="xb-platform-"+cfg["runid"]+"-"+cfg["attempt"]
    assert cfg["inner"]==cfg["started"]+270 and cfg["outer"]==cfg["started"]+300
    assert cfg["runid"].isdecimal() and cfg["attempt"].isdecimal()
    assert len(cfg["target"])==40 and all(ch in "0123456789abcdef" for ch in cfg["target"])
    immutable_collector(root,cfg["collector_sha256"])
    remaining(cfg["inner"]);assert os.geteuid()==0 and cfg["uid"]>0 and cfg["gid"]>0
    unit=unit_name(cfg,stage);cg=PARENT/unit
    assert Path("/proc/self/cgroup").read_text().strip()=="0::/"+str(cg.relative_to(Path("/sys/fs/cgroup")))
    assert limits(cg)==dict(zip(KEYS,[str(DATA_CAP),"0","1"]))
    PHASE_CONTEXT={"runid":cfg["runid"],"attempt":cfg["attempt"],"head":cfg["target"],"unit":unit,"inner":cfg["inner"]}
    phase("root_entry","STARTED")
    assert read_small(root/(stage+".permit")).decode()==cfg["epoch"] and not (root/"abort.json").exists()
    assert limits(PARENT)["memory.max"]==str(ORDINARY) and limits(PARENT)["memory.swap.max"]=="0"
    assert limits(PROJECT)["memory.max"]==str(PROJECT_CAP) and limits(PROJECT)["memory.swap.max"]=="0"
    fixed_write(PARENT/"memory.oom.group","1");fixed_write(PROJECT/"memory.oom.group","1")
    assert limits(PARENT)==dict(zip(KEYS,[str(ORDINARY),"0","1"]))
    assert limits(PROJECT)==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"]))
    phase("root_entry","FINISHED")
    phase("pid1_snapshot","STARTED")
    fixed_pid1_metadata_snapshot(cfg,root,unit)
    phase("pid1_snapshot","FINISHED")
    fixed_write(Path("/proc/self/oom_score_adj"),"0")
    assert read_small(root/(stage+".permit")).decode()==cfg["epoch"] and not (root/"abort.json").exists()
    phase("drop","STARTED")
    os.setgroups([]);os.setresgid(cfg["gid"],cfg["gid"],cfg["gid"]);os.setresuid(cfg["uid"],cfg["uid"],cfg["uid"])
    assert os.getresuid()==(cfg["uid"],)*3 and os.getresgid()==(cfg["gid"],)*3 and os.getgroups()==[]
    assert Path("/proc/self/oom_score_adj").read_text().strip()=="0"
    assert limits(cg)==dict(zip(KEYS,[str(DATA_CAP),"0","1"]))
    assert limits(PARENT)==dict(zip(KEYS,[str(ORDINARY),"0","1"])) and limits(PROJECT)==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"]))
    remaining(cfg["inner"])
    phase("drop","FINISHED")
    collect(cfg,unit)

def trusted_tool(path):
    value=Path(path);actual=value.resolve(strict=True)
    item=actual.stat()
    assert stat.S_ISREG(item.st_mode) and item.st_uid==0 and stat.S_IMODE(item.st_mode)&0o022==0
    assert stat.S_IMODE(item.st_mode)&0o111
    return str(value)

def bounded_query(argv,deadline):
    import selectors,hashlib
    label=command_phase(argv);phase(label,"STARTED")
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
                    part=os.read(key.fileobj.fileno(),min(4096,caps[key.data]+1-len(output[key.data])))
                    if not part:selector.unregister(key.fileobj);continue
                    if len(output[key.data])+len(part)>caps[key.data]:raise ValueError("metadata output cap")
                    output[key.data].extend(part)
            code=process.wait(timeout=remaining(stop))
        except BaseException as error:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            try:process.wait(timeout=min(0.1,max(0.001,deadline-now())))
            except subprocess.TimeoutExpired:pass
            phase(label,"UNKNOWN")
            return {"status":"UNKNOWN_"+type(error).__name__,"argv":argv,"complete":False}
        finally:
            selector.close();process.stdout.close();process.stderr.close()
        result={"status":"CAPTURED" if code==0 else "UNKNOWN_EXIT","argv":argv,"exit":code,"complete":True}
        for key in ("stdout","stderr"):
            raw=output.pop(key)
            result[key+"_bytes"]=len(raw);result[key+"_sha256"]=hashlib.sha256(raw).hexdigest()
            result[key]=raw.decode("utf-8","strict")
        del raw,output
        phase(label,"FINISHED" if code==0 else "UNKNOWN")
        return result
    except BaseException as error:
        phase(label,"UNKNOWN")
        return {"status":"UNKNOWN_"+type(error).__name__,"argv":argv,"complete":False}

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

def collect(cfg,unit):
    import hashlib
    phase("collector_entry","STARTED")
    uid,gid=cfg["uid"],cfg["gid"]
    started,inner,outer=cfg["started"],cfg["inner"],cfg["outer"]
    runid,attempt,target=cfg["runid"],cfg["attempt"],cfg["target"]
    assert inner==started+270 and outer==started+300 and now()<inner
    assert os.getresuid()==(uid,)*3 and os.getresgid()==(gid,)*3 and os.getgroups()==[] and uid>0 and gid>0
    assert Path("/proc/self/oom_score_adj").read_text().strip()=="0"
    assert Path("/proc/self/cgroup").read_text().strip()=="0::/"+str((PARENT/unit).relative_to(Path("/sys/fs/cgroup")))
    expected=dict(zip(KEYS,[str(DATA_CAP),"0","1"]))
    assert limits(PARENT/unit)==expected and limits(PARENT)==dict(zip(KEYS,[str(ORDINARY),"0","1"]))
    assert limits(PROJECT)==dict(zip(KEYS,[str(PROJECT_CAP),"0","1"]))
    assert runid.isdecimal() and attempt.isdecimal() and len(target)==40 and all(c in "0123456789abcdef" for c in target)
    phase("collector_entry","FINISHED")
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
    phase("report","STARTED")
    raw=(json.dumps(report,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()
    assert len(raw)<=32768,"complete version report over cap; never truncate to pass"
    print("PLATFORM_VERSION_METADATA_REPORT "+raw.decode().rstrip("\n"),flush=True)
    print("PLATFORM_VERSION_METADATA_IDENTITY "+json.dumps({"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest(),
        "complete":True,"run_id":runid,"attempt":attempt,"not_resource_restoration_proof":True}),flush=True)
    phase("report","FINISHED")



if __name__=="__main__":
    assert sys.argv[1]=="wrapper" and len(sys.argv)==4
    try:wrapper()
    except BaseException:
        if PHASE_CONTEXT is not None:phase(PHASE_ACTIVE,"UNKNOWN")
        raise
