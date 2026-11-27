/**
 * The database's structure, read from the system catalogs as a sorted list of items, and the difference
 * between two such lists.
 *
 * WHAT IT IS FOR. v0.2.17 replaced the migration history (222 migrations) with one baseline. A database
 * that came up through the history is adopted only when its structure is the baseline's, item by item
 * (`./baseline-adoption`): this module is how "item by item" is decided. Read from the catalogs inside the
 * migration transaction rather than by running `pg_dump`: it needs no client binary of a matching major
 * version in the image (the Helm Job and the compose stack have none), it sees exactly the snapshot the
 * ledger rewrite commits against, and its output has none of `pg_dump`'s per-run noise to strip.
 *
 * WHAT IS COMPARED, every item a schema-only dump would carry: schemas, extensions (name and schema),
 * types (enums with their labels in order, domains with their constraints, standalone composites,
 * ranges), tables and their kind, persistence, row-level-security switches, options, partitioning and
 * inheritance, columns (position, type, NOT NULL, default, identity, generated expression, collation),
 * constraints, indexes (and whether each is valid), RLS policies (command, permissive, roles, both
 * expressions), triggers (and whether each is enabled), functions and procedures (their whole definition:
 * body, volatility, SECURITY DEFINER, SET clauses), views, sequences (parameters and owning column),
 * rules, extended statistics, event triggers, comments, every grant (table, column, sequence, function,
 * schema, type) and the default privileges.
 *
 * WHAT IS NOT, because it legitimately differs between two databases with the same structure:
 *  - who owns what, when it is the role reading: objects are created by whichever role runs the
 *    migrations, and that role's name differs between environments (a production volume renamed in
 *    v0.2.16, an operator's own owner role, CI's superuser). The reader stands for the owner, as `<owner>`
 *    wherever a grant or a policy names it; an object owned by anyone ELSE is listed, by name, because an
 *    application role owning a table would let it step around row-level security.
 *  - the owner's own privileges on its objects and the grantor of each grant (always the owner), for the
 *    same reason, and because PostgreSQL 17 adds MAINTAIN to an owner's implicit privileges.
 *  - an extension's version, its owner and its member objects (a pg_dump prints none of them either).
 *  - the migrator's bookkeeping: every relation in the `drizzle` schema (the schema and its grants are
 *    compared). Sequence positions, statistics, database-level settings and roles' attributes, which are
 *    not part of the schema.
 *  - how the ANDs and ORs of a constraint, policy, index or trigger expression are grouped, which a dump
 *    and restore changes without changing the meaning ({@link flattenBooleanNesting}).
 *
 * Names are printed as they are with an empty `search_path`, so every one is schema-qualified the same way
 * whatever the caller's path is; the path is set inside a savepoint that is rolled back afterwards.
 */
import type { TransactionSql } from "postgres";

/** One item: what kind of object, which one, and everything compared about it. */
export type StructureItem = readonly [
  kind: string,
  name: string,
  detail: string,
];

/** Schemas whose contents are never compared: the system's own, and the migrator's ledger tables. */
const EXCLUDED_SCHEMAS = `
  n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'`;

/** An object that belongs to an extension, by class and oid. */
const extensionMember = (classid: string, objid: string) => `EXISTS (
  SELECT 1 FROM pg_catalog.pg_depend xm
   WHERE xm.classid = '${classid}'::regclass AND xm.objid = ${objid} AND xm.deptype = 'e')`;

/**
 * An ACL as sorted `grantee=PRIVILEGE[*]` entries, grantor dropped. NULL means the default for that kind
 * of object, so it is expanded the way PostgreSQL itself reads it. The owner's own entries are left out
 * (see the header).
 */
const acl = (value: string, objectType: string, owner: string) => `(
  SELECT coalesce(string_agg(entry, ',' ORDER BY entry), '')
    FROM (SELECT format('%s=%s%s',
                   CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                        WHEN a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                          THEN '<owner>'
                        ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
                   a.privilege_type, CASE WHEN a.is_grantable THEN '*' ELSE '' END) AS entry
            FROM pg_catalog.aclexplode(coalesce(${value}, pg_catalog.acldefault('${objectType}', ${owner}))) a
           WHERE a.grantee <> ${owner}) entries)`;

