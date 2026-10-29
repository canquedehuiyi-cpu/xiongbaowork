import os, sys, time
from pathlib import Path

PARENT = Path("/sys/fs/cgroup/xiongbaowork.slice")
KEYS = ("memory.max", "memory.swap.max", "memory.oom.group")
PARENT_EXPECTED = dict(zip(KEYS, ("536870912", "0", "1")))
DATA_EXPECTED = dict(zip(KEYS, ("67108864", "0", "1")))
PLAN_SHA = "4230852838939b42b64829e03659070eb147d9c939fdce324cc78a5754e3a8cf"
PLAN_PATH = "archives/recovery-20261028/A11-OFFLINE-DATA-PLAN-20261030.json"
EXPECTED = {
 "generated/0081_full50_approval_seed_diagnostic.sql": (155827, "a6f52a08d9b612493189a0dab215ab70cb6f43efc184249cb167b20976ce7cf7",14698,"39a220285bb6ea5e45a63dfce47e4d57b07092ff70b690a007e315d076243ec9"),
 "generated/meta/0081_snapshot.json": (633425,"dedfd90e57638dbaf00a35c81712490f4972843d2598637ef3228f375aea68d1",36005,"24b0ff8d7289394c045461c9b79bf5343ed792dd75590b29db77de4375e05397"),
 "generated/meta/_journal.json": (12118,"9737cfc237ef6c0640946a4a81396be45d6784142bad3f36b5a3ce330041abf0",2116,"bad92853250fff038e0f8e09a8c0c5aaac7cf799ffdf009c2a482cbf920c4dcc"),
 "diagnostic/generator.log": (7289,"1b763a1a1d305b7330963d9fd90371618ba0c19649d8db236ac99f8074eed550",1863,"6678619710cc821bc2ce97484cec3f9f4ef42ae5e382c40d50cf1d0b597ad11f")
}
def limits(path):
    return {k:(path/k).read_text().strip() for k in KEYS}
