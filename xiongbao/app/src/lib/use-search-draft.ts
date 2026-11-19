import { useEffect, useRef, useState } from "react";

/**
 * A workbench search box's own text (员工管理, 自主工作, @Waker). It is mirrored into `?q=`, but drawn from local state: the router
 * commits a navigation asynchronously, and an input controlled by the address alone would be reset
 * to the previous value between keystrokes and drop characters. An address that changes for any
 * other reason (Back, 清除筛选) is taken over.
 */
export function useSearchDraft(fromUrl: string) {
  const [draft, setDraft] = useState(fromUrl);
  const draftRef = useRef(fromUrl);
  const written = useRef(new Set<string>());
  useEffect(() => {
    if (fromUrl === draftRef.current) {
      written.current.clear();
      return;
    }
    if (written.current.has(fromUrl)) return;
    written.current.clear();
    draftRef.current = fromUrl;
    setDraft(fromUrl);
  }, [fromUrl]);
  const write = (next: string) => {
    written.current.add(next);
    draftRef.current = next;
    setDraft(next);
  };
  return [draft, write] as const;
}
