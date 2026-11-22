import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Empty as KumoEmpty } from "@cloudflare/kumo/components/empty";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Tray, X } from "@phosphor-icons/react";
import { Component, type ReactNode } from "react";
import { message } from "../../assets/scripts/api";
import { english, useT } from "../../i18n";
import { HelpTip } from "../kumo-ext";
import "./style.css";

export function PageHeader({
  title,
  description,
  help,
  badge,
  action,
}: {
  title: string;
  description?: string;
  help?: string;
  badge?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-kumo-line pb-5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-strong sm:text-[1.625rem]">
            {title}
          </h1>
          {badge}
          {help && <HelpTip content={help} />}
        </div>
        {description && (
          <p className="text-sm leading-relaxed text-kumo-subtle">
            {description}
          </p>
        )}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2 shrink-0">{action}</div>}
    </header>
  );
}

export function SectionCard({
  title,
  description,
  help,
  action,
  footer,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: string;
  description?: string;
  help?: string;
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <LayerCard render={<section />} className={`overflow-hidden min-w-0 ${className}`}>
      {(title || description || action) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line px-5 py-3.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && (
              <div className="flex items-center gap-1.5">
                <h2 className="text-base font-semibold text-kumo-strong">{title}</h2>
                {help && <HelpTip content={help} />}
              </div>
            )}
            {description && <p className="text-xs text-kumo-subtle">{description}</p>}
          </div>
          {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={`p-5 ${bodyClassName}`}>{children}</div>
      {footer && (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line bg-kumo-recessed/40 px-5 py-3">
          {footer}
        </footer>
      )}
    </LayerCard>
  );
}

export function Banner({ error, children }: { error?: unknown; children?: ReactNode }) {
  if (!error && !children) return null;
  return (
    <KumoBanner
      size="sm"
      variant={error ? "error" : "default"}
      role={error ? "alert" : "status"}
      description={error ? message(error) : children}
    />
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <KumoEmpty
      size="sm"
      icon={<Tray size={22} aria-hidden />}
      title={title}
      description={typeof children === "string" ? children : undefined}
      contents={
        <>
          {typeof children !== "string" && children}
          {action}
        </>
      }
      className="empty-state"
    />
  );
}

export function Loading({ label }: { label?: string }) {
  const t = useT("common");
  return (
    <div className="flex min-h-32 items-center justify-center gap-2.5 p-6 text-sm text-kumo-subtle" role="status">
      <Loader size={18} />
      <span>{label ?? t("loading", "Loading…")}</span>
    </div>
  );
}

export class PageErrorBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <PageLoadFailed />;
  }
}

function PageLoadFailed() {
  const t = useT("common");
  return (
    <Empty
      title={english("common", "pageUnavailable", "Page unavailable")}
      action={<Button variant="secondary" onClick={() => location.reload()}>{t("reload", "Reload page")}</Button>}
    >
      {english("common", "interrupted", "An error interrupted this page. Reload it to try again.")}
    </Empty>
  );
}

const statusVariant = {
  neutral: "secondary",
  green: "success",
  blue: "info",
  amber: "warning",
  red: "error",
} as const;

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: keyof typeof statusVariant }) {
  return (
    <Badge variant={statusVariant[tone]} className="console-badge">
      {children}
    </Badge>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  pending = false,
  children,
  large = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  pending?: boolean;
  children: ReactNode;
  large?: boolean;
}) {
  const t = useT("common");
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <Dialog
        size={large ? "xl" : "lg"}
        className="dialog-panel"
        data-kumo-dialog={open ? "open" : undefined}
      >
        <header className="dialog-heading">
          <div className="min-w-0 flex-1">
            <Dialog.Title className="text-base font-semibold text-kumo-strong">{title}</Dialog.Title>
            {description && (
              <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
                {description}
              </Dialog.Description>
            )}
          </div>
          <Dialog.Close
            render={(props) => (
              <Button
                {...props}
                variant="ghost"
                shape="square"
                size="sm"
                aria-label={t("close", "Close")}
                disabled={pending}
              >
                <X size={16} />
              </Button>
            )}
          />
        </header>
        <div className="dialog-body">{children}</div>
      </Dialog>
    </Dialog.Root>
  );
}

export function FormActions({
  onClose,
  pending,
  label,
  destructive = false,
  disabled = false,
}: {
  onClose: () => void;
  pending: boolean;
  label?: string;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const t = useT("common");
  return (
    <div className="dialog-actions">
      <Button variant="secondary" type="button" disabled={pending} onClick={onClose}>
        {t("cancel", "Cancel")}
      </Button>
      <Button
        variant={destructive ? "destructive" : "primary"}
        type="submit"
        loading={pending}
        disabled={disabled}
      >
        {label ?? t("save", "Save changes")}
      </Button>
    </div>
  );
}