def fixed(path, value):
    fd=os.open(path,os.O_WRONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        raw=value.encode();assert os.write(fd,raw)==len(raw)
    finally:os.close(fd)
def populated(path):
    if not path.exists():return None
    return dict(l.split() for l in (path/"cgroup.events").read_text().splitlines())["populated"]
def emit(prefix,value):
    import json
    raw=json.dumps(value,sort_keys=True,separators=(",",":"))
    assert len(raw)<12000
    print(prefix+" "+raw,flush=True)
def own_gate(unit):
    assert os.geteuid()!=0
    assert Path("/proc/self/cgroup").read_text().strip()=="0::/xiongbaowork.slice/"+unit
    assert limits(PARENT/unit)==DATA_EXPECTED and limits(PARENT)==PARENT_EXPECTED
    assert Path("/proc/self/oom_score_adj").read_text().strip()=="0"
    assert os.getgroups()==[] and len(set(os.getresuid()))==1 and len(set(os.getresgid()))==1
def data(unit,target):
    own_gate(unit)
    import base64, binascii, hashlib, json, math, re, struct, urllib.error, urllib.request, zlib
    assert len(target)==40 and all(c in "0123456789abcdef" for c in target)
    # No authentication, project checkout, SDK, packages, SQL or Subject execution.
    url="https://raw.githubusercontent.com/canquedehuiyi-cpu/xiongbaowork/"+target+"/"+PLAN_PATH
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args):return None
    opener=urllib.request.build_opener(NoRedirect)
    with opener.open(urllib.request.Request(url,headers={"User-Agent":"A11-offline-DATA-verifier"}),timeout=20) as response:
        assert response.status==200 and response.geturl()==url
        raw_plan=response.read(100001)
        assert len(raw_plan)<=100000 and response.read(1)==b""
    assert hashlib.sha256(raw_plan).hexdigest()==PLAN_SHA
    def duplicate_free(pairs):
        result={}
        for key,value in pairs:
            assert key not in result,"duplicate JSON key"
            result[key]=value
        return result
    def reject_constant(value):raise ValueError("nonfinite JSON constant")
    def bounded_int(value):
        assert len(value)<=100
        return int(value)
    def bounded_float(value):
        assert len(value)<=100
        number=float(value);assert math.isfinite(number)
        return number
    def safe_json(raw,cap):
        assert len(raw)<=cap
        text=raw.decode("utf-8","strict")
        assert text.encode("utf-8")==raw and not text.startswith("\ufeff")
        depth=0;quoted=False;escaped=False
        for char in text:
            if quoted:
                if escaped:escaped=False
                elif char=="\\":escaped=True
                elif char=='"':quoted=False
            elif char=='"':quoted=True
            elif char in "[{":
                depth+=1;assert depth<=64
            elif char in "]}":
                depth-=1;assert depth>=0
        assert not quoted and depth==0
        value=json.loads(text,object_pairs_hook=duplicate_free,parse_constant=reject_constant,
                         parse_int=bounded_int,parse_float=bounded_float)
        stack=[(value,0)];nodes=0
        while stack:
            item,level=stack.pop();nodes+=1
            assert nodes<=200000 and level<=64
            if isinstance(item,dict):
                assert len(item)<=30000
                for key,v in item.items():
                    assert isinstance(key,str) and len(key)<=4096
                    assert all(not 0xD800<=ord(c)<=0xDFFF for c in key)
                    stack.append((v,level+1))
            elif isinstance(item,list):
                assert len(item)<=30000
                stack.extend((v,level+1) for v in item)
            elif isinstance(item,str):
                assert len(item)<=700000 and all(not 0xD800<=ord(c)<=0xDFFF for c in item)
            else:assert item is None or isinstance(item,(bool,int,float))
        return value,nodes
    plan,_=safe_json(raw_plan,100000)
    assert plan["origin"]["run"]==40902334215 and plan["origin"]["job"]==123547693853
    assert len(plan["files"])==4
    # Root-authorized safer path: never persist compressed/raw exports in repo.
    # Only documented endpoint for one fixed same-repository job is accessed.
    token=os.environ.pop("A11_READ_TOKEN")
    assert len(token)>0 and len(token)<4096 and "\n" not in token and "\r" not in token
    api="https://api.github.com/repos/canquedehuiyi-cpu/xiongbaowork/actions/jobs/123547693853/logs"
    request=urllib.request.Request(api,headers={"Accept":"application/vnd.github+json",
        "X-GitHub-Api-Version":"2022-11-28","Authorization":"Bearer "+token,
        "User-Agent":"A11-offline-DATA-verifier"})
    try:
        response=opener.open(request,timeout=20)
    except urllib.error.HTTPError as exc:
        assert exc.code==302
        location=exc.headers.get("Location");assert isinstance(location,str) and len(location)<=16384
        from urllib.parse import urlsplit
        destination=urlsplit(location)
        assert destination.scheme=="https" and destination.port in (None,443)
        assert destination.username is None and destination.password is None and not destination.fragment
        host=destination.hostname
        assert host is not None and (host.endswith(".blob.core.windows.net") or host.endswith(".githubusercontent.com"))
        # Signed redirect is received from authenticated TLS GitHub API, never guessed.
        # Authorization is deliberately absent on this new storage request.
        response=opener.open(urllib.request.Request(location,headers={"User-Agent":"A11-offline-DATA-verifier"}),timeout=20)
    del token,request
    with response:
        assert response.status==200
        lograw=response.read(1048577)
        assert len(lograw)<=1048576 and response.read(1)==b""
    logtext=lograw.decode("utf-8","strict")
    records=[]
    for line in logtext.splitlines():
        matched=re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z GENERATED_DATA_(HEADER|CHUNK|END) (\{.*\})",line)
        if matched:
            item,_=safe_json(matched[2].encode(),60000)
            records.append((matched[1],item))
    assert [kind for kind,_ in records].count("HEADER")==4
    assert [kind for kind,_ in records].count("CHUNK")==5
    assert [kind for kind,_ in records].count("END")==4
    fixed_headers={item["header"]["path"]:item for item in plan["files"]}
    assert set(fixed_headers)==set(EXPECTED)
    exports=[];active=None
    for kind,item in records:
        if kind=="HEADER":
            assert active is None and item["path"] in fixed_headers
            assert item==fixed_headers[item["path"]]["header"]
            active={"header":item,"chunks":[]}
        elif kind=="CHUNK":
            assert active is not None and item["path"]==active["header"]["path"]
            assert item["index"]==len(active["chunks"])
            assert isinstance(item["base64"],str) and len(item["base64"])<=32000
            active["chunks"].append(item["base64"])
        else:
            assert active is not None and item==fixed_headers[active["header"]["path"]]["end"]
            assert item["chunks"]==len(active["chunks"])
            exports.append({"header":active["header"],"end":item,"base64":"".join(active["chunks"])})
            active=None
    assert active is None and len(exports)==4
    del records,logtext,lograw,raw_plan,plan
    seen=set();results=[]
    for item in exports:
        h=item["header"];path=h["path"];assert path in EXPECTED and path not in seen
        seen.add(path);expected_size,expected_sha,gzsize,gzsha=EXPECTED[path]
        assert h["exported_bytes"]==h["original_identity"]["bytes"]==expected_size
        assert h["exported_sha256"]==h["original_identity"]["sha256"]==expected_sha
        assert h["gzip_bytes"]==gzsize and h["gzip_sha256"]==gzsha
        assert h["complete_file"] is True and h["adopted"] is False
        end=item["end"];assert end["path"]==path and end["exported_bytes"]==expected_size and end["complete_file"] is True
        encoded=item["base64"];assert isinstance(encoded,str) and len(encoded)<=50000
        compressed=base64.b64decode(encoded,validate=True)
        assert base64.b64encode(compressed).decode("ascii")==encoded
        assert len(compressed)==gzsize and hashlib.sha256(compressed).hexdigest()==gzsha
        assert compressed[:3]==b"\x1f\x8b\x08" and compressed[3]&0xe0==0
        flags=compressed[3];offset=10
        assert len(compressed)>=18
        if flags&4:
            assert offset+2<=len(compressed)-8
            extra=struct.unpack_from("<H",compressed,offset)[0];offset+=2+extra
            assert offset<=len(compressed)-8
        for bit in (8,16):
            if flags&bit:
                terminator=compressed.find(b"\0",offset,len(compressed)-8)
                assert terminator>=offset and terminator-offset<=4096
                offset=terminator+1
        if flags&2:
            assert offset+2<=len(compressed)-8
            assert struct.unpack_from("<H",compressed,offset)[0]==(binascii.crc32(compressed[:offset])&0xffff)
            offset+=2
        assert offset<len(compressed)-8
        decoder=zlib.decompressobj(-zlib.MAX_WBITS)
        raw=decoder.decompress(compressed[offset:-8],expected_size+1)
        assert decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
        assert len(raw)==expected_size,"wrong size or output cap exceeded"
        crc,isize=struct.unpack("<II",compressed[-8:])
        actual_crc=binascii.crc32(raw)&0xffffffff
        assert crc==actual_crc and isize==expected_size
        actual_sha=hashlib.sha256(raw).hexdigest();assert actual_sha==expected_sha
        summary={"path":path,"gzip_bytes":len(compressed),"gzip_sha256":gzsha,
                 "raw_bytes":len(raw),"raw_sha256":actual_sha,"crc32":format(actual_crc,"08x"),
                 "single_member":True,"trailing_bytes":0,"raw_saved_or_executed":False}
        if path.endswith(".json"):
            value,nodes=safe_json(raw,700000)
            assert isinstance(value,dict)
            summary["json"]={"status":"SAFE_STRUCTURE_VALIDATED","nodes":nodes,
                             "top_level_keys":sorted(value.keys()),"duplicate_keys":False,
                             "nonfinite":False,"depth_cap":64,"node_cap":200000}
            if path.endswith("_journal.json"):
                assert isinstance(value.get("entries"),list) and len(value["entries"])<=10000
                summary["json"]["entries"]=len(value["entries"])
            del value
        else:summary["json"]="NOT_APPLICABLE_BYTES_ONLY_NO_SQL_OR_LOG_EXECUTION"
        emit("A11_DATA_FILE_VERIFIED",summary);results.append(summary)
        del raw,compressed,decoder
    assert seen==set(EXPECTED)
    own_gate(unit)
    emit("A11_DATA_VALIDATION_RESULT",{"status":"FOUR_ORIGINAL_EXPORTS_BYTE_VERIFIED",
         "files":len(results),"origin_run":40902334215,"origin_job":123547693853,
         "resource_gate":DATA_EXPECTED,"source_adopted":False,"PG":"PG_PENDING",
         "migration_semantics":"NOT_REVIEWED","raw_output_files":0})
