import {
  IconAdjustments,
  IconArrowsExchange,
  IconBrain,
  IconClock,
  IconPencil,
  IconPlugConnected,
  IconPuzzle,
  IconUser,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { ZodType } from "zod";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { CallbackTokenPanel } from "@/components/agents/callback-token-panel";
import { HandoffPanel } from "@/components/agents/handoff-panel";
import { RoutinesList } from "@/components/routines/routines-list";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
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
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentFormValues,
  agentFormSchema,
  agentInputFrom,
} from "@/lib/agents/form";
import {
  deleteAgentMutationOptions,
  duplicateAgentMutationOptions,
  setAgentHiddenMutationOptions,
  setAgentPinnedMutationOptions,
  updateAgentMutationOptions,
} from "@/lib/agents/mutations";
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";
import { isComposing } from "@/lib/composing";
import {
  modelChoiceName,
  modelLibraryQueryOptions,
} from "@/lib/models/queries";
import {
  deletePersonaTemplateMutationOptions,
  personaTemplatesQueryOptions,
  savePersonaTemplateMutationOptions,
} from "@/lib/personas/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { readToolName } from "@/lib/plugins/tool-name";
import type { Persona } from "../../../../shared/persona";

/**
 * A coworker, in a dialog with its own sidebar.
 *
 * The agents screen used to slide this in as a side panel; a profile carries enough distinct
 * concerns — who it is, where it runs, what it may hand work to, and what can be done to it — that
 * a single scrolling column buried the later ones. Each concern is a section here, and the sidebar
 * is the map.
 */
export function AgentDialog({
  agentId,
  open,
  onClose,
}: {
  /** Which coworker to show. Null renders nothing but keeps the dialog mounted for its exit. */
  agentId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={open}>
      {/* p-0/overflow-hidden hands the popup's rounding to the sidebar; wider than the default
          dialog because it holds a two-pane layout, which is the stated reason to deviate. */}
      {/* Tall enough that General's rows and its Delete sit on screen together; the popup's own
          max-h-[85svh] still caps it on a short display, where the main pane scrolls. */}
      <DialogContent className="overflow-hidden p-0 md:max-h-[680px] md:max-w-[700px] lg:max-w-[800px]">
        {/* Keyed by coworker so the section and edit state never carry over from another one. */}
        {agentId ? <AgentDialogBody agentId={agentId} key={agentId} /> : null}
      </DialogContent>
    </Dialog>
  );
}

