# Flow structure candidate and activation contract

Status: **STRUCTURE_CANDIDATE / ACTIVATION_BLOCKED / PG_PENDING**.

This is a design contract, not an implemented classifier, lock, runtime gate,
Root release, or database receipt. This package does not execute SQL or connect
the recovery overlay to a migrator. No Flow writer or execution authority is
activated by this document or by the new schema fields.

## Exact structural target

- `tasks.trigger_source`: nullable text, no default.
- `waker_flows.definition_mode`: text, NOT NULL, default `'json-plan-v1'`.
- `waker_flows.active_source_version_id`: nullable UUID, no default and no FK.
- The historical `waker_flows_definition_mode_check` is preserved exactly:
  JSON mode requires a NULL active source; JS mode requires a non-NULL active
  source and NULL plan, group and template. No third mode is introduced.
- `audit_events_subject_time_idx`: non-unique, non-concurrent btree, no WHERE;
  subject tenant ASC, created time DESC, id DESC, each explicitly NULLS LAST.

Adding a default makes existing rows read as `json-plan-v1`. The absence of an
UPDATE statement, or the absence of a physical table rewrite, does **not** mean
that old rows were not assigned a definition meaning. Passing the target CHECK
proves only its limited column relationship; it does not prove a valid or
previously authorized Flow. This package neither classifies nor activates old
rows. It does not erase old plan/group/template values or fabricate UUIDs.

## Trusted read-only classification required before nonempty upgrade

A future implementation must inventory and classify **every** existing Flow,
including drafts, deleted rows and rows with NULL fields. It must not evaluate
or execute JSON plans or historical JS to classify them. No sampling, count-only
receipt, updated-at watermark, caller-selected subset or unexplained omission
is sufficient. Zero rows must also be a trusted, locked database observation,
not an assumed empty environment.

The complete evidence must be bound by a Root-trusted release authority to:

1. The actual target database identity, deployment identity and trusted lineage
   prefix, including exact migration identities and the real current catalog.
   A caller's database label, OID alone, or self-consistent hash pair is not
   authority. The trusted catalog/lineage comparison must precede DDL.
2. The reviewed candidate source, exact SQL/snapshot/bundle hashes and a
   versioned classifier implementation and rules hash. Canonicalization rules
   must preserve SQL NULL, absent versus present definition fields and unknown
   JSON fields; silent lossy numeric conversion or selected-field hashing is
   insufficient. This document does not define an approved classifier hash.
3. A complete row manifest, with every id, tenant, revision, all relevant old
   fields and their definition digest, classification, reasons, and all
   referenced definition/resource identities and authority evidence. The row
   key set and exact relevant values matter, not merely row count or timestamps.
4. The resolved source-version/body/content identity, owner and tenant where
   applicable, plus the actual plan/agent/group/template/model and execution
   authority inputs required by the approved rules. Unknown, illegal,
   inconsistent, missing or unverifiable authority must be refused.

A nonempty/object JSON plan, successful Zod shape validation, a positive
revision or a DTO labelled ready is not sufficient evidence of execution
legality. The old table has no owner_user_id; do not infer an owner from actor,
session, or an unverified tenant-to-user convention. A JS UUID without an FK
proves neither source-version existence nor owner/tenant authorization.

The classifier must prove that this **exact** migration preserves each row's
authorized definition semantics. All old rows receive the JSON-mode default
and a NULL active source under this SQL. A row that would require a JS binding
or any other non-default transition cannot be silently mapped by this package,
even if an external source claims to recognize it; it requires a separate
reviewed transition. No backfill or owner inference is authorized here.

## Lock, full recheck, then exact DDL

Read-only classification taken earlier is not permission to execute later.
Before the first exact DDL statement, a future migration executor must:

1. Authenticate the Root-trusted release/bundle and classifier receipt, acquire
   the trusted single-migration-writer lock, and establish a fence that blocks
   all Flow writes **and** new Flow admission/dispatch across every relevant
   process. Advisory locking alone cannot stop a non-cooperating writer.
2. Drain or prove the safe disposition of already admitted execution and obtain
   actual database locks/fences sufficient for the affected row set and any
   authority inputs whose changes could invalidate classification. A table lock
   alone does not stop already-running external Flow actions. Lock coverage and
   application cooperation must be implemented and verified, not assumed.
3. Under those retained locks/fences, reread the actual database identity,
   lineage/catalog and complete row set, revalidate the exact candidate and
   classifier authority, and compare/reclassify every row and referenced input.
   Newly arrived, missing, changed, unknown or illegal rows, changed rules or
   references, missing evidence and any catalog/lineage drift must reject the
   upgrade **before DDL**. Same count or unchanged updated_at cannot excuse a
   changed id, tenant, revision, definition or authority fact.
4. Use a fail-closed rejection predicate: a classification predicate that is
   `IS NOT TRUE` is refused, covering SQL FALSE and SQL NULL. `NOT predicate`
   alone can omit NULL cases. This rule is for classification/refusal logic;
   it does not replace or tighten the exact historical target CHECK.
5. Keep the locks/fences through the approved atomic DDL and verification
   transaction, and permit no intermediate execution. On failure, roll back the
   DDL while keeping admission blocked until the actual state is reconciled.
   Durable already-admitted/unknown work must not be erased to fake rollback.

The exact lock protocol, full read-only classifier and receipt verification,
real pre-DDL refusal and atomic recovery are **NOT IMPLEMENTED by this
package**. No actual database has been classified or upgraded here.

## Runtime activation is a separate mandatory gate

There is no real activation/refusal runtime gate implemented by this package.
Before any Root release enabling this upgrade or Flow execution, the reviewed
runtime must reject unsupported, NULL, unknown, illegal, missing or stale
binding/authority at every real admission/execution entry. A schema default,
CHECK, passing CPU test, signed-looking caller JSON or this document cannot
substitute for that gate. The classifier and actual refusal gate must exist,
be reviewed, be bound to the release and be genuinely verified before release.
Current classifier/lock/runtime-gate implementation and PG enforcement remain
missing; activation and Root release remain blocked.

If classification cannot be completed but an intermediate storage state is
needed, Root must separately authorize a **nullable, no-default** migration,
its own new snapshot/lineage and a real entry gate that rejects NULL before
execution. This package is the final exact NN/default structural candidate;
it does not smuggle that intermediate state in, add `legacy_unknown`, loosen
the CHECK, clear old definitions or synthesize source-version identifiers.

## Required later evidence

Actual PG tests must cover nonempty upgrade and NULL three-valued negatives,
unknown/illegal rows, same-count row replacement, changed revisions/definitions,
new or missing rows and changed references between inventory and lock; worker
admission/write races and already-admitted work; owner/tenant and source-version
negative controls; exact lineage/catalog rejection before any DDL; and atomic
DDL failure/rollback while execution remains fenced. No such PG or runtime
proof is claimed by the structural CPU tests in this package.
