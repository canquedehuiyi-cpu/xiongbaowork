/**
 * 记忆注入「粘住」：同一线程里，话题没变就原样复用上次的注入块（期 1·1.2 补）。
 *
 * 为什么：记忆块是放在对话最前面的一条系统消息。它每一轮都跟着用户的新消息变，整段历史的前缀缓存就整段失效，
 * 按相关度注入省下的 token 会被缓存失效吃掉一部分。所以按线程记住上次挑出来的块：新消息没有实词（「好的」
 * 「继续」），或者和上次挑选时的那条消息词重叠相似度不低于 {@link MEMORY_STICKY_SIMILARITY}，就逐字节复用；
 * 话题明显变了，或者记忆本身增删改了（指纹变了），才重挑。比较的始终是「上次挑选时的那条消息」，不是上一条，
 * 话题一点点漂远了总会重挑。
 *
 * 记在这个进程里：换了副本、重启了，只是多挑一次，不会错。`XIONGBAO_MEMORY_STICKY=off` 关掉，每条消息各挑各的。
 */
import { createHash } from "node:crypto";
import { hasSubstantiveWords, similarity, tokensOf } from "../text-tokens";

export const MEMORY_STICKY_SIMILARITY = 0.3;
const DEFAULT_MAX_THREADS = 500;

type Entry = {
  /** 挑选时那条消息的词集；那条消息没有实词就是空的。 */
  tokens: Set<string>;
  /** 挑选时用的那条有实词的消息；没有就是空串。 */
  query: string;
  fingerprint: string;
  block: string;
};

/** 候选记忆的指纹：编号、来源、正文和顺序，任何一条变了它就变。 */
function fingerprintOf(
  memories: readonly { id: string; content: string; provenance: string }[],
): string {
  const hash = createHash("sha256");
  for (const memory of memories)
    hash.update(
      `${memory.id}\u0000${memory.provenance}\u0000${memory.content}\u0001`,
    );
  return hash.digest("hex");
}

export function createStickyMemory(
  options: {
    env?: Record<string, string | undefined>;
    maxThreads?: number;
  } = {},
) {
  const enabled =
    (
      options.env ?? process.env
    ).XIONGBAO_MEMORY_STICKY?.trim().toLowerCase() !== "off";
  const maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS;
  // 插入顺序就是最近使用的顺序（命中时重新插入）：满了丢最前面的。
  const entries = new Map<string, Entry>();
  return {
    /**
     * 这一轮的注入块。`key` 是人、员工和线程合起来的键，没有线程（没有可粘的东西）就不粘；
     * `render(query)` 是不粘时怎么挑、怎么排版。
     */
    choose(input: {
      key: string | undefined;
      memories: readonly { id: string; content: string; provenance: string }[];
      query: string;
      render: (query: string) => string;
    }): string {
      const { key, memories, query, render } = input;
      if (!enabled || !key) return render(query);
      const fingerprint = fingerprintOf(memories);
      const substantive = hasSubstantiveWords(query);
      const tokens = substantive ? tokensOf(query) : new Set<string>();
      const previous = entries.get(key);
      if (
        previous &&
        previous.fingerprint === fingerprint &&
        (!substantive ||
          (previous.tokens.size > 0 &&
            similarity(tokens, previous.tokens) >= MEMORY_STICKY_SIMILARITY))
      ) {
        entries.delete(key);
        entries.set(key, previous);
        return previous.block;
      }
      /*
       * 记忆变了而这条消息没有实词：话题还是上次那个，按上次挑选时的那条消息重挑，不退回按最近更新取。
       */
      const asked = substantive ? query : (previous?.query ?? query);
      const block = render(asked);
      entries.delete(key);
      entries.set(key, {
        tokens: substantive ? tokens : (previous?.tokens ?? tokens),
        query: substantive ? query : (previous?.query ?? ""),
        fingerprint,
        block,
      });
      while (entries.size > maxThreads) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return block;
    },
  };
}