def admin(base,target,runid,attempt,uid,gid):
    import json, math, signal, stat, subprocess
    assert os.geteuid()==0 and uid>0 and gid>0
    credential=os.environ.pop("A11_READ_TOKEN")
    assert 0<len(credential)<4096 and "\n" not in credential and "\r" not in credential
    assert runid.isdecimal() and attempt.isdecimal()
    base=Path(base);assert base.is_absolute()
    unit="xb-a11-data-"+runid+"-"+attempt+".service"
    root=Path("/run")/("xb-a11-data-"+runid+"-"+attempt)
    root.mkdir(mode=0o755)
    started=time.monotonic();inner=started+120;outer=started+150
    def command(args,deadline):
        left=deadline-time.monotonic();assert left>0
        return subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
               timeout=left,env={"PATH":"/usr/bin:/bin","LC_ALL":"C"},check=False)
    def restore():
        for k,v in PARENT_EXPECTED.items():fixed(PARENT/k,v)
        assert limits(PARENT)==PARENT_EXPECTED
    def record(value):
        encoded=(json.dumps(value,sort_keys=True)+"\n").encode();assert len(encoded)<12000
        fd=os.open(root/"terminal.json",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,"wb") as out:out.write(encoded)
    proc=None;code=None;cleanup=False;error=None
    try:
        unitfile=Path("/run/systemd/system/xiongbaowork.slice")
        fd=os.open(unitfile,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
        with os.fdopen(fd,"w") as out:out.write("[Unit]\nDescription=Project ordinary aggregate\n[Slice]\nMemoryMax=512M\nMemorySwapMax=0\n")
        assert command(["systemctl","daemon-reload"],inner).returncode==0
        assert command(["systemctl","start","xiongbaowork.slice"],inner).returncode==0
        restore()
        emit("A11_DATA_PARENT_INITIAL",{"limits":limits(PARENT),"populated":populated(PARENT)})
        # As in actually-run A11: OOMPolicy=kill creates child's group policy.
        # The root activation gate repairs the parent and checks actual kernel files.
        wrapper=r"""
import os,sys,time
from pathlib import Path
controller,unit,uid,gid,target,deadline=sys.argv[1:]
uid=int(uid);gid=int(gid);deadline=float(deadline)
assert os.geteuid()==0 and uid>0 and gid>0 and time.monotonic()<deadline
parent=Path('/sys/fs/cgroup/xiongbaowork.slice')
assert Path('/proc/self/cgroup').read_text().strip()=='0::/xiongbaowork.slice/'+unit
cg=parent/unit;keys=('memory.max','memory.swap.max','memory.oom.group')
def observed(p):return {k:(p/k).read_text().strip() for k in keys}
assert observed(cg)==dict(zip(keys,('67108864','0','1')))
(parent/'memory.oom.group').write_text('1')
assert observed(parent)==dict(zip(keys,('536870912','0','1')))
Path('/proc/self/oom_score_adj').write_text('0')
os.setgroups([]);os.setresgid(gid,gid,gid);os.setresuid(uid,uid,uid)
assert os.getresuid()==(uid,uid,uid) and os.getresgid()==(gid,gid,gid) and os.getgroups()==[]
assert Path('/proc/self/oom_score_adj').read_text().strip()=='0'
assert observed(cg)==dict(zip(keys,('67108864','0','1'))) and observed(parent)==dict(zip(keys,('536870912','0','1')))
assert time.monotonic()<deadline
credential=os.environ.pop('A11_READ_TOKEN')
os.execve('/usr/bin/python3',['/usr/bin/python3','-I','-B',controller,'data',unit,target],{'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1','A11_READ_TOKEN':credential})
"""
        args=["systemd-run","--wait","--pipe","--unit="+unit,"--slice=xiongbaowork.slice",
              "--setenv=A11_READ_TOKEN","--property=Type=exec","--property=MemoryMax=67108864","--property=MemorySwapMax=0",
              "--property=OOMPolicy=kill","--property=KillMode=control-group",
              "--property=RuntimeMaxSec="+str(max(1,math.floor(inner-time.monotonic()-2))),
              "--property=TimeoutStartSec=1","--property=TimeoutStopSec=1",
              "--property=SendSIGKILL=yes","--property=KillSignal=SIGKILL","--property=FinalKillSignal=SIGKILL",
              "/usr/bin/python3","-I","-B","-c",wrapper,str(Path(__file__)),unit,str(uid),str(gid),target,str(inner)]
        proc=subprocess.Popen(args,stdin=subprocess.DEVNULL,env={"PATH":"/usr/bin:/bin","LC_ALL":"C","A11_READ_TOKEN":credential})
        del credential
        try:code=proc.wait(timeout=max(0.01,inner-time.monotonic()))
        except subprocess.TimeoutExpired:code=124
    except BaseException as exc:
        error=type(exc).__name__+":"+str(exc)[:500]
    finally:
        cg=PARENT/unit
        try:
            if cg.exists():fixed(cg/"cgroup.kill","1")
            stopped=command(["systemctl","stop",unit],outer-3)
            shown=command(["systemctl","show",unit,"--property=ActiveState","--property=LoadState","--property=Job"],outer-2)
            assert stopped.returncode in (0,5) and shown.returncode in (0,1)
            assert len(shown.stdout)<8192
            props=dict(l.split("=",1) for l in shown.stdout.decode().splitlines() if "=" in l)
            assert props.get("ActiveState") in ("inactive","failed")
            assert props.get("LoadState") in ("loaded","not-found") and props.get("Job") in ("","0")
            assert "Job" in props
            if stopped.returncode or shown.returncode:assert props["LoadState"]=="not-found" and not cg.exists()
            assert populated(cg) in ("0",None)
            if proc is not None and proc.poll() is None:
                proc.kill();proc.wait(timeout=max(0.01,outer-time.monotonic()-2))
            restore()
            assert populated(PARENT)=="0" and time.monotonic()<outer
            cleanup=True
            terminal={"status":"DATA_VERIFIED" if code==0 and error is None else "FAILED_OR_UNKNOWN",
                      "data_exit":code,"error":error,"restore_proven":True,
                      "subject_populated":populated(cg),"parent_populated":populated(PARENT),
                      "limits":limits(PARENT),"unit_state":props,
                      "elapsed":time.monotonic()-started,"absolute_seconds":150,
                      "source_adopted":False,"origin_run":40902334215,"origin_job":123547693853}
            record(terminal);emit("A11_DATA_PRIVILEGED_TERMINAL",terminal)
        except BaseException as exc:
            emit("A11_DATA_PRIVILEGED_UNKNOWN",{"restore_proven":False,"error":type(exc).__name__,
                 "data_exit":code,"source_adopted":False})
    if not cleanup or code!=0 or error is not None:raise SystemExit(1)
def witness(runid,attempt):
    import json, stat
    root=Path("/run")/("xb-a11-data-"+runid+"-"+attempt);p=root/"terminal.json"
    assert os.geteuid()==0
    fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        st=os.fstat(fd);assert stat.S_ISREG(st.st_mode) and st.st_uid==0 and st.st_nlink==1 and st.st_size<12000
        raw=os.read(fd,12000)
    finally:os.close(fd)
    value=json.loads(raw)
    unit="xb-a11-data-"+runid+"-"+attempt+".service"
    assert limits(PARENT)==PARENT_EXPECTED and populated(PARENT)=="0" and populated(PARENT/unit) in ("0",None)
    assert value["restore_proven"] is True
    emit("A11_DATA_ALWAYS_INDEPENDENT",{"terminal":value,"actual_parent":limits(PARENT),
         "actual_parent_populated":populated(PARENT),"actual_child_populated":populated(PARENT/unit),
         "read_only_no_new_cleanup":True})
    if value["status"]!="DATA_VERIFIED":raise SystemExit(1)
if __name__=="__main__":
    mode=sys.argv[1]
    if mode=="data":data(sys.argv[2],sys.argv[3])
    elif mode=="admin":admin(sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5],int(sys.argv[6]),int(sys.argv[7]))
    elif mode=="witness":witness(sys.argv[2],sys.argv[3])
    else:raise ValueError("unknown mode")
