import { useEffect, useState } from "react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  THINKING_DEFAULT,
  THINKING_HINT,
  THINKING_LABEL,
} from "../../../../shared/thinking";

/** 远端员工：模型在它自己的服务器上，这个开关管不到。 */
const REMOTE =
  "这位员工运行在它自己的端点上，用不用思考由那边决定，这个开关对它不起作用。";

const SAVE_FAILED = "没能保存，请再试一次。";

/**
 * 员工设置「模型」那一节里的「思考模式」开关（期三）。
 *
 * 拨一下马上换过来，同时保存（`PATCH /api/agents/:id` 带 `thinking`）；没存上就拨回去，并说为什么。资料里没有这个
 * 字段（老服务器）按开着读，和服务器对没设置过的员工一样（`THINKING_DEFAULT`）。远端员工的模型由它自己的服务器
 * 决定，开关拨不动，下面说原因；不归你管的员工只能看。
 */
export function ThinkingItem({
  agent,
  onSave,
}: {
  agent: AgentProfile;
  onSave: (thinking: boolean) => Promise<unknown>;
}) {
  const saved = agent.thinking ?? THINKING_DEFAULT;
  /** 拨过的那一下：存的时候、存上以后资料还没跟上时都照它画；没存上就清掉，拨回资料里的。 */
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 资料跟上了，就不必再记着。
  useEffect(() => {
    if (!saving && chosen === saved) setChosen(null);
  }, [saving, chosen, saved]);
  const checked = chosen ?? saved;
  const editable = agent.builtIn && agent.canManage;
  const id = `thinking-${agent.id}`;
  return (
    <Item>
      <ItemContent>
        <ItemTitle id={id}>{THINKING_LABEL}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {agent.builtIn ? THINKING_HINT : REMOTE}
        </ItemDescription>
        {error ? (
          <p className="m-0 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions>
        <Switch
          aria-labelledby={id}
          checked={agent.builtIn ? checked : false}
          disabled={!editable || saving}
          onCheckedChange={async (next) => {
            setError(null);
            setChosen(next);
            setSaving(true);
            try {
              await onSave(next);
            } catch (failure) {
              setChosen(null);
              setError(
                failure instanceof Error && failure.message
                  ? failure.message
                  : SAVE_FAILED,
              );
            } finally {
              setSaving(false);
            }
          }}
        />
      </ItemActions>
    </Item>
  );
}
