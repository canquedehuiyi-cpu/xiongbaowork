import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  hardModelQueryOptions,
  saveHardModelMutationOptions,
} from "@/lib/agents/hard-model";
import { modelCatalogueQueryOptions } from "@/lib/models/queries";

/** 选择器里表示「没设置」的那一项（真正的模型名不会长这样）：子代理用员工平时的模型。 */
const DEFAULT = "__default__";
const DEFAULT_LABEL = "默认模型";

/**
 * 员工设置「模型」那一节里的「难任务模型」（期七）。
 *
 * 选项是对话里模型选择器用的那份目录（`/api/model-catalogue`，管理员的白名单已算在里面），第一项「默认模型」
 * 是留空。存下来的那个模型要是已经不在目录里了（管理员收回、换了提供方），照样列出来、标明，子代理遇到时会
 * 退回默认模型。不归你管的员工只能看。读不到时只在这一行说一句话，不影响别的设置。
 */
export function HardModelItem({
  agentId,
  canManage,
}: {
  agentId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const saved = useQuery(hardModelQueryOptions(agentId));
  const catalogue = useQuery(modelCatalogueQueryOptions());
  const save = useMutation(saveHardModelMutationOptions(queryClient, agentId));

  const models = catalogue.data?.models ?? [];
  const labels: Record<string, string> = { [DEFAULT]: DEFAULT_LABEL };
  for (const model of models) labels[model.id] = model.label || model.id;
  const stored = saved.data ?? DEFAULT;
  // 按住的那一下在存的时候就先画出来；存好以后以服务器存的为准。
  const current = save.isPending ? (save.variables ?? DEFAULT) : stored;
  if (current !== DEFAULT && !(current in labels))
    labels[current] = `${current}（已不在可用的模型里）`;

  return (
    <Item>
      <ItemContent>
        <ItemTitle id={`hard-model-${agentId}`}>难任务模型</ItemTitle>
        <ItemDescription className="line-clamp-none">
          子代理遇到难的子任务时会用这个模型。留空就用上面的模型。
        </ItemDescription>
        {saved.isError ? (
          <p className="m-0 text-destructive text-sm" role="alert">
            读不到这位员工的难任务模型。
          </p>
        ) : null}
        {save.error ? (
          <p className="m-0 text-destructive text-sm" role="alert">
            {save.error.message}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions>
        {canManage ? (
          <Select
            disabled={
              saved.isPending ||
              saved.isError ||
              catalogue.isPending ||
              save.isPending
            }
            items={labels}
            onValueChange={(next) => {
              const value = next ?? DEFAULT;
              if (value === stored) return;
              save.mutate(value === DEFAULT ? null : value);
            }}
            value={current}
          >
            <SelectTrigger aria-label="难任务模型" className="w-56 max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{DEFAULT_LABEL}</SelectItem>
              {Object.entries(labels)
                .filter(([value]) => value !== DEFAULT)
                .map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-muted-foreground text-sm">
            {labels[current] ?? DEFAULT_LABEL}
          </span>
        )}
      </ItemActions>
    </Item>
  );
}
