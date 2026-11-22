import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { InputGroup } from "@cloudflare/kumo/components/input-group";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import {
  ArrowClockwise,
  ArrowDown,
  ArrowUp,
  Bell,
  Broadcast,
  Devices,
  HardDrives,
  MagnifyingGlass,
  Megaphone,
  Pulse,
  Signpost,
  UserPlus,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState, type FormEvent } from "react";
import { api } from "../../assets/scripts/api";
import { useConsoleNavigate } from "../../app/router";
import { Banner, Chip, Empty, Loading, PageHeader } from "../../components/console-ui";
import { bytes } from "../../components/format";
import { KpiStatCard } from "../../components/kumo-ext";
import { dashboardUrl, type Metrics, type TrafficRange } from "../../features/dashboard/model";
import { useSession } from "../../features/session/context";
import { can } from "../../features/session/model";
import { useLocale, useT } from "../../i18n";
import "./style.css";

const TransferChart = lazy(() => import("../../features/dashboard/chart"));
const NodeMap = lazy(() => import("../../features/dashboard/map"));

export default function AdminOverview() {
  const { access } = useSession();
  const t = useT("dashboard");
  const { locale } = useLocale();
  const navigate = useConsoleNavigate();
  const count = new Intl.NumberFormat(locale);
  const [range, setRange] = useState<TrafficRange>("24h");
  const [query, setQuery] = useState("");
  const resource = useQuery({
    queryKey: [dashboardUrl, range],
    queryFn: ({ signal }) => api<Metrics>(`${dashboardUrl}?range=${range}`, "GET", undefined, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 25_000,
    staleTime: 15_000,
  });

  const accounts = resource.data?.accounts;
  const infra = resource.data?.infrastructure;

  function findUser(event: FormEvent) {
    event.preventDefault();
    const term = query.trim();
    navigate(term ? "/admin/users?" + new URLSearchParams({ q: term }) : "/admin/users");
  }

  return (
    <>
      <PageHeader
        title={t("title", "Administration overview")}
        description={t("description", "Monitor live traffic, node health and jump directly into common operations.")}
        action={
          <>
            <Tooltip
              content={t("refreshMetrics", "Refresh dashboard metrics")}
              render={
                <Button
                  variant="secondary"
                  shape="square"
                  icon={ArrowClockwise}
                  loading={resource.isFetching && !resource.isPending}
                  aria-label={t("refreshMetrics", "Refresh dashboard metrics")}
                  onClick={() => void resource.refetch()}
                />
              }
            />
            {can(access, "users.create") && (
              <LinkButton href="/admin/users?create=1" variant="primary" icon={UserPlus}>
                {t("quick.createUser", "Create user")}
              </LinkButton>
            )}
            {can(access, "nodes.read") && (
              <>
                <LinkButton href="/admin/nodes" variant="secondary" icon={Broadcast}>
                  {t("quick.nodes", "Nodes")}
                </LinkButton>
                <LinkButton href="/admin/servers" variant="secondary" icon={HardDrives}>
                  {t("quick.servers", "Servers")}
                </LinkButton>
              </>
            )}
            {can(access, "routing.read") && (
              <LinkButton href="/admin/routing?tab=preview" variant="secondary" icon={Signpost}>
                {t("quick.testRouting", "Test routing")}
              </LinkButton>
            )}
            {can(access, "announcements.manage") && (
              <LinkButton href="/admin/announcements" variant="secondary" icon={Megaphone}>
                {t("quick.announcements", "Announcements")}
              </LinkButton>
            )}
          </>
        }
      />

      <Banner error={resource.error} />

      {!!infra?.attention_nodes && (
        <KumoBanner
          size="sm"
          variant="alert"
          icon={<WarningCircle size={17} />}
          title={t("attention", "Published nodes need attention")}
          description={t("attention.detail", "{count} nodes have a stale connection or deployment problem.", {
            count: infra.attention_nodes,
          })}
          action={
            <KumoBanner.Action href="/admin/nodes?attention=1" variant="secondary">
              {t("attention.open", "Review nodes")}
            </KumoBanner.Action>
          }
        />
      )}

      {can(access, "users.read") && (
        <LayerCard render={<section />} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-kumo-strong">
            <UsersThree size={18} style={{ color: "var(--brand-accent)" }} aria-hidden />
            <span>{t("quick.find", "Quick user lookup")}</span>
            <span className="hidden text-xs font-normal text-kumo-subtle sm:inline">
              {t("quick.findHelp", "Search by email or display name.")}
            </span>
          </div>
          <form className="flex w-full max-w-md items-center gap-2" onSubmit={findUser}>
            <div className="min-w-0 flex-1">
              <InputGroup>
                <InputGroup.Addon align="start">
                  <MagnifyingGlass size={15} className="text-kumo-subtle" aria-hidden />
                </InputGroup.Addon>
                <InputGroup.Input
                  type="search"
                  aria-label={t("quick.searchField", "Name or email")}
                  placeholder={t("quick.searchField", "Name or email")}
                  maxLength={120}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </InputGroup>
            </div>
            <Button type="submit" variant="secondary">
              {t("quick.search", "Search")}
            </Button>
          </form>
        </LayerCard>
      )}

      {resource.isPending && <Loading label={t("loading", "Loading workspace metrics…")} />}

      {!!(accounts || infra) && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {accounts && (
            <>
              <KpiStatCard
                icon={UsersThree}
                title={t("metric.users", "Users")}
                value={count.format(accounts.users)}
                subtitle={t("metric.usersSub", "{active} active", { active: accounts.enabled_users })}
                help={t("metric.usersHelp", "{active} users can sign in.", { active: accounts.enabled_users })}
                href={can(access, "users.read") ? "/admin/users" : undefined}
              />
              <KpiStatCard
                icon={Pulse}
                title={t("metric.sessions", "Active console sessions")}
                value={count.format(accounts.active_console_sessions)}
                subtitle={t("metric.sessionsSub", "Last 5 minutes")}
                help={t("metric.sessionsHelp", "Signed-in sessions that were active in the last five minutes.")}
              />
              <KpiStatCard
                icon={Devices}
                title={t("metric.devices", "Recent subscription devices")}
                value={count.format(accounts.recent_subscription_devices)}
                subtitle={t("metric.devicesSub", "Refreshed in 15 min")}
                help={t("metric.devicesHelp", "Distinct subscription clients seen refreshing in the last 15 minutes.")}
              />
            </>
          )}
          {infra && (
            <>
              {infra.presence && (
                <KpiStatCard
                  icon={Broadcast}
                  title={t("metric.proxy", "Online proxy sources")}
                  value={
                    infra.presence.measured_instances
                      ? count.format(infra.presence.sources)
                      : t("metric.proxyUnavailable", "Unavailable")
                  }
                  subtitle={t("metric.proxySub", "{measured}/{total} instances reporting", {
                    measured: infra.presence.measured_instances,
                    total: infra.presence.active_instances,
                  })}
                  help={t(
                    "metric.proxyHelp",
                    "{measured} of {total} active instances report source addresses. Devices sharing an address count once per account.",
                    { measured: infra.presence.measured_instances, total: infra.presence.active_instances },
                  )}
                />
              )}
              <KpiStatCard
                icon={HardDrives}
                title={t("metric.nodes", "Connected agents")}
                value={t("metric.nodesValue", "{online} of {total}", {
                  online: infra.online_agents,
                  total: infra.registered_nodes,
                })}
                badge={
                  <Chip tone={infra.attention_nodes > 0 ? "amber" : "green"}>
                    {t("nodes.published", "{n} published", { n: infra.published_nodes })}
                  </Chip>
                }
                help={t("metric.nodesHelp", "Agents with a heartbeat in the last minute.")}
                href={can(access, "nodes.read") ? "/admin/servers" : undefined}
              />
              <KpiStatCard
                icon={Bell}
                title={t("metric.traffic", "Recorded traffic")}
                value={bytes(String(BigInt(infra.totals.uploaded) + BigInt(infra.totals.downloaded)))}
                subtitle={t("metric.trafficSub", "Cumulative across all nodes")}
                help={t("metric.trafficHelp", "Combined upload and download recorded by the Board across all nodes.")}
                href={can(access, "quotas.read") ? "/admin/quotas" : undefined}
              />
              <KpiStatCard
                icon={ArrowUp}
                title={t("metric.up", "Upload rate")}
                value={t("metric.rate", "{value}/s", {
                  value: bytes(String(Math.round(Number(infra.last_minute.uploaded) / 60))),
                })}
                subtitle={t("metric.rateSub", "1-minute average")}
                help={t("metric.rateHelp", "Average recorded bytes per second over the last minute.")}
              />
              <KpiStatCard
                icon={ArrowDown}
                title={t("metric.down", "Download rate")}
                value={t("metric.rate", "{value}/s", {
                  value: bytes(String(Math.round(Number(infra.last_minute.downloaded) / 60))),
                })}
                subtitle={t("metric.rateSub", "1-minute average")}
                help={t("metric.rateHelp", "Average recorded bytes per second over the last minute.")}
              />
            </>
          )}
        </div>
      )}

      {infra && (
        <div className="grid gap-5">
          <LayerCard render={<section aria-busy={resource.isPlaceholderData} />} className="dashboard-visual overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line px-5 py-3.5">
              <div>
                <h2 className="text-base font-semibold text-kumo-strong">{t("chart.title", "Transfer activity")}</h2>
                <p className="text-xs text-kumo-subtle">{t("chart.subtitle", "Reported traffic across server nodes.")}</p>
              </div>
              <Tabs
                variant="segmented"
                value={range}
                onValueChange={(next) => setRange(next as TrafficRange)}
                tabs={[
                  { value: "1h", label: t("range.hour", "1H") },
                  { value: "24h", label: t("range.day", "24H") },
                  { value: "7d", label: t("range.week", "7D") },
                ]}
              />
            </header>
            <div className="dashboard-chart-region">
              <div inert={resource.isPlaceholderData} className={resource.isPlaceholderData ? "dashboard-chart-previous" : undefined}>
                <Suspense fallback={<Loading label={t("chart.loading", "Loading chart…")} />}>
                  <TransferChart rows={infra.timeseries} range={range} />
                </Suspense>
              </div>
              {resource.isPlaceholderData && (
                <div className="dashboard-chart-pending">
                  <Loading label={t("chart.updating", "Updating time range…")} />
                </div>
              )}
            </div>
          </LayerCard>

          <LayerCard render={<section />} className="dashboard-visual overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line px-5 py-3.5">
              <div>
                <h2 className="text-base font-semibold text-kumo-strong">{t("map.title", "Node locations")}</h2>
                <p className="text-xs text-kumo-subtle">{t("map.subtitle", "Select a node on the map to open its details.")}</p>
              </div>
              {can(access, "nodes.read") && (
                <LinkButton href="/admin/servers" variant="ghost" size="sm">
                  {t("servers.action", "Open servers")}
                </LinkButton>
              )}
            </header>
            {infra.locations.length ? (
              <Suspense fallback={<Loading label={t("map.loading", "Loading map…")} />}>
                <NodeMap nodes={infra.locations} />
              </Suspense>
            ) : (
              <Empty
                title={t("map.empty", "Add locations to see nodes on the map")}
                action={
                  <LinkButton href="/admin/servers" variant="secondary">
                    {t("servers.action", "Open servers")}
                  </LinkButton>
                }
              />
            )}
          </LayerCard>
        </div>
      )}
    </>
  );
}