/** A role by name, the reading role as `<owner>`. */
const roleName = (oid: string) =>
  `CASE WHEN ${oid} = 0 THEN 'PUBLIC' WHEN pg_catalog.pg_get_userbyid(${oid}) = current_user THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(${oid}) END`;

/** Each query returns rows of (kind, name, detail). */
const QUERIES: readonly string[] = [
  // Schemas.
  `SELECT 'schema', n.nspname, 'acl=' || ${acl("n.nspacl", "n", "n.nspowner")}
     FROM pg_catalog.pg_namespace n
    WHERE ${EXCLUDED_SCHEMAS} AND NOT ${extensionMember("pg_namespace", "n.oid")}`,
  // Extensions: which, and where. Not the version, not the owner.
  `SELECT 'extension', x.extname, 'schema=' || x.extnamespace::regnamespace::text
     FROM pg_catalog.pg_extension x`,
  // Relations other than indexes, composite types and the ledger's tables.
  `SELECT 'relation', c.oid::regclass::text,
          concat_ws(' ', 'kind=' || c.relkind::text, 'persistence=' || c.relpersistence::text,
            'rls=' || c.relrowsecurity, 'force_rls=' || c.relforcerowsecurity,
            'replica_identity=' || c.relreplident::text,
            'options=' || coalesce(array_to_string(c.reloptions, ','), ''),
            'partition_key=' || coalesce(pg_catalog.pg_get_partkeydef(c.oid), ''),
            'partition_of=' || coalesce((SELECT string_agg(i.inhparent::regclass::text, ',' ORDER BY i.inhseqno)
                                           FROM pg_catalog.pg_inherits i WHERE i.inhrelid = c.oid), ''),
            'partition_bound=' || coalesce(pg_catalog.pg_get_expr(c.relpartbound, c.oid), ''),
            'acl=' || ${acl("c.relacl", "r", "c.relowner")})
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${EXCLUDED_SCHEMAS} AND n.nspname <> 'drizzle' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND NOT ${extensionMember("pg_class", "c.oid")}`,
  // Views and materialized views: their query.
  `SELECT 'view', c.oid::regclass::text, pg_catalog.pg_get_viewdef(c.oid)
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${EXCLUDED_SCHEMAS} AND c.relkind IN ('v', 'm') AND NOT ${extensionMember("pg_class", "c.oid")}`,
  // Columns, by position among the live ones (dropped columns leave gaps in attnum).
  `SELECT 'column', c.oid::regclass::text || '.' || quote_ident(a.attname),
          concat_ws(' ',
            'position=' || row_number() OVER (PARTITION BY a.attrelid ORDER BY a.attnum),
            'type=' || pg_catalog.format_type(a.atttypid, a.atttypmod),
            'not_null=' || a.attnotnull,
            'default=' || coalesce(CASE WHEN a.attgenerated = '' THEN pg_catalog.pg_get_expr(d.adbin, d.adrelid) END, ''),
            'generated=' || coalesce(CASE WHEN a.attgenerated <> '' THEN a.attgenerated::text || ':' || pg_catalog.pg_get_expr(d.adbin, d.adrelid) END, ''),
            'identity=' || a.attidentity::text,
            'collation=' || coalesce(CASE WHEN a.attcollation <> t.typcollation THEN a.attcollation::regcollation::text END, ''),
            'acl=' || coalesce((SELECT string_agg(entry, ',' ORDER BY entry)
                                  FROM (SELECT format('%s=%s%s', ${roleName("x.grantee")}, x.privilege_type,
                                                 CASE WHEN x.is_grantable THEN '*' ELSE '' END) AS entry
                                          FROM pg_catalog.aclexplode(a.attacl) x) entries), ''))
     FROM pg_catalog.pg_attribute a
     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE ${EXCLUDED_SCHEMAS} AND n.nspname <> 'drizzle' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c')
      AND a.attnum > 0 AND NOT a.attisdropped
      AND NOT ${extensionMember("pg_class", "c.oid")}
      AND (c.relkind <> 'c' OR NOT ${extensionMember("pg_type", "c.reltype")})`,
  // Constraints on tables and on domains.
  `SELECT 'constraint', coalesce(k.conrelid::regclass::text, k.contypid::regtype::text) || '.' || quote_ident(k.conname),
          'type=' || k.contype::text || ' ' || pg_catalog.pg_get_constraintdef(k.oid)
     FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace n ON n.oid = k.connamespace
    WHERE ${EXCLUDED_SCHEMAS} AND n.nspname <> 'drizzle' AND NOT ${extensionMember("pg_constraint", "k.oid")}
      AND (k.contypid = 0 OR NOT ${extensionMember("pg_type", "k.contypid")})`,
  // Indexes, constraint-backed ones included.
  `SELECT 'index', c.oid::regclass::text,
          pg_catalog.pg_get_indexdef(c.oid) || ' valid=' || i.indisvalid || ' clustered=' || i.indisclustered
            || ' replica_identity=' || i.indisreplident
     FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${EXCLUDED_SCHEMAS} AND n.nspname <> 'drizzle' AND NOT ${extensionMember("pg_class", "c.oid")}`,
  // Row-level security policies.
  `SELECT 'policy', p.polrelid::regclass::text || '.' || quote_ident(p.polname),
          concat_ws(' ', 'command=' || p.polcmd::text, 'permissive=' || p.polpermissive,
            'roles=' || (SELECT string_agg(r, ',' ORDER BY r)
                           FROM (SELECT ${roleName("x")} AS r FROM unnest(p.polroles) x) roles),
            'using=' || coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), ''),
            'check=' || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), ''))
     FROM pg_catalog.pg_policy p`,
  // Triggers written by a migration (not the ones PostgreSQL makes for foreign keys).
  `SELECT 'trigger', g.tgrelid::regclass::text || '.' || quote_ident(g.tgname),
          pg_catalog.pg_get_triggerdef(g.oid) || ' enabled=' || g.tgenabled::text
     FROM pg_catalog.pg_trigger g
     JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT g.tgisinternal AND ${EXCLUDED_SCHEMAS} AND n.nspname <> 'drizzle'`,
  // Functions and procedures: the whole definition. Aggregates have none, so they are named with their
  // signature and transition function.
  `SELECT 'function', p.oid::regprocedure::text,
          CASE WHEN p.prokind = 'a'
               THEN 'aggregate ' || (SELECT a.aggtransfn::regproc::text || ' ' || pg_catalog.format_type(a.aggtranstype, NULL)
                                       FROM pg_catalog.pg_aggregate a WHERE a.aggfnoid = p.oid)
               ELSE pg_catalog.pg_get_functiondef(p.oid) END
            || E'\\nacl=' || ${acl("p.proacl", "f", "p.proowner")}
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE ${EXCLUDED_SCHEMAS} AND NOT ${extensionMember("pg_proc", "p.oid")}`,
  // Types a migration created (enum, domain, standalone composite, range), not the row types of tables
  // and not the array types PostgreSQL makes alongside each.
  `SELECT 'type', t.oid::regtype::text,
          concat_ws(' ', 'kind=' || t.typtype::text,
            'labels=' || coalesce((SELECT string_agg(quote_literal(e.enumlabel), ',' ORDER BY e.enumsortorder)
                                     FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid), ''),
            'base=' || coalesce(CASE WHEN t.typtype = 'd' THEN pg_catalog.format_type(t.typbasetype, t.typtypmod) END, ''),
            'not_null=' || t.typnotnull,
            'default=' || coalesce(t.typdefault, ''),
            'range_of=' || coalesce((SELECT r.rngsubtype::regtype::text FROM pg_catalog.pg_range r WHERE r.rngtypid = t.oid), ''),
            'acl=' || ${acl("t.typacl", "T", "t.typowner")})
     FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE ${EXCLUDED_SCHEMAS} AND n.nspname <> 'drizzle'
      AND (t.typtype IN ('e', 'd', 'r', 'm')
           OR (t.typtype = 'c' AND (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid) = 'c'))
      AND NOT ${extensionMember("pg_type", "t.oid")}`,
  // Sequences: their parameters and the column that owns each.
  `SELECT 'sequence', s.seqrelid::regclass::text,
          concat_ws(' ', 'type=' || s.seqtypid::regtype::text, 'start=' || s.seqstart, 'increment=' || s.seqincrement,
            'min=' || s.seqmin, 'max=' || s.seqmax, 'cache=' || s.seqcache, 'cycle=' || s.seqcycle,
            'owned_by=' || coalesce((SELECT d.refobjid::regclass::text || '.' || quote_ident(a.attname)
                                       FROM pg_catalog.pg_depend d
                                       JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                                      WHERE d.classid = 'pg_class'::regclass AND d.objid = s.seqrelid
                                        AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
                                      LIMIT 1), ''),
            'acl=' || ${acl("c.relacl", "s", "c.relowner")})
     FROM pg_catalog.pg_sequence s
     JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${EXCLUDED_SCHEMAS} AND n.nspname <> 'drizzle' AND NOT ${extensionMember("pg_class", "c.oid")}`,
  // Rules other than the one every view has.
  `SELECT 'rule', r.ev_class::regclass::text || '.' || quote_ident(r.rulename), pg_catalog.pg_get_ruledef(r.oid)
     FROM pg_catalog.pg_rewrite r
     JOIN pg_catalog.pg_class c ON c.oid = r.ev_class
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE r.rulename <> '_RETURN' AND ${EXCLUDED_SCHEMAS}`,
  // Extended statistics.
  `SELECT 'statistics', s.stxnamespace::regnamespace::text || '.' || quote_ident(s.stxname),
          pg_catalog.pg_get_statisticsobjdef(s.oid)
     FROM pg_catalog.pg_statistic_ext s`,
  // Event triggers.
  `SELECT 'event_trigger', quote_ident(e.evtname),
          concat_ws(' ', 'event=' || e.evtevent, 'function=' || e.evtfoid::regprocedure::text,
            'tags=' || coalesce(array_to_string(e.evttags, ','), ''), 'enabled=' || e.evtenabled::text)
     FROM pg_catalog.pg_event_trigger e
    WHERE NOT ${extensionMember("pg_event_trigger", "e.oid")}`,
  // Comments on anything a migration made.
  `SELECT 'comment', pg_catalog.pg_describe_object(d.classoid, d.objoid, d.objsubid), d.description
     FROM pg_catalog.pg_description d
    WHERE d.objoid >= 16384
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend e
                       WHERE e.classid = d.classoid AND e.objid = d.objoid AND e.deptype = 'e')
      AND NOT (d.classoid = 'pg_class'::regclass AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE c.oid = d.objoid AND n.nspname = 'drizzle'))`,
  // Default privileges.
  `SELECT 'default_privileges',
          ${roleName("a.defaclrole")} || ' in ' || coalesce(a.defaclnamespace::regnamespace::text, '*') || ' on ' || a.defaclobjtype::text,
          (SELECT coalesce(string_agg(entry, ',' ORDER BY entry), '')
             FROM (SELECT format('%s=%s%s', ${roleName("x.grantee")}, x.privilege_type,
                            CASE WHEN x.is_grantable THEN '*' ELSE '' END) AS entry
                     FROM pg_catalog.aclexplode(a.defaclacl) x WHERE x.grantee <> a.defaclrole) entries)
     FROM pg_catalog.pg_default_acl a`,
  // Objects owned by anyone but the reader (see the header). The `public` schema belongs to
  // pg_database_owner on every database PostgreSQL 15 or later made, which is listed as such.
  `SELECT 'owner', kind || ' ' || name, pg_catalog.pg_get_userbyid(owner)
     FROM (SELECT 'schema' AS kind, n.nspname::text AS name, n.nspowner AS owner
             FROM pg_catalog.pg_namespace n
            WHERE ${EXCLUDED_SCHEMAS} AND NOT ${extensionMember("pg_namespace", "n.oid")}
           UNION ALL
           SELECT 'relation', c.oid::regclass::text, c.relowner
             FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE ${EXCLUDED_SCHEMAS} AND n.nspname <> 'drizzle' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'c')
              AND NOT ${extensionMember("pg_class", "c.oid")}
           UNION ALL
           SELECT 'function', p.oid::regprocedure::text, p.proowner
             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE ${EXCLUDED_SCHEMAS} AND NOT ${extensionMember("pg_proc", "p.oid")}
           UNION ALL
           SELECT 'type', t.oid::regtype::text, t.typowner
             FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
            WHERE ${EXCLUDED_SCHEMAS} AND n.nspname <> 'drizzle' AND t.typtype IN ('e', 'd', 'r', 'm')
              AND NOT ${extensionMember("pg_type", "t.oid")}
           UNION ALL
           SELECT 'event trigger', e.evtname::text, e.evtowner FROM pg_catalog.pg_event_trigger e
            WHERE NOT ${extensionMember("pg_event_trigger", "e.oid")}) owned
    WHERE pg_catalog.pg_get_userbyid(owner) <> current_user`,
];

