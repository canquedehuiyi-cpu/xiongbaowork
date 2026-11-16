import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { summonAnchor } from "@/components/bots/summon-card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 「去人才市场」: the way to summon an employee from anywhere else (召唤员工 Task 10). Summoning happens
 * only on 人才市场 (`/bots`); with `agentId` the link lands on that employee's 待召唤 card. A real
 * link drawn as a button, so it opens in a new tab like any other address.
 */
export function TalentMarketLink({
  agentId,
  className,
  size = "sm",
  variant = "outline",
  children = "去人才市场",
}: {
  agentId?: string;
  className?: string;
  size?: "xs" | "sm" | "default";
  variant?: "outline" | "default" | "ghost";
  children?: React.ReactNode;
}) {
  return (
    <Link
      className={cn(buttonVariants({ size, variant }), className)}
      hash={agentId ? summonAnchor(agentId) : undefined}
      to="/bots"
    >
      {children}
    </Link>
  );
}
