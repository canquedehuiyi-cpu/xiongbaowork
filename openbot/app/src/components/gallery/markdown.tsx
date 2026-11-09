import { useContext, useState } from "react";
import { Streamdown } from "streamdown";
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
import { markdownComponents } from "@/lib/markdown";
=======
import {
  markdownComponents,
  markdownPlugins,
  replyRemarkPlugins,
} from "@/lib/markdown";
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
import { cn } from "@/lib/utils";
import { GalleryStreamingContext } from "./streaming";

/**
 * Text a Bot wrote into a card, drawn the way its reply draws it.
 *
 * WHY. A Bot writes a card's text the way it writes a reply, in markdown. Asked for its five most
 * recent unread emails "with a link to each message", a Bot drew a notice whose every point was
 * `[Sender](https://mail.google.com/mail/u/0/#inbox/…) — 5:00 pm. …`, and the card drew that
 * literally: brackets, parentheses and the whole Gmail address on every line, and nothing to click.
 *
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
 * THE REPLY'S RENDERER, NOT A SECOND ONE. The same Streamdown and components as a Bot's reply in
 * the transcript, so a link is the same link (a new tab, no referrer, which OpenBot Desktop hands to
 * the person's own browser), a connected document is the same chip, and raw HTML is dropped by the
 * same sanitising. Nothing here can drift from the transcript. This fork's transcript passes
 * Streamdown no code or remark plugins (upstream's `markdownPlugins` and `replyRemarkPlugins` are
 * not ported), so neither does this.
=======
 * THE REPLY'S RENDERER, NOT A SECOND ONE. The same Streamdown, components, plugins and line endings
 * as a Bot's reply in the transcript, so a link is the same link (a new tab, no referrer, which
 * OpenBot Desktop hands to the person's own browser), a connected document is the same chip, and raw
 * HTML is dropped by the same sanitising. Nothing here can drift from the transcript.
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
 *
 * A LONG LINK WRAPS. A card is narrower than a reply and clips what runs past its edge, so a long
 * URL or path in its text breaks across lines rather than losing its end. Code blocks still scroll.
 *
 * FOR PROSE ONLY. A card's title, caption and labels stay plain: they are one line, cut to fit.
 *
 * Streaming is decided once, when the card mounts, as the transcript decides it for a message: a card
 * drawn while its arguments arrive closes a half-written link or bold marker for the duration rather
 * than flashing the markers, and the renderer never changes under the reader once they are in.
 */
export function GalleryMarkdown({
  children,
  className,
}: {
  children: string | undefined;
  className?: string;
}) {
  const streaming = useContext(GalleryStreamingContext);
  const [mode] = useState<"static" | "streaming">(
    streaming ? "streaming" : "static",
  );
  if (!children) return null;
  return (
    <Streamdown
      className={cn("break-words", className)}
      components={markdownComponents}
      mode={mode}
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
=======
      plugins={markdownPlugins}
      remarkPlugins={replyRemarkPlugins}
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
    >
      {children}
    </Streamdown>
  );
}
