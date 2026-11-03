// Prints one fenced code block from a Markdown manual, so CI runs the exact commands a customer
// copies (Gate 7, .github/workflows/clean-deploy.yml).
//
//   bun scripts/ci/manual-blocks.mjs <markdown-file> <name>
//
// The block sits between the lines `<!-- <name>:begin -->` and `<!-- <name>:end -->`. Between the
// two markers there must be exactly one fenced block and nothing but blank lines around it. A
// missing, duplicated, out-of-order or unterminated marker or fence exits non-zero, so a manual
// edit can never make CI silently run nothing or run the wrong block.
import { readFileSync } from "node:fs";

const NAME = /^[a-z0-9][a-z0-9:._-]*$/;
const OPENING = /^(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;

function markerLines(lines, marker) {
  const found = [];
  lines.forEach((line, index) => {
    if (line.trim() === marker) found.push(index);
  });
  return found;
}

/**
 * Returns `{ lang, body }` for the single fenced block between the named markers, `body` ending
 * in a newline. Throws an Error naming the problem otherwise.
 */
export function extractBlock(markdown, name) {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Error(`Invalid block name: ${JSON.stringify(name)}`);
  }
  if (typeof markdown !== "string") {
    throw new Error("Markdown text is required");
  }
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const beginMarker = `<!-- ${name}:begin -->`;
  const endMarker = `<!-- ${name}:end -->`;
  const begins = markerLines(lines, beginMarker);
  const ends = markerLines(lines, endMarker);
  if (begins.length === 0) throw new Error(`Missing marker ${beginMarker}`);
  if (begins.length > 1) {
    throw new Error(`Duplicate marker ${beginMarker} (${begins.length} times)`);
  }
  if (ends.length > 1) {
    throw new Error(`Duplicate marker ${endMarker} (${ends.length} times)`);
  }
  if (ends.length === 0) {
    throw new Error(`Unterminated block ${name}: missing ${endMarker}`);
  }
  const begin = begins[0];
  const end = ends[0];
  if (end < begin) {
    throw new Error(
      `Unterminated block ${name}: ${endMarker} before ${beginMarker}`,
    );
  }

  let fence = null;
  let lang = "";
  let body = [];
  let blocks = 0;
  for (let index = begin + 1; index < end; index++) {
    const line = lines[index];
    if (fence) {
      const trimmed = line.trim();
      if (
        trimmed.length >= fence.length &&
        trimmed === fence[0].repeat(trimmed.length)
      ) {
        fence = null;
      } else {
        body.push(line);
      }
      continue;
    }
    if (line.trim() === "") continue;
    const opening = OPENING.exec(line);
    if (!opening) {
      throw new Error(
        `Block ${name} has text outside its fenced block at line ${index + 1}`,
      );
    }
    blocks++;
    if (blocks > 1) {
      throw new Error(`Block ${name} contains more than one fenced block`);
    }
    fence = opening[1];
    lang = opening[2];
    body = [];
  }
  if (fence) {
    throw new Error(`Block ${name} has an unterminated ${fence} fence`);
  }
  if (blocks === 0) throw new Error(`Block ${name} contains no fenced block`);
  return { lang, body: `${body.join("\n")}\n` };
}

if (import.meta.main) {
  const [file, name] = process.argv.slice(2);
  if (!file || !name) {
    console.error("usage: manual-blocks.mjs <markdown-file> <name>");
    process.exit(2);
  }
  try {
    process.stdout.write(extractBlock(readFileSync(file, "utf8"), name).body);
  } catch (error) {
    console.error(`manual-blocks: ${file}: ${error.message}`);
    process.exit(1);
  }
}
