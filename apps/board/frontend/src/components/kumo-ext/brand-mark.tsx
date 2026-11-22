import {
  CirclesFour,
  Compass,
  Cube,
  GlobeHemisphereEast,
  Leaf,
  Lightning,
  ShieldCheck,
  Sparkle,
  type Icon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useTheme } from "../../features/theme";

export type BrandIconPreset =
  | "circles"
  | "leaf"
  | "shield"
  | "globe"
  | "lightning"
  | "compass"
  | "cube"
  | "sparkle";

export const brandIconPresets: Record<BrandIconPreset, { label: string; icon: Icon }> = {
  circles: { label: "Meridian", icon: CirclesFour },
  leaf: { label: "Leaf", icon: Leaf },
  shield: { label: "Shield", icon: ShieldCheck },
  globe: { label: "Globe", icon: GlobeHemisphereEast },
  lightning: { label: "Bolt", icon: Lightning },
  compass: { label: "Compass", icon: Compass },
  cube: { label: "Cube", icon: Cube },
  sparkle: { label: "Sparkle", icon: Sparkle },
};

export function BrandMark({
  iconPreset = "circles",
  logoUrl,
  logoDarkUrl,
  alt = "",
  size = "md",
  className = "",
}: {
  iconPreset?: BrandIconPreset;
  logoUrl?: string | null;
  logoDarkUrl?: string | null;
  alt?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const { resolved } = useTheme();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const candidate = resolved === "dark" ? (logoDarkUrl || logoUrl) : (logoUrl || logoDarkUrl);
  const src = candidate && candidate !== failedSrc ? candidate : null;
  const Glyph = brandIconPresets[iconPreset]?.icon ?? CirclesFour;

  const boxClass =
    size === "sm"
      ? "size-7 rounded-md"
      : size === "lg"
        ? "size-10 rounded-xl"
        : "size-8 rounded-lg";
  const iconSize = size === "sm" ? 16 : size === "lg" ? 22 : 18;

  if (src) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center overflow-hidden border border-kumo-line bg-kumo-base ${boxClass} ${className}`}
      >
        <img
          src={src}
          alt={alt}
          className="size-full object-contain p-0.5"
          onError={() => setFailedSrc(src)}
        />
      </span>
    );
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center text-white shadow-xs ${boxClass} ${className}`}
      style={{ background: "var(--brand-accent)" }}
      aria-hidden={!alt}
    >
      <Glyph size={iconSize} weight="fill" aria-hidden />
    </span>
  );
}
