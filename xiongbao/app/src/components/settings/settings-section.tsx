import { PageSection } from "@/components/layout/page-shell";
import {
  type SectionAudience,
  shows,
  useSettingsAudience,
} from "@/lib/settings/audience";

/** 团队管理员的节在描述前固定加的一句：说明谁看得到、改动影响谁。 */
export const TEAM_ADMIN_NOTE = "只有管理员看得到。改动对所有成员生效。";

const EVERYONE: SectionAudience = { who: "everyone", edition: "both" };

/**
 * 设置话题页上的一节。受众不满足时返回 null；受众受限的节在用户与版本都读完之前也不画（不闪）。
 * `id` 是锚点，落在节的 `<section>` 上。
 */
export function SettingsSection({
  audience = EVERYONE,
  children,
  description,
  id,
  title,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  audience?: SectionAudience;
  children: React.ReactNode;
}) {
  const current = useSettingsAudience();
  if (!shows(audience, current)) return null;
  return (
    <PageSection
      description={
        audience.who === "team-admin" ? (
          <>
            {TEAM_ADMIN_NOTE}
            {description}
          </>
        ) : (
          description
        )
      }
      id={id}
      title={title}
    >
      {children}
    </PageSection>
  );
}
