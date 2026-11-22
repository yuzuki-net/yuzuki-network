import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import {
  AndroidLogo,
  AppleLogo,
  ArrowRight,
  ArrowSquareOut,
  BellRinging,
  BookOpen,
  ChartDonut,
  Compass,
  Desktop,
  DeviceMobile,
  Devices,
  DownloadSimple,
  Lifebuoy,
  LinkSimple,
  LinuxLogo,
  QrCode,
  ShieldCheck,
  Sparkle,
  WarningCircle,
  WindowsLogo,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useResource } from "../../app/query";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, PageHeader } from "../../components/console-ui";
import { bytes, dateTime, percent } from "../../components/format";
import { HelpTip, QrCodeModal } from "../../components/kumo-ext";
import { normalizePanel, usePortalOptions } from "../../features/portal/options";
import { personalQuotaPath, type QuotaDetails } from "../../features/quotas/model";
import { useCan, useSession } from "../../features/session/context";
import {
  detectPlatform,
  resolvePlatformImports,
  type PlatformId,
} from "../../features/subscriptions/clients";
import {
  absoluteLink,
  countLinks,
  formats,
  provisionSubscriptionsUrl,
  subscriptionsUrl,
  type FormatCode,
  type SubscriptionLink,
  type SubscriptionSnapshot,
} from "../../features/subscriptions/links";
import { SubscriberNodesCard } from "../../features/subscriptions/nodes-card";
import { english, useT } from "../../i18n";
import { UNREAD, type UnreadSummary } from "../announcements/model";
import "./style.css";

const PLATFORMS: readonly { id: PlatformId; label: string }[] = [
  { id: "ios", label: "iOS" },
  { id: "android", label: "Android" },
  { id: "windows", label: "Windows" },
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
];

function PlatformIcon({ id }: { id: PlatformId }) {
  if (id === "ios" || id === "macos") return <AppleLogo size={15} aria-hidden />;
  if (id === "android") return <AndroidLogo size={15} aria-hidden />;
  if (id === "windows") return <WindowsLogo size={15} aria-hidden />;
  return <LinuxLogo size={15} aria-hidden />;
}

