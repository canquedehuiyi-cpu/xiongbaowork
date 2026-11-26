import { oldSettingsRefusal, settingsUnderOldNamesOnly } from "./env-name";

// A module of its own, imported before everything else in an entry point: ES imports are evaluated
// before the importing file's body, so a check placed in index.ts would run after any module that
// reads config while loading. A deployment that still sets only the names before v0.2.16 is refused
// here, before anything reads its environment, rather than started without those settings.
const names = settingsUnderOldNamesOnly(process.env);
if (names.length > 0) {
  console.error(oldSettingsRefusal(names));
  process.exit(1);
}