const SECTIONS = [
  { id: "general", name: "基本信息", icon: IconUser },
  { id: "persona", name: "人设", icon: IconBrain },
  { id: "access", name: "权限", icon: IconPuzzle },
  { id: "connection", name: "连接", icon: IconPlugConnected },
  { id: "handoff", name: "交接", icon: IconArrowsExchange },
  { id: "routines", name: "定时任务", icon: IconClock },
  { id: "manage", name: "管理", icon: IconAdjustments },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** The three parts a persona is written in, in the order they are shown and read. */
const PERSONA_PARTS: {
  key: keyof Persona;
  label: string;
  hint: string;
}[] = [
  {
    key: "tone",
    label: "怎么说话",
    hint: "语气、措辞、直接程度——它说出来的话是什么样子。",
  },
  {
    key: "principles",
    label: "怎么做事",
    hint: "它干活时遵守的规矩。",
  },
  {
    key: "habits",
    label: "一贯会做的事",
    hint: "别人可以指望它一定会说、或一定会拒绝的那些话。",
  },
];

const emptyPersona: Persona = { tone: "", principles: "", habits: "" };

function AgentDialogBody({ agentId }: { agentId: string }) {
  const [section, setSection] = useState<SectionId>("general");
  const agent = useQuery(agentQueryOptions(agentId));

  if (agent.isPending) {
    return (
      <div className="flex h-[640px] max-h-[80svh] flex-col gap-4 p-6">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (agent.error || !agent.data) {
    return (
      <p className="p-6 text-sm text-destructive" role="alert">
        读不到这位员工。
      </p>
    );
  }
  const profile = agent.data;
  const active = SECTIONS.find((candidate) => candidate.id === section);

  return (
    <>
      <DialogTitle className="sr-only">{profile.name}</DialogTitle>
      {/* min-h-full overrides the provider's own min-h-svh, which is sized for a page. */}
      <SidebarProvider className="min-h-full items-start">
        <Sidebar className="hidden md:flex" collapsible="none">
          {/* Who this dialog is about, said once here rather than repeated per section. */}
          <SidebarHeader className="flex-row items-center gap-3 p-4">
            <AbstractAvatar
              name={profile.name}
              seed={profile.avatarSeed}
              size={36}
            />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">
                {profile.name}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {profile.title}
              </span>
            </div>
          </SidebarHeader>
          <SidebarContent className="mt-2">
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu className="gap-px">
                  {SECTIONS.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={item.id === section}
                        onClick={() => setSection(item.id)}
                      >
                        <item.icon />
                        <span>{item.name}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <main className="flex h-[640px] max-h-[80svh] flex-1 flex-col overflow-hidden">
          {/*
           * The sidebar hides below md, and without this strip that left the sections unreachable
           * on a phone: the dialog opened on General and nothing could leave it. A scrollable row
           * of the same sections, shown only where the sidebar is not. The identity the sidebar
           * header carries rides along, with room kept for the popup's close button.
           */}
          <div className="flex shrink-0 flex-col gap-2 border-b border-border p-3 pr-12 md:hidden">
            <div className="flex items-center gap-2">
              <AbstractAvatar
                name={profile.name}
                seed={profile.avatarSeed}
                size={28}
              />
              <span className="truncate text-sm font-medium">
                {profile.name}
              </span>
            </div>
            <div className="flex gap-1 overflow-x-auto">
              {SECTIONS.map((item) => (
                <Button
                  className="shrink-0"
                  key={item.id}
                  onClick={() => setSection(item.id)}
                  size="sm"
                  variant={item.id === section ? "secondary" : "ghost"}
                >
                  <item.icon />
                  {item.name}
                </Button>
              ))}
            </div>
          </div>
          <header className="flex h-14 shrink-0 items-center gap-2 px-6">
            <h2 className="text-sm font-medium">{active?.name}</h2>
          </header>
          <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
            {section === "general" ? (
              <GeneralSection agentId={agentId} profile={profile} />
            ) : section === "persona" ? (
              <PersonaSection agentId={agentId} profile={profile} />
            ) : section === "access" ? (
              <AccessSection agentId={agentId} />
            ) : section === "connection" ? (
              <ConnectionSection agentId={agentId} profile={profile} />
            ) : section === "handoff" ? (
              <HandoffPanel agentId={agentId} />
            ) : section === "routines" ? (
              <RoutinesList agentId={agentId} embedded />
            ) : (
              <ManageSection agentId={agentId} profile={profile} />
            )}
          </div>
        </main>
      </SidebarProvider>
    </>
  );
}

/**
 * One field at a time, over the whole update endpoint.
 *
 * The API takes the full profile, so the fields nobody touched ride along as they are on screen — and
 * the empty key means "keep the current one". Every section that edits a coworker writes through
 * this, because a section that rebuilt the input itself would be a second place to get the carry-over
 * wrong, and the way to get it wrong is the same each time: send one field, lose the others.
 */
export function useProfileSave(agentId: string, profile: AgentProfile) {
  const queryClient = useQueryClient();
  const updateAgent = useMutation(updateAgentMutationOptions(queryClient));
  const save = (patch: Partial<AgentFormValues> & { persona?: Persona }) =>
    updateAgent.mutateAsync({
      agentId,
      input: agentInputFrom({
        name: profile.name,
        title: profile.title,
        roleDescription: profile.roleDescription,
        visibility: profile.visibility,
        /*
         * Not a built-in coworker's endpoint. That is the managed Bot's own address, which nobody
         * typed, and the route checks any endpoint it is sent as one somebody did: on a deployment
         * whose Bot is on localhost it refused every edit. Empty leaves the stored one where it is.
         */
        endpoint: profile.builtIn ? "" : (profile.endpoint ?? ""),
        authValue: "",
        ...patch,
      }),
    });
  return { save, saving: updateAgent.isPending };
}

function GeneralSection({
  agentId,
  profile,
}: {
  agentId: string;
  profile: AgentProfile;
}) {
  const navigate = useNavigate();
  const { save } = useProfileSave(agentId, profile);

  return (
    <>
      {/* Each stands on its own — muted, not bg-card, which is invisible against a popup — and
          each edits in place: the field somebody wants to change is the only one that opens. */}
      <div className="flex flex-col gap-2">
        <EditableTextItem
          canManage={profile.canManage}
          label="名字"
          onSave={(name) => save({ name })}
          schema={agentFormSchema.shape.name}
          value={profile.name}
        />
        <EditableTextItem
          canManage={profile.canManage}
          label="头衔"
          onSave={(title) => save({ title })}
          schema={agentFormSchema.shape.title}
          value={profile.title}
        />
        <EditableTextItem
          canManage={profile.canManage}
          label="角色"
          multiline
          onSave={(roleDescription) => save({ roleDescription })}
          schema={agentFormSchema.shape.roleDescription}
          value={profile.roleDescription}
        />
        <VisibilityItem
          canManage={profile.canManage}
          onSave={(visibility) => save({ visibility })}
          value={profile.visibility}
        />
        <ModelItem
          builtIn={profile.builtIn}
          canManage={profile.canManage}
          modelRef={profile.modelRef}
          onSave={(modelRef) => save({ modelRef })}
        />
        {profile.systemOwned ? (
          <Item variant="muted">
            <ItemContent>
              <ItemTitle>系统自带</ItemTitle>
              <ItemDescription>随部署一起提供，不属于某个人。</ItemDescription>
            </ItemContent>
          </Item>
        ) : null}
      </div>

      <Item variant="muted">
        <ItemContent>
          <ItemTitle>装配</ItemTitle>
          <ItemDescription>
            它用哪个模型、什么人设、能碰到什么，在一屏里定。
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            render={(props) => (
              <Link {...props} params={{ agentId }} to="/assemble/$agentId" />
            )}
            size="sm"
          >
            打开
          </Button>
        </ItemActions>
      </Item>

      <Item variant="muted">
        <ItemContent>
          <ItemTitle>开始对话</ItemTitle>
          <ItemDescription>和这位员工开一个新频道。</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            onClick={() =>
              void navigate({
                search: { agent: agentId },
                to: "/channel/new",
              })
            }
            size="sm"
          >
            开始
          </Button>
        </ItemActions>
      </Item>
    </>
  );
}

/**
 * One fact about the coworker, edited in place.
 *
 * Only the field somebody wants to change opens: Edit swaps this item — and this item alone — for
 * its input, validated against the same limits the server enforces, and Save writes just it back.
 */
function EditableTextItem({
  label,
  value,
  canManage,
  multiline = false,
  schema,
  onSave,
}: {
  label: string;
  value: string;
  canManage: boolean;
  /** A textarea rather than an input, for the field that is a paragraph. */
  multiline?: boolean;
  /** The field's slice of the shared form contract, so errors match the server's limits. */
  schema: ZodType<string>;
  onSave: (draft: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setEditing(false);
    setError(null);
  };
  const submit = async () => {
    const parsed = schema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "That value does not fit.");
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed.data);
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <Item variant="muted">
        <ItemContent>
          <ItemTitle>{label}</ItemTitle>
        </ItemContent>
        <ItemActions className="min-w-0">
          <span
            className={`text-right text-sm text-muted-foreground ${
              multiline ? "line-clamp-2 whitespace-pre-wrap" : "truncate"
            }`}
          >
            {value}
          </span>
          {canManage ? (
            <Button
              aria-label={`编辑${label}`}
              onClick={() => {
                setDraft(value);
                setEditing(true);
              }}
              size="icon-sm"
              variant="ghost"
            >
              <IconPencil />
            </Button>
          ) : null}
        </ItemActions>
      </Item>
    );
  }

  return (
    <Item variant="muted">
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        {multiline ? (
          <Textarea
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            rows={4}
            value={draft}
          />
        ) : (
          <Input
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Not the Enter that confirms a composed character: that one would save the value
              // before the person has finished typing it.
              if (event.key === "Enter" && !isComposing(event)) {
                event.preventDefault();
                void submit();
              }
            }}
            value={draft}
          />
        )}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-1 flex gap-2">
          <Button disabled={saving} onClick={() => void submit()} size="sm">
            {saving ? "正在保存…" : "保存"}
          </Button>
          <Button disabled={saving} onClick={close} size="sm" variant="outline">
            取消
          </Button>
        </div>
      </ItemContent>
    </Item>
  );
}

