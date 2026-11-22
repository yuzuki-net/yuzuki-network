import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import { SectionCard } from "../../components/console-ui";
import type { BannerVariant, Panel, WorkspaceUi } from "../../features/portal/options";
import { localeNames, useT, type Locale } from "../../i18n";

type Features = Panel["features"];

export function FeatureSettings({
  features,
  workspace,
  disabled,
  onChangeFeatures,
  onChangeWorkspace,
}: {
  features: Features;
  workspace: WorkspaceUi;
  disabled: boolean;
  onChangeFeatures: (changes: Partial<Features>) => void;
  onChangeWorkspace: (changes: Partial<WorkspaceUi>) => void;
}) {
  const t = useT("settings");
  const allLocales = Object.entries(localeNames) as [Locale, string][];
  const banner = workspace.maintenance_banner;

  function toggleLocale(code: Locale, checked: boolean) {
    const current = workspace.enabled_locales.length ? workspace.enabled_locales : allLocales.map(([k]) => k);
    const next = checked ? Array.from(new Set([...current, code])) : current.filter((item) => item !== code);
    if (next.length === 0) return;
    onChangeWorkspace({ enabled_locales: next.length === allLocales.length ? [] : next });
  }

  return (
    <div className="flex flex-col gap-5">
      <SectionCard
        title={t("features.title", "Features & workspace modules")}
        description={t("features.description", "Choose which features and self-service controls are available in the portal and personal workspace.")}
      >
        <div className="flex flex-col divide-y divide-kumo-line rounded-lg border border-kumo-line bg-kumo-recessed/30 px-4">
          <div className="flex items-center justify-between gap-4 py-3.5">
            <div>
              <p className="text-sm font-medium text-kumo-strong">
                {t("features.registration", "Allow account registration")}
              </p>
              <p className="text-xs text-kumo-subtle">
                {t("features.registration_hint", "New registrations appear in Users and require approval before sign-in.")}
              </p>
            </div>
            <Switch
              aria-label={t("features.registration", "Allow account registration")}
              checked={features.registration}
              disabled={disabled}
              onCheckedChange={(registration) => onChangeFeatures({ registration })}
            />
          </div>

          <div className="flex items-center justify-between gap-4 py-3.5">
            <div>
              <p className="text-sm font-medium text-kumo-strong">
                {t("features.announcements", "Enable announcements")}
              </p>
              <p className="text-xs text-kumo-subtle">
                {t("features.announcements_hint", "Show the announcement inbox and allow administrators to publish updates.")}
              </p>
            </div>
            <Switch
              aria-label={t("features.announcements", "Enable announcements")}
              checked={features.announcements}
              disabled={disabled}
              onCheckedChange={(announcements) => onChangeFeatures({ announcements })}
            />
          </div>

          <div className="flex items-center justify-between gap-4 py-3.5">
            <div>
              <p className="text-sm font-medium text-kumo-strong">
                {t("features.allowProfileEdit", "Allow users to edit display name & email")}
              </p>
              <p className="text-xs text-kumo-subtle">
                {t("features.allowProfileEditHint", "When disabled, the profile form in Account settings becomes read-only.")}
              </p>
            </div>
            <Switch
              aria-label={t("features.allowProfileEdit", "Allow users to edit display name & email")}
              checked={workspace.allow_profile_edit}
              disabled={disabled}
              onCheckedChange={(allow_profile_edit) => onChangeWorkspace({ allow_profile_edit })}
            />
          </div>

          <div className="flex items-center justify-between gap-4 py-3.5">
            <div>
              <p className="text-sm font-medium text-kumo-strong">
                {t("features.showDevicesCard", "Show subscription devices card on overview")}
              </p>
              <p className="text-xs text-kumo-subtle">
                {t("features.showDevicesCardHint", "Displays active bound device counts and quick release access on the Personal Overview.")}
              </p>
            </div>
            <Switch
              aria-label={t("features.showDevicesCard", "Show subscription devices card on overview")}
              checked={workspace.show_devices_card}
              disabled={disabled}
              onCheckedChange={(show_devices_card) => onChangeWorkspace({ show_devices_card })}
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={t("features.localesTitle", "Language preferences")}
        description={t("features.localesDesc", "Select the default language for new visitors and control which languages appear in the language picker.")}
      >
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <Select
            label={t("features.defaultLocale", "Default language")}
            value={workspace.default_locale ?? "auto"}
            disabled={disabled}
            items={{ auto: t("features.localeAuto", "Browser language (auto)"), ...localeNames }}
            onValueChange={(value: string | null) =>
              onChangeWorkspace({ default_locale: value && value !== "auto" ? (value as Locale) : null })
            }
          />
          <div className="flex flex-col gap-2.5">
            <span className="text-sm font-medium text-kumo-default">
              {t("features.enabledLocales", "Available languages")}
            </span>
            <div className="flex flex-wrap gap-4 pt-1.5">
              {allLocales.map(([code, name]) => {
                const active = workspace.enabled_locales.length === 0 || workspace.enabled_locales.includes(code);
                return (
                  <Checkbox
                    key={code}
                    label={name}
                    checked={active}
                    disabled={disabled}
                    onCheckedChange={(checked) => toggleLocale(code, checked)}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={t("features.maintenanceTitle", "Global maintenance & notice banner")}
        description={t("features.maintenanceDesc", "Display a prominent banner at the top of workspaces for scheduled maintenance or service alerts.")}
      >
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.85fr)]">
          <div className="form-fields">
            <Switch
              label={t("features.maintenanceEnabled", "Display global notice banner")}
              checked={banner.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) =>
                onChangeWorkspace({ maintenance_banner: { ...banner, enabled } })
              }
            />
            <div className="edit-grid">
              <Select
                label={t("features.maintenanceSeverity", "Banner severity")}
                value={banner.variant}
                disabled={disabled || !banner.enabled}
                items={{
                  info: t("features.severity.info", "Information"),
                  warning: t("features.severity.warning", "Warning / Maintenance"),
                  error: t("features.severity.error", "Critical / Outage"),
                }}
                onValueChange={(variant: BannerVariant | null) =>
                  variant && onChangeWorkspace({ maintenance_banner: { ...banner, variant } })
                }
              />
              <Input
                label={t("features.maintenanceHeading", "Banner title")}
                value={banner.title ?? ""}
                maxLength={120}
                disabled={disabled || !banner.enabled}
                placeholder={t("features.maintenanceTitlePlaceholder", "Scheduled maintenance window")}
                onChange={(e) =>
                  onChangeWorkspace({ maintenance_banner: { ...banner, title: e.target.value || null } })
                }
              />
            </div>
            <Textarea
              label={t("features.maintenanceMessage", "Banner message")}
              value={banner.message ?? ""}
              rows={2}
              maxLength={500}
              disabled={disabled || !banner.enabled}
              placeholder={t("features.maintenanceMessagePlaceholder", "Tokyo nodes will upgrade between 02:00 and 02:30 UTC.")}
              onChange={(e) =>
                onChangeWorkspace({ maintenance_banner: { ...banner, message: e.target.value || null } })
              }
            />
          </div>

          <aside className="flex flex-col gap-2.5 rounded-lg border border-kumo-line bg-kumo-recessed/40 p-4">
            <span className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
              {t("features.livePreview", "Live preview")}
            </span>
            {banner.enabled && (banner.title || banner.message) ? (
              <KumoBanner
                size="sm"
                variant={banner.variant === "error" ? "error" : banner.variant === "warning" ? "alert" : "default"}
                title={banner.title || undefined}
                description={banner.message || undefined}
              />
            ) : (
              <p className="text-xs text-kumo-subtle">
                {t("features.maintenanceDesc", "Display a prominent banner at the top of workspaces for scheduled maintenance or service alerts.")}
              </p>
            )}
          </aside>
        </div>
      </SectionCard>
    </div>
  );
}
