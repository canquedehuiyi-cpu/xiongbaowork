/**
 * 一轮之内压缩要问的「这个模型的窗口多大」（期七，toolkit 里的 `turn-folding.ts`）。
 *
 * 窗口的来源是模型目录（`model-catalogue.ts`：缓存的 models.dev 数据，再退到内置的小表），开机时由 `index.ts`
 * 接上；没接上、或目录里没有这个模型时回答空，压缩那边就用保守的默认值。目录从不等网络，所以这里每一步问一次也不慢。
 */

type Source = (
  providerId: string,
  modelName: string,
  baseUrl?: string | null,
) => Promise<number | undefined>;

let source: Source | undefined;

/** 开机时接上目录；不传就拆掉（测试用）。 */
export function configureContextWindowSource(next?: Source): void {
  source = next;
}

/** 这个模型的窗口（token），目录里没有就是空。 */
export async function contextWindowOf(
  providerId: string,
  modelName: string,
): Promise<number | undefined> {
  return source?.(providerId, modelName);
}