/** Thrown only to roll the savepoint back, which restores the caller's `search_path`. */
class PathRestored extends Error {}

/**
 * The structure of the database `tx` is connected to, as the role `tx` runs as sees it, sorted.
 *
 * Read in a savepoint that is rolled back, so the empty `search_path` it reads under does not outlive the
 * read: a migration run after it in the same transaction sees the path its caller left.
 */
export async function readStructure(
  tx: TransactionSql,
): Promise<StructureItem[]> {
  const items: StructureItem[] = [];
  const restored = new PathRestored();
  await tx
    .savepoint(async (sp) => {
      await sp`select pg_catalog.set_config('search_path', '', true)`;
      for (const query of QUERIES) {
        const rows = (await sp.unsafe(query).values()) as unknown as Array<
          [string, string, string | null]
        >;
        for (const [kind, name, detail] of rows)
          items.push([
            kind,
            name,
            EXPRESSION_KINDS.has(kind)
              ? flattenBooleanNesting(detail ?? "")
              : (detail ?? ""),
          ]);
      }
      throw restored;
    })
    .catch((failure: unknown) => {
      if (failure !== restored) throw failure;
    });
  return items.sort(compareItems);
}

/** The kinds whose detail is a deparsed expression, read through {@link flattenBooleanNesting}. */
const EXPRESSION_KINDS: ReadonlySet<string> = new Set([
  "constraint",
  "policy",
  "index",
  "trigger",
]);

