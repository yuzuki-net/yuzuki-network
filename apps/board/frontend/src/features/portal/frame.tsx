import { LinkButton } from "@cloudflare/kumo/components/button";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { useEffect, useMemo, type ReactNode } from "react";
import { ThemeProvider, ThemeSwitcher } from "../theme";
import { useT } from "../../i18n";
import { LanguagePicker } from "../../i18n/language-picker";
import { PortalBrand } from "./brand";
import { normalizePanel, type Panel } from "./options";
import "./style.css";

export function PortalFrame({
  panel: rawPanel,
  waiting = false,
  home,
  workspace,
  children,
}: {
  panel: Panel;
  home?: boolean;
  waiting?: boolean;
  workspace?: "/workspace" | "/admin" | null;
  children: ReactNode;
}) {
  const t = useT("portal");
  const panel = useMemo(() => normalizePanel(rawPanel), [rawPanel]);

  useEffect(() => {
    document.title = panel.name;
  }, [panel.name]);

  const themeAppearance = useMemo(
    () => ({
      defaultMode: panel.appearance.default_mode,
      allowModeSwitch: panel.appearance.allow_mode_switch,
      accent: panel.landing.accent,
      customHex: panel.appearance.accent_custom_hex,
      density: panel.appearance.density,
      radius: panel.appearance.radius,
      faviconUrl: panel.branding.favicon_url,
    }),
    [panel],
  );

  return (
    <ThemeProvider appearance={themeAppearance}>
      <div className="portal" data-home={home || undefined}>
        <header className="portal-header">
          <div className="portal-width portal-header-inner">
            <PortalBrand
              name={panel.name}
              tagline={panel.branding.tagline}
              iconPreset={panel.branding.icon_preset}
              logoUrl={panel.branding.logo_url}
              logoDarkUrl={panel.branding.logo_dark_url}
            />
            <nav className="portal-navigation" aria-label={t("navigation.label", "Site navigation")}>
              <ThemeSwitcher />
              <LanguagePicker enabledLocales={panel.workspace.enabled_locales} />
              {home ? (
                waiting ? (
                  <SkeletonLine className="portal-navigation-placeholder" />
                ) : (
                  <LinkButton href={workspace ?? "/login"} variant="secondary" size="sm">
                    {workspace === "/admin"
                      ? t("home.openAdmin", "Open administration")
                      : workspace
                        ? t("home.open", "Open workspace")
                        : t("auth.sign_in", "Sign in")}
                  </LinkButton>
                )
              ) : (
                <LinkButton href="/" variant="ghost" size="sm">
                  {t("auth.back", "Homepage")}
                </LinkButton>
              )}
            </nav>
          </div>
        </header>
        {children}
        <footer className="portal-footer">
          <div className="portal-width portal-footer-inner">
            <p className="text-xs text-kumo-subtle" dir={panel.copyright ? "auto" : undefined}>
              {panel.copyright ??
                t("footer.copyright", "© {year} {name}", {
                  year: String(new Date().getFullYear()),
                  name: panel.name,
                })}
            </p>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              {panel.branding.footer_links.map((link, index) => (
                <a
                  key={index}
                  className="portal-website"
                  href={link.url}
                  target={link.external ? "_blank" : undefined}
                  rel={link.external ? "noopener noreferrer" : undefined}
                >
                  <span>{link.label}</span>
                  {link.external && <ArrowSquareOut size={13} aria-hidden />}
                </a>
              ))}
              {panel.url && (
                <a className="portal-website" href={panel.url} target="_blank" rel="noopener noreferrer">
                  <span>{t("footer.website", "Website")}</span>
                  <ArrowSquareOut size={13} aria-hidden />
                </a>
              )}
            </div>
          </div>
        </footer>
      </div>
    </ThemeProvider>
  );
}
