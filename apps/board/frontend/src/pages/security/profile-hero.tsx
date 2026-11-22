import { Badge } from "@cloudflare/kumo/components/badge";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Meter } from "@cloudflare/kumo/components/meter";
import {
  ArrowRight,
  Calendar,
  ChartDonut,
  Devices,
  Envelope,
  Package,
  ShieldCheck,
  User,
} from "@phosphor-icons/react";
import { useResource } from "../../app/query";
import { Chip } from "../../components/console-ui";
import { bytes, dateTime, percent } from "../../components/format";
import { personalQuotaPath, type QuotaDetails } from "../../features/quotas/model";
import { useCan, useSession } from "../../features/session/context";
import { displayName } from "../../features/session/model";
import { useLocale, useT } from "../../i18n";

function initials(name: string) {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function ProfileHero() {
  const t = useT("security");
  const { locale } = useLocale();
  const session = useSession();
  const canSubscribe = useCan("subscriptions.read");
  const quota = useResource<QuotaDetails>(personalQuotaPath);
  const sessions = useResource<Array<{ id: string }>>("/api/v1/me/sessions");

  const fullName = displayName(session);
  const roles = session.access.roles ?? [];
  const joinedDate = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
    new Date(session.created_at),
  );

  const lifetimeUsed = quota.data?.lifetime_used_bytes ?? session.used_bytes ?? "0";
  const currentUsed = quota.data?.used_bytes ?? session.used_bytes ?? "0";
  const quotaLimit = quota.data ? quota.data.quota_bytes : session.quota_bytes;
  const remainingStr = quota.data?.remaining_bytes ?? null;
  const usedBig = BigInt(currentUsed || "0");
  const limitBig = quotaLimit === null ? null : BigInt(quotaLimit);
  const remainingBig =
    remainingStr !== null
      ? BigInt(remainingStr)
      : limitBig === null
        ? null
        : limitBig > usedBig
          ? limitBig - usedBig
          : 0n;
  const usagePct = percent(currentUsed, quotaLimit);
  const activeGrants = (quota.data?.grants ?? []).filter((g) => !g.revoked && g.state === "available");

  return (
    <LayerCard render={<section aria-labelledby="account-profile-hero" />} className="overflow-hidden">
      {/* Top identity banner */}
      <div className="profile-hero-header">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <div className="profile-avatar" aria-hidden="true">
            {initials(fullName)}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="account-profile-hero" className="truncate text-lg font-semibold text-kumo-strong">
                <bdi>{fullName}</bdi>
              </h2>
              <Chip tone={session.active ? "green" : "amber"}>
                {session.active ? t("hero.statusActive", "Active") : t("hero.statusInactive", "Inactive")}
              </Chip>
              {roles.map((role) => (
                <Badge key={role.id} variant={role.locked ? "primary" : "secondary"}>
                  {role.locked && <ShieldCheck size={12} className="me-1 inline" aria-hidden />}
                  {role.name}
                </Badge>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-kumo-subtle">
              <span className="inline-flex items-center gap-1.5">
                <Envelope size={14} aria-hidden />
                <bdi>{session.email}</bdi>
              </span>
              {session.display_name && (
                <span className="inline-flex items-center gap-1.5">
                  <User size={14} aria-hidden />
                  <bdi>{session.display_name}</bdi>
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                <Calendar size={14} aria-hidden />
                <span>{t("hero.memberSince", "Member since {date}", { date: joinedDate })}</span>
              </span>
            </div>
          </div>
        </div>

        {canSubscribe && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <LinkButton href="/workspace/subscriptions" variant="secondary" size="sm" icon={ArrowRight}>
              {t("hero.openSubscriptions", "Subscriptions")}
            </LinkButton>
          </div>
        )}
      </div>

      {/* KPI Metrics Row */}
      <div className="grid gap-px border-t border-kumo-line bg-kumo-line sm:grid-cols-2 xl:grid-cols-4">
        {/* 1. Lifetime & Current Transfer */}
        <div className="flex flex-col gap-1.5 bg-kumo-base p-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-kumo-subtle">
            <ChartDonut size={15} style={{ color: "var(--brand-accent)" }} aria-hidden />
            <span>{t("hero.totalUsed", "Lifetime transfer")}</span>
          </div>
          <div className="text-xl font-semibold tracking-tight text-kumo-strong tabular-nums">
            {bytes(lifetimeUsed)}
          </div>
          <p className="text-xs text-kumo-subtle">
            {t("hero.cycleUsed", "Current window: {value}", { value: bytes(currentUsed) })}
          </p>
        </div>

        {/* 2. Remaining Allowance */}
        <div className="flex flex-col gap-1.5 bg-kumo-base p-4">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-kumo-subtle">
            <span>{t("hero.allowance", "Available allowance")}</span>
            {quota.data?.window_ends_at && (
              <span className="truncate text-[11px]">
                {t("hero.windowEnds", "Until {date}", { date: dateTime(quota.data.window_ends_at) })}
              </span>
            )}
          </div>
          <div className="text-xl font-semibold tracking-tight text-kumo-strong tabular-nums">
            {remainingBig === null ? t("hero.unlimited", "Unlimited") : bytes(remainingBig.toString())}
          </div>
          {limitBig !== null ? (
            <Meter
              label={t("hero.quotaMeter", "Quota usage")}
              value={usagePct}
              customValue={`${bytes(currentUsed)} / ${bytes(quotaLimit)}`}
            />
          ) : (
            <p className="text-xs text-kumo-subtle">
              {t("hero.noCap", "No transfer cap applied")}
            </p>
          )}
        </div>

        {/* 3. Active Packages */}
        <div className="flex flex-col gap-1.5 bg-kumo-base p-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-kumo-subtle">
            <Package size={15} style={{ color: "var(--brand-accent)" }} aria-hidden />
            <span>{t("hero.packages", "Active quota packages")}</span>
          </div>
          <div className="text-xl font-semibold tracking-tight text-kumo-strong tabular-nums">
            {quota.isPending
              ? "—"
              : t("hero.packageCount", "{count} active", { count: activeGrants.length })}
          </div>
          {activeGrants.length > 0 ? (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {activeGrants.slice(0, 3).map((grant) => (
                <Badge key={grant.id} variant="secondary">
                  {grant.name}
                </Badge>
              ))}
              {activeGrants.length > 3 && (
                <Badge variant="outline">+{activeGrants.length - 3}</Badge>
              )}
            </div>
          ) : (
            <p className="text-xs text-kumo-subtle">
              {t("hero.noPackages", "Default account allowance")}
            </p>
          )}
        </div>

        {/* 4. Devices & Active Sessions */}
        <div className="flex flex-col gap-1.5 bg-kumo-base p-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-kumo-subtle">
            <Devices size={15} style={{ color: "var(--brand-accent)" }} aria-hidden />
            <span>{t("hero.devicesAndSessions", "Devices & sessions")}</span>
          </div>
          <div className="text-xl font-semibold tracking-tight text-kumo-strong tabular-nums">
            {quota.data
              ? quota.data.max_devices !== null
                ? `${quota.data.active_devices} / ${quota.data.max_devices}`
                : t("hero.devicesCount", "{count} devices", { count: quota.data.active_devices })
              : "—"}
          </div>
          <p className="text-xs text-kumo-subtle">
            {sessions.data
              ? t("hero.sessionsCount", "{count} active sign-in session(s)", { count: sessions.data.length })
              : t("hero.loading", "Loading…")}
          </p>
        </div>
      </div>
    </LayerCard>
  );
}