/**
 * The same boolean expression whatever way its ANDs (or ORs) were grouped.
 *
 * WHY. PostgreSQL keeps an expression as the parse tree it was written as. `a BETWEEN 1 AND 80 AND b`
 * is stored as AND(AND(a >= 1, a <= 80), b), and printed `(((a >= 1) AND (a <= 80)) AND b)`; the parser
 * reading that text back makes one flat AND(a >= 1, a <= 80, b), printed `((a >= 1) AND (a <= 80) AND
 * b)`. Same meaning, different text. A database restored from a dump (the way back of v0.2.16's
 * upgrade restores one) has the second form wherever the database it was dumped from had the first, and
 * would be refused for it. So a parenthesised operand of an AND that is itself an AND is spliced into the
 * outer one, and the same for OR, everywhere in the text, innermost first. Nothing else changes: no
 * operand is dropped, reordered or rewritten, and text inside quotes is left alone.
 */
export function flattenBooleanNesting(text: string): string {
  type Node = string | Node[];
  // Parse into nested groups by parentheses, keeping quoted text whole.
  const root: Node[] = [];
  const stack: Node[][] = [root];
  let buffer = "";
  const push = () => {
    if (buffer) (stack.at(-1) as Node[]).push(buffer);
    buffer = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === char) {
          if (text[end + 1] === char) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      buffer += text.slice(index, end + 1);
      index = end;
    } else if (char === "(") {
      push();
      const group: Node[] = [];
      (stack.at(-1) as Node[]).push(group);
      stack.push(group);
    } else if (char === ")" && stack.length > 1) {
      push();
      stack.pop();
    } else buffer += char;
  }
  push();
  if (stack.length !== 1) return text;

  /** The group's top-level operator when its parts are joined by exactly one of AND / OR, else none. */
  const operatorOf = (group: Node[]): "AND" | "OR" | undefined => {
    let found: "AND" | "OR" | undefined;
    for (const part of group) {
      if (typeof part !== "string") continue;
      for (const match of part.matchAll(/ (AND|OR) /g)) {
        const word = match[1] as "AND" | "OR";
        if (found && found !== word) return undefined;
        found = word;
      }
    }
    return found;
  };
  /** Split a group's parts into operands at its top-level operator. */
  const operands = (group: Node[], word: string): Node[][] => {
    const out: Node[][] = [[]];
    for (const part of group) {
      if (typeof part !== "string") {
        (out.at(-1) as Node[]).push(part);
        continue;
      }
      const pieces = part.split(` ${word} `);
      pieces.forEach((piece, at) => {
        if (at > 0) out.push([]);
        if (piece) (out.at(-1) as Node[]).push(piece);
      });
    }
    return out;
  };
  const flatten = (group: Node[]): Node[] => {
    const inner = group.map((part) =>
      typeof part === "string" ? part : flatten(part),
    );
    const word = operatorOf(inner);
    if (!word) return inner;
    const spliced: Node[][] = [];
    for (const operand of operands(inner, word)) {
      const only = operand.length === 1 ? operand[0] : undefined;
      if (Array.isArray(only) && operatorOf(only) === word)
        spliced.push(...operands(only, word));
      else spliced.push(operand);
    }
    const joined: Node[] = [];
    spliced.forEach((operand, at) => {
      if (at > 0) joined.push(` ${word} `);
      joined.push(...operand);
    });
    return joined;
  };
  const render = (group: Node[]): string =>
    group
      .map((part) => (typeof part === "string" ? part : `(${render(part)})`))
      .join("");
  return render(flatten(root));
}

