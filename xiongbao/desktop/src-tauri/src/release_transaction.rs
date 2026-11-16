//! Bounded transaction DATA. No filesystem observations, permits or publication.
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(super) type H = [u8; 32];
pub(super) type N = [u8; 16];
type R<T> = Result<T, Error>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Error { Limit, Overflow, Truncated, Encoding, Version, Kind, Digest, Path, Identity, Sequence, State, Binding, Unsupported }
#[derive(Clone, Copy, Debug)]
pub(super) struct Limits { pub frame: usize, pub journal: usize, pub events: usize, pub plan: usize, pub path: usize, pub version: usize }
impl Limits {
    pub fn checked(self) -> R<Self> {
        let values = [(self.frame,16*1024*1024),(self.journal,64*1024*1024),(self.events,40007),(self.plan,20001),(self.path,512),(self.version,256)];
        if values.iter().any(|(n,c)| *n==0 || *n==usize::MAX || n>c) || self.frame>self.journal { return Err(Error::Limit); }
        Ok(self)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Id { pub device: u64, pub inode: u64 }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Tip { pub seq: u64, pub sha: H }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct CommitRef { pub generation: u64, pub tip: Tip }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct PreparedRef { pub generation: u64, pub digest: H }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Location { Existing(Id), Vacant { parent: Id, basename: String } }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Seed { pub prior_frame: Option<Tip>, pub prior_commit: Option<CommitRef>, pub prior_prepared: Option<PreparedRef>, pub anchor: Id, pub location: Location }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Header { pub seq: u64, pub previous_seq: u64, pub previous_sha: Option<H>, pub generation: u64, pub nonce: N, pub binding: H }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PlanItem { pub path: String, pub kind: u8, pub mode: u32, pub size: u64, pub content: Option<H>, pub source: Id }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ActualItem { pub path: String, pub kind: u8, pub source: Id, pub target: Id, pub mode: u32, pub size: u64, pub content: Option<H>, pub before: Option<u64>, pub after: Option<u64> }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Intent { pub version: String, pub prior_commit: Option<CommitRef>, pub prior_prepared: Option<PreparedRef>, pub anchor: Id, pub location: Location, pub stage: Id, pub retained: Id, pub seal: H, pub plan: Vec<PlanItem> }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Event {
    Intent(Intent), Fenced(Option<PreparedRef>), RootBound { root: Id, location: Location },
    OpIntent { index: u32, item: PlanItem, expected_absent: u8 }, OpRecorded { index: u32, item: ActualItem },
    Commit { root: Id, version: String, seal: H, count: u32, inventory: H },
    Ready { commit: Tip, root: Id, seal: H, count: u32, inventory: H, prepared: H },
}
impl Event { fn kind(&self)->u8 { match self { Self::Intent(_)=>1,Self::Fenced(_)=>2,Self::RootBound{..}=>3,Self::OpIntent{..}=>4,Self::OpRecorded{..}=>5,Self::Commit{..}=>6,Self::Ready{..}=>7 } } }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Record { pub header: Header, pub event: Event }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Frame { pub record: Record, pub sha: H }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Phase { Empty, IntentFixed, FencedRecorded, RootBoundRecorded, Publishing, ReleaseCommittedNotPrepared, ReadyRecordDecoded }
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Replay { pub phase: Phase, pub pending: Option<u32>, pub tip: Option<Tip>, pub commit: Option<CommitRef>, pub prepared: Option<PreparedRef> }

fn hash(domain: &str, bytes: &[u8])->H { let mut h=Sha256::new(); h.update(domain.as_bytes()); h.update([0]); h.update(bytes); h.finalize().into() }
fn add(a:usize,b:usize)->R<usize> { a.checked_add(b).ok_or(Error::Overflow) }
fn count(n:usize)->R<u32> { u32::try_from(n).map_err(|_|Error::Overflow) }
fn portable(s:&str, cap:usize)->R<()> {
    if s.is_empty() || s.len()>cap || !s.is_ascii() || s.ends_with('/') || s.bytes().any(|b|b<32||b==127||matches!(b,b'\\'|b':'|b'<'|b'>'|b'"'|b'|'|b'?'|b'*')) { return Err(Error::Path); }
    for c in s.split('/') {
        if c.is_empty()||c=="."||c==".."||c.ends_with(' ')||c.ends_with('.') { return Err(Error::Path); }
        let stem=c.split('.').next().ok_or(Error::Path)?.trim_end_matches(' ').to_ascii_uppercase();
        if matches!(stem.as_str(),"CON"|"PRN"|"AUX"|"NUL"|"CLOCK$"|"CONIN$"|"CONOUT$") || (stem.len()==4 && (stem.starts_with("COM")||stem.starts_with("LPT")) && matches!(stem.as_bytes()[3],b'0'..=b'9')) { return Err(Error::Path); }
    }
    Ok(())
}
fn location_ok(l:&Location, limits:Limits)->R<()> { if let Location::Vacant{basename,..}=l { portable(basename,limits.path)?; if basename.contains('/') { return Err(Error::Path); } } Ok(()) }
fn item_ok(p:&PlanItem,l:Limits)->R<()> { portable(&p.path,l.path)?; if p.mode>0o777 { return Err(Error::Encoding); } match p.kind { 1 if p.content.is_some()=>Ok(()),2 if p.size==0&&p.content.is_none()=>Ok(()),_=>Err(Error::Kind) } }
fn actual_ok(p:&ActualItem,l:Limits)->R<()> { portable(&p.path,l.path)?; if p.mode>0o777 { return Err(Error::Encoding); } match p.kind {1 if p.content.is_some()&&p.before==Some(1)&&p.after==Some(2)&&p.target==p.source=>Ok(()),2 if p.size==0&&p.content.is_none()&&p.before.is_none()&&p.after.is_none()&&p.target!=p.source=>Ok(()),_=>Err(Error::Identity)} }

// First pass counts actual structures; second pass allocates only that measured size.
struct Out { bytes: Option<Vec<u8>>, len: usize, cap: usize }
impl Out {
    fn measure(cap:usize)->Self { Self{bytes:None,len:0,cap} }
    fn allocated(len:usize)->R<Self> { let mut v=Vec::new(); v.try_reserve_exact(len).map_err(|_|Error::Limit)?; Ok(Self{bytes:Some(v),len:0,cap:len}) }
    fn raw(&mut self,b:&[u8])->R<()> { self.len=add(self.len,b.len())?; if self.len>self.cap {return Err(Error::Limit)} if let Some(v)=&mut self.bytes {v.extend_from_slice(b)} Ok(()) }
    fn u8(&mut self,x:u8)->R<()> {self.raw(&[x])} fn u32(&mut self,x:u32)->R<()> {self.raw(&x.to_be_bytes())} fn u64(&mut self,x:u64)->R<()> {self.raw(&x.to_be_bytes())}
    fn text(&mut self,s:&str,cap:usize)->R<()> {if s.len()>cap {return Err(Error::Limit)} self.u32(count(s.len())?)?;self.raw(s.as_bytes())}
    fn id(&mut self,x:Id)->R<()> {self.u8(1)?;self.u64(x.device)?;self.u64(x.inode)}
    fn opt<T>(&mut self,x:&Option<T>,f:impl FnOnce(&mut Self,&T)->R<()>)->R<()> {match x {None=>self.u8(0),Some(x)=>{self.u8(1)?;f(self,x)}}}
    fn tip(&mut self,x:Tip)->R<()> {self.u64(x.seq)?;self.raw(&x.sha)}
    fn commit(&mut self,x:&Option<CommitRef>)->R<()> {self.opt(x,|w,x|{w.u64(x.generation)?;w.tip(x.tip)})}
    fn prepared(&mut self,x:&Option<PreparedRef>)->R<()> {self.opt(x,|w,x|{w.u64(x.generation)?;w.raw(&x.digest)})}
    fn location(&mut self,x:&Location,l:Limits)->R<()> {location_ok(x,l)?;match x {Location::Existing(id)=>{self.u8(1)?;self.id(*id)},Location::Vacant{parent,basename}=>{self.u8(2)?;self.id(*parent)?;self.text(basename,l.path)}}}
    fn plan(&mut self,p:&PlanItem,l:Limits)->R<()> {item_ok(p,l)?;self.text(&p.path,l.path)?;self.u8(p.kind)?;self.u32(p.mode)?;self.u64(p.size)?;self.opt(&p.content,|w,h|w.raw(h))?;self.id(p.source)}
    fn actual(&mut self,p:&ActualItem,l:Limits)->R<()> {actual_ok(p,l)?;self.text(&p.path,l.path)?;self.u8(p.kind)?;self.id(p.source)?;self.id(p.target)?;self.u32(p.mode)?;self.u64(p.size)?;self.opt(&p.content,|w,h|w.raw(h))?;self.opt(&p.before,|w,n|w.u64(*n))?;self.opt(&p.after,|w,n|w.u64(*n))}
    fn intent(&mut self,i:&Intent,l:Limits)->R<()> {version_ok(&i.version,l)?;if i.plan.is_empty()||i.plan.len()>l.plan {return Err(Error::Limit)} self.text(&i.version,l.version)?;self.commit(&i.prior_commit)?;self.prepared(&i.prior_prepared)?;self.id(i.anchor)?;self.location(&i.location,l)?;self.id(i.stage)?;self.id(i.retained)?;self.raw(&i.seal)?;self.u32(count(i.plan.len())?)?;for p in &i.plan {self.plan(p,l)?;}Ok(())}
    fn event(&mut self,e:&Event,l:Limits)->R<()> {match e {
        Event::Intent(i)=>self.intent(i,l),
        Event::Fenced(p)=>self.prepared(p),Event::RootBound{root,location}=>{self.id(*root)?;self.location(location,l)},
        Event::OpIntent{index,item,expected_absent}=>{if *expected_absent!=1{return Err(Error::Encoding)}self.u32(*index)?;self.plan(item,l)?;self.u8(*expected_absent)},
        Event::OpRecorded{index,item}=>{self.u32(*index)?;self.actual(item,l)},
        Event::Commit{root,version,seal,count,inventory}=>{version_ok(version,l)?;self.id(*root)?;self.text(version,l.version)?;self.raw(seal)?;self.u32(*count)?;self.raw(inventory)},
        Event::Ready{commit,root,seal,count,inventory,prepared}=>{self.tip(*commit)?;self.id(*root)?;self.raw(seal)?;self.u32(*count)?;self.raw(inventory)?;self.raw(prepared)},
    }}
    fn record(&mut self,r:&Record,l:Limits)->R<()> {let h=&r.header;self.u32(1)?;self.u8(r.event.kind())?;self.u64(h.seq)?;self.u64(h.previous_seq)?;self.opt(&h.previous_sha,|w,x|w.raw(x))?;self.u64(h.generation)?;self.raw(&h.nonce)?;self.raw(&h.binding)?;self.event(&r.event,l)}
    fn finish(self)->R<Vec<u8>> {self.bytes.ok_or(Error::Encoding)}
}
fn materialize(cap:usize,f:impl Fn(&mut Out)->R<()>)->R<Vec<u8>> {let mut m=Out::measure(cap);f(&mut m)?;let mut w=Out::allocated(m.len)?;f(&mut w)?;w.finish()}
fn version_ok(s:&str,l:Limits)->R<()> {if s.is_empty()||s.len()>l.version {Err(Error::Limit)}else{Ok(())}}
pub(super) fn plan_seal(plan:&[PlanItem],l:Limits)->R<H> {let l=l.checked()?;if plan.is_empty()||plan.len()>l.plan{return Err(Error::Limit)}let b=materialize(l.frame,|w|{w.u32(count(plan.len())?)?;for p in plan {w.plan(p,l)?}Ok(())})?;Ok(hash("openbot.release-plan.v1",&b))}
pub(super) fn binding(generation:u64,nonce:N,i:&Intent,l:Limits)->R<H> {let l=l.checked()?;let b=materialize(l.frame,|w|{w.u64(generation)?;w.raw(&nonce)?;w.intent(i,l)})?;Ok(hash("openbot.release-binding.v1",&b))}
pub(super) fn inventory(items:&[ActualItem],l:Limits)->R<H> {let l=l.checked()?;if items.len()>l.plan{return Err(Error::Limit)}let b=materialize(l.journal,|w|{w.u32(count(items.len())?)?;for a in items{w.actual(a,l)?}Ok(())})?;Ok(hash("openbot.release-inventory.v1",&b))}
fn prepared(h:&Header,root:Id,commit:Tip,seal:H,n:u32,inventory:H,l:Limits)->R<H> {let b=materialize(l.frame,|w|{w.u64(h.generation)?;w.raw(&h.nonce)?;w.raw(&h.binding)?;w.id(root)?;w.tip(commit)?;w.raw(&seal)?;w.u32(n)?;w.raw(&inventory)})?;Ok(hash("openbot.release-prepared-data.v1",&b))}
pub(super) fn encode_frame(r:&Record,l:Limits)->R<Vec<u8>> {let l=l.checked()?;let cap=l.frame.checked_sub(36).ok_or(Error::Limit)?;let payload=materialize(cap,|w|w.record(r,l))?;let mut out=Out::allocated(add(36,payload.len())?)?;out.u32(count(payload.len())?)?;out.raw(&payload)?;let digest=hash("openbot.release-transaction.v1",out.bytes.as_ref().ok_or(Error::Encoding)?);out.raw(&digest)?;out.finish()}

struct Input<'a>{b:&'a[u8],at:usize}
impl<'a> Input<'a> {
    fn take(&mut self,n:usize)->R<&'a[u8]>{let end=add(self.at,n)?;let s=self.b.get(self.at..end).ok_or(Error::Truncated)?;self.at=end;Ok(s)}
    fn u8(&mut self)->R<u8>{Ok(self.take(1)?[0])} fn u32(&mut self)->R<u32>{Ok(u32::from_be_bytes(self.take(4)?.try_into().map_err(|_|Error::Encoding)?))} fn u64(&mut self)->R<u64>{Ok(u64::from_be_bytes(self.take(8)?.try_into().map_err(|_|Error::Encoding)?))}
    fn h(&mut self)->R<H>{self.take(32)?.try_into().map_err(|_|Error::Encoding)} fn n(&mut self)->R<N>{self.take(16)?.try_into().map_err(|_|Error::Encoding)}
    fn opt<T>(&mut self,f:impl FnOnce(&mut Self)->R<T>)->R<Option<T>>{match self.u8()?{0=>Ok(None),1=>Ok(Some(f(self)?)),_=>Err(Error::Encoding)}}
    fn text(&mut self,cap:usize)->R<String>{let n=usize::try_from(self.u32()?).map_err(|_|Error::Overflow)?;if n>cap{return Err(Error::Limit)}let b=self.take(n)?;let s=std::str::from_utf8(b).map_err(|_|Error::Encoding)?;Ok(s.to_owned())}
    fn id(&mut self)->R<Id>{if self.u8()?!=1{return Err(Error::Identity)}Ok(Id{device:self.u64()?,inode:self.u64()?})}
    fn tip(&mut self)->R<Tip>{Ok(Tip{seq:self.u64()?,sha:self.h()?})}
    fn commit(&mut self)->R<Option<CommitRef>>{self.opt(|r|Ok(CommitRef{generation:r.u64()?,tip:r.tip()?}))}
    fn prepared(&mut self)->R<Option<PreparedRef>>{self.opt(|r|Ok(PreparedRef{generation:r.u64()?,digest:r.h()?}))}
    fn location(&mut self,l:Limits)->R<Location>{let x=match self.u8()?{1=>Location::Existing(self.id()?),2=>Location::Vacant{parent:self.id()?,basename:self.text(l.path)?},_=>return Err(Error::Encoding)};location_ok(&x,l)?;Ok(x)}
    fn plan(&mut self,l:Limits)->R<PlanItem>{let p=PlanItem{path:self.text(l.path)?,kind:self.u8()?,mode:self.u32()?,size:self.u64()?,content:self.opt(|r|r.h())?,source:self.id()?};item_ok(&p,l)?;Ok(p)}
    fn actual(&mut self,l:Limits)->R<ActualItem>{let p=ActualItem{path:self.text(l.path)?,kind:self.u8()?,source:self.id()?,target:self.id()?,mode:self.u32()?,size:self.u64()?,content:self.opt(|r|r.h())?,before:self.opt(|r|r.u64())?,after:self.opt(|r|r.u64())?};actual_ok(&p,l)?;Ok(p)}
    fn record(&mut self,l:Limits)->R<Record>{if self.u32()?!=1{return Err(Error::Version)}let kind=self.u8()?;let header=Header{seq:self.u64()?,previous_seq:self.u64()?,previous_sha:self.opt(|r|r.h())?,generation:self.u64()?,nonce:self.n()?,binding:self.h()?};let event=match kind {
        1=>{let version=self.text(l.version)?;version_ok(&version,l)?;let prior_commit=self.commit()?;let prior_prepared=self.prepared()?;let anchor=self.id()?;let location=self.location(l)?;let stage=self.id()?;let retained=self.id()?;let seal=self.h()?;let n=usize::try_from(self.u32()?).map_err(|_|Error::Overflow)?;if n==0||n>l.plan{return Err(Error::Limit)}// No reserve from declared count; each item consumes real input first.
            let mut plan=Vec::new();for _ in 0..n {let p=self.plan(l)?;plan.try_reserve(1).map_err(|_|Error::Limit)?;plan.push(p)}Event::Intent(Intent{version,prior_commit,prior_prepared,anchor,location,stage,retained,seal,plan})},
        2=>Event::Fenced(self.prepared()?),3=>Event::RootBound{root:self.id()?,location:self.location(l)?},4=>{let index=self.u32()?;let item=self.plan(l)?;let expected_absent=self.u8()?;if expected_absent!=1{return Err(Error::Encoding)}Event::OpIntent{index,item,expected_absent}},5=>Event::OpRecorded{index:self.u32()?,item:self.actual(l)?},6=>{let root=self.id()?;let version=self.text(l.version)?;version_ok(&version,l)?;Event::Commit{root,version,seal:self.h()?,count:self.u32()?,inventory:self.h()?}},7=>Event::Ready{commit:self.tip()?,root:self.id()?,seal:self.h()?,count:self.u32()?,inventory:self.h()?,prepared:self.h()?},_=>return Err(Error::Kind)};Ok(Record{header,event})}
}
pub(super) fn decode_journal(bytes:&[u8],l:Limits)->R<Vec<Frame>> {let l=l.checked()?;if bytes.len()>l.journal{return Err(Error::Limit)}let mut r=Input{b:bytes,at:0};let mut frames=Vec::new();while r.at<bytes.len(){if frames.len()>=l.events{return Err(Error::Limit)}let start=r.at;let n=usize::try_from(r.u32()?).map_err(|_|Error::Overflow)?;let whole=add(n,36)?;if whole>l.frame{return Err(Error::Limit)}let payload=r.take(n)?;let trailer=r.h()?;let end=add(start,add(4,n)?)?;if hash("openbot.release-transaction.v1",&bytes[start..end])!=trailer{return Err(Error::Digest)}let mut p=Input{b:payload,at:0};let record=p.record(l)?;if p.at!=payload.len(){return Err(Error::Encoding)}frames.try_reserve(1).map_err(|_|Error::Limit)?;frames.push(Frame{record,sha:trailer});}Ok(frames)}

fn seed_ok(s:&Seed,l:Limits)->R<()> {location_ok(&s.location,l)?;match(s.prior_frame,s.prior_commit,s.prior_prepared){(None,None,None)=>Ok(()),(Some(f),Some(c),Some(p)) if c.generation==p.generation && c.tip.seq.checked_add(1)==Some(f.seq) && matches!(s.location,Location::Existing(_))=>Ok(()),_=>Err(Error::Binding)}}
fn plan_ok(i:&Intent,l:Limits)->R<()> {
    if i.plan.is_empty()||i.plan.len()>l.plan{return Err(Error::Limit)}
    let mut prefixes=BTreeMap::<String,String>::new();let mut files=BTreeSet::new();let mut regular=BTreeSet::new();let mut directories=BTreeSet::new();let mut previous:Option<&str>=None;
    for p in &i.plan {item_ok(p,l)?;if previous.is_some_and(|x|x>=p.path.as_str()){return Err(Error::Path)}previous=Some(&p.path);if p.source.device!=i.stage.device||p.source==i.stage||p.source==i.retained{return Err(Error::Identity)}
        let mut end=0;for c in p.path.split('/') {end=if end==0{c.len()}else{add(add(end,1)?,c.len())?};let prefix=&p.path[..end];let lower=prefix.to_ascii_lowercase();if let Some(old)=prefixes.get(&lower){if old!=prefix{return Err(Error::Path)}}else{prefixes.insert(lower,prefix.to_owned());}if end<p.path.len()&&files.contains(prefix){return Err(Error::Path)}}
        if p.kind==1 {if !regular.insert(p.source)||directories.contains(&p.source){return Err(Error::Identity)}files.insert(p.path.clone());}else{if regular.contains(&p.source){return Err(Error::Identity)}directories.insert(p.source);}
    }
    if plan_seal(&i.plan,l)?!=i.seal{return Err(Error::Digest)}Ok(())
}
pub(super) fn replay(frames:&[Frame],seed:&Seed,l:Limits)->R<Replay> {
    let l=l.checked()?;seed_ok(seed,l)?;if frames.len()>l.events{return Err(Error::Limit)}
    let generation=seed.prior_commit.map_or(0,|x|x.generation).checked_add(1).ok_or(Error::Overflow)?;
    let mut previous=seed.prior_frame;let mut phase=Phase::Empty;let mut intent:Option<Intent>=None;let mut fixed:Option<(N,H)>=None;let mut root=None;let mut pending=None;let mut actual=Vec::new();let mut targets=BTreeSet::new();let mut commit=None;let mut prepared_ref=None;let mut total=0usize;
    for frame in frames {
        // Direct typed replay is not a budget bypass. Measure before encode/clone/insert.
        let mut measurement=Out::measure(l.frame.checked_sub(36).ok_or(Error::Limit)?);measurement.record(&frame.record,l)?;total=add(total,add(36,measurement.len)?)?;if total>l.journal{return Err(Error::Limit)}
        let encoded=encode_frame(&frame.record,l)?;if encoded.get(encoded.len().checked_sub(32).ok_or(Error::Encoding)?..)!=Some(frame.sha.as_slice()){return Err(Error::Digest)}
        let h=&frame.record.header;let next=previous.map_or(0,|p|p.seq).checked_add(1).ok_or(Error::Overflow)?;
        if h.seq!=next||h.previous_seq!=previous.map_or(0,|p|p.seq)||h.previous_sha!=previous.map(|p|p.sha)||h.generation!=generation{return Err(Error::Sequence)}
        if let Some((n,b))=fixed{if h.nonce!=n||h.binding!=b{return Err(Error::Binding)}}
        match &frame.record.event {
            Event::Intent(i) if phase==Phase::Empty=>{if i.prior_commit!=seed.prior_commit||i.prior_prepared!=seed.prior_prepared||i.anchor!=seed.anchor||i.location!=seed.location{return Err(Error::Binding)}plan_ok(i,l)?;if binding(generation,h.nonce,i,l)?!=h.binding{return Err(Error::Binding)}fixed=Some((h.nonce,h.binding));intent=Some(i.clone());phase=Phase::IntentFixed;},
            Event::Fenced(p) if phase==Phase::IntentFixed=>{if *p!=seed.prior_prepared{return Err(Error::Binding)}phase=Phase::FencedRecorded;},
            Event::RootBound{root:r,location} if phase==Phase::FencedRecorded=>{let i=intent.as_ref().ok_or(Error::State)?;if *location!=i.location||r.device!=i.stage.device||r.device!=i.retained.device||*r==i.stage||*r==i.retained{return Err(Error::Identity)}match location{Location::Existing(x) if x!=r=>return Err(Error::Identity),Location::Vacant{parent,..} if parent==r=>return Err(Error::Identity),_=>{}}if i.plan.iter().any(|p|p.source==*r){return Err(Error::Identity)}root=Some(*r);phase=Phase::RootBoundRecorded;},
            Event::OpIntent{index,item,expected_absent} if matches!(phase,Phase::RootBoundRecorded|Phase::Publishing)=>{let i=intent.as_ref().ok_or(Error::State)?;if pending.is_some()||usize::try_from(*index).map_err(|_|Error::Overflow)?!=actual.len()||i.plan.get(actual.len())!=Some(item)||*expected_absent!=1{return Err(Error::State)}pending=Some(*index);phase=Phase::Publishing;},
            Event::OpRecorded{index,item} if phase==Phase::Publishing=>{let i=intent.as_ref().ok_or(Error::State)?;if pending!=Some(*index)||usize::try_from(*index).map_err(|_|Error::Overflow)?!=actual.len(){return Err(Error::State)}let p=i.plan.get(actual.len()).ok_or(Error::State)?;actual_ok(item,l)?;let r=root.ok_or(Error::State)?;if item.path!=p.path||item.kind!=p.kind||item.source!=p.source||item.mode!=p.mode||item.size!=p.size||item.content!=p.content||item.target.device!=r.device||item.target==r||item.target==i.stage||item.target==i.retained||targets.contains(&item.target){return Err(Error::Identity)}// Source regular identity can be consumed at most once (plan_ok + target uniqueness).
                actual.try_reserve(1).map_err(|_|Error::Limit)?;targets.insert(item.target);actual.push(item.clone());pending=None;},
            Event::Commit{root:r,version,seal,count:n,inventory:inv} if matches!(phase,Phase::RootBoundRecorded|Phase::Publishing)=>{let i=intent.as_ref().ok_or(Error::State)?;if pending.is_some()||actual.len()!=i.plan.len()||*n!=count(actual.len())?||Some(*r)!=root||*version!=i.version||*seal!=i.seal||inventory(&actual,l)?!=*inv{return Err(Error::Binding)}commit=Some(CommitRef{generation,tip:Tip{seq:h.seq,sha:frame.sha}});phase=Phase::ReleaseCommittedNotPrepared;},
            Event::Ready{commit:c,root:r,seal,count:n,inventory:inv,prepared:p} if phase==Phase::ReleaseCommittedNotPrepared=>{let i=intent.as_ref().ok_or(Error::State)?;let committed=commit.ok_or(Error::State)?;if *c!=committed.tip||Some(*r)!=root||*seal!=i.seal||*n!=count(actual.len())?||*inv!=inventory(&actual,l)?||*p!=prepared(h,*r,*c,*seal,*n,*inv,l)?{return Err(Error::Binding)}prepared_ref=Some(PreparedRef{generation,digest:*p});phase=Phase::ReadyRecordDecoded;},
            _=>return Err(Error::State),
        }
        previous=Some(Tip{seq:h.seq,sha:frame.sha});
    }
    Ok(Replay{phase,pending,tip:previous,commit,prepared:prepared_ref})
}
/// No data journal can establish native anchor, alias, lock or consumer authority.
pub(super) fn require_native_binding()->R<()> {Err(Error::Unsupported)}
#[cfg(test)]
#[path = "release_transaction_tests.rs"]
mod tests;
