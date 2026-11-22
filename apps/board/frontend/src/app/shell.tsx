import { Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, api, message } from "../assets/scripts/api";
import { Empty, Loading, PageErrorBoundary, PageHeader } from "../components/console-ui";
import { useResource } from "./query";
import { SessionContext } from "../features/session/context";
import type { Account, Session } from "../features/session/model";
import { ThemeProvider, type AccentPreset, type ColorMode, type Density, type RadiusStyle } from "../features/theme";
import { applySyncedLocale, english, setAccountLocalePersister, supportedLocale, useT, type Locale } from "../i18n";
import { ConsoleLayout, type MaintenanceNotice } from "../layout/console";
import type { BrandAppearance } from "../layout/console/navigation";
import { normalizePath, ConsoleRouter, useConsoleLocation } from "./router";
import { labelRoute, routes, type Route } from "./routes";

type PanelOptions = {
  name?: string;
  features?: { announcements?: boolean };
  landing?: { accent?: AccentPreset };
  branding?: {
    tagline?: string | null;
    icon_preset?: BrandAppearance["iconPreset"];
    logo_url?: string | null;
    logo_dark_url?: string | null;
    favicon_url?: string | null;
  };
  appearance?: {
    default_mode?: ColorMode;
    allow_mode_switch?: boolean;
    accent_custom_hex?: string | null;
    density?: Density;
    radius?: RadiusStyle;
    sidebar_default_collapsed?: boolean;
  };
  workspace?: {
    default_locale?: import("../i18n").Locale | null;
    enabled_locales?: import("../i18n").Locale[];
    maintenance_banner?: MaintenanceNotice;
  };
};

type Options = { panel?: PanelOptions };

export function WorkspaceApp() {
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const session = useResource<Session>("/api/v1/me", true, 60_000);
  const { data: options, isPending: optionsPending } = useResource<Options>("/auth/options", true, 60_000);
  const t = useT("navigation");
  const panel = options?.panel;
  const lastSyncedAccountLocale = useRef<string | null>(null);

  // Sync account's saved database locale when session loads or changes on server.
  useEffect(() => {
    const accountId = session.data?.id;
    const saved = session.data?.locale;
    if (!accountId || !saved) return;
    const key = `${accountId}:${saved}`;
    if (lastSyncedAccountLocale.current === key) return;
    const resolved = supportedLocale(saved);
    if (resolved) {
      lastSyncedAccountLocale.current = key;
      applySyncedLocale(resolved);
    }
  }, [session.data?.id, session.data?.locale]);

  // Persist any language switch inside the signed-in workspace to the account in the database.
  useEffect(() => {
    const accountId = session.data?.id;
    if (!accountId) {
      setAccountLocalePersister(null);
      return;
    }
    let active = true;
    let latestSave = 0;
    let pending = Promise.resolve();
    setAccountLocalePersister((nextLocale: Locale) => {
      const save = ++latestSave;
      lastSyncedAccountLocale.current = `${accountId}:${nextLocale}`;
      cache.setQueryData<Session>(["/api/v1/me"], (current) =>
        current ? { ...current, locale: nextLocale } : current,
      );
      pending = pending.then(async () => {
        if (!active || save !== latestSave) return;
        try {
          const updated = await api<Account>("/api/v1/me/locale", "PUT", { locale: nextLocale });
          if (active && save === latestSave) {
            cache.setQueryData<Session>(["/api/v1/me"], (current) =>
              current?.id === accountId ? { ...current, locale: updated.locale } : current,
            );
          }
        } catch {
          if (active && save === latestSave) {
            toast.add({ variant: "error", title: "Could not save the account language. Try again." });
          }
        }
      });
    });
    return () => {
      active = false;
      setAccountLocalePersister(null);
    };
  }, [cache, session.data?.id, toast]);

  const visible = useMemo(
    () =>
      routes.filter(
        (route) =>
          session.data &&
          (route.area !== "admin" || session.data.admin_workspace) &&
          (!route.permission || session.data.access.permissions.some((key) => key === route.permission)) &&
          (!route.feature || panel?.features?.[route.feature] === true),
      ),
    [session.data, panel],
  );
  const canNavigate = useCallback((path: string) => visible.some((route) => path === route.path), [visible]);

  const themeAppearance = useMemo(
    () => ({
      defaultMode: panel?.appearance?.default_mode ?? "system",
      allowModeSwitch: panel?.appearance?.allow_mode_switch ?? true,
      accent: panel?.landing?.accent ?? "emerald",
      customHex: panel?.appearance?.accent_custom_hex ?? null,
      density: panel?.appearance?.density ?? "comfortable",
      radius: panel?.appearance?.radius ?? "default",
      faviconUrl: panel?.branding?.favicon_url ?? null,
    }),
    [panel],
  );

  const brand: BrandAppearance = useMemo(
    () => ({
      name: panel?.name,
      tagline: panel?.branding?.tagline,
      iconPreset: panel?.branding?.icon_preset,
      logoUrl: panel?.branding?.logo_url,
      logoDarkUrl: panel?.branding?.logo_dark_url,
    }),
    [panel],
  );

  let body;
  if (session.isPending) {
    body = (
      <main className="boot">
        <Loading label={t("opening", "Opening your workspace…")} />
      </main>
    );
  } else if (!session.data || (session.error instanceof ApiError && session.error.status === 404)) {
    body = (
      <main className="boot">
        <Empty
          title={english("navigation", "unavailable", "Workspace unavailable")}
          action={
            <LinkButton href="/login" variant="secondary">
              {t("signIn", "Go to sign in")}
            </LinkButton>
          }
        >
          {session.error && message(session.error)}
        </Empty>
      </main>
    );
  } else {
    body = (
      <SessionContext.Provider value={session.data}>
        <ConsoleRouter canNavigate={canNavigate}>
          <CurrentPage
            visible={visible}
            session={session.data}
            brand={brand}
            defaultCollapsed={panel?.appearance?.sidebar_default_collapsed}
            maintenance={panel?.workspace?.maintenance_banner}
            enabledLocales={panel?.workspace?.enabled_locales}
            optionsPending={optionsPending}
          />
        </ConsoleRouter>
      </SessionContext.Provider>
    );
  }

  return <ThemeProvider appearance={themeAppearance}>{body}</ThemeProvider>;
}

