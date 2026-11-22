import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { ArrowRight, BellRinging, ChartLineUp, ShieldCheck } from "@phosphor-icons/react";
import { brandIconPresets } from "../../components/kumo-ext";
import { PortalFrame } from "../../features/portal/frame";
import { defaultPanel, normalizePanel, usePortalOptions, useRefreshRestoredPortal } from "../../features/portal/options";
import { useT } from "../../i18n";
import "./style.css";

export default function Home() {
  const t = useT("portal");
  const options = usePortalOptions();
  const panel = normalizePanel(options.data?.panel ?? defaultPanel);
  const signedIn = options.data?.signed_in ?? false;
  const workspace = options.data?.workspace;
  useRefreshRestoredPortal();

  const quickLinks = [
    {
      key: "usage",
      href: "/workspace",
      icon: ChartLineUp,
      title: t("home.usage", "Review usage"),
      description: t("home.usage_desc", "Check available transfer and active subscriptions."),
    },
    {
      key: "security",
      href: "/workspace/security",
      icon: ShieldCheck,
      title: t("home.security", "Manage your account"),
      description: t("home.security_desc", "Update your profile and manage where you’re signed in."),
    },
    ...(panel.features.announcements
      ? [
          {
            key: "news",
            href: "/workspace/announcements",
            icon: BellRinging,
            title: t("home.news", "Read announcements"),
            description: t("home.news_desc", "See updates from your workspace administrators."),
          },
        ]
      : []),
  ];

  const primaryLabel =
    workspace === "/admin"
      ? t("home.openAdmin", "Open administration")
      : signedIn
        ? t("home.open", "Open workspace")
        : panel.portal.primary_cta || t("home.sign_in", "Sign in to your workspace");

  const maintenance = panel.workspace.maintenance_banner;
  const showArt = panel.portal.hero_style !== "none";

  return (
    <PortalFrame panel={panel} home workspace={workspace} waiting={options.isPending}>
      <main className="portal-home portal-width" id="main-content">
        {maintenance.enabled && (maintenance.title || maintenance.message) && (
          <KumoBanner
            size="sm"
            variant={maintenance.variant === "error" ? "error" : maintenance.variant === "warning" ? "alert" : "default"}
            title={maintenance.title || undefined}
            description={maintenance.message || undefined}
          />
        )}

        <LayerCard
          render={<section aria-labelledby="hero-heading" />}
          className={`portal-hero ${!showArt ? "portal-hero-solo" : ""}`}
        >
          <div className="portal-hero-content">
            {panel.portal.hero_badge && (
              <span
                className="inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs font-medium"
                style={{
                  background: "var(--brand-accent-soft)",
                  borderColor: "var(--brand-accent-border)",
                  color: "var(--brand-accent-strong)",
                }}
              >
                {panel.portal.hero_badge}
              </span>
            )}
            <h1 id="hero-heading" dir={panel.landing.headline ? "auto" : undefined}>
              {panel.landing.headline ?? t("home.headline", "Your workspace, ready when you are")}
            </h1>
            <p dir={panel.landing.description ? "auto" : undefined}>
              {panel.landing.description ??
                (signedIn
                  ? t("home.signedInDescription", "Open your workspace to manage your account.")
                  : t("home.description", "Sign in to access your organization’s workspace and manage your account."))}
            </p>
            <div className="portal-hero-action">
              {options.isPending ? (
                <SkeletonLine className="portal-hero-placeholder" />
              ) : (
                <LinkButton href={workspace ?? "/login"} variant="primary" icon={ArrowRight}>
                  {primaryLabel}
                </LinkButton>
              )}
              {!options.isPending && !signedIn && options.data?.registration && (
                <LinkButton href="/register" variant="secondary">
                  {t("auth.register", "Create an account")}
                </LinkButton>
              )}
            </div>
          </div>

          {showArt && (
            <div className="portal-hero-art" data-style={panel.portal.hero_style} aria-hidden="true">
              <div className="portal-art-lines">
                <i />
                <i />
                <i />
              </div>
              <div className="portal-art-center">
                <span />
                <span />
                <span />
                <span />
              </div>
              <div className="portal-art-accent" />
            </div>
          )}
        </LayerCard>

        {panel.portal.highlights.length > 0 && (
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label={t("home.highlights", "Highlights")}>
            {panel.portal.highlights.map((card, index) => {
              const Glyph = brandIconPresets[card.icon]?.icon ?? brandIconPresets.circles.icon;
              return (
                <LayerCard key={index} render={<article />} className="flex flex-col gap-2.5 p-5">
                  <span
                    className="inline-flex size-9 items-center justify-center rounded-lg"
                    style={{ background: "var(--brand-accent-soft)", color: "var(--brand-accent-strong)" }}
                    aria-hidden
                  >
                    <Glyph size={19} weight="duotone" />
                  </span>
                  <h2 className="text-base font-semibold text-kumo-strong" dir="auto">
                    {card.title}
                  </h2>
                  <p className="text-sm leading-relaxed text-kumo-subtle" dir="auto">
                    {card.description}
                  </p>
                </LayerCard>
              );
            })}
          </section>
        )}

        {panel.landing.show_features && signedIn && (
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label={t("home.quick_links", "Quick links")}>
            {quickLinks.map(({ key, href, icon: Icon, title, description }) => (
              <LayerCard className="flex flex-col justify-between gap-3 p-5" render={<article />} key={key}>
                <div className="flex flex-col gap-2.5">
                  <span
                    className="inline-flex size-9 items-center justify-center rounded-lg"
                    style={{ background: "var(--brand-accent-soft)", color: "var(--brand-accent-strong)" }}
                    aria-hidden
                  >
                    <Icon size={20} aria-hidden />
                  </span>
                  <h2 className="text-base font-semibold text-kumo-strong">{title}</h2>
                  <p className="text-sm text-kumo-subtle">{description}</p>
                </div>
                <div>
                  <LinkButton href={href} variant="secondary" size="sm" aria-label={title} icon={ArrowRight}>
                    {t("home.open_feature", "Open")}
                  </LinkButton>
                </div>
              </LayerCard>
            ))}
          </section>
        )}
      </main>
    </PortalFrame>
  );
}
