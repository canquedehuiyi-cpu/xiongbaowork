import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * 头像: the picture a person chose for a coworker (员工) or a group (群组), in place of the abstract
 * one drawn from its seed. Either one of 熊宝's five expressions or a picture they uploaded.
 *
 * Called a portrait in code because "avatar" in this codebase already means a person's 分身.
 *
 * Read as one list for the whole workspace (`GET /api/portraits`) rather than as a field on every
 * coworker and group response: rosters, cards, sidebars and member stacks all draw faces, and one
 * cached map serves all of them without touching any of the reads that list the things themselves.
 */
export type PortraitKind = "coworker" | "group";

/** 调皮 · 可爱 · 帅气 · 开心 · 卖萌 — the character sheet's expressions, offered as ready-made faces. */
export const PORTRAIT_PRESETS = [
  { value: "naughty", label: "调皮" },
  { value: "cute", label: "可爱" },
  { value: "cool", label: "帅气" },
  { value: "happy", label: "开心" },
  { value: "sweet", label: "卖萌" },
] as const;

export type PortraitPreset =
  | (typeof PORTRAIT_PRESETS)[number]["value"]
  | BaoRolePreset;

/** 宝小熊的 45 个角色脸（第二批）: one ready-made face per role, grouped by series. */
export const BAO_ROLE_PRESETS = [
  {
    value: "doctor",
    label: "暖心医生",
    subtitle: "医疗健康",
    series: "职业形象系列 01",
    group: "职业形象",
  },
  {
    value: "teacher",
    label: "智慧教师",
    subtitle: "教育培训",
    series: "职业形象系列 01",
    group: "职业形象",
  },
  {
    value: "chef",
    label: "星级主厨",
    subtitle: "餐饮美食",
    series: "职业形象系列 01",
    group: "职业形象",
  },
  {
    value: "tech-engineer",
    label: "科技工程师",
    subtitle: "人工智能",
    series: "职业形象系列 02",
    group: "职业形象",
  },
  {
    value: "financial-advisor",
    label: "理财顾问",
    subtitle: "金融服务",
    series: "职业形象系列 02",
    group: "职业形象",
  },
  {
    value: "lawyer",
    label: "专业律师",
    subtitle: "法律服务",
    series: "职业形象系列 02",
    group: "职业形象",
  },
  {
    value: "construction-engineer",
    label: "建造工程师",
    subtitle: "建筑工程",
    series: "职业形象系列 03",
    group: "职业形象",
  },
  {
    value: "farmer",
    label: "丰收果农",
    subtitle: "现代农业",
    series: "职业形象系列 03",
    group: "职业形象",
  },
  {
    value: "courier",
    label: "快递先锋",
    subtitle: "智慧物流",
    series: "职业形象系列 03",
    group: "职业形象",
  },
  {
    value: "pilot",
    label: "王牌飞行员",
    subtitle: "航空出行",
    series: "职业形象系列 04",
    group: "职业形象",
  },
  {
    value: "firefighter",
    label: "勇敢消防员",
    subtitle: "应急消防",
    series: "职业形象系列 04",
    group: "职业形象",
  },
  {
    value: "tour-guide",
    label: "金牌导游",
    subtitle: "文化旅游",
    series: "职业形象系列 04",
    group: "职业形象",
  },
  {
    value: "journalist",
    label: "现场记者",
    subtitle: "新闻传媒",
    series: "职业形象系列 05",
    group: "职业形象",
  },
  {
    value: "creative-designer",
    label: "灵感设计师",
    subtitle: "创意设计",
    series: "职业形象系列 05",
    group: "职业形象",
  },
  {
    value: "fitness-coach",
    label: "活力教练",
    subtitle: "体育健身",
    series: "职业形象系列 05",
    group: "职业形象",
  },
  {
    value: "general-manager",
    label: "总经理",
    subtitle: "沉稳自信",
    series: "内置员工形象 01",
    group: "内置员工形象",
  },
  {
    value: "accountant",
    label: "会计",
    subtitle: "专注严谨",
    series: "内置员工形象 01",
    group: "内置员工形象",
  },
  {
    value: "operations-director",
    label: "运营总监",
    subtitle: "干练有活力",
    series: "内置员工形象 01",
    group: "内置员工形象",
  },
  {
    value: "designer",
    label: "设计师",
    subtitle: "灵动好奇",
    series: "内置员工形象 02",
    group: "内置员工形象",
  },
  {
    value: "director",
    label: "导演",
    subtitle: "投入专注",
    series: "内置员工形象 02",
    group: "内置员工形象",
  },
  {
    value: "programmer",
    label: "编程大佬",
    subtitle: "机智得意",
    series: "内置员工形象 02",
    group: "内置员工形象",
  },
  {
    value: "social-media-operator",
    label: "自媒体运营官",
    subtitle: "俏皮有感染力",
    series: "内置员工形象 03",
    group: "内置员工形象",
  },
  {
    value: "actor",
    label: "演员",
    subtitle: "温柔有戏感",
    series: "内置员工形象 03",
    group: "内置员工形象",
  },
  {
    value: "singer",
    label: "歌手",
    subtitle: "热情投入",
    series: "内置员工形象 03",
    group: "内置员工形象",
  },
  {
    value: "product-manager",
    label: "产品经理",
    subtitle: "思考有洞察",
    series: "内置员工形象 04",
    group: "内置员工形象",
  },
  {
    value: "data-analyst",
    label: "数据分析师",
    subtitle: "理性而温和",
    series: "内置员工形象 04",
    group: "内置员工形象",
  },
  {
    value: "marketing-director",
    label: "市场总监",
    subtitle: "热情自信",
    series: "内置员工形象 04",
    group: "内置员工形象",
  },
  {
    value: "hr-manager",
    label: "人力资源主管",
    subtitle: "亲切包容",
    series: "内置员工形象 05",
    group: "内置员工形象",
  },
  {
    value: "legal-advisor",
    label: "法务顾问",
    subtitle: "沉着坚定",
    series: "内置员工形象 05",
    group: "内置员工形象",
  },
  {
    value: "customer-service-manager",
    label: "客服主管",
    subtitle: "耐心温暖",
    series: "内置员工形象 05",
    group: "内置员工形象",
  },
  {
    value: "founder-assistant",
    label: "创始人助理",
    subtitle: "机灵周到",
    series: "OPC员工形象 06",
    group: "OPC员工形象",
  },
  {
    value: "project-manager",
    label: "项目经理",
    subtitle: "专注可靠",
    series: "OPC员工形象 06",
    group: "OPC员工形象",
  },
  {
    value: "admin-specialist",
    label: "行政专员",
    subtitle: "亲切利落",
    series: "OPC员工形象 06",
    group: "OPC员工形象",
  },
  {
    value: "sales-consultant",
    label: "销售顾问",
    subtitle: "自信有魅力",
    series: "OPC员工形象 07",
    group: "OPC员工形象",
  },
  {
    value: "business-development",
    label: "商务拓展",
    subtitle: "开放有远见",
    series: "OPC员工形象 07",
    group: "OPC员工形象",
  },
  {
    value: "customer-success",
    label: "客户成功",
    subtitle: "温暖有耐心",
    series: "OPC员工形象 07",
    group: "OPC员工形象",
  },
  {
    value: "copywriter",
    label: "文案策划",
    subtitle: "细腻会思考",
    series: "OPC员工形象 08",
    group: "OPC员工形象",
  },
  {
    value: "brand-planner",
    label: "品牌策划",
    subtitle: "灵感十足",
    series: "OPC员工形象 08",
    group: "OPC员工形象",
  },
  {
    value: "ad-specialist",
    label: "广告投手",
    subtitle: "敏锐果断",
    series: "OPC员工形象 08",
    group: "OPC员工形象",
  },
  {
    value: "store-manager",
    label: "电商店长",
    subtitle: "稳妥有条理",
    series: "OPC员工形象 09",
    group: "OPC员工形象",
  },
  {
    value: "live-stream-operator",
    label: "直播运营",
    subtitle: "热情带节奏",
    series: "OPC员工形象 09",
    group: "OPC员工形象",
  },
  {
    value: "private-domain-operator",
    label: "私域运营",
    subtitle: "俏皮有亲和力",
    series: "OPC员工形象 09",
    group: "OPC员工形象",
  },
  {
    value: "automation-engineer",
    label: "自动化工程师",
    subtitle: "好奇善解题",
    series: "OPC员工形象 10",
    group: "OPC员工形象",
  },
  {
    value: "test-engineer",
    label: "测试工程师",
    subtitle: "严谨又细致",
    series: "OPC员工形象 10",
    group: "OPC员工形象",
  },
  {
    value: "security-officer",
    label: "网络安全官",
    subtitle: "沉稳有担当",
    series: "OPC员工形象 10",
    group: "OPC员工形象",
  },
] as const;

