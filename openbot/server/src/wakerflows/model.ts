import type { LanguageModel } from "ai";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  type FlowModelChoice,
  PLATFORM_FLOW_MODEL_ID,
} from "../../../shared/wakerflows";
import { decryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { credentials, modelRegistry } from "../db/schema";
import { languageModelFor } from "../models/runtime-resolver";
import { runAsTenant } from "../tenant/context";
import { WakerFlowValidationError } from "./store";

/**
 * Which model a WakerFlow is planned with (spec D10, story WF2).
 *
 * The person picks a row of their own model library. A pick that is not theirs, is switched off, has
 * no key, or whose key was revoked or cannot be read is refused — and refused, never quietly swapped
 * for the deployment's model: a plan written by a model the person did not choose, on a bill they did
 * not expect, is the failure this file exists to rule out.
 *
 * The deployment's own model is a separate, explicit choice ({@link PLATFORM_FLOW_MODEL_ID}). Whether
 * it is offered is still an open product decision, so it is off unless `allowPlatformModel` is set.
 */

export const FLOW_MODEL_UNAVAILABLE_MESSAGE = "所选模型不可用，请重新选择。";
export const FLOW_PLATFORM_MODEL_MISSING_MESSAGE =
  "平台模型未配置，请选择模型库中的模型。";

export class FlowModelUnavailableError extends WakerFlowValidationError {
  constructor(message = FLOW_MODEL_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "FlowModelUnavailableError";
  }
}

export type ResolvedFlowModel = {
  modelRef: string;
  name: string;
  model: LanguageModel;
};

export type FlowModelResolver = {
  choices: (tenantId: string) => Promise<FlowModelChoice[]>;
  resolve: (tenantId: string, modelRef: unknown) => Promise<ResolvedFlowModel>;
};

export type PlatformFlowModel = {
  /** `provider/model`. */
  name: string;
  model: () => LanguageModel | Promise<LanguageModel>;
};

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function createFlowModelResolver(options: {
  database: Database;
  encryptionKey: string;
  resolve?: typeof languageModelFor;
  /** Pending product decision: off means the platform model is neither listed nor accepted. */
  allowPlatformModel?: boolean;
  platform?: PlatformFlowModel;
}): FlowModelResolver {
  const { database, encryptionKey } = options;
  const build = options.resolve ?? languageModelFor;
  const platform =
    options.allowPlatformModel === true ? options.platform : undefined;

  /** The tenant's usable rows: enabled, keyed, key not revoked. One query, tenancy stated twice. */
  const usable = (tenantId: string, id?: string) =>
    runAsTenant(tenantId, async () =>
      database
        .select({
          id: modelRegistry.id,
          provider: modelRegistry.provider,
          baseUrl: modelRegistry.baseUrl,
          modelName: modelRegistry.modelName,
          label: modelRegistry.label,
          encryptedValue: credentials.encryptedValue,
        })
        .from(modelRegistry)
        .innerJoin(
          credentials,
          and(
            eq(credentials.id, modelRegistry.credentialId),
            eq(credentials.tenantId, tenantId),
            isNull(credentials.revokedAt),
          ),
        )
        .where(
          and(
            eq(modelRegistry.tenantId, tenantId),
            eq(modelRegistry.enabled, true),
            ...(id ? [eq(modelRegistry.id, id)] : []),
          ),
        )
        .orderBy(asc(modelRegistry.createdAt)),
    );

  return {
    async choices(tenantId) {
      const rows = await usable(tenantId);
      const listed: FlowModelChoice[] = rows.map((row) => {
        const name = `${row.provider}/${row.modelName}`;
        return { id: row.id, name, label: row.label?.trim() || name };
      });
      if (platform) {
        listed.push({
          id: PLATFORM_FLOW_MODEL_ID,
          name: platform.name,
          label: `平台模型 · ${platform.name}`,
        });
      }
      return listed;
    },

    async resolve(tenantId, modelRef) {
      if (modelRef === PLATFORM_FLOW_MODEL_ID) {
        if (!platform)
          throw new FlowModelUnavailableError(
            FLOW_PLATFORM_MODEL_MISSING_MESSAGE,
          );
        try {
          return {
            modelRef: PLATFORM_FLOW_MODEL_ID,
            name: platform.name,
            model: await platform.model(),
          };
        } catch {
          throw new FlowModelUnavailableError(
            FLOW_PLATFORM_MODEL_MISSING_MESSAGE,
          );
        }
      }
      if (!isUuid(modelRef)) throw new FlowModelUnavailableError();
      const [row] = await usable(tenantId, modelRef);
      if (!row) throw new FlowModelUnavailableError();
      try {
        const apiKey = await decryptSecret(encryptionKey, row.encryptedValue);
        return {
          modelRef: row.id,
          name: `${row.provider}/${row.modelName}`,
          model: build(row.provider, row.baseUrl, row.modelName, apiKey),
        };
      } catch {
        // Never the thrown value: it can carry key material or the envelope.
        throw new FlowModelUnavailableError();
      }
    },
  };
}
