import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Breadcrumbs } from "@cloudflare/kumo/components/breadcrumbs";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { Bell, List } from "@phosphor-icons/react";
import { useRef, type CSSProperties, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../assets/scripts/api";
import { useResource } from "../../app/query";
import type { Area, Route } from "../../app/routes";
import { Banner } from "../../components/console-ui";
import type { Session } from "../../features/session/model";
import { ThemeSwitcher } from "../../features/theme";
import { useLocale, useT } from "../../i18n";
import { LanguagePicker } from "../../i18n/language-picker";
import { FullscreenAnnouncementOverlay } from "../../pages/announcements/fullscreen-overlay";
import { UNREAD, type UnreadSummary } from "../../pages/announcements/model";
import { AccountMenu } from "./account-menu";
import { ConsoleCommands } from "./commands";
import { Navigation, workspaces, workspaceTitle, type BrandAppearance } from "./navigation";
import "./style.css";

export type MaintenanceNotice = {
  enabled: boolean;
  variant: "info" | "warning" | "error";
  title?: string | null;
  message?: string | null;
};

type LayoutProps = {
  area: Area;
  items: Route[];
  allItems: Route[];
  active: string;
  session: Session;
  brand?: BrandAppearance;
  defaultCollapsed?: boolean;
  maintenance?: MaintenanceNotice;
  enabledLocales?: readonly import("../../i18n").Locale[];
  children: ReactNode;
};

export function ConsoleLayout(props: LayoutProps) {
  const { direction } = useLocale();
  return (
    <Sidebar.Provider
      className="console"
      defaultOpen={!props.defaultCollapsed}
      defaultWidth={244}
      mobileBreakpoint={820}
      side={direction === "rtl" ? "right" : "left"}
      style={
        {
          "--sidebar-bg": "var(--color-kumo-base)",
          "--sidebar-active-bg": "var(--brand-accent-soft)",
        } as CSSProperties
      }
    >
      <ConsoleBody {...props} />
    </Sidebar.Provider>
  );
}

function ConsoleBody({
  area,
  items,
  allItems,
  active,
  session,
  brand,
  maintenance,
  enabledLocales,
  children,
}: LayoutProps) {
  const { isMobile, open, openMobile } = useSidebar();
  const trigger = useRef<HTMLButtonElement>(null);
  const t = useT("navigation");
  const hasInbox = allItems.some(({ path }) => path === "/workspace/announcements");
  const unreadSummary = useResource<UnreadSummary>(UNREAD, hasInbox, 60_000).data;
  const unread = unreadSummary?.unread ?? 0;
  const fullscreenNotices = unreadSummary?.fullscreen ?? [];
  const notices = t("noticesUnread", "{count} unread announcements", { count: unread });
  const workspace = workspaces[area];
  const title = workspaceTitle(area, t);
  const AreaIcon = workspace.icon;
  const current = items.find(({ path }) => path === active)?.label;
  const signOut = useMutation({
    mutationFn: () => api("/auth/logout", "POST"),
    onSuccess: () => location.assign("/"),
  });

  const badges: Partial<Record<string, number>> = {};
  if (unread > 0) badges["/workspace/announcements"] = unread;

  const triggerLabel = isMobile
    ? t("openNav", "Open navigation")
    : open
      ? t("collapseNav", "Collapse navigation")
      : t("expandNav", "Expand navigation");

  return (
    <>
      <a className="skip-link" href="#main-content" tabIndex={openMobile ? -1 : undefined}>
        {t("skip", "Skip to content")}
      </a>
      <Navigation
        area={area}
        items={items}
        active={active}
        canAdmin={session.admin_workspace}
        brand={brand}
        badges={badges}
        onMobileClose={() => requestAnimationFrame(() => trigger.current?.focus())}
      />
      <div className="console-main" inert={isMobile && openMobile}>
        <header className="console-topbar">
          <div className="console-location">
            <Tooltip
              content={triggerLabel}
              render={
                <Sidebar.Trigger
                  ref={trigger}
                  aria-label={triggerLabel}
                  aria-expanded={isMobile ? openMobile : open}
                  aria-controls="console-navigation"
                >
                  {isMobile ? <List size={20} aria-hidden /> : undefined}
                </Sidebar.Trigger>
              }
            />
            <span className="console-topbar-rule" aria-hidden />
            <span className="console-compact-area">
              {area === "admin" ? title : t("mobilePersonal", "Personal")}
            </span>
            <Breadcrumbs size="sm">
              {current && active !== workspace.home ? (
                <>
                  <Breadcrumbs.Link href={workspace.home} icon={<AreaIcon size={15} />}>
                    <span className="console-area-name">{title}</span>
                    {isMobile && <span className="sr-only">{title}</span>}
                  </Breadcrumbs.Link>
                  <Breadcrumbs.Separator />
                  <Breadcrumbs.Current>{current}</Breadcrumbs.Current>
                </>
              ) : (
                <Breadcrumbs.Current icon={<AreaIcon size={15} />}>{title}</Breadcrumbs.Current>
              )}
            </Breadcrumbs>
          </div>
          <div className="console-top-actions">
            <ConsoleCommands items={allItems} />
            {hasInbox && unread > 0 && (
              <Tooltip
                content={notices}
                render={
                  <LinkButton
                    href="/workspace/announcements"
                    variant="ghost"
                    shape="square"
                    icon={Bell}
                    className="console-notice-link"
                    aria-label={notices}
                  >
                    <span className="console-notice-dot" aria-hidden />
                  </LinkButton>
                }
              />
            )}
            <ThemeSwitcher />
            <LanguagePicker enabledLocales={enabledLocales} />
            <AccountMenu session={session} pending={signOut.isPending} signOut={() => signOut.mutate()} />
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="console-content">
          {maintenance?.enabled && (maintenance.title || maintenance.message) && (
            <KumoBanner
              size="sm"
              variant={maintenance.variant === "error" ? "error" : maintenance.variant === "warning" ? "alert" : "default"}
              title={maintenance.title || undefined}
              description={maintenance.message || undefined}
            />
          )}
          <Banner error={signOut.error} />
          {children}
        </main>
      </div>
      {hasInbox && fullscreenNotices.length > 0 && (
        <FullscreenAnnouncementOverlay notices={fullscreenNotices} />
      )}
    </>
  );
}
