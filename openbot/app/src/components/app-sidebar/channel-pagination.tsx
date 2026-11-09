import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { ChannelSummary } from "@/lib/channels/queries";

type Props = {
  query: Pick<
    UseInfiniteQueryResult<ChannelSummary[]>,
    | "hasNextPage"
    | "isFetching"
    | "isFetchingNextPage"
    | "isFetchNextPageError"
    | "fetchNextPage"
  >;
  scrollRoot: RefObject<HTMLDivElement | null>;
  searching: boolean;
};

export function ChannelPagination({ query, scrollRoot, searching }: Props) {
  const sentinel = useRef<HTMLDivElement>(null);
  const {
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = query;

  useEffect(() => {
    // Filtering can expose the sentinel immediately. Let people explicitly
    // expand their search instead of downloading their entire history.
    if (
      searching ||
      !hasNextPage ||
      isFetching ||
      isFetchNextPageError ||
      !scrollRoot.current ||
      !sentinel.current ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void fetchNextPage({ cancelRefetch: false });
        }
      },
      { root: scrollRoot.current, rootMargin: "160px 0px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetching,
    scrollRoot,
    searching,
  ]);

  if (!hasNextPage) return null;

  return (
    <div ref={sentinel} className="px-2 py-3 text-center">
      {isFetchNextPageError ? (
        <p role="alert" className="mb-2 text-xs text-muted-foreground">
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
          更早的会话没能加载。
=======
          Couldn't load older conversations.
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
        </p>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="w-full text-xs"
        disabled={isFetching}
        onClick={() => void fetchNextPage({ cancelRefetch: false })}
      >
        {isFetchingNextPage
          ? "正在加载更早的会话…"
          : isFetchNextPageError
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
            ? "重新加载更早的会话"
            : "加载更早的会话"}
=======
            ? "Try again"
            : "Load older conversations"}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
      </Button>
    </div>
  );
}
