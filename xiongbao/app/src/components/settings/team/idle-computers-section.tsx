import { IconChevronRight, IconDeviceDesktop } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  setEnterpriseSettingMutationOptions,
  terminateInactiveComputersMutationOptions,
} from "@/lib/enterprise/mutations";
import { enterpriseOverviewQueryOptions } from "@/lib/enterprise/queries";

/**
 * 电脑与设备里团队版管理员的「闲置电脑」一节（`#idle`，O17、O18）：闲置多少天后停掉（天数对话框），以及
 * 立即停掉一次。原来是企业管控页的「电脑」一节。
 */
export function IdleComputersSection() {
  return (
    <SettingsSection
      audience={{ who: "team-admin", edition: "team" }}
      description="停掉电脑会结束上面正在运行的员工，磁盘会保留；员工下次会话时会拿到一台新电脑。要停掉某个人的电脑，请到成员页操作。"
      id="idle"
      title="闲置电脑"
    >
      <IdleRows />
    </SettingsSection>
  );
}

function IdleRows() {
  const queryClient = useQueryClient();
  const overview = useQuery(enterpriseOverviewQueryOptions());
  const setSetting = useMutation(
    setEnterpriseSettingMutationOptions(queryClient),
  );
  const [open, setOpen] = useState(false);
  if (overview.isPending) return null;
  if (overview.error) {
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        读不到闲置电脑的设置。请刷新页面。
      </p>
    );
  }
  const days = overview.data.settings.inactiveComputerDays;

  return (
    <>
      {setSetting.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {setSetting.error.message}
        </p>
      ) : null}
      <PageRows>
        <Item
          render={
            <button
              data-setting-key="enterprise.inactiveComputerDays"
              disabled={setSetting.isPending}
              onClick={() => setOpen(true)}
              type="button"
            />
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconDeviceDesktop />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>停掉闲置电脑</ItemTitle>
            <ItemDescription>
              {days === 0 ? "关" : `闲置 ${days} 天后`}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
      <SweepNow />
      {/* 存下的天数一变就重新挂载，下次打开时输入框是新值。 */}
      <DaysDialog
        initial={days}
        key={days}
        onClose={() => setOpen(false)}
        onSave={(value) =>
          setSetting.mutate({ key: "inactiveComputerDays", value })
        }
        open={open}
      />
    </>
  );
}

function SweepNow() {
  const sweep = useMutation(terminateInactiveComputersMutationOptions());
  return (
    <div className="mt-4 flex items-center gap-3">
      <Button
        disabled={sweep.isPending}
        onClick={() => sweep.mutate()}
        size="sm"
        variant="outline"
      >
        {sweep.isPending ? "正在停止…" : "立即停掉闲置电脑"}
      </Button>
      {sweep.data ? (
        <span className="text-muted-foreground text-sm">
          已停掉 {sweep.data.stopped.length} 台。
        </span>
      ) : null}
      {sweep.error ? (
        <span className="text-destructive text-sm" role="alert">
          {sweep.error.message}
        </span>
      ) : null}
    </div>
  );
}

function DaysDialog({
  open,
  initial,
  onSave,
  onClose,
}: {
  open: boolean;
  initial: number;
  onSave: (days: number) => void;
  onClose: () => void;
}) {
  const [days, setDays] = useState(String(initial));
  const parsed = Number(days);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 3650;
  return (
    <Dialog
      onOpenChange={(next) => (next ? setDays(String(initial)) : onClose())}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>停掉闲置电脑</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-2">
          <Label htmlFor="inactive-days">闲置天数</Label>
          <Input
            id="inactive-days"
            inputMode="numeric"
            onChange={(event) => setDays(event.target.value)}
            value={days}
          />
          <p className="text-muted-foreground text-xs">
            填 0 表示关闭。每小时检查一次。
          </p>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            取消
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onSave(parsed);
              onClose();
            }}
            size="sm"
            type="button"
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
