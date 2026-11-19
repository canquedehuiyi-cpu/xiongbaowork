import { applyEnvironmentAliases } from "./env-aliases";

// A module of its own, imported before everything else in an entry point: ES imports are evaluated
// before the importing file's body, so a call placed in index.ts would run after any module that
// reads config while loading.
for (const name of applyEnvironmentAliases(process.env).conflicts) {
  console.warn(
    `${name} is also set under its XIONGBAO_ name; using the XIONGBAO_ value.`,
  );
}
