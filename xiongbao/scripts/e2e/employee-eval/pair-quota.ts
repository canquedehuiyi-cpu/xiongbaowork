/**
 * 重复任务按对做：每一对用自己的新员工（同组一位、对照一位），评测账号的员工数有上限，
 * 所以每一对做完就把这一对用过的员工删掉，名额还给下一对。这里只放纯函数，接线在 `run-xiongbao.ts`。
 * 不改产品行为。
 */

/** 只看这两个字段：运行的键，和它属于哪一对（普通题没有）。 */
export type PairedRun = { key: string; pairKey?: string };

/**
 * 这次运行是不是这一对的最后一次：后面的运行里没有同一对的了。普通题（没有 `pairKey`）不算。
 * 熊宝侧有坑可学的题最后一次是对照，没有对照的题是第二次；对照建不出来被跳过时，它仍然排在最后，
 * 照样算这一对结束。
 */
export function isLastRunOfPair(
  works: readonly PairedRun[],
  at: number,
): boolean {
  const pairKey = works[at]?.pairKey;
  if (!pairKey) return false;
  return !works.slice(at + 1).some((work) => work.pairKey === pairKey);
}

/** 一对用过的员工：同组那位（组名 = 对名）和对照那位（组名 = 对名 + `-control`），只列已经建出来的。 */
export function pairEmployees(
  pairKey: string,
  agentOfGroup: ReadonlyMap<string, string>,
): { group: string; agentId: string }[] {
  return [pairKey, `${pairKey}-control`].flatMap((group) => {
    const agentId = agentOfGroup.get(group);
    return agentId ? [{ group, agentId }] : [];
  });
}