function compareItems(a: StructureItem, b: StructureItem): number {
  const left = a.join("\u0000");
  const right = b.join("\u0000");
  return left < right ? -1 : left > right ? 1 : 0;
}

/** One difference: the item as expected, as found, or both when it is the same object changed. */
export type StructureDifference = {
  kind: string;
  name: string;
  expected?: string;
  actual?: string;
};

/**
 * Every item that is not the same in both lists, keyed by kind and name: missing (expected only),
 * unexpected (actual only), or changed (both, with different details).
 */
export function diffStructure(
  expected: readonly StructureItem[],
  actual: readonly StructureItem[],
): StructureDifference[] {
  const key = ([kind, name]: StructureItem) => `${kind}\u0000${name}`;
  const group = (items: readonly StructureItem[]) => {
    const map = new Map<string, string[]>();
    for (const item of items) {
      const details = map.get(key(item)) ?? [];
      details.push(item[2]);
      map.set(key(item), details);
    }
    return map;
  };
  const want = group(expected);
  const have = group(actual);
  const differences: StructureDifference[] = [];
  for (const id of [...new Set([...want.keys(), ...have.keys()])].sort()) {
    const [kind = "", name = ""] = id.split("\u0000");
    const a = (want.get(id) ?? []).sort();
    const b = (have.get(id) ?? []).sort();
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const longest = Math.max(a.length, b.length);
    for (let index = 0; index < longest; index += 1) {
      if (a[index] === b[index]) continue;
      differences.push({
        kind,
        name,
        ...(a[index] === undefined ? {} : { expected: a[index] }),
        ...(b[index] === undefined ? {} : { actual: b[index] }),
      });
    }
  }
  return differences;
}

