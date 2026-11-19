import logo256 from "@/assets/brand/xiongbao-logo-256.png";
import { cn } from "@/lib/utils";

/**
 * The product's logo: 熊宝, the 京剧脸谱 red panda in a black hoodie, framed in glowing gold. The
 * file is the logo cut to its rounded square, so it sits on any ground in either theme.
 *
 * `alt` is empty by default because the logo usually stands beside the product's written name; pass
 * one where the picture is the only thing naming what it stands for.
 */
export function BrandLogo({
  size,
  alt = "",
  className,
}: {
  size: number;
  alt?: string;
  className?: string;
}) {
  return (
    <img
      alt={alt}
      className={cn("shrink-0 select-none", className)}
      decoding="async"
      draggable={false}
      height={size}
      src={logo256}
      width={size}
    />
  );
}
