import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";
import type { NavigationItem } from "@/lib/navigation";

type NavigationTargetProps = {
  /** How the link looks while it is the current page. */
  activeProps?: LinkProps["activeProps"];
  "aria-current"?: "page";
  "aria-label"?: string;
  children?: React.ReactNode;
  className?: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
};

/**
 * The element a navigation entry is drawn as, for a `render` prop: a link to its page. Every frame
 * that draws the navigation list goes through here, so every skin draws an entry the same way.
 */
export function navigationRender(
  item: NavigationItem,
  props: NavigationTargetProps = {},
): React.ReactElement {
  return <Link {...props} to={item.to} />;
}

/** The same, as a component, for a frame that draws an entry with children of its own. */
export function NavigationTarget({
  activeProps,
  item,
  onClick,
  ...props
}: NavigationTargetProps & { item: NavigationItem }) {
  return (
    <Link {...props} activeProps={activeProps} onClick={onClick} to={item.to} />
  );
}