export type BaoRolePreset = (typeof BAO_ROLE_PRESETS)[number]["value"];

/** A role face's group, for the picker's grouped display: 职业 / 内置员工 / OPC 员工. */
export const BAO_ROLE_GROUPS = ["职业形象", "内置员工形象", "OPC员工形象"] as const;

/** 宝小熊的五套服装。第一批只留字段（见 0203 迁移）；按服装出图是第二批。 */
export const PORTRAIT_OUTFITS = [
  { value: "street", label: "潮酷街头" },
  { value: "guofeng", label: "华贵国风" },
  { value: "casual", label: "休闲萌趣" },
  { value: "tech", label: "酷炫科技" },
  { value: "lion", label: "喜庆舞狮" },
] as const;

export type PortraitOutfit = (typeof PORTRAIT_OUTFITS)[number]["value"];

/** A video a person uploaded must fit in this; it has to match the server's limit. */
export const PORTRAIT_VIDEO_MAX_BYTES = 2 * 1024 * 1024;

export type Portrait = {
  kind: PortraitKind;
  id: string;
  /** One of 熊宝's expressions, or null when the portrait is an uploaded picture. */
  preset: PortraitPreset | null;
  /** Where the uploaded picture is served, versioned so a replaced one is fetched again. */
  imageUrl: string | null;
  /** Where an uploaded video is served, or null when there is none; the picture is its poster. */
  videoUrl: string | null;
  /** The 宝小熊 outfit this portrait wears, or null when none was picked (second batch). */
  outfit: PortraitOutfit | null;
  updatedAt: string;
};