/**
 * Visibility is two named choices, so it edits as a select that writes on pick — no open state and
 * no Save, because there is no draft worth holding: the pick is the whole of the change.
 */
function VisibilityItem({
  value,
  canManage,
  onSave,
}: {
  value: AgentProfile["visibility"];
  canManage: boolean;
  onSave: (visibility: AgentProfile["visibility"]) => Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Item variant="muted">
      <ItemContent>
        <ItemTitle>可见范围</ItemTitle>
        <ItemDescription>
          {value === "private"
            ? "只有你能看到它、和它开频道。"
            : "部署里的每个人都能找到并使用它。"}
        </ItemDescription>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions>
        {canManage ? (
          <Select
            disabled={saving}
            // The label map, so the closed trigger says "Private" rather than the raw value.
            items={{ private: "私有", public: "公开" }}
            onValueChange={async (next) => {
              if (next === value) return;
              setError(null);
              setSaving(true);
              try {
                await onSave(next as AgentProfile["visibility"]);
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Could not save.",
                );
              } finally {
                setSaving(false);
              }
            }}
            value={value}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="private">私有</SelectItem>
              <SelectItem value="public">公开</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm text-muted-foreground">
            {value === "private" ? "私有" : "公开"}
          </span>
        )}
      </ItemActions>
    </Item>
  );
}

