import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { ArrowRight, type Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { HelpTip } from "./field-hint";

export function KpiStatCard({
  title,
  value,
  subtitle,
  help,
  icon: IconGlyph,
  badge,
  href,
  footer,
  className = "",
}: {
  title: string;
  value: ReactNode;
  subtitle?: ReactNode;
  help?: string;
  icon?: Icon;
  badge?: ReactNode;
  href?: string;
  footer?: ReactNode;
  className?: string;
}) {
  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-kumo-subtle">
          {IconGlyph && (
            <span
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md"
              style={{ background: "var(--brand-accent-soft)", color: "var(--brand-accent-strong)" }}
              aria-hidden
            >
              <IconGlyph size={15} weight="duotone" />
            </span>
          )}
          <span className="truncate">{title}</span>
          {help && <HelpTip content={help} />}
        </div>
        {badge}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-2xl font-semibold tracking-tight text-kumo-strong tabular-nums">
          {value}
        </div>
        {href && (
          <ArrowRight
            size={15}
            className="shrink-0 text-kumo-subtle transition-transform group-hover/kpi:translate-x-0.5 group-hover/kpi:text-kumo-default"
            aria-hidden
          />
        )}
      </div>
      {subtitle && <div className="text-xs text-kumo-subtle">{subtitle}</div>}
      {footer}
    </>
  );

  if (href) {
    return (
      <LayerCard
        render={<a href={href} />}
        className={`group/kpi flex min-w-0 flex-col justify-between gap-2.5 p-4 no-underline transition-colors hover:border-kumo-interact ${className}`}
      >
        {inner}
      </LayerCard>
    );
  }

  return (
    <LayerCard
      render={<section />}
      className={`flex min-w-0 flex-col justify-between gap-2.5 p-4 ${className}`}
    >
      {inner}
    </LayerCard>
  );
}