export default function Overview() {
  const t = useT("overview");
  const session = useSession();
  const options = usePortalOptions();
  const panel = normalizePanel(options.data?.panel);
  const subscriptions = useCan("subscriptions.read");
  const canCreate = useCan("subscriptions.manage");
  const quota = useResource<QuotaDetails>(personalQuotaPath);
  const snapshot = useResource<SubscriptionSnapshot>(subscriptionsUrl, subscriptions);
  const unread = useResource<UnreadSummary>(UNREAD, panel.features.announcements, 60_000).data?.unread ?? 0;

  const [platform, setPlatform] = useState<PlatformId>(() => detectPlatform());
  const [advancedFormat, setAdvancedFormat] = useState<FormatCode>(3);
  const [qrTarget, setQrTarget] = useState<{ title: string; subtitle: string; value: string } | null>(null);

  const cache = useQueryClient();
  const toast = useKumoToastManager();

  const links = snapshot.data?.links ?? [];
  const inUse = snapshot.data ? countLinks(snapshot.data) : ([0, 0, 0, 0] as const);
  const eligible = snapshot.data?.quota.eligible ?? quota.data?.eligible;
  const quotaStatus = quota.data ?? snapshot.data?.quota;
  const usedBytes = quotaStatus?.used_bytes ?? session.used_bytes;
  const quotaBytes = quotaStatus ? quotaStatus.quota_bytes : session.quota_bytes;
  const remainingStr = quotaStatus?.remaining_bytes ?? null;
  const used = BigInt(usedBytes || "0");
  const limit = quotaBytes === null ? null : BigInt(quotaBytes);
  const available =
    remainingStr !== null
      ? BigInt(remainingStr)
      : limit === null
        ? null
        : limit > used
          ? limit - used
          : 0n;
  const usage = percent(usedBytes, quotaBytes);
  const activeGrants = (quotaStatus?.grants ?? []).filter((g) => !g.revoked && g.state === "available");

  const missingFormats = snapshot.data
    ? formats.filter(({ code }) => snapshot.data!.effective_link_limits[code] > 0 && inUse[code] === 0)
    : [];

  const provision = useMutation({
    mutationFn: () => api<SubscriptionLink[]>(provisionSubscriptionsUrl, "POST"),
    onSuccess: (created) => {
      void cache.invalidateQueries({ queryKey: [subscriptionsUrl] });
      void cache.invalidateQueries({ queryKey: [personalQuotaPath] });
      toast.add({
        title:
          created.length > 0
            ? t("provisionSuccess", "Created {count} default subscription link(s)", { count: created.length })
            : t("provisionUpToDate", "All default subscription links are ready"),
        variant: "success",
      });
    },
  });

  const platformClients = resolvePlatformImports(
    platform,
    links,
    panel.name,
    panel.subscription.base_url,
    panel.subscription.enabled_clients,
  );

  // Primary subscription link for quick copy & QR: prefer Universal (3), then default_format, then any active link
  const primaryLink =
    links.find((l) => l.format === 3 && l.within_limit) ??
    links.find((l) => l.format === panel.subscription.default_format && l.within_limit) ??
    links.find((l) => l.within_limit);
  const primaryFormat = primaryLink ? formats[primaryLink.format] : formats[3];
  const primaryUrl = primaryLink ? absoluteLink(primaryLink.path, panel.subscription.base_url) : undefined;

  // Advanced per-format link
  const advFormatSpec = formats.find(({ code }) => code === advancedFormat) ?? formats[3];
  const advLink = links.find((l) => l.format === advancedFormat && l.within_limit);
  const advUrl = advLink ? absoluteLink(advLink.path, panel.subscription.base_url) : undefined;

  return (
    <>
      <PageHeader
        title={
          session.display_name
            ? t("welcome", "Welcome, {name}", { name: session.display_name })
            : t("title", "Personal overview")
        }
        description={t("description", "Connect a client, review your allowance and manage your account.")}
        action={
          <>
            {panel.subscription.guide_url && (
              <LinkButton
                href={panel.subscription.guide_url}
                target="_blank"
                rel="noopener noreferrer"
                variant="secondary"
                icon={BookOpen}
              >
                {t("guide", "Setup guide")}
              </LinkButton>
            )}
            {subscriptions && (
              <LinkButton href="/workspace/subscriptions" variant="secondary" icon={ArrowRight}>
                {t("manage", "Manage subscriptions")}
              </LinkButton>
            )}
          </>
        }
      />

      {panel.features.announcements && unread > 0 && (
        <KumoBanner
          size="sm"
          variant="default"
          icon={<BellRinging size={17} />}
          title={t("unreadTitle", "{count} unread announcements", { count: unread })}
          description={t("unreadDesc", "Your workspace administrators published new updates.")}
          action={
            <KumoBanner.Action href="/workspace/announcements" variant="secondary">
              {t("unreadOpen", "Open inbox")}
            </KumoBanner.Action>
          }
        />
      )}

      {limit !== null && usage >= 100 && (
        <KumoBanner
          size="sm"
          variant="error"
          icon={<WarningCircle size={17} />}
          title={english("overview", "quotaExhaustedTitle", "Transfer allowance exhausted")}
          description={english("overview", "quotaExhaustedDesc", "Your subscription links are paused until your quota resets or is increased by an administrator.")}
        />
      )}

      {limit !== null && usage >= 85 && usage < 100 && (
        <KumoBanner
          size="sm"
          variant="alert"
          icon={<WarningCircle size={17} />}
          title={t("quotaLowTitle", "Less than 15% transfer allowance remaining")}
          description={t("quotaLowDesc", "Only {remaining} remains in your current quota window.", {
            remaining: available !== null ? bytes(available.toString()) : "0 B",
          })}
        />
      )}

      {subscriptions && (
        <LayerCard render={<section aria-labelledby="start-heading" />} className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line px-5 py-3.5">
            <div className="flex items-center gap-2.5">
              <span
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg"
                style={{ background: "var(--brand-accent-soft)", color: "var(--brand-accent-strong)" }}
                aria-hidden
              >
                <DownloadSimple size={18} weight="bold" />
              </span>
              <div>
                <div className="flex items-center gap-1.5">
                  <h2 id="start-heading" className="text-base font-semibold text-kumo-strong">
                    {t("quickImport.title", "Quick import")}
                  </h2>
                  <HelpTip
                    content={t(
                      "quickImport.tooltip",
                      "Select your device platform and click your client to import your subscription automatically in the optimal format.",
                    )}
                  />
                </div>
                <p className="text-xs text-kumo-subtle">
                  {eligible === false
                    ? english("overview", "paused", "Subscription access is paused. Check your transfer allowance or contact an administrator.")
                    : t("quickImport.subtitle", "Pick your device platform to one-click import or copy your universal subscription.")}
                </p>
              </div>
            </div>

            <Tabs
              variant="segmented"
              value={platform}
              onValueChange={(value) => setPlatform(value as PlatformId)}
              tabs={PLATFORMS.map((p) => ({
                value: p.id,
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <PlatformIcon id={p.id} />
                    <span>{p.label}</span>
                  </span>
                ),
              }))}
            />
          </div>

          <div className="flex flex-col gap-4 p-5">
            <Banner error={provision.error} />

            {eligible === false ? (
              <div className="rounded-lg border border-dashed border-kumo-line bg-kumo-recessed/40 p-4 text-sm text-kumo-subtle">
                {english("overview", "paused", "Subscription access is paused. Check your transfer allowance or contact an administrator.")}
              </div>
            ) : (
              <>
                {canCreate && missingFormats.length > 0 && (
                  <KumoBanner
                    size="sm"
                    variant="default"
                    icon={<Sparkle size={17} />}
                    title={t("provisionBanner.title", "Missing default subscription links")}
                    description={t(
                      "provisionBanner.desc",
                      "Generate links for all supported formats ({formats}) in one click so every client works immediately.",
                      { formats: missingFormats.map((f) => f.name).join(", ") },
                    )}
                    action={
                      <Button
                        variant="primary"
                        size="sm"
                        icon={Sparkle}
                        loading={provision.isPending}
                        onClick={() => provision.mutate()}
                      >
                        {t("provisionBanner.action", "Generate default links")}
                      </Button>
                    }
                  />
                )}

                {/* One-click Client Import Grid */}
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {platformClients.map((client) => {
                    const fmtLabel = client.format !== null ? formats[client.format].name : null;
                    return (
                      <div
                        key={client.key}
                        className="flex flex-col justify-between gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/30 p-3.5 transition-colors hover:border-kumo-interact"
                      >
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center justify-between gap-2">
                            <strong className="truncate text-sm text-kumo-strong">{client.name}</strong>
                            {client.badge && (
                              <Badge variant="primary">
                                {t("quickImport.recommended", "Recommended")}
                              </Badge>
                            )}
                          </div>
                          <span className="text-xs text-kumo-subtle">
                            {fmtLabel
                              ? t("quickImport.usesFormat", "Format: {format}", { format: fmtLabel })
                              : t("quickImport.noLink", "Link not generated yet")}
                          </span>
                        </div>
                        {client.href ? (
                          <LinkButton href={client.href} variant="primary" size="sm" icon={DownloadSimple} className="w-full justify-center">
                            {t("oneClickImport", "One-click import")}
                          </LinkButton>
                        ) : canCreate ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={Sparkle}
                            loading={provision.isPending}
                            className="w-full justify-center"
                            onClick={() => provision.mutate()}
                          >
                            {t("provisionBanner.short", "Generate link")}
                          </Button>
                        ) : (
                          <Button variant="secondary" size="sm" disabled className="w-full justify-center">
                            {t("unavailable", "Unavailable")}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Universal Subscription Copy + QR + Actions */}
                {primaryUrl && (
                  <div className="flex flex-wrap items-center gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-3.5">
                    <div className="flex items-center gap-2 text-xs font-medium text-kumo-strong">
                      <LinkSimple size={15} style={{ color: "var(--brand-accent)" }} aria-hidden />
                      <span>{t("quickImport.copyLabel", "{format} subscription", { format: primaryFormat.name })}</span>
                      <Chip tone="blue">{primaryFormat.type}</Chip>
                    </div>
                    <div className="min-w-0 flex-1 basis-56">
                      <ClipboardText
                        key={primaryUrl}
                        size="sm"
                        text={primaryUrl}
                        labels={{ copyAction: t("copy", "{format} subscription address", { format: primaryFormat.name }) }}
                        tooltip={{ text: t("copyBtn", "Copy link"), copiedText: t("copiedBtn", "Copied") }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {panel.subscription.show_qr_code && (
                        <Tooltip
                          content={t("qrTooltip", "Show scannable QR code for mobile clients")}
                          render={
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={QrCode}
                              onClick={() =>
                                setQrTarget({
                                  title: primaryLink?.name || `${panel.name} · ${primaryFormat.name}`,
                                  subtitle: `${primaryFormat.name} (${primaryFormat.type})`,
                                  value: primaryUrl,
                                })
                              }
                            >
                              {t("qrButton", "QR code")}
                            </Button>
                          }
                        />
                      )}
                      <LinkButton href="/workspace/subscriptions" variant="ghost" size="sm">
                        {t("allLinks", "All links")}
                      </LinkButton>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Power-user collapsible format selector */}
          <div className="border-t border-kumo-line bg-kumo-recessed/25 px-5 py-2.5">
            <Collapsible.Root>
              <Collapsible.Trigger className="flex items-center gap-1.5 text-xs font-medium text-kumo-subtle hover:text-kumo-strong">
                <Compass size={14} aria-hidden />
                <span>{t("quickImport.byFormat", "Advanced: copy subscription link by core format (Universal / mihomo / sing-box / xray-core)")}</span>
              </Collapsible.Trigger>
              <Collapsible.Panel className="flex flex-col gap-3 pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Tabs
                    variant="segmented"
                    value={String(advancedFormat)}
                    onValueChange={(v) => setAdvancedFormat(Number(v) as FormatCode)}
                    tabs={formats.map((f) => ({ value: String(f.code), label: `${f.name} (${f.type})` }))}
                  />
                  <span className="text-xs text-kumo-subtle">
                    {t("clientsSupported", "Compatible clients: {clients}", { clients: advFormatSpec.clients })}
                  </span>
                </div>
                {advUrl && eligible ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1 basis-60">
                      <ClipboardText
                        key={advUrl}
                        size="sm"
                        text={advUrl}
                        labels={{ copyAction: t("copy", "{format} subscription address", { format: advFormatSpec.name }) }}
                        tooltip={{ text: t("copyBtn", "Copy link"), copiedText: t("copiedBtn", "Copied") }}
                      />
                    </div>
                    {panel.subscription.show_qr_code && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={QrCode}
                        onClick={() =>
                          setQrTarget({
                            title: advLink?.name || `${panel.name} · ${advFormatSpec.name}`,
                            subtitle: `${advFormatSpec.name} (${advFormatSpec.type})`,
                            value: advUrl,
                          })
                        }
                      >
                        {t("qrButton", "QR code")}
                      </Button>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-kumo-subtle">
                    {t("noLinkYet", "You do not have an active {format} subscription link yet.", { format: advFormatSpec.name })}
                  </p>
                )}
              </Collapsible.Panel>
            </Collapsible.Root>
          </div>
        </LayerCard>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <LayerCard render={<section aria-labelledby="usage-heading" />} className="flex flex-col justify-between overflow-hidden">
          <header className="flex items-center justify-between gap-2 border-b border-kumo-line px-5 py-3.5">
            <div className="flex items-center gap-2">
              <ChartDonut size={18} style={{ color: "var(--brand-accent)" }} aria-hidden />
              <h2 id="usage-heading" className="text-sm font-semibold text-kumo-strong">
                {t("quota", "Transfer allowance")}
              </h2>
            </div>
            <div className="flex items-center gap-1.5">
              {activeGrants.length > 1 && (
                <Chip tone="blue">{t("quotaPackages", "{count} packages", { count: activeGrants.length })}</Chip>
              )}
              <HelpTip content={t("quotaTip", "Includes combined upload and download transfer across your active quota packages.")} />
            </div>
          </header>
          <div className="flex flex-1 flex-col gap-3 p-5">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tracking-tight text-kumo-strong tabular-nums">
                {available === null ? t("unlimited", "Unlimited") : bytes(available.toString())}
              </span>
              <span className="text-xs text-kumo-subtle">
                {available === null ? t("allowance", "allowance") : t("remaining", "remaining")}
              </span>
            </div>
            {limit === null ? (
              <p className="text-xs text-kumo-subtle">
                {t("transferred", "{value} transferred", { value: bytes(usedBytes) })}
              </p>
            ) : (
              <Meter
                label={t("transferUsed", "Transfer used")}
                value={usage}
                customValue={t("transferUsed.value", "{used} of {max}", {
                  used: bytes(usedBytes),
                  max: bytes(quotaBytes),
                })}
              />
            )}
            {activeGrants.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {activeGrants.slice(0, 3).map((g) => (
                  <Badge key={g.id} variant="secondary">
                    {g.name}
                    {g.quota_bytes !== null && g.remaining_bytes !== null
                      ? ` · ${bytes(g.remaining_bytes)}`
                      : ""}
                  </Badge>
                ))}
              </div>
            )}
            {quotaStatus?.window_ends_at && (
              <p className="mt-auto text-xs text-kumo-subtle">
                {activeGrants.some((g) => g.reset_mode === "cycle" && g.cycle_ends_at === quotaStatus.window_ends_at)
                  ? t("resets", "Resets {date}", { date: dateTime(quotaStatus.window_ends_at) })
                  : t("ends", "Ends {date}", { date: dateTime(quotaStatus.window_ends_at) })}
              </p>
            )}
          </div>
        </LayerCard>

        {panel.workspace.show_devices_card && (
          <LayerCard render={<section aria-labelledby="devices-heading" />} className="flex flex-col justify-between overflow-hidden">
            <header className="flex items-center justify-between gap-2 border-b border-kumo-line px-5 py-3.5">
              <div className="flex items-center gap-2">
                {platform === "ios" || platform === "android" ? (
                  <DeviceMobile size={18} style={{ color: "var(--brand-accent)" }} aria-hidden />
                ) : (
                  <Desktop size={18} style={{ color: "var(--brand-accent)" }} aria-hidden />
                )}
                <h2 id="devices-heading" className="text-sm font-semibold text-kumo-strong">
                  {t("devices", "Subscription devices")}
                </h2>
              </div>
              <HelpTip content={t("devicesTip", "A client occupies a device slot for 30 days after its latest subscription refresh.")} />
            </header>
            <div className="flex flex-1 flex-col justify-between gap-3 p-5">
              <div>
                <p className="text-2xl font-semibold tracking-tight text-kumo-strong tabular-nums">
                  {quota.data
                    ? t("devices.count", "{count} recent", { count: quota.data.active_devices })
                    : t("checking", "Checking…")}
                </p>
                <p className="mt-1 text-xs text-kumo-subtle">
                  {quota.data?.max_devices !== null && quota.data?.max_devices !== undefined
                    ? t("devices.limit", "Limit of {max} devices", { max: quota.data.max_devices })
                    : t("devices.unlimited", "Unlimited device bindings")}
                </p>
              </div>
              {subscriptions && (
                <div>
                  <LinkButton href="/workspace/subscriptions?view=devices" variant="secondary" size="sm" icon={Devices}>
                    {t("devices.open", "Manage subscription devices")}
                  </LinkButton>
                </div>
              )}
            </div>
          </LayerCard>
        )}

        <LayerCard render={<section aria-labelledby="account-heading" />} className="flex flex-col justify-between overflow-hidden">
          <header className="flex items-center justify-between gap-2 border-b border-kumo-line px-5 py-3.5">
            <div className="flex items-center gap-2">
              {panel.subscription.support_links.length > 0 ? (
                <Lifebuoy size={18} style={{ color: "var(--brand-accent)" }} aria-hidden />
              ) : (
                <ShieldCheck size={18} style={{ color: "var(--brand-accent)" }} aria-hidden />
              )}
              <h2 id="account-heading" className="text-sm font-semibold text-kumo-strong">
                {panel.subscription.support_links.length > 0
                  ? t("supportAndAccount", "Support & account")
                  : t("account", "Your account")}
              </h2>
            </div>
          </header>
          <div className="flex flex-1 flex-col justify-between gap-3 p-5">
            <div className="flex flex-col gap-2">
              <p className="truncate text-sm font-medium text-kumo-strong" title={session.email}>
                <bdi>{session.email}</bdi>
              </p>
              {panel.subscription.support_links.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {panel.subscription.support_links.map((item, idx) => (
                    <LinkButton
                      key={idx}
                      href={item.url}
                      target={item.external ? "_blank" : undefined}
                      rel={item.external ? "noopener noreferrer" : undefined}
                      variant="secondary"
                      size="xs"
                      icon={ArrowSquareOut}
                    >
                      {item.label}
                    </LinkButton>
                  ))}
                </div>
              )}
            </div>
            <div>
              <LinkButton href="/workspace/security" variant="secondary" size="sm" icon={ShieldCheck}>
                {t("account.open", "Account settings")}
              </LinkButton>
            </div>
          </div>
        </LayerCard>
      </div>

      <SubscriberNodesCard enabled={subscriptions} />

      {qrTarget && (
        <QrCodeModal
          open
          onClose={() => setQrTarget(null)}
          title={qrTarget.title}
          subtitle={qrTarget.subtitle}
          value={qrTarget.value}
        />
      )}
    </>
  );
}