/** "google-drive" as "Google Drive": the connector key, said the way a person would. */
function connectorName(key: string): string {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * What this coworker may reach when it works: its granted connectors, one row each, and its skills.
 *
 * Read from the same snapshot the runtime offers the Bot, so this shows what a run would actually
 * hold rather than a second opinion. Read-only on purpose — granting is an administrator's, made on
 * the Plugins screens, and a row of switches here would be a second place for the same decision.
 */
function AccessSection({ agentId }: { agentId: string }) {
  const plugins = useQuery(agentPluginsQueryOptions(agentId));

  if (plugins.isPending) return null;
  if (plugins.error || !plugins.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        读不到这位员工能碰到什么。
      </p>
    );
  }

  /* One row per connector, carrying what a person recognises: the tools' names, not their count. */
  const connectors = new Map<string, string[]>();
  for (const tool of plugins.data.tools) {
    const key = tool.ref.split("/")[0] ?? tool.ref;
    let label = readToolName(tool.toolName).label;
    /*
     * Vendors prefix every tool with their own name — "Notion create pages" — which next to a row
     * already titled Notion reads as a stutter. Stripped only as a leading word, and re-cased, so
     * "Notion search" becomes "Search" while "Search notion pages" is left alone.
     */
    const prefix = `${key.toLowerCase()} `;
    if (label.toLowerCase().startsWith(prefix)) {
      const rest = label.slice(prefix.length);
      label = rest ? rest[0]?.toUpperCase() + rest.slice(1) : label;
    }
    const labels = connectors.get(key) ?? [];
    labels.push(label);
    connectors.set(key, labels);
  }
  const skills = plugins.data.skills;

  if (connectors.size === 0 && skills.length === 0) {
    return (
      <Empty className="h-[180px] border border-dashed">
        <EmptyHeader>
          <EmptyTitle className="text-muted-foreground">
            还没有授予任何东西
          </EmptyTitle>
          <EmptyDescription>
            连接器和技能由管理员在插件页里授予。在那之前，这位员工只能对话，别的都做不了。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        这位员工干活时能碰到的东西。由管理员在插件页里授予；没列在这里的，调用时都会被拒绝。
      </p>
      <div className="flex flex-col gap-2">
        {[...connectors.entries()].map(([key, labels]) => (
          <Item key={key} variant="muted">
            <ItemContent>
              <ItemTitle>{connectorName(key)}</ItemTitle>
              <ItemDescription>
                {labels.slice(0, 4).join(", ")}
                {labels.length > 4 ? ` 等另外 ${labels.length - 4} 项` : ""}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-sm text-muted-foreground tabular-nums">
                {labels.length} 个工具
              </span>
            </ItemActions>
          </Item>
        ))}
        {skills.map((skill) => (
          <Item key={skill.slug} variant="muted">
            <ItemContent>
              <ItemTitle>{skill.title}</ItemTitle>
              <ItemDescription>{skill.summary}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-sm text-muted-foreground">技能</span>
            </ItemActions>
          </Item>
        ))}
      </div>
    </>
  );
}

function ConnectionSection({
  agentId,
  profile,
}: {
  agentId: string;
  profile: AgentProfile;
}) {
  /*
   * A built-in coworker is done the moment it exists: it runs on the deployment's own Bot, whose
   * process already holds the deployment's tool credential, so its tool calls authenticate with no
   * setup. Showing it the endpoint and the callback-token panel told the person the opposite —
   * an internal address they never typed, and a credential they were never supposed to need.
   */
  if (!profile.endpoint || profile.builtIn) {
    return (
      <p className="text-sm text-muted-foreground">
        运行在这个部署自带的员工上。不需要连接、也不需要认证：它调用工具用的是部署自己的凭据。
      </p>
    );
  }
  return (
    <>
      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          端点
        </h2>
        <p className="break-all font-mono text-sm">{profile.endpoint}</p>
      </section>
      {profile.canManage ? (
        <CallbackTokenPanel
          agentId={agentId}
          hasToken={profile.hasCallbackToken}
        />
      ) : null}
    </>
  );
}

/**
 * Who this coworker is, in the words of the person who owns it.
 *
 * Written as a whole rather than part by part: a persona is read as one character, and the line
 * somebody deleted should stop being said on the next turn instead of lingering in the stored one.
 *
 * A saved persona is copied in, never referenced. That is what makes the reuse safe to offer —
 * handing "Careful reviewer" to a new coworker cannot leave the two of them tied together, so
 * editing one later does not silently rewrite the other, and forgetting a template changes nobody's
 * behaviour.
 */
export function PersonaSection({
  agentId,
  profile,
}: {
  agentId: string;
  profile: AgentProfile;
}) {
  const queryClient = useQueryClient();
  const { save, saving } = useProfileSave(agentId, profile);
  const templates = useQuery(personaTemplatesQueryOptions());
  const saveTemplate = useMutation(
    savePersonaTemplateMutationOptions(queryClient),
  );
  const removeTemplate = useMutation(
    deletePersonaTemplateMutationOptions(queryClient),
  );
  const [draft, setDraft] = useState<Persona>(profile.persona ?? emptyPersona);
  const [templateName, setTemplateName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const current = profile.persona ?? emptyPersona;
  const dirty = PERSONA_PARTS.some(
    (part) => draft[part.key] !== current[part.key],
  );
  const trimmed = (): Persona => ({
    tone: draft.tone.trim(),
    principles: draft.principles.trim(),
    habits: draft.habits.trim(),
  });
  const written = Object.values(trimmed()).some((value) => value.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        这位员工是什么样的，和它的角色分开维护。角色决定做什么，人设决定怎么做，在每个频道的每一轮都会带上。
      </p>
      {PERSONA_PARTS.map((part) => (
        <label
          className="flex flex-col gap-1"
          htmlFor={`persona-${part.key}`}
          key={part.key}
        >
          <span className="font-medium text-sm">{part.label}</span>
          <span className="text-muted-foreground text-xs">{part.hint}</span>
          <Textarea
            id={`persona-${part.key}`}
            maxLength={2000}
            onChange={(event) =>
              setDraft((draft) => ({
                ...draft,
                [part.key]: event.target.value,
              }))
            }
            rows={3}
            value={draft[part.key]}
          />
        </label>
      ))}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="text-muted-foreground text-sm">{notice}</p>
      ) : null}
      <div className="flex gap-2">
        <Button
          disabled={saving || !dirty}
          onClick={async () => {
            setError(null);
            setNotice(null);
            try {
              await save({ persona: trimmed() });
              setNotice("Saved. It applies from the coworker's next turn.");
            } catch (failure) {
              setError(
                failure instanceof Error ? failure.message : "Could not save.",
              );
            }
          }}
          size="sm"
        >
          {saving ? "正在保存…" : "保存"}
        </Button>
        {profile.persona ? (
          <Button
            disabled={saving}
            onClick={async () => {
              setError(null);
              setDraft(emptyPersona);
              try {
                await save({ persona: emptyPersona });
                setNotice("Cleared.");
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Could not save.",
                );
              }
            }}
            size="sm"
            variant="outline"
          >
            清空
          </Button>
        ) : null}
      </div>

      <Separator className="my-1" />

      <div className="flex flex-col gap-2">
        <span className="font-medium text-sm">复用一个人设</span>
        <p className="text-muted-foreground text-xs">
          存下的人设是复制进来的，不是链接——之后改它不会影响别人。
        </p>
        {templates.isError ? (
          <p className="text-destructive text-sm" role="status">
            读不到你存下的人设。
          </p>
        ) : null}
        {(templates.data ?? []).length === 0 ? (
          <p className="text-muted-foreground text-sm">
            还没有存过。在上面写一个，再存下来给下一位员工用。
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {(templates.data ?? []).map((template) => (
              <Item key={template.id} variant="muted">
                <ItemContent>
                  <ItemTitle>{template.name}</ItemTitle>
                  <ItemDescription>
                    {PERSONA_PARTS.map((part) =>
                      template.persona[part.key].trim(),
                    )
                      .filter(Boolean)
                      .join(" · ")}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    onClick={() => {
                      setDraft(template.persona);
                      setError(null);
                      setNotice(
                        `已把「${template.name}」填进上面的输入框，保存后才会给到这位员工。`,
                      );
                    }}
                    size="sm"
                    variant="outline"
                  >
                    载入
                  </Button>
                  <Button
                    disabled={removeTemplate.isPending}
                    onClick={() => removeTemplate.mutate(template.id)}
                    size="sm"
                    variant="ghost"
                  >
                    删掉
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </div>
        )}
        <div className="flex items-start gap-2">
          <Input
            disabled={!written || saveTemplate.isPending}
            onChange={(event) => setTemplateName(event.target.value)}
            placeholder="给这个人设起个名字"
            value={templateName}
          />
          <Button
            disabled={
              !written || !templateName.trim() || saveTemplate.isPending
            }
            onClick={() => {
              setError(null);
              saveTemplate.mutate(
                { name: templateName.trim(), persona: trimmed() },
                {
                  onSuccess: () => {
                    setTemplateName("");
                    setNotice("Saved for reuse.");
                  },
                  onError: (failure) =>
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : "Could not save.",
                    ),
                },
              );
            }}
            size="sm"
            variant="outline"
          >
            {saveTemplate.isPending ? "正在保存…" : "存为模板"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which model this coworker answers with — the deployment's own, or one entry of this person's
 * model library.
 *
 * Offered only to a coworker that runs here. A remote one answers on somebody else's server, where
 * the model was chosen long before this screen, and a picker that looked like it worked there would
 * be a second place for a decision this deployment does not make.
 *
 * A model switched off stays in the list, marked, rather than dropping out: the binding is still on
 * the row, and a run on it falls back to the deployment's model. Showing "Deployment model" for a
 * coworker that is pointed at something else would be the screen disagreeing with the person's own
 * last choice.
 */
export function ModelItem({
  modelRef,
  builtIn,
  canManage,
  onSave,
}: {
  modelRef: string | null;
  /** Whether this coworker runs on this deployment, which is what makes a binding mean anything. */
  builtIn: boolean;
  canManage: boolean;
  onSave: (modelRef: string | null) => Promise<unknown>;
}) {
  const models = useQuery(modelLibraryQueryOptions());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!builtIn) return null;

  const connected = models.data?.models ?? [];
  const items: Record<string, string> = {
    none: "部署自带的模型",
    ...Object.fromEntries(
      connected.map((model) => [
        model.id,
        model.enabled
          ? modelChoiceName(model)
          : `${modelChoiceName(model)} (switched off)`,
      ]),
    ),
  };
  // A binding to a model this library no longer lists is shown as what it has become: the run takes
  // the deployment's model, and the trigger says so instead of holding a dead id.
  const current = modelRef && items[modelRef] ? modelRef : "none";

  return (
    <Item variant="muted">
      <ItemContent>
        <ItemTitle>模型</ItemTitle>
        <ItemDescription>
          {connected.length === 0
            ? "还没有接入任何模型，所以这位员工用部署自带的模型回答。"
            : "可以给每位员工选不同的模型：开发用一个，审核用另一个。"}
        </ItemDescription>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions>
        {canManage ? (
          <Select
            disabled={saving || models.isPending}
            items={items}
            onValueChange={async (next) => {
              if ((next === "none" ? null : next) === modelRef) return;
              setError(null);
              setSaving(true);
              try {
                await onSave(next === "none" ? null : next);
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Could not save.",
                );
              } finally {
                setSaving(false);
              }
            }}
            value={current}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(items).map(([value, name]) => (
                <SelectItem key={value} value={value}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm text-muted-foreground">
            {items[current] ?? "部署自带的模型"}
          </span>
        )}
      </ItemActions>
    </Item>
  );
}

function ManageSection({
  agentId,
  profile,
}: {
  agentId: string;
  profile: AgentProfile;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const setPinned = useMutation(setAgentPinnedMutationOptions(queryClient));
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const duplicateAgent = useMutation(
    duplicateAgentMutationOptions(queryClient),
  );
  const deleteAgent = useMutation(deleteAgentMutationOptions(queryClient));
  const actionError =
    setPinned.error ?? setHidden.error ?? duplicateAgent.error;

  return (
    <>
      {/* The same gap the General items keep, so the two screens read as one list style. */}
      <div className="flex flex-col gap-2">
        <Item variant="muted">
          <ItemContent>
            <ItemTitle>{profile.pinned ? "已置顶" : "置顶"}</ItemTitle>
            <ItemDescription>
              {profile.pinned
                ? "在你的员工列表最上面。不影响任何其他人。"
                : "把它放在你的员工列表最上面。不影响任何其他人。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              disabled={setPinned.isPending}
              onClick={() =>
                setPinned.mutate({ agentId, pinned: !profile.pinned })
              }
              size="sm"
              variant="outline"
            >
              {setPinned.isPending
                ? profile.pinned
                  ? "正在取消置顶…"
                  : "正在置顶…"
                : profile.pinned
                  ? "取消置顶"
                  : "置顶"}
            </Button>
          </ItemActions>
        </Item>

        <Item variant="muted">
          <ItemContent>
            <ItemTitle>{profile.hidden ? "已隐藏" : "隐藏"}</ItemTitle>
            <ItemDescription>
              {profile.hidden
                ? "已从你的员工列表里隐藏。不影响任何其他人。"
                : "从你的员工列表里拿掉。不影响任何其他人。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              disabled={setHidden.isPending}
              onClick={async () => {
                await setHidden.mutateAsync({
                  agentId,
                  hidden: !profile.hidden,
                });
                if (!profile.hidden)
                  await navigate({ search: {}, to: "/agents" });
              }}
              size="sm"
              variant="outline"
            >
              {setHidden.isPending
                ? profile.hidden
                  ? "正在取消隐藏…"
                  : "正在隐藏…"
                : profile.hidden
                  ? "取消隐藏"
                  : "隐藏"}
            </Button>
          </ItemActions>
        </Item>

        <Item variant="muted">
          <ItemContent>
            <ItemTitle>复制一份</ItemTitle>
            <ItemDescription>
              复制一份归你，不带密钥、不带频道。
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              disabled={duplicateAgent.isPending}
              onClick={async () => {
                const copy = await duplicateAgent.mutateAsync(agentId);
                await navigate({ search: { agent: copy.id }, to: "/agents" });
              }}
              size="sm"
              variant="outline"
            >
              {duplicateAgent.isPending ? "正在复制…" : "复制一份"}
            </Button>
          </ItemActions>
        </Item>

        {profile.canManage ? (
          <Item variant="muted">
            <ItemContent>
              <ItemTitle>删除</ItemTitle>
              <ItemDescription>删除后无法撤销。</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                onClick={() => setConfirmingDelete(true)}
                size="sm"
                variant="destructive"
              >
                删除
              </Button>
            </ItemActions>
          </Item>
        ) : null}
      </div>

      {actionError ? (
        <p className="text-sm text-destructive" role="alert">
          {actionError.message}
        </p>
      ) : null}

      {/* Stacked over the agent dialog: destroying something deserves its own moment, and the
          question keeps the name in it so the wrong tab cannot delete the wrong coworker. */}
      <Dialog
        onOpenChange={(next) => !next && setConfirmingDelete(false)}
        open={confirmingDelete}
      >
        <DialogContent
          className="max-w-sm"
          overlayClassName="bg-black/20 supports-backdrop-filter:backdrop-blur-sm"
        >
          <DialogHeader>
            <DialogTitle>删除「{profile.name}」？</DialogTitle>
            <DialogDescription>删除后无法撤销。</DialogDescription>
          </DialogHeader>
          {deleteAgent.error ? (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {deleteAgent.error.message}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setConfirmingDelete(false)}
              size="sm"
              variant="outline"
            >
              取消
            </Button>
            <Button
              disabled={deleteAgent.isPending}
              onClick={async () => {
                await deleteAgent.mutateAsync(agentId);
                await navigate({ search: {}, to: "/agents" });
              }}
              size="sm"
              variant="destructive"
            >
              {deleteAgent.isPending ? "正在删除…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
