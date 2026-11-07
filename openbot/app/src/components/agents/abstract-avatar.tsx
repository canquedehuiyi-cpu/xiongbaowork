import Avatar from "boring-avatars";

export function AbstractAvatar({
  name,
  seed,
  size = 40,
  decorative = false,
}: {
  name: string;
  seed: string;
  size?: number;
  /**
   * The name is already written beside it (a roster row, a header): draw the face only, so the
   * coworker is announced once and nothing else carries their bare name as a label.
   */
  decorative?: boolean;
}) {
  if (decorative) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex shrink-0 overflow-hidden rounded-full"
        style={{ height: size, width: size }}
      >
        <Avatar name={seed} size={size} />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={name}
      className="inline-flex shrink-0 overflow-hidden rounded-full"
      style={{ height: size, width: size }}
    >
      {/* The drawing carries its own role; hidden so the coworker is announced once, by name. */}
      <span aria-hidden="true" className="contents">
        <Avatar name={seed} size={size} />
      </span>
    </span>
  );
}
