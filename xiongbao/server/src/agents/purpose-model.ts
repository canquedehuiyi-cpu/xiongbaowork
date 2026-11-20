import type { LanguageModel } from "ai";
import type {
  AgentModelResolver,
  DeploymentModel,
} from "../models/runtime-resolver";

/**
 * 员工为某件事用的模型（期 2 接期 1·1.5）：自动抽记忆、做完复盘这类背景小活用「轻量模型」，别的用员工平时的。
 *
 * `light`：员工设置里写了轻量模型（`shared/light-model.ts`），而且它现在还在本租户可用的模型里，就用它，
 * 经部署的模型和密钥构建、按这个人计量；排在员工在模型库里的绑定前面（`ignoreBinding`），和巡检、跟进那类
 * 轻量轮一样（`agents/light-model.ts`）。没设置、不在目录里、读失败，都是员工平时的模型：背景小活不该因为
 * 一个设置读不出来就没了。`work` 一直是员工平时的模型。
 * 都拿不到（没有密钥、没有可用的模型）答 null，调用方不做这件事。
 */
export function createPurposeModel(deps: {
  resolve: AgentModelResolver;
  /** 部署的模型，按模型名构建；不给名字是部署默认的。没有密钥等拿不到时是 undefined。 */
  deployment: (modelName?: string) => Promise<DeploymentModel | undefined>;
  /** 这位员工设置里的轻量模型名。 */
  lightModelOf: (agentId: string) => Promise<string | undefined>;
  /** 本租户可用的模型名。 */
  allowed: () => Promise<readonly string[]>;
}) {
  return async (
    agentId: string,
    purpose: "light" | "work",
  ): Promise<LanguageModel | null> => {
    try {
      if (purpose === "light") {
        const light = await deps
          .lightModelOf(agentId)
          .then(async (name) =>
            name && (await deps.allowed()).includes(name) ? name : undefined,
          )
          .catch(() => undefined);
        if (light) {
          const deployment = await deps.deployment(light);
          if (deployment) {
            const model = await deps.resolve(agentId, deployment, {
              ignoreBinding: true,
            });
            if (model) return model;
          }
        }
      }
      return await deps.resolve(agentId, await deps.deployment());
    } catch {
      return null;
    }
  };
}
