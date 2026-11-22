import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import { SectionCard } from "../../components/console-ui";
import type { Accent, AppearanceConfig } from "../../features/portal/options";
import type { ColorMode, Density, RadiusStyle } from "../../features/theme";
import { useT } from "../../i18n";

const ACCENT_PRESETS: { key: Accent; swatch: string; fallback: string }[] = [
  { key: "emerald", swatch: "#10b981", fallback: "Emerald Green" },
  { key: "teal", swatch: "#0d9488", fallback: "Teal" },
  { key: "orange", swatch: "#f6821f", fallback: "Cloudflare Orange" },
  { key: "blue", swatch: "#2563eb", fallback: "Blue" },
  { key: "indigo", swatch: "#4f46e5", fallback: "Indigo" },
  { key: "rose", swatch: "#e11d48", fallback: "Rose" },
  { key: "slate", swatch: "#475569", fallback: "Slate" },
  { key: "custom", swatch: "conic-gradient(#10b981, #2563eb, #f6821f, #e11d48, #10b981)", fallback: "Custom hex" },
];

export function AppearanceSettings({
  accent,
  appearance,
  brandName,
  disabled,
  onChangeAccent,
  onChange,
}: {
  accent: Accent;
  appearance: AppearanceConfig;
  brandName: string;
  disabled: boolean;
  onChangeAccent: (accent: Accent) => void;
  onChange: (changes: Partial<AppearanceConfig>) => void;
}) {
  const t = useT("settings");
  const activeHex =
    accent === "custom"
      ? appearance.accent_custom_hex || "#10b981"
      : ACCENT_PRESETS.find((p) => p.key === accent)?.swatch ?? "#10b981";

  return (
    <div className="flex flex-col gap-5">
      <SectionCard
        title={t("appearance.accentTitle", "Brand accent color")}
        description={t(
          "appearance.accentDesc",
          "Applies across the public portal, active navigation highlight, brand mark and interactive indicators.",
        )}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {ACCENT_PRESETS.map(({ key, swatch, fallback }) => (
              <button
                key={key}
                type="button"
                disabled={disabled}
                aria-pressed={accent === key}
                onClick={() => onChangeAccent(key)}
                className="settings-swatch-btn"
              >
                <span
                  className="size-4 shrink-0 rounded-full border border-black/15"
                  style={{ background: swatch }}
                  aria-hidden
                />
                <span>{t(`accent.${key}`, fallback)}</span>
              </button>
            ))}
          </div>

          {accent === "custom" && (
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="custom-accent-picker" className="text-sm font-medium text-kumo-default">
                  {t("appearance.colorPicker", "Color picker")}
                </label>
                <input
                  id="custom-accent-picker"
                  type="color"
                  disabled={disabled}
                  value={/^#[0-9a-fA-F]{6}$/.test(appearance.accent_custom_hex ?? "") ? appearance.accent_custom_hex! : "#10b981"}
                  onChange={(e) => onChange({ accent_custom_hex: e.target.value })}
                  className="h-9 w-14 cursor-pointer rounded-md border border-kumo-line bg-kumo-base p-1"
                />
              </div>
              <div className="w-44">
                <Input
                  label={t("appearance.hexValue", "Hex color")}
                  value={appearance.accent_custom_hex ?? "#10b981"}
                  maxLength={7}
                  dir="ltr"
                  disabled={disabled}
                  placeholder="#10b981"
                  onChange={(e) => onChange({ accent_custom_hex: e.target.value || null })}
                />
              </div>
            </div>
          )}

          {/* Dual Light / Dark preview */}
          <div className="grid gap-3 pt-1 sm:grid-cols-2">
            {(["light", "dark"] as const).map((mode) => (
              <div
                key={mode}
                className="flex flex-col gap-2.5 rounded-lg border p-4"
                style={{
                  background: mode === "dark" ? "#141414" : "#ffffff",
                  borderColor: mode === "dark" ? "#2e2e2e" : "#e5e7eb",
                  color: mode === "dark" ? "#f5f5f5" : "#171717",
                }}
              >
                <div className="flex items-center justify-between text-xs opacity-70">
                  <span>{mode === "dark" ? t("appearance.previewDark", "Dark mode preview") : t("appearance.previewLight", "Light mode preview")}</span>
                  <span
                    className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{
                      background: `color-mix(in srgb, ${activeHex} 18%, transparent)`,
                      color: activeHex,
                    }}
                  >
                    {brandName || "Meridian"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex h-7 items-center rounded-md px-3 text-xs font-medium text-white"
                    style={{ background: activeHex }}
                  >
                    {t("appearance.previewPrimary", "Primary action")}
                  </span>
                  <span
                    className="inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium"
                    style={{
                      borderColor: `color-mix(in srgb, ${activeHex} 35%, transparent)`,
                      background: `color-mix(in srgb, ${activeHex} 12%, transparent)`,
                      color: activeHex,
                    }}
                  >
                    {t("appearance.previewActiveNav", "Active nav item")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={t("appearance.layoutTitle", "Theme mode & layout density")}
        description={t("appearance.layoutDesc", "Control default dark mode behavior, spacing density, corner rounding and sidebar initial state.")}
      >
        <div className="form-fields">
          <div className="edit-grid">
            <Select
              label={t("appearance.defaultMode", "Default color mode")}
              value={appearance.default_mode}
              disabled={disabled}
              items={{
                system: t("appearance.mode.system", "Follow system"),
                light: t("appearance.mode.light", "Light"),
                dark: t("appearance.mode.dark", "Dark"),
              }}
              onValueChange={(value: ColorMode | null) => value && onChange({ default_mode: value })}
            />
            <Select
              label={t("appearance.density", "Interface density")}
              value={appearance.density}
              disabled={disabled}
              items={{
                comfortable: t("appearance.density.comfortable", "Comfortable (default)"),
                compact: t("appearance.density.compact", "Compact (higher density)"),
              }}
              onValueChange={(value: Density | null) => value && onChange({ density: value })}
            />
            <Select
              label={t("appearance.radius", "Corner radius style")}
              value={appearance.radius}
              disabled={disabled}
              items={{
                sharp: t("appearance.radius.sharp", "Sharp"),
                default: t("appearance.radius.default", "Balanced (default)"),
                rounded: t("appearance.radius.rounded", "Rounded"),
              }}
              onValueChange={(value: RadiusStyle | null) => value && onChange({ radius: value })}
            />
          </div>

          <div className="flex flex-col divide-y divide-kumo-line rounded-lg border border-kumo-line bg-kumo-recessed/30 px-4">
            <div className="flex items-center justify-between gap-4 py-3.5">
              <div>
                <p className="text-sm font-medium text-kumo-strong">
                  {t("appearance.allowSwitch", "Allow users to switch light / dark mode")}
                </p>
                <p className="text-xs text-kumo-subtle">
                  {t("appearance.allowSwitchHint", "Displays a theme switcher in the console top bar and public header.")}
                </p>
              </div>
              <Switch
                aria-label={t("appearance.allowSwitch", "Allow users to switch light / dark mode")}
                checked={appearance.allow_mode_switch}
                disabled={disabled}
                onCheckedChange={(allow_mode_switch) => onChange({ allow_mode_switch })}
              />
            </div>
            <div className="flex items-center justify-between gap-4 py-3.5">
              <div>
                <p className="text-sm font-medium text-kumo-strong">
                  {t("appearance.sidebarCollapsed", "Start with sidebar collapsed on desktop")}
                </p>
                <p className="text-xs text-kumo-subtle">
                  {t("appearance.sidebarCollapsedHint", "Maximizes content width by collapsing navigation to an icon rail by default.")}
                </p>
              </div>
              <Switch
                aria-label={t("appearance.sidebarCollapsed", "Start with sidebar collapsed on desktop")}
                checked={appearance.sidebar_default_collapsed}
                disabled={disabled}
                onCheckedChange={(sidebar_default_collapsed) => onChange({ sidebar_default_collapsed })}
              />
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
