/**
 * Split PostgreSQL script text into its top-level statements, the way the server would see them.
 *
 * A semicolon ends a statement only outside every quoted form: single-quoted strings (doubled `''`
 * included), `E'…'` strings (backslash escapes), double-quoted identifiers, dollar-quoted bodies
 * (`$$…$$`, `$tag$…$tag$`) and comments (`-- …` to end of line, nested `/* … *\/`). Comments outside
 * statements are dropped; comments inside a statement stay in its text, exactly as written.
 *
 * Used to read `pg_dump` output and the baseline migration statement by statement
 * (`./schema-dump`); psql meta-commands (a line starting with a backslash) are returned as their own
 * entries so the caller can decide what to do with them.
 */
export function splitSqlStatements(text: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  const flush = () => {
    const statement = current.trim();
    if (statement) statements.push(statement);
    current = "";
  };
  while (index < text.length) {
    const char = text[index] as string;
    const next = text[index + 1];
    const atLineStart = index === 0 || text[index - 1] === "\n";
    if (atLineStart && char === "\\" && current.trim() === "") {
      const end = text.indexOf("\n", index);
      const stop = end < 0 ? text.length : end;
      statements.push(text.slice(index, stop).trim());
      current = "";
      index = stop;
      continue;
    }
    if (char === "-" && next === "-") {
      const end = text.indexOf("\n", index);
      const stop = end < 0 ? text.length : end;
      if (current.trim() !== "") current += text.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      let depth = 1;
      let at = index + 2;
      while (at < text.length && depth > 0) {
        if (text[at] === "/" && text[at + 1] === "*") {
          depth += 1;
          at += 2;
        } else if (text[at] === "*" && text[at + 1] === "/") {
          depth -= 1;
          at += 2;
        } else at += 1;
      }
      if (current.trim() !== "") current += text.slice(index, at);
      index = at;
      continue;
    }
    if (char === "'") {
      const escaped =
        (text[index - 1] === "E" || text[index - 1] === "e") &&
        !/[A-Za-z0-9_]/.test(text[index - 2] ?? "");
      let at = index + 1;
      while (at < text.length) {
        if (escaped && text[at] === "\\") {
          at += 2;
          continue;
        }
        if (text[at] === "'") {
          if (text[at + 1] === "'") {
            at += 2;
            continue;
          }
          break;
        }
        at += 1;
      }
      current += text.slice(index, at + 1);
      index = at + 1;
      continue;
    }
    if (char === '"') {
      let at = index + 1;
      while (at < text.length) {
        if (text[at] === '"') {
          if (text[at + 1] === '"') {
            at += 2;
            continue;
          }
          break;
        }
        at += 1;
      }
      current += text.slice(index, at + 1);
      index = at + 1;
      continue;
    }
    if (char === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(index));
      const before = text[index - 1] ?? "";
      if (tag && !/[A-Za-z0-9_]/.test(before)) {
        const close = text.indexOf(tag[0], index + tag[0].length);
        const stop = close < 0 ? text.length : close + tag[0].length;
        current += text.slice(index, stop);
        index = stop;
        continue;
      }
    }
    if (char === ";") {
      flush();
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  flush();
  return statements;
}