function CurrentPage({
  visible,
  session,
  brand,
  defaultCollapsed,
  maintenance,
  enabledLocales,
  optionsPending,
}: {
  visible: Route[];
  session: Session;
  brand: BrandAppearance;
  defaultCollapsed?: boolean;
  maintenance?: MaintenanceNotice;
  enabledLocales?: readonly import("../i18n").Locale[];
  optionsPending: boolean;
}) {
  const cache = useQueryClient();
  const href = useConsoleLocation();
  const path = normalizePath(new URL(href, location.origin).pathname);
  const t = useT("navigation");
  const area = session.admin_workspace && path.startsWith("/admin") ? "admin" : "personal";
  const page = visible.find((route) => route.path === path);
  const items = visible.filter((route) => route.area === area).map((route) => labelRoute(route, t));
  const checkingFeature = optionsPending && routes.some((route) => route.path === path && route.feature);
  const title = page ? t(page.labelKey, page.label) : english("navigation", "pageUnavailable", "Page unavailable");
  const loading = (
    <div className="console-page-loading">
      <Loading label={t("loading", "Loading page…")} />
    </div>
  );
  const panelName = brand.name || "Meridian";
  return (
    <ConsoleLayout
      area={area}
      items={items}
      allItems={visible.map((route) => labelRoute(route, t))}
      active={path}
      session={session}
      brand={brand}
      defaultCollapsed={defaultCollapsed}
      maintenance={maintenance}
      enabledLocales={enabledLocales}
    >
      <title>{checkingFeature ? panelName : `${title} | ${panelName}`}</title>
      {page ? (
        <PageErrorBoundary
          key={page.path}
          onError={() => {
            void cache.invalidateQueries({ queryKey: ["/api/v1/me"] });
          }}
        >
          <Suspense fallback={loading}>
            <page.page />
          </Suspense>
        </PageErrorBoundary>
      ) : checkingFeature ? (
        loading
      ) : (
        <PageHeader
          title={title}
          action={
            <LinkButton href={area === "admin" ? "/admin" : "/workspace"} variant="secondary">
              {t("back", "Back to your workspace")}
            </LinkButton>
          }
        />
      )}
    </ConsoleLayout>
  );
}