export const portraitKeys = {
  all: ["portraits"] as const,
};

export function portraitsQueryOptions() {
  return queryOptions({
    queryKey: portraitKeys.all,
    queryFn: () =>
      client<Portrait[]>("/api/portraits", "portraits", {
        fallback: "读不到自定义头像。",
      }),
    // Faces change when somebody changes one, and that write invalidates this; no polling.
    staleTime: 5 * 60_000,
  });
}

/** `${kind}:${id}` → portrait, for the components that draw one face at a time. */
export function portraitIndex(
  portraits: readonly Portrait[] | undefined,
): Map<string, Portrait> {
  return new Map(
    (portraits ?? []).map((portrait) => [
      `${portrait.kind}:${portrait.id}`,
      portrait,
    ]),
  );
}

export type PortraitChoice =
  | { preset: PortraitPreset }
  /** The picture, already squared and re-encoded in the browser, as base64. */
  | { image: string }
  /** A video, sent as it was picked (the browser does not re-encode video), as base64. */
  | { video: string };

export function setPortraitMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      kind,
      id,
      choice,
      outfit,
    }: {
      kind: PortraitKind;
      id: string;
      choice: PortraitChoice;
      /** The outfit worn with this choice; only the server's known outfits are accepted. */
      outfit?: PortraitOutfit;
    }) =>
      client<Portrait>(
        `/api/portraits/${kind}/${encodeURIComponent(id)}`,
        "portrait",
        {
          method: "PUT",
          body: { ...choice, ...(outfit ? { outfit } : {}) },
          fallback: "头像没有保存成功。",
        },
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: portraitKeys.all }),
  });
}

export function resetPortraitMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({ kind, id }: { kind: PortraitKind; id: string }) =>
      client(`/api/portraits/${kind}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "没能恢复默认头像。",
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: portraitKeys.all }),
  });
}

/** A Blob as the base64 the server's JSON body carries. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
