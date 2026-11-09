/*
 * 上游 0069（#871）：员工可以单独拥有一台电脑（`agent_profiles.isolated`）。
 */
ALTER TABLE "agent_profiles" ADD COLUMN "isolated" boolean DEFAULT false NOT NULL;
