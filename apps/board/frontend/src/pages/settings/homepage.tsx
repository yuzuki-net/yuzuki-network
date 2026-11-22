import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { Plus, Trash } from "@phosphor-icons/react";
import { SectionCard } from "../../components/console-ui";
import { brandIconPresets, type BrandIconPreset } from "../../components/kumo-ext";
import type { HeroStyle, HighlightCard, Panel, PortalCustomization } from "../../features/portal/options";
import { useT } from "../../i18n";

type Landing = Panel["landing"];

export function HomepageSettings({
  landing,
  portal,
  disabled,
  onChangeLanding,
  onChangePortal,
}: {
  landing: Landing;
  portal: PortalCustomization;
  disabled: boolean;
  onChangeLanding: (changes: Partial<Landing>) => void;
  onChangePortal: (changes: Partial<PortalCustomization>) => void;
}) {
  const t = useT("settings");
  const portalT = useT("portal");
  const defaultHeadline = portalT("home.headline", "Your workspace, ready when you are");
  const defaultIntro = portalT("home.description", "Sign in to access your organization’s workspace and manage your account.");

  const iconOptions = Object.fromEntries(
    Object.entries(brandIconPresets).map(([key, val]) => [key, val.label]),
  );

  function addHighlight() {
    if (portal.highlights.length >= 6) return;
    onChangePortal({
      highlights: [
        ...portal.highlights,
        { icon: "lightning", title: "", description: "" },
      ],
    });
  }

  function updateHighlight(index: number, patch: Partial<HighlightCard>) {
    onChangePortal({
      highlights: portal.highlights.map((card, i) => (i === index ? { ...card, ...patch } : card)),
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <SectionCard
        title={t("homepage.title", "Public homepage")}
        description={t("homepage.description", "Customize the built-in homepage hero, visual artwork and call to action. A custom public HTML overlay still takes precedence when configured.")}
      >
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)]">
          <div className="form-fields">
            <div className="edit-grid">
              <Input
                label={t("homepage.badge", "Hero badge")}
                value={portal.hero_badge ?? ""}
                placeholder={t("homepage.badgePlaceholder", "e.g. Global Edge Network")}
                maxLength={60}
                disabled={disabled}
                onChange={(e) => onChangePortal({ hero_badge: e.target.value || null })}
              />
              <Select
                label={t("homepage.heroStyle", "Hero visual style")}
                value={portal.hero_style}
                disabled={disabled}
                items={{
                  mesh: t("homepage.style.mesh", "Gradient mesh"),
                  grid: t("homepage.style.grid", "Architectural grid"),
                  minimal: t("homepage.style.minimal", "Minimal card"),
                  none: t("homepage.style.none", "Text only (no artwork)"),
                }}
                onValueChange={(hero_style: HeroStyle | null) => hero_style && onChangePortal({ hero_style })}
              />
            </div>

            <Input
              label={t("homepage.headline", "Headline")}
              name="hero-headline"
              value={landing.headline ?? ""}
              placeholder={defaultHeadline}
              maxLength={120}
              disabled={disabled}
              onChange={(event) => onChangeLanding({ headline: event.target.value || null })}
            />
            <Textarea
              label={t("homepage.text", "Introduction")}
              name="hero-description"
              value={landing.description ?? ""}
              placeholder={defaultIntro}
              rows={3}
              maxLength={600}
              disabled={disabled}
              onChange={(event) => onChangeLanding({ description: event.target.value || null })}
            />
            <div className="edit-grid">
              <Input
                label={t("homepage.primaryCta", "Primary button text")}
                value={portal.primary_cta ?? ""}
                placeholder={portalT("home.sign_in", "Sign in to your workspace")}
                maxLength={48}
                disabled={disabled}
                onChange={(e) => onChangePortal({ primary_cta: e.target.value || null })}
              />
              <div className="sm:mt-8">
                <Switch
                  label={t("homepage.quick_links", "Show quick links for signed-in users")}
                  checked={landing.show_features}
                  onCheckedChange={(show_features) => onChangeLanding({ show_features })}
                  disabled={disabled}
                />
              </div>
            </div>
          </div>

          <aside className="flex flex-col gap-2.5 rounded-lg border border-kumo-line bg-kumo-recessed/50 p-4">
            <span className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
              {t("homepage.preview", "Homepage preview")}
            </span>
            <div className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-base p-5">
              {portal.hero_badge && (
                <span
                  className="inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
                  style={{ background: "var(--brand-accent-soft)", color: "var(--brand-accent-strong)" }}
                >
                  {portal.hero_badge}
                </span>
              )}
              <strong className="text-lg font-semibold leading-snug text-kumo-strong" dir="auto">
                {landing.headline || defaultHeadline}
              </strong>
              <p className="whitespace-pre-line text-sm text-kumo-subtle" dir="auto">
                {landing.description || defaultIntro}
              </p>
              <span
                className="mt-1 inline-flex w-fit items-center rounded-md px-3 py-1.5 text-xs font-medium text-white"
                style={{ background: "var(--brand-accent)" }}
              >
                {portal.primary_cta || portalT("home.sign_in", "Sign in to your workspace")}
              </span>
            </div>
          </aside>
        </div>
      </SectionCard>

      <SectionCard
        title={t("homepage.highlights", "Public feature highlights")}
        description={t("homepage.highlightsDesc", "Display up to 6 feature cards on the public landing page for all visitors (e.g. protocols, global nodes, zero-config setup).")}
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={Plus}
            disabled={disabled || portal.highlights.length >= 6}
            onClick={addHighlight}
          >
            {t("homepage.addHighlight", "Add highlight")}
          </Button>
        }
      >
        {portal.highlights.length === 0 ? (
          <p className="text-sm text-kumo-subtle">
            {t("homepage.noHighlights", "No public highlight cards configured. Add cards to showcase your service capabilities on the homepage.")}
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {portal.highlights.map((card, index) => (
              <div
                key={index}
                className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/30 p-3.5"
              >
                <div className="flex items-end justify-between gap-2">
                  <div className="flex-1">
                    <Select
                      label={t("homepage.cardIcon", "Icon")}
                      value={card.icon}
                      items={iconOptions}
                      disabled={disabled}
                      onValueChange={(icon: BrandIconPreset | null) =>
                        icon && updateHighlight(index, { icon })
                      }
                    />
                  </div>
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
                          onChangePortal({ highlights: portal.highlights.filter((_, i) => i !== index) })
                        }
                      />
                    }
                  />
                </div>
                <Input
                  label={t("homepage.cardTitle", "Title")}
                  value={card.title}
                  maxLength={60}
                  required
                  disabled={disabled}
                  placeholder={t("homepage.cardTitlePlaceholder", "Multi-protocol subscriptions")}
                  onChange={(e) => updateHighlight(index, { title: e.target.value })}
                />
                <Textarea
                  label={t("homepage.cardDesc", "Description")}
                  value={card.description}
                  rows={2}
                  maxLength={240}
                  required
                  disabled={disabled}
                  placeholder={t("homepage.cardDescPlaceholder", "Generate xray-core, sing-box and mihomo profiles from one place.")}
                  onChange={(e) => updateHighlight(index, { description: e.target.value })}
                />
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={t("homepage.authTitle", "Sign-in & registration pages")}
        description={t("homepage.authDesc", "Customize headings, notices and legal links shown on /login and /register.")}
      >
        <div className="form-fields">
          <div className="edit-grid">
            <Input
              label={t("homepage.authHeading", "Sign-in heading override")}
              value={portal.auth_title ?? ""}
              maxLength={80}
              disabled={disabled}
              placeholder={portalT("auth.sign_in", "Sign in")}
              onChange={(e) => onChangePortal({ auth_title: e.target.value || null })}
            />
            <Input
              label={t("homepage.authSubtitle", "Sign-in subtitle override")}
              value={portal.auth_subtitle ?? ""}
              maxLength={240}
              disabled={disabled}
              placeholder={portalT("auth.login_desc", "Enter your email address and password to access your workspace.")}
              onChange={(e) => onChangePortal({ auth_subtitle: e.target.value || null })}
            />
          </div>
          <Textarea
            label={t("homepage.authNotice", "Auth page notice banner")}
            description={t("homepage.authNoticeHint", "Optional notice shown above the sign-in and registration form (e.g. invitation rules or support contact).")}
            value={portal.auth_notice ?? ""}
            rows={2}
            maxLength={400}
            disabled={disabled}
            onChange={(e) => onChangePortal({ auth_notice: e.target.value || null })}
          />
          <div className="edit-grid">
            <Input
              label={t("homepage.termsUrl", "Terms of Service URL")}
              type="url"
              dir="ltr"
              value={portal.terms_url ?? ""}
              maxLength={2048}
              disabled={disabled}
              placeholder="https://example.net/terms"
              onChange={(e) => onChangePortal({ terms_url: e.target.value || null })}
            />
            <Input
              label={t("homepage.privacyUrl", "Privacy Policy URL")}
              type="url"
              dir="ltr"
              value={portal.privacy_url ?? ""}
              maxLength={2048}
              disabled={disabled}
              placeholder="https://example.net/privacy"
              onChange={(e) => onChangePortal({ privacy_url: e.target.value || null })}
            />
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