/** How long one side of a changed item may be when printed; definitions can run to pages. */
const DETAIL_LIMIT = 1_500;
/** How many differences are printed; the count of the rest is said. */
const SHOWN_LIMIT = 60;

/** The differences as an operator reads them in a start-up log: one block per item, `-` expected, `+` found. */
export function formatStructureDifferences(
  differences: readonly StructureDifference[],
): string {
  const clip = (text: string) =>
    text.length > DETAIL_LIMIT
      ? `${text.slice(0, DETAIL_LIMIT)}…（共 ${text.length} 字符）`
      : text;
  const blocks = differences.slice(0, SHOWN_LIMIT).map((difference) => {
    const lines = [`${difference.kind} ${difference.name}`];
    lines.push(
      difference.expected === undefined
        ? "  - （基线里没有）"
        : `  - ${clip(difference.expected).replaceAll("\n", "\n    ")}`,
    );
    lines.push(
      difference.actual === undefined
        ? "  + （这个库里没有）"
        : `  + ${clip(difference.actual).replaceAll("\n", "\n    ")}`,
    );
    return lines.join("\n");
  });
  if (differences.length > SHOWN_LIMIT)
    blocks.push(`……另有 ${differences.length - SHOWN_LIMIT} 处不同未列出`);
  return blocks.join("\n");
}
