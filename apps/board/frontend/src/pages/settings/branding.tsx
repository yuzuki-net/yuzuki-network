import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input } from "@cloudflare/kumo/components/input";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { ArrowDown, ArrowUp, Plus, Trash } from "@phosphor-icons/react";
import { SectionCard } from "../../components/console-ui";
import { BrandMark, brandIconPresets, type BrandIconPreset } from "../../components/kumo-ext";
import type { BrandingExtra, NavLink, Panel } from "../../features/portal/options";
import { useT } from "../../i18n";

type BasicBranding = Pick<Panel, "name" | "url" | "copyright">;

export function BrandingSettings({
  value,
  onChange,
  onChangeExtra,
  disabled,
}: {
  value: Panel;
  onChange: (changes: Partial<BasicBranding>) => void;
  onChangeExtra: (changes: Partial<BrandingExtra>) => void;
  disabled: boolean;
}) {
  const t = useT("settings");
  const extra = value.branding;

  function updateLink(index: number, patch: Partial<NavLink>) {
    onChangeExtra({
      footer_links: extra.footer_links.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    });
  }

  function moveLink(index: number, delta: number) {
    const next = [...extra.footer_links];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChangeExtra({ footer_links: next });
  }

  function addLink() {
    if (extra.footer_links.length >= 8) return;
    onChangeExtra({
      footer_links: [...extra.footer_links, { label: "", url: "https://", external: true }],
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <SectionCard
        title={t("branding.title", "Branding")}
        description={t("branding.description", "Set how your organization appears across the portal, sidebar and browser tab.")}
      >
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="form-fields">
            <div className="edit-grid">
              <Input
                name="panel-name"
                label={t("branding.name", "Panel name")}
                value={value.name}
                maxLength={60}
                onChange={(event) => onChange({ name: event.target.value })}
                required
                disabled={disabled}
              />
              <Input
                name="panel-tagline"
                label={t("branding.tagline", "Sidebar tagline")}
                value={extra.tagline ?? ""}
                maxLength={100}
                placeholder={t("branding.tagline_placeholder", "e.g. Global Edge Network")}
                onChange={(event) => onChangeExtra({ tagline: event.target.value || null })}
                disabled={disabled}
              />
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-kumo-default">
                {t("branding.icon_preset", "Built-in icon mark")}
              </span>
              <div className="flex flex-wrap gap-2">
                {(Object.entries(brandIconPresets) as [BrandIconPreset, { label: string; icon: typeof BrandMark }][]).map(
                  ([key, meta]) => {
                    const Glyph = brandIconPresets[key].icon;
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={disabled}
                        aria-pressed={extra.icon_preset === key}
                        onClick={() => onChangeExtra({ icon_preset: key })}
                        className="settings-swatch-btn"
                      >
                        <Glyph size={16} weight="fill" style={{ color: "var(--brand-accent)" }} aria-hidden />
                        <span>{meta.label}</span>
                      </button>
                    );
                  },
                )}
              </div>
            </div>

            <div className="edit-grid">
              <Input
                label={t("branding.logo_url", "Custom logo URL (Light)")}
                description={t("branding.logo_hint", "HTTPS URL or root-relative path like /logo.svg. Overrides the built-in icon.")}
                value={extra.logo_url ?? ""}
                placeholder="https://cdn.example.net/logo.svg"
                maxLength={2048}
                disabled={disabled}
                onChange={(event) => onChangeExtra({ logo_url: event.target.value || null })}
              />
              <Input
                label={t("branding.logo_dark_url", "Custom logo URL (Dark)")}
                description={t("branding.logo_dark_hint", "Optional dark-mode logo. Falls back to the light logo when blank.")}
                value={extra.logo_dark_url ?? ""}
                placeholder="https://cdn.example.net/logo-dark.svg"
                maxLength={2048}
                disabled={disabled}
                onChange={(event) => onChangeExtra({ logo_dark_url: event.target.value || null })}
              />
            </div>

            <div className="edit-grid">
              <Input
                label={t("branding.favicon_url", "Favicon URL")}
                description={t("branding.favicon_hint", "Browser tab icon (SVG, PNG or ICO).")}
                value={extra.favicon_url ?? ""}
                placeholder="/favicon.ico"
                maxLength={2048}
                disabled={disabled}
                onChange={(event) => onChangeExtra({ favicon_url: event.target.value || null })}
              />
              <Input
                label={t("branding.url", "Website URL")}
                name="panel-url"
                type="url"
                value={value.url ?? ""}
                description={t("branding.url_hint", "A link to your organization’s website in the public footer.")}
                onChange={(event) => onChange({ url: event.target.value || null })}
                maxLength={2048}
                disabled={disabled}
              />
            </div>

            <Input
              label={t("branding.copyright", "Copyright text")}
              name="panel-copyright"
              value={value.copyright ?? ""}
              placeholder={`© ${new Date().getFullYear()} ${value.name || "Meridian"}`}
              onChange={(event) => onChange({ copyright: event.target.value || null })}
              maxLength={140}
              disabled={disabled}
            />
          </div>

          <aside className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/50 p-4">
            <span className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
              {t("branding.preview", "Brand preview")}
            </span>
            <div className="flex items-center gap-2.5 rounded-lg border border-kumo-line bg-kumo-base p-3">
              <BrandMark
                iconPreset={extra.icon_preset}
                logoUrl={extra.logo_url}
                logoDarkUrl={extra.logo_dark_url}
                alt={value.name}
                size="md"
              />
              <div className="flex min-w-0 flex-col">
                <strong className="truncate text-sm font-semibold text-kumo-strong" dir="auto">
                  {value.name || "Meridian"}
                </strong>
                {extra.tagline && (
                  <span className="truncate text-xs text-kumo-subtle" dir="auto">
                    {extra.tagline}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-kumo-subtle">
              <span>{t("branding.collapsedPreview", "Collapsed rail:")}</span>
              <span className="inline-flex size-10 items-center justify-center rounded-lg border border-kumo-line bg-kumo-base">
                <BrandMark
                  iconPreset={extra.icon_preset}
                  logoUrl={extra.logo_url}
                  logoDarkUrl={extra.logo_dark_url}
                  alt={value.name}
                  size="md"
                />
              </span>
            </div>
          </aside>
        </div>
      </SectionCard>

      <SectionCard
        title={t("branding.footerLinks", "Public footer links")}
        description={t("branding.footerLinksDesc", "Add up to 8 links (documentation, status page, community, legal) shown in the portal footer.")}
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={Plus}
            disabled={disabled || extra.footer_links.length >= 8}
            onClick={addLink}
          >
            {t("branding.addLink", "Add link")}
          </Button>
        }
      >
        {extra.footer_links.length === 0 ? (
          <p className="text-sm text-kumo-subtle">
            {t("branding.noLinks", "No custom footer links yet. Click Add link to display navigation links in the public footer.")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {extra.footer_links.map((link, index) => (
              <div
                key={index}
                className="grid items-start gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/30 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto_auto]"
              >
                <Input
                  label={t("branding.linkLabel", "Label")}
                  value={link.label}
                  maxLength={48}
                  required
                  disabled={disabled}
                  placeholder={t("branding.linkLabelPlaceholder", "Documentation")}
                  onChange={(e) => updateLink(index, { label: e.target.value })}
                />
                <Input
                  label={t("branding.linkUrl", "URL")}
                  type="url"
                  value={link.url}
                  maxLength={2048}
                  required
                  disabled={disabled}
                  dir="ltr"
                  placeholder="https://docs.example.net"
                  onChange={(e) => updateLink(index, { url: e.target.value })}
                />
                <div className="md:mt-8">
                  <Checkbox
                    label={t("branding.newTab", "New tab")}
                    checked={link.external}
                    disabled={disabled}
                    onCheckedChange={(checked) => updateLink(index, { external: checked })}
                  />
                </div>
                <div className="flex items-center gap-1 md:mt-7">
                  <Tooltip
                    content={t("common.moveUp", "Move up")}
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        shape="square"
                        size="sm"
                        icon={ArrowUp}
                        disabled={disabled || index === 0}
                        aria-label={t("common.moveUp", "Move up")}
                        onClick={() => moveLink(index, -1)}
                      />
                    }
                  />
                  <Tooltip
                    content={t("common.moveDown", "Move down")}
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        shape="square"
                        size="sm"
                        icon={ArrowDown}
                        disabled={disabled || index === extra.footer_links.length - 1}
                        aria-label={t("common.moveDown", "Move down")}
                        onClick={() => moveLink(index, 1)}
                      />
                    }
                  />
                  <Tooltip
                    content={t("common.remove", "Remove")}
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        shape="square"
                        size="sm"
                        icon={Trash}
                        disabled={disabled}
                        aria-label={t("common.remove", "Remove")}
                        onClick={() =>
                          onChangeExtra({ footer_links: extra.footer_links.filter((_, i) => i !== index) })
                        }
                      />
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
