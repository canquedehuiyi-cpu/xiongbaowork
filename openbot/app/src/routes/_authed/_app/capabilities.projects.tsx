import { createFileRoute } from "@tanstack/react-router";

/** M5b 第 0 步占位：能力 › 公开项目。D 组在这里接熊宝现有的页签内容。 */
export const Route = createFileRoute("/_authed/_app/capabilities/projects")({
  component: CapabilityPlaceholder,
});

function CapabilityPlaceholder() {
  return <h1 className="px-6 py-4 font-semibold text-lg">公开项目</h1>;
}
