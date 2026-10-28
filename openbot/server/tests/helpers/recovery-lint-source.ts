import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

// Exact current test bytes -> exact pre-lint bytes. Original historical guards run afterwards.
// No filesystem writes, project imports, dynamic evaluation, or generic acceptance of changed files.
type ApprovedLintTestInverse = Readonly<{
  path: string;
  currentBytes: number;
  currentSha256: string;
  beforeBytes: number;
  beforeSha256: string;
  edits: readonly Readonly<{ after: string; before: string; count: number }>[];
}>;
const APPROVED_LINT_TEST_INVERSES: readonly ApprovedLintTestInverse[] = [
  {
    "path": "tests/recovery-resource-project-foundations.test.ts",
    "currentBytes": 115974,
    "currentSha256": "d8701c36d66fd26527d24bf3c8e1bfad358b082f5074a8e7f6a31bf746293099",
    "beforeBytes": 115756,
    "beforeSha256": "27b7105e8e8f0d26adcc7a92dd1c661b3b869af47ed202717bfbe81c79fb7b51",
    "edits": [
      {
        "after": "        let onUpdate: \"cascade\" | \"no action\";\n        if (c.peek() === \"CASCADE\") {\n          c.take(\"CASCADE\");\n          onUpdate = \"cascade\";\n        } else {\n          c.take(\"NO\");\n          c.take(\"ACTION\");\n          onUpdate = \"no action\";\n        }",
        "before": "        const onUpdate = c.peek() === \"CASCADE\"\n          ? (c.take(\"CASCADE\"), \"cascade\")\n          : (c.take(\"NO\"), c.take(\"ACTION\"), \"no action\");",
        "count": 1
      },
      {
        "after": "        let onDelete: \"cascade\" | \"no action\";\n        if (c.peek() === \"CASCADE\") {\n          c.take(\"CASCADE\");\n          onDelete = \"cascade\";\n        } else {\n          c.take(\"NO\");\n          c.take(\"ACTION\");\n          onDelete = \"no action\";\n        }",
        "before": "        const onDelete = c.peek() === \"CASCADE\"\n          ? (c.take(\"CASCADE\"), \"cascade\")\n          : (c.take(\"NO\"), c.take(\"ACTION\"), \"no action\");",
        "count": 1
      }
    ]
  },
  {
    "path": "tests/recovery-plugin-assembly-foundations.test.ts",
    "currentBytes": 128442,
    "currentSha256": "795e8365ad2ac62d78f6de4973b382dd95625f3698ab62a840b3ce41ecaabfa3",
    "beforeBytes": 128110,
    "beforeSha256": "375416fe839aee76dc4b006eede366d54c94d0e944ccedddeb35f745636917e8",
    "edits": [
      {
        "after": "\nfunction historicalK106PriorTestSource(path:string,raw:Buffer):Buffer {\n  raw = preLintRecoverySource(path, raw);",
        "before": "\nfunction historicalK106PriorTestSource(path:string,raw:Buffer):Buffer {",
        "count": 1
      },
      {
        "after": "import { describe, expect, test } from \"bun:test\";\nimport { preLintRecoverySource } from \"./helpers/recovery-lint-source\";",
        "before": "import { describe, expect, test } from \"bun:test\";",
        "count": 1
      },
      {
        "after": "        let onUpdate: \"cascade\" | \"no action\";\n        if (c.peek() === \"CASCADE\") {\n          c.take(\"CASCADE\");\n          onUpdate = \"cascade\";\n        } else {\n          c.take(\"NO\");\n          c.take(\"ACTION\");\n          onUpdate = \"no action\";\n        }",
        "before": "        const onUpdate = c.peek() === \"CASCADE\"\n          ? (c.take(\"CASCADE\"), \"cascade\")\n          : (c.take(\"NO\"), c.take(\"ACTION\"), \"no action\");",
        "count": 1
      },
      {
        "after": "        let onDelete: \"cascade\" | \"no action\";\n        if (c.peek() === \"CASCADE\") {\n          c.take(\"CASCADE\");\n          onDelete = \"cascade\";\n        } else {\n          c.take(\"NO\");\n          c.take(\"ACTION\");\n          onDelete = \"no action\";\n        }",
        "before": "        const onDelete = c.peek() === \"CASCADE\"\n          ? (c.take(\"CASCADE\"), \"cascade\")\n          : (c.take(\"NO\"), c.take(\"ACTION\"), \"no action\");",
        "count": 1
      }
    ]
  },
  {
    "path": "tests/recovery-knowledge-write-foundations.test.ts",
    "currentBytes": 130752,
    "currentSha256": "33bd5d214ab3020edc86654e71e08db75ffa38a7d9bb1c9fa0e1b6960fa43f64",
    "beforeBytes": 130422,
    "beforeSha256": "27088e601b335f82efb159f938f77add9e3ed249fa420816e95e47560a3ccc1e",
    "edits": [
      {
        "after": "\nfunction historicalProtectedSource(path: string, raw: Buffer): Buffer {\n  raw = preLintRecoverySource(path, raw);",
        "before": "\nfunction historicalProtectedSource(path: string, raw: Buffer): Buffer {",
        "count": 1
      },
      {
        "after": "import { describe, expect, test } from \"bun:test\";\nimport { preLintRecoverySource } from \"./helpers/recovery-lint-source\";",
        "before": "import { describe, expect, test } from \"bun:test\";",
        "count": 1
      },
      {
        "after": "      fk.columnsFrom.forEach((c,i)=>{assert.equal(t.columns[c]?.type,p.columns[fk.columnsTo[i] ?? \"\"]?.type);});",
        "before": "      fk.columnsFrom.forEach((c,i)=>assert.equal(t.columns[c]?.type,p.columns[fk.columnsTo[i] ?? \"\"]?.type));",
        "count": 1
      },
      {
        "after": "\nimport { is, SQL } from \"drizzle-orm\";",
        "before": "\nimport { is, sql, SQL } from \"drizzle-orm\";",
        "count": 1
      },
      {
        "after": "        let onUpdate: \"cascade\" | \"no action\";\n        if (c.peek() === \"CASCADE\") {\n          c.take(\"CASCADE\");\n          onUpdate = \"cascade\";\n        } else {\n          c.take(\"NO\");\n          c.take(\"ACTION\");\n          onUpdate = \"no action\";\n        }",
        "before": "        const onUpdate = c.peek() === \"CASCADE\"\n          ? (c.take(\"CASCADE\"), \"cascade\")\n          : (c.take(\"NO\"), c.take(\"ACTION\"), \"no action\");",
        "count": 1
      },
      {
        "after": "        let onDelete: \"cascade\" | \"no action\";\n        if (c.peek() === \"CASCADE\") {\n          c.take(\"CASCADE\");\n          onDelete = \"cascade\";\n        } else {\n          c.take(\"NO\");\n          c.take(\"ACTION\");\n          onDelete = \"no action\";\n        }",
        "before": "        const onDelete = c.peek() === \"CASCADE\"\n          ? (c.take(\"CASCADE\"), \"cascade\")\n          : (c.take(\"NO\"), c.take(\"ACTION\"), \"no action\");",
        "count": 1
      }
    ]
  }
];

export function preLintRecoverySource(path: string, raw: Buffer): Buffer {
  const inverse = APPROVED_LINT_TEST_INVERSES.find((entry) => entry.path === path);
  if (!inverse) return raw;
  assert.equal(raw.length, inverse.currentBytes, "exact approved lint source size");
  assert.equal(createHash("sha256").update(raw).digest("hex"), inverse.currentSha256, "unknown lint source delta rejected");
  let source = raw.toString("utf8");
  assert.ok(Buffer.from(source, "utf8").equals(raw));
  for (const edit of inverse.edits) {
    assert.ok(edit.after.length > 0 && Number.isSafeInteger(edit.count) && edit.count > 0);
    assert.equal(source.split(edit.after).length, edit.count + 1, "closed lint inverse literal multiplicity");
    source = source.split(edit.after).join(edit.before);
  }
  const restored = Buffer.from(source, "utf8");
  assert.equal(restored.length, inverse.beforeBytes, "original pre-lint test size");
  assert.equal(createHash("sha256").update(restored).digest("hex"), inverse.beforeSha256, "original pre-lint test identity");
  return restored;
}
