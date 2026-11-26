import {
  applyEnvironmentAliases,
  reportEnvironmentAliases,
} from "./env-aliases";

// A module of its own, imported before everything else in an entry point: ES imports are evaluated
// before the importing file's body, so a call placed in index.ts would run after any module that
// reads config while loading.
reportEnvironmentAliases(applyEnvironmentAliases(process.env));
