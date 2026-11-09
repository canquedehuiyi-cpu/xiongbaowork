/**
 * An app's tool schema, cut down to what every model provider accepts.
 *
 * The one implementation is the toolkit's (`toolkit/src/tool-schema.ts`, which upstream v1.0.0 and
 * the plugins session wrote the same), and `parametersFor` in `@openbot/toolkit/granted-tool` is
 * what applies it to every app tool a Bot is offered. Re-exported here so the plugins keep their
 * path to it without a second copy that could drift.
 */
export {
  isPortablePattern,
  providerSafeSchema,
} from "@openbot/toolkit/tool-schema";
