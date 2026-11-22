import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { Check, Desktop, Globe, Moon, Sun } from "@phosphor-icons/react";
import { SectionCard } from "../../components/console-ui";
import { normalizePanel, usePortalOptions } from "../../features/portal/options";
import { useSession } from "../../features/session/context";
import { useTheme, type ColorMode } from "../../features/theme";
import { localeNames, useLocale, useT, type Locale } from "../../i18n";

const ALL_LOCALES = Object.keys(localeNames) as Locale[];

export function PreferencesSettings() {
  const t = useT("security");
  const { locale, changeLocale } = useLocale();
  const { mode, allowSwitch, setMode } = useTheme();
  const options = usePortalOptions();
  const session = useSession();
  const panel = normalizePanel(options.data?.panel);

  const enabledLocales =
    panel.workspace.enabled_locales.length > 0
      ? panel.workspace.enabled_locales.filter((code): code is Locale => code in localeNames)
      : ALL_LOCALES;
  const selectableLocales = enabledLocales.length > 0 ? enabledLocales : ALL_LOCALES;

  const themeOptions: { value: ColorMode; label: string; description: string; icon: typeof Sun }[] = [
    {
      value: "light",
      label: t("preferences.themeLight", "Light"),
      description: t("preferences.themeLightDesc", "Bright workspace surface"),
      icon: Sun,
    },
    {
      value: "dark",
      label: t("preferences.themeDark", "Dark"),
      description: t("preferences.themeDarkDesc", "Reduced glare at night"),
      icon: Moon,
    },
    {
      value: "system",
      label: t("preferences.themeSystem", "System"),
      description: t("preferences.themeSystemDesc", "Match device setting"),
      icon: Desktop,
    },
  ];

  return (
    <SectionCard
      title={t("preferences.title", "Workspace preferences")}
      description={t("preferences.description", "Customize your display language, theme mode and review account metadata.")}
    >
      <div className="flex flex-col gap-5">
        {/* Language preference */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-sm font-medium text-kumo-strong">
            <Globe size={16} style={{ color: "var(--brand-accent)" }} aria-hidden />
            <span>{t("preferences.language", "Display language")}</span>
          </div>
          <p className="text-xs text-kumo-subtle">
            {t("preferences.languageHint", "Saved to your account and synced across browsers whenever you sign in.")}
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {selectableLocales.map((code) => {
              const active = locale === code;
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => changeLocale(code)}
                  className={`pref-option ${active ? "pref-option-active" : ""}`}
                  aria-pressed={active}
                >
                  <span className="truncate text-sm font-medium">{localeNames[code]}</span>
                  <span className="text-[11px] uppercase tracking-wide text-kumo-subtle">{code}</span>
                  {active && <Check size={15} className="ms-auto shrink-0" style={{ color: "var(--brand-accent)" }} aria-hidden />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Color mode */}
        <div className="flex flex-col gap-2 border-t border-kumo-line pt-4">
          <span className="text-sm font-medium text-kumo-strong">
            {t("preferences.theme", "Color mode")}
          </span>
          {!allowSwitch ? (
            <KumoBanner
              size="sm"
              variant="secondary"
              description={t("preferences.themeLocked", "Color mode is locked by your workspace administrator.")}
            />
          ) : (
            <div className="grid gap-2 sm:grid-cols-3">
              {themeOptions.map(({ value, label, description, icon: Icon }) => {
                const active = mode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setMode(value)}
                    className={`pref-theme-card ${active ? "pref-option-active" : ""}`}
                    aria-pressed={active}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Icon size={16} style={active ? { color: "var(--brand-accent)" } : undefined} aria-hidden />
                      {active && <Check size={14} style={{ color: "var(--brand-accent)" }} aria-hidden />}
                    </div>
                    <div className="text-start">
                      <div className="text-sm font-medium text-kumo-strong">{label}</div>
                      <div className="text-[11px] text-kumo-subtle">{description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Account Technical Identifier */}
        <div className="flex flex-col gap-2 border-t border-kumo-line pt-4">
          <span className="text-sm font-medium text-kumo-strong">
            {t("preferences.accountId", "Account identifier")}
          </span>
          <p className="text-xs text-kumo-subtle">
            {t("preferences.accountIdHint", "Share this identifier with an administrator if you need support.")}
          </p>
          <ClipboardText
            size="sm"
            text={session.id}
            labels={{ copyAction: t("preferences.copyAccountId", "Copy account identifier") }}
          />
        </div>
      </div>
    </SectionCard>
  );
}
