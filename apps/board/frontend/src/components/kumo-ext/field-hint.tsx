import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { Info } from "@phosphor-icons/react";
import type { ReactElement, ReactNode } from "react";

export function HelpTip({ content, label }: { content: ReactNode; label?: string }) {
  return (
    <Tooltip
      content={content}
      render={
        <button
          type="button"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2"
          aria-label={label ?? (typeof content === "string" ? content : "More information")}
        >
          <Info size={14} aria-hidden />
        </button>
      }
    />
  );
}

/**
 * Wraps a potentially disabled interactive element so users still receive a
 * Kumo Tooltip explaining why the action is unavailable.
 */
export function ActionTooltip({
  content,
  disabled = false,
  children,
}: {
  content?: ReactNode;
  disabled?: boolean;
  children: ReactElement;
}) {
  if (!content) return children;
  if (disabled) {
    return (
      <Tooltip
        content={content}
        render={<span className="inline-flex cursor-not-allowed">{children}</span>}
      />
    );
  }
  return <Tooltip content={content} render={children} />;
}
