import { Badge } from "@cloudflare/kumo/components/badge";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { GlobeHemisphereEast, HardDrives, MapPin } from "@phosphor-icons/react";
import { useState } from "react";
import { useResource } from "../../app/query";
import { Banner, Chip, Empty } from "../../components/console-ui";
import { DataTable, DataToolbar, type Column } from "../../components/data-table";
import { useLocale, useT } from "../../i18n";
import { formatRate, protocols as protocolNames } from "../nodes/model";
import { formats, subscriberNodesUrl, type FormatCode, type SubscriberNode } from "./links";

function formatProtocolLabel(raw: string): string {
  if (Object.hasOwn(protocolNames, raw)) {
    return protocolNames[raw as keyof typeof protocolNames];
  }
  return raw.toUpperCase();
}

export function SubscriberNodesCard({ enabled = true }: { enabled?: boolean }) {
  const t = useT("overview");
  const nodes = useResource<SubscriberNode[]>(subscriberNodesUrl, enabled, 60_000);
  const items = nodes.data ?? [];
  const onlineCount = items.filter((n) => n.online).length;

  if (!enabled) return null;

  return (
    <LayerCard render={<section aria-labelledby="nodes-status-heading" />} className="overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg"
            style={{ background: "var(--brand-accent-soft)", color: "var(--brand-accent-strong)" }}
            aria-hidden
          >
            <GlobeHemisphereEast size={18} />
          </span>
          <div>
            <h2 id="nodes-status-heading" className="text-sm font-semibold text-kumo-strong">
              {t("nodes.title", "Available nodes")}
            </h2>
            <p className="text-xs text-kumo-subtle">
              {nodes.isPending
                ? t("checking", "Checking…")
                : t("nodes.summary", "{online} of {total} published nodes online", {
                    online: onlineCount,
                    total: items.length,
                  })}
            </p>
          </div>
        </div>
        <LinkButton href="/workspace/subscriptions?view=nodes" variant="ghost" size="sm">
          {t("nodes.viewAll", "View all")}
        </LinkButton>
      </header>

      <div className="p-5">
        {nodes.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-kumo-recessed/60" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-kumo-subtle">
            {t("nodes.empty", "No published nodes are currently available for your account.")}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.slice(0, 6).map((node) => (
              <div
                key={node.id}
                className="flex flex-col gap-2 rounded-lg border border-kumo-line bg-kumo-recessed/30 p-3.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`inline-block size-2 shrink-0 rounded-full ${
                        node.online ? "bg-emerald-500" : "bg-neutral-400"
                      }`}
                      aria-hidden
                    />
                    <strong className="truncate text-sm text-kumo-strong" title={node.name}>
                      {node.name}
                    </strong>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {node.rate !== undefined && node.rate !== 1 && (
                      <Badge variant="outline">{formatRate(node.rate)}</Badge>
                    )}
                    <Chip tone={node.online ? "green" : "neutral"}>
                      {node.online ? t("nodes.online", "Online") : t("nodes.offline", "Offline")}
                    </Chip>
                  </div>
                </div>
                {node.location && (
                  <p className="flex items-center gap-1 text-xs text-kumo-subtle">
                    <MapPin size={12} aria-hidden />
                    <span>{node.location}</span>
                  </p>
                )}
                <div className="mt-auto flex flex-wrap gap-1 pt-1">
                  {node.protocols.map((proto) => (
                    <Badge key={proto} variant="secondary">
                      {formatProtocolLabel(proto)}
                    </Badge>
                  ))}
                  {(node.tags ?? []).map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </LayerCard>
  );
}

export function SubscriberNodesTable() {
  const t = useT("subscriptions");
  const { locale } = useLocale();
  const data = useResource<SubscriberNode[]>(subscriberNodesUrl, true, 60_000);
  const [search, setSearch] = useState("");
  const [formatFilter, setFormatFilter] = useState<"all" | FormatCode>("all");

  const items = data.data ?? [];
  const onlineCount = items.filter((n) => n.online).length;
  const visible = items.filter((row) => {
    const matchesFormat = formatFilter === "all" || row.formats[formatFilter];
    const term = search.trim().toLocaleLowerCase(locale);
    const matchesSearch =
      !term ||
      row.name.toLocaleLowerCase(locale).includes(term) ||
      (row.location ?? "").toLocaleLowerCase(locale).includes(term) ||
      row.protocols.some((p) => formatProtocolLabel(p).toLocaleLowerCase(locale).includes(term));
    return matchesFormat && matchesSearch;
  });

  const columns: Column<SubscriberNode>[] = [
    {
      key: "name",
      title: t("nodes.name", "Node"),
      sort: (left, right) => left.name.localeCompare(right.name, locale),
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-block size-2 shrink-0 rounded-full ${row.online ? "bg-emerald-500" : "bg-neutral-400"}`}
              aria-hidden
            />
            <strong className="text-kumo-strong">{row.name}</strong>
            {row.rate !== undefined && (
              <Badge variant={row.rate === 1 ? "secondary" : "outline"}>{formatRate(row.rate)}</Badge>
            )}
            {(row.tags ?? []).map((tag) => (
              <Badge key={tag} variant="outline" className="text-[11px]">
                {tag}
              </Badge>
            ))}
          </div>
          {row.location && (
            <span className="flex items-center gap-1 text-xs text-kumo-subtle">
              <MapPin size={12} aria-hidden />
              {row.location}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "status",
      title: t("nodes.status", "Status"),
      width: "8rem",
      cell: (row) => (
        <Chip tone={row.online ? "green" : "neutral"}>
          {row.online ? t("nodes.online", "Online") : t("nodes.offline", "Offline")}
        </Chip>
      ),
    },
    {
      key: "protocols",
      title: t("nodes.protocols", "Protocols"),
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.protocols.map((proto) => (
            <Badge key={proto} variant="secondary">
              {formatProtocolLabel(proto)}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: "formats",
      title: t("nodes.formats", "Compatible clients"),
      width: "16rem",
      omitOnMobile: true,
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {formats.map(({ code, name }) =>
            row.formats[code] ? (
              <Badge key={code} variant="success" appearance="dot">
                {name}
              </Badge>
            ) : null,
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <Banner error={data.error} />
      {data.data && (
        <LayerCard className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <span
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "var(--brand-accent-soft)", color: "var(--brand-accent-strong)" }}
              aria-hidden
            >
              <HardDrives size={18} />
            </span>
            <div>
              <p className="text-sm font-semibold text-kumo-strong">
                {t("nodes.onlineCount", "{online} of {total} nodes online", {
                  online: onlineCount,
                  total: items.length,
                })}
              </p>
              <p className="text-xs text-kumo-subtle">
                {t("nodes.hint", "All published nodes compatible with your subscription link format are synced automatically.")}
              </p>
            </div>
          </div>
        </LayerCard>
      )}
      <DataTable
        label={t("nodes.table", "Available nodes")}
        rows={visible}
        columns={columns}
        rowId={(row) => row.id}
        busy={data.isFetching}
        sortPreference="subscriber-nodes"
        pagination={{ defaultPageSize: 10, storageKey: "subscriber-nodes" }}
        toolbar={
          items.length > 0 && (
            <DataToolbar
              quickFilters={{
                label: t("format", "Format"),
                value: formatFilter === "all" ? "all" : String(formatFilter),
                onChange: (value) => setFormatFilter(value === "all" ? "all" : (Number(value) as FormatCode)),
                options: [
                  { value: "all", label: t("allFormats", "All formats"), count: items.length },
                  { value: "3", label: "Universal", count: items.filter((n) => n.formats[3]).length },
                  { value: "2", label: "mihomo", count: items.filter((n) => n.formats[2]).length },
                  { value: "1", label: "sing-box", count: items.filter((n) => n.formats[1]).length },
                  { value: "0", label: "xray-core", count: items.filter((n) => n.formats[0]).length },
                ],
              }}
              search={{
                label: t("nodes.search", "Search nodes"),
                placeholder: t("nodes.searchHint", "Name, location, or protocol"),
                value: search,
                onChange: setSearch,
                resultCount: visible.length,
              }}
              onClear={
                search || formatFilter !== "all"
                  ? () => {
                      setSearch("");
                      setFormatFilter("all");
                    }
                  : undefined
              }
              onRefresh={() => void data.refetch()}
              refreshing={data.isFetching}
            />
          )
        }
        empty={
          <Empty title={search || formatFilter !== "all" ? t("nodes.noMatches", "No matching nodes") : t("nodes.empty", "No published nodes yet")}>
            {t("nodes.emptyHint", "Published nodes will appear here as soon as an administrator enables them.")}
          </Empty>
        }
      />
    </>
  );
}
