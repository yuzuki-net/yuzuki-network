import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import {
  ArrowCounterClockwise,
  ArrowLeft,
  CaretRight,
  Cpu,
  GlobeHemisphereEast,
  MapPin,
  PencilSimple,
  Plus,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useResource } from "../../app/query";
import { useConsoleLocation, useConsoleNavigate } from "../../app/router";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, Empty, FormActions, Loading, Modal, PageHeader, SectionCard } from "../../components/console-ui";
import { DataTable, DataToolbar, RowActions, type Column } from "../../components/data-table";
import { dateTime } from "../../components/format";
import { ConfirmDeleteDialog } from "../../components/kumo-ext";
import { NodeLocationPanel } from "../../features/dashboard/location";
import { ServerConnection } from "../../features/nodes/connection";
import { ServerCores } from "../../features/nodes/cores";
import {
  coreNames,
  coreVersion,
  nodeRuntimeTone,
  nodesPath,
  protocols,
  serverHealth,
  serverHealthTone,
  serversPath,
  serverUrl,
  type ProxyNode,
  type Server,
  type ServerTab,
} from "../../features/nodes/model";
import { ServerFormModal } from "../../features/nodes/server-form";
import { useCan } from "../../features/session/context";
import { english, useT } from "../../i18n";
import "../nodes/style.css";

export default function ServersPage() {
  const href = useConsoleLocation();
  const params = new URL(href, location.origin).searchParams;
  const serverId = params.get("server");
  const rawTab = params.get("tab");
  const tab: ServerTab = rawTab === "connection" || rawTab === "cores" ? rawTab : "overview";

  const servers = useResource<Server[]>(`${serversPath}?include_deleted=true`, true, 10_000);
  const nodes = useResource<ProxyNode[]>(`${nodesPath}?include_deleted=true`, true, 10_000);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  if (serverId) {
    const server = (servers.data ?? []).find((s) => s.id === serverId);
    return (
      <ServerDetailView
        serverId={serverId}
        server={server}
        loading={servers.isPending}
        error={servers.error}
        hostedNodes={(nodes.data ?? []).filter((n) => n.server_id === serverId && !n.deleted_at)}
        tab={tab}
        now={now}
      />
    );
  }

  return (
    <ServerListView
      servers={servers.data ?? []}
      loading={servers.isFetching}
      error={servers.error}
      now={now}
      onRefresh={() => {
        void servers.refetch();
        void nodes.refetch();
      }}
    />
  );
}

function ServerListView({
  servers,
  loading,
  error,
  now,
  onRefresh,
}: {
  servers: Server[];
  loading: boolean;
  error: unknown;
  now: number;
  onRefresh: () => void;
}) {
  const t = useT("nodes");
  const canManage = useCan("nodes.manage");
  const href = useConsoleLocation();
  const navigate = useConsoleNavigate();
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const queryCreate = new URL(href, location.origin).searchParams.get("create") === "1";

  const [view, setView] = useState<"active" | "trash">("active");
  const [search, setSearch] = useState("");
  const [formState, setFormState] = useState<{ open: boolean; server?: Server }>({ open: false });

  useEffect(() => {
    if (queryCreate && canManage) {
      setFormState({ open: true });
      const next = new URL(href, location.origin);
      next.searchParams.delete("create");
      navigate(next.pathname + next.search, true);
    }
  }, [queryCreate, canManage, href, navigate]);
  const [deleteTarget, setDeleteTarget] = useState<Server | null>(null);
  const [deleteCascade, setDeleteCascade] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<Server | null>(null);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);

  const activeServers = useMemo(() => servers.filter((s) => !s.deleted_at), [servers]);
  const trashedServers = useMemo(() => servers.filter((s) => Boolean(s.deleted_at)), [servers]);

  const rows = useMemo(() => {
    const base = view === "trash" ? trashedServers : activeServers;
    const term = search.trim().toLowerCase();
    if (!term) return base;
    return base.filter(
      (s) =>
        s.name.toLowerCase().includes(term) ||
        s.remark.toLowerCase().includes(term) ||
        (s.default_host ?? "").toLowerCase().includes(term) ||
        (s.location ?? "").toLowerCase().includes(term),
    );
  }, [view, activeServers, trashedServers, search]);

  const refreshAll = () => {
    void cache.invalidateQueries({ queryKey: [`${serversPath}?include_deleted=true`] });
    void cache.invalidateQueries({ queryKey: [serversPath] });
    void cache.invalidateQueries({ queryKey: [`${nodesPath}?include_deleted=true`] });
  };

  const softDelete = useMutation({
    mutationFn: ({ id, cascade }: { id: string; cascade: boolean }) =>
      api(`${serversPath}/${id}?cascade=${cascade}`, "DELETE"),
    onSuccess: () => {
      setDeleteTarget(null);
      setDeleteCascade(false);
      toast.add({ title: t("trash.movedServer", "Server moved to trash"), variant: "success" });
      refreshAll();
    },
  });

  const restoreServer = useMutation({
    mutationFn: (id: string) => api<Server>(`${serversPath}/${id}/restore`, "POST"),
    onSuccess: () => {
      toast.add({ title: t("trash.restoredServer", "Server restored"), variant: "success" });
      refreshAll();
    },
  });

  const purgeServer = useMutation({
    mutationFn: (id: string) => api(`${serversPath}/${id}/purge`, "DELETE"),
    onSuccess: () => {
      setPurgeTarget(null);
      toast.add({ title: t("trash.purgedServer", "Server permanently deleted"), variant: "success" });
      refreshAll();
    },
  });

  const emptyTrash = useMutation({
    mutationFn: () => api<{ purged: number }>(`${serversPath}/trash`, "DELETE"),
    onSuccess: (res) => {
      setEmptyTrashOpen(false);
      toast.add({
        title: t("trash.emptied", "{count} trashed items permanently deleted", { count: res.purged }),
        variant: "success",
      });
      refreshAll();
    },
  });

  const activeColumns: Column<Server>[] = [
    {
      key: "name",
      title: t("servers.server", "Server"),
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <LinkButton variant="ghost" size="sm" className="w-fit px-1.5" href={serverUrl(row.id)}>
            <strong className="text-kumo-strong">{row.name}</strong>
            <CaretRight size={14} aria-hidden />
          </LinkButton>
          {(row.default_host || row.remark) && (
            <span className="px-1.5 text-xs text-kumo-subtle">
              {[row.default_host, row.remark].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "location",
      title: t("location.title", "Map location"),
      omitOnMobile: true,
      cell: (row) =>
        row.location ? (
          <span className="inline-flex items-center gap-1 text-xs text-kumo-default">
            <MapPin size={13} aria-hidden />
            {row.location}
          </span>
        ) : (
          <span className="text-xs text-kumo-subtle">—</span>
        ),
    },
    {
      key: "agent",
      title: t("inventory.agent", "Agent status"),
      cell: (row) => {
        const state = serverHealth(row, now);
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone={serverHealthTone(state)}>{t(`health.${state}`, state)}</Chip>
            {row.config_warnings.length > 0 && (
              <Tooltip
                content={row.config_warnings.join(" | ")}
                render={
                  <span>
                    <Chip tone="amber">
                      <span className="inline-flex items-center gap-1">
                        <WarningCircle size={12} aria-hidden />
                        {t("servers.configWarningsBadge", "{count} config warning(s)", {
                          count: row.config_warnings.length,
                        })}
                      </span>
                    </Chip>
                  </span>
                }
              />
            )}
          </div>
        );
      },
    },
    {
      key: "cores",
      title: t("cores.tab", "Core runtimes"),
      omitOnMobile: true,
      cell: (row) => (
        <div className="flex flex-col gap-1">
          {row.host_info && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-kumo-subtle">
              <Cpu size={12} aria-hidden />
              {row.host_info.os}/{row.host_info.arch}
            </span>
          )}
          <div className="flex flex-wrap gap-1">
            {row.capabilities.length > 0 ? (
              row.capabilities.map((cap) => (
                <Badge key={cap.core} variant="secondary">
                  {coreNames[cap.core]} {coreVersion(cap.version, "")}
                </Badge>
              ))
            ) : (
              <span className="text-xs text-kumo-subtle">{t("cores.notInstalled", "Not installed")}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: "nodes",
      title: t("servers.hostedNodes", "Hosted nodes"),
      omitOnMobile: true,
      cell: (row) => (
        <LinkButton variant="ghost" size="xs" href={`/admin/nodes?server=${row.id}`}>
          {t("servers.nodeCount", "{enabled}/{total} active", {
            enabled: row.enabled_node_count,
            total: row.node_count,
          })}
        </LinkButton>
      ),
    },
    {
      key: "heartbeat",
      title: t("inventory.heartbeat", "Last heartbeat"),
      omitOnMobile: true,
      cell: (row) => (row.last_seen_at ? dateTime(row.last_seen_at) : t("never", "Never")),
    },
    ...(canManage
      ? [
          {
            key: "actions",
            title: "",
            width: "4rem",
            end: true,
            sticky: true,
            cell: (row: Server) => (
              <RowActions
                item={row.name}
                actions={[
                  {
                    label: t("servers.open", "Open server"),
                    icon: CaretRight,
                    href: serverUrl(row.id),
                  },
                  {
                    label: t("servers.editTitle", "Edit server"),
                    icon: PencilSimple,
                    run: () => setFormState({ open: true, server: row }),
                  },
                  {
                    label: t("trash.delete", "Delete"),
                    icon: Trash,
                    danger: true,
                    run: () => {
                      softDelete.reset();
                      setDeleteCascade(false);
                      setDeleteTarget(row);
                    },
                  },
                ]}
              />
            ),
          } satisfies Column<Server>,
        ]
      : []),
  ];

  const trashColumns: Column<Server>[] = [
    {
      key: "name",
      title: t("servers.server", "Server"),
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <strong className="text-kumo-strong">{row.name}</strong>
          {row.default_host && <span className="font-mono text-xs text-kumo-subtle">{row.default_host}</span>}
        </div>
      ),
    },
    {
      key: "deleted_at",
      title: t("trash.deletedAt", "Deleted at"),
      cell: (row) => (row.deleted_at ? dateTime(row.deleted_at) : "—"),
    },
    ...(canManage
      ? [
          {
            key: "actions",
            title: "",
            width: "12rem",
            end: true,
            cell: (row: Server) => (
              <div className="flex items-center justify-end gap-1.5">
                <Button
                  variant="secondary"
                  size="xs"
                  icon={ArrowCounterClockwise}
                  loading={restoreServer.isPending}
                  onClick={() => restoreServer.mutate(row.id)}
                >
                  {t("trash.restore", "Restore")}
                </Button>
                <Button
                  variant="destructive"
                  size="xs"
                  icon={Trash}
                  onClick={() => {
                    purgeServer.reset();
                    setPurgeTarget(row);
                  }}
                >
                  {t("trash.purge", "Delete forever")}
                </Button>
              </div>
            ),
          } satisfies Column<Server>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={t("servers.title", "Servers")}
        description={t(
          "servers.subtitle",
          "Connect managed hosts via yuzuki-node, inspect config warnings, install proxy cores, and set map locations.",
        )}
        action={
          <>
            <LinkButton href="/admin/nodes" variant="secondary" icon={GlobeHemisphereEast}>
              {t("servers.openNodes", "Proxy nodes")}
            </LinkButton>
            {canManage && view === "trash" && trashedServers.length > 0 && (
              <Button variant="destructive" icon={Trash} onClick={() => setEmptyTrashOpen(true)}>
                {t("trash.emptyTrash", "Empty trash")}
              </Button>
            )}
            {canManage && (
              <Button variant="primary" icon={Plus} onClick={() => setFormState({ open: true })}>
                {t("servers.add", "Add server")}
              </Button>
            )}
          </>
        }
      />

      <Banner error={error} />

      <Tabs
        variant="segmented"
        className="w-fit max-w-full"
        value={view}
        onValueChange={(next) => setView(next as "active" | "trash")}
        tabs={[
          { value: "active", label: `${t("servers.all", "Active servers")} (${activeServers.length})` },
          { value: "trash", label: `${t("trash.tab", "Trash")} (${trashedServers.length})` },
        ]}
      />

      <DataTable
        label={t("servers.title", "Servers")}
        rows={rows}
        columns={view === "trash" ? trashColumns : activeColumns}
        rowId={(row) => row.id}
        busy={loading}
        toolbar={
          <DataToolbar
            search={{
              label: t("servers.search", "Search servers"),
              placeholder: t("servers.searchPlaceholder", "Name, host, location, or remark"),
              value: search,
              onChange: setSearch,
              resultCount: rows.length,
            }}
            onRefresh={onRefresh}
            refreshing={loading}
          />
        }
        empty={
          <Empty
            title={
              view === "trash"
                ? t("trash.emptyServers", "Trash is empty")
                : search.trim()
                  ? t("servers.emptyFiltered", "No matching servers")
                  : t("servers.empty", "No servers registered")
            }
            action={
              view !== "trash" && canManage ? (
                <Button variant="primary" icon={Plus} onClick={() => setFormState({ open: true })}>
                  {t("servers.add", "Add server")}
                </Button>
              ) : undefined
            }
          />
        }
      />

      <ServerFormModal
        open={formState.open}
        server={formState.server}
        onClose={() => setFormState({ open: false })}
        onSaved={(saved) => {
          if (!formState.server) navigate(serverUrl(saved.id, "connection"));
        }}
      />

      {/* Soft delete dialog */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        pending={softDelete.isPending}
        title={t("trash.deleteServerTitle", "Move server to trash?")}
        description={
          deleteTarget
            ? t(
                "trash.deleteServerDesc",
                "\"{name}\" will have its agent identities revoked, active session disconnected, and be moved to Trash.",
                { name: deleteTarget.name },
              )
            : undefined
        }
      >
        {deleteTarget && (
          <form
            className="form-fields"
            onSubmit={(e) => {
              e.preventDefault();
              softDelete.mutate({ id: deleteTarget.id, cascade: deleteCascade });
            }}
          >
            {deleteTarget.node_count > 0 && (
              <div className="flex flex-col gap-2 rounded-lg border border-kumo-line bg-kumo-recessed/30 p-3">
                <p className="text-xs text-kumo-default">
                  {t(
                    "trash.serverHasNodes",
                    "This server hosts {count} active proxy node(s).",
                    { count: deleteTarget.node_count },
                  )}
                </p>
                <Checkbox
                  label={t("trash.cascadeNodes", "Also move hosted proxy nodes (and their relays) to trash")}
                  checked={deleteCascade}
                  onCheckedChange={setDeleteCascade}
                />
              </div>
            )}
            <Banner error={softDelete.error} />
            <FormActions
              onClose={() => setDeleteTarget(null)}
              pending={softDelete.isPending}
              destructive
              label={t("trash.delete", "Delete")}
            />
          </form>
        )}
      </Modal>

      <ConfirmDeleteDialog
        open={purgeTarget !== null}
        onClose={() => setPurgeTarget(null)}
        resourceType={t("trash.serverResource", "server")}
        resourceName={purgeTarget?.name ?? ""}
        requireName
        confirmLabel={t("trash.purge", "Delete forever")}
        description={t(
          "trash.purgeServerDesc",
          "Permanently delete this server record, location, and task history? Historical traffic rollups are kept.",
        )}
        pending={purgeServer.isPending}
        error={purgeServer.error instanceof Error ? purgeServer.error.message : undefined}
        onConfirm={() => {
          if (purgeTarget) purgeServer.mutate(purgeTarget.id);
        }}
      />

      <ConfirmDeleteDialog
        open={emptyTrashOpen}
        onClose={() => setEmptyTrashOpen(false)}
        resourceType={t("trash.serverResource", "server")}
        resourceName={t("trash.tab", "Trash")}
        confirmLabel={t("trash.emptyTrash", "Empty trash")}
        description={t(
          "trash.emptyServersDesc",
          "Permanently delete all {count} trashed server(s)? This cannot be undone.",
          { count: trashedServers.length },
        )}
        pending={emptyTrash.isPending}
        error={emptyTrash.error instanceof Error ? emptyTrash.error.message : undefined}
        onConfirm={() => emptyTrash.mutate()}
      />
    </>
  );
}

function ServerDetailView({
  serverId,
  server,
  loading,
  error,
  hostedNodes,
  tab,
  now,
}: {
  serverId: string;
  server?: Server;
  loading: boolean;
  error: unknown;
  hostedNodes: ProxyNode[];
  tab: ServerTab;
  now: number;
}) {
  const t = useT("nodes");
  const canManage = useCan("nodes.manage");
  const canEnroll = useCan("nodes.enroll");
  const navigate = useConsoleNavigate();
  const [editOpen, setEditOpen] = useState(false);

  const go = (next: ServerTab) => navigate(serverUrl(serverId, next));

  if (loading) return <Loading label={t("loading", "Loading node inventory…")} />;
  if (!server) {
    return (
      <>
        <Banner error={error} />
        <Empty
          title={english("nodes", "servers.missing", "Server unavailable")}
          action={
            <LinkButton href="/admin/servers" variant="secondary">
              {t("servers.back", "Back to servers")}
            </LinkButton>
          }
        />
      </>
    );
  }

  const healthState = serverHealth(server, now);

  return (
    <>
      <div>
        <LinkButton href="/admin/servers" variant="ghost" size="sm" icon={ArrowLeft}>
          {t("servers.back", "Back to servers")}
        </LinkButton>
      </div>

      <PageHeader
        title={server.name}
        description={[server.default_host, server.remark].filter(Boolean).join(" · ") || t("servers.detailFallback", "Managed host server")}
        badge={<Chip tone={serverHealthTone(healthState)}>{t(`health.${healthState}`, healthState)}</Chip>}
        action={
          canManage && (
            <>
              <Button variant="secondary" icon={PencilSimple} onClick={() => setEditOpen(true)}>
                {t("servers.editTitle", "Edit server")}
              </Button>
              <LinkButton href={`/admin/nodes?create=1&server=${server.id}`} variant="primary" icon={Plus}>
                {t("servers.addNodeHere", "Add proxy node")}
              </LinkButton>
            </>
          )
        }
      />

      {server.config_warnings.length > 0 && (
        <KumoBanner
          size="sm"
          variant="alert"
          icon={<WarningCircle size={17} />}
          title={t("servers.configWarningsTitle", "Agent started with node.toml configuration warnings")}
          description={server.config_warnings.join(" · ")}
        />
      )}

      {server.deployment_error && (
        <KumoBanner
          size="sm"
          variant="error"
          icon={<WarningCircle size={17} />}
          title={english("nodes", "health.error", "Deployment failed")}
          description={server.deployment_error}
        />
      )}

      <div className="node-tabs">
        <Tabs
          variant="underline"
          value={tab}
          onValueChange={(next) => go(next as ServerTab)}
          tabs={[
            { value: "overview", label: t("overview", "Overview") },
            { value: "connection", label: t("connection", "Agent connection") },
            { value: "cores", label: t("cores.tab", "Core runtimes") },
          ]}
        />
      </div>

      {tab === "overview" && (
        <div className="flex flex-col gap-4">
          <div className="node-overview-grid">
            <LayerCard render={<section />} className="node-step-card">
              <header>
                <Cpu size={20} aria-hidden />
                <h2>{t("servers.hostHealth", "Host & agent details")}</h2>
              </header>
              <dl className="grid w-full grid-cols-2 gap-3 text-xs">
                <div>
                  <dt className="text-kumo-subtle">{t("inventory.heartbeat", "Last heartbeat")}</dt>
                  <dd className="mt-0.5 font-medium text-kumo-strong">
                    {server.last_seen_at ? dateTime(server.last_seen_at) : t("never", "Never")}
                  </dd>
                </div>
                <div>
                  <dt className="text-kumo-subtle">{t("servers.platform", "Platform")}</dt>
                  <dd className="mt-0.5 font-mono font-medium text-kumo-strong">
                    {server.host_info ? `${server.host_info.os}/${server.host_info.arch}` : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-kumo-subtle">{t("servers.defaultHostShort", "Default host")}</dt>
                  <dd className="mt-0.5 font-mono font-medium text-kumo-strong">
                    {server.default_host ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-kumo-subtle">{t("publish.revision", "Last applied configuration")}</dt>
                  <dd className="mt-0.5 font-mono text-kumo-default">
                    {server.applied_revision ? server.applied_revision.slice(0, 12) : "—"}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="secondary" size="sm" onClick={() => go("connection")}>
                  {t("connection", "Agent connection")}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => go("cores")}>
                  {t("cores.tab", "Core runtimes")}
                </Button>
              </div>
            </LayerCard>

            <NodeLocationPanel id={server.id} manage={canManage} />
          </div>

          <SectionCard
            title={t("servers.hostedNodes", "Hosted nodes")}
            description={t("servers.hostedNodesDesc", "Proxy nodes deployed and running on this server.")}
            action={
              <LinkButton href={`/admin/nodes?server=${server.id}`} variant="ghost" size="sm">
                {t("servers.viewInNodes", "Open in Nodes")}
              </LinkButton>
            }
          >
            {hostedNodes.length === 0 ? (
              <Empty
                title={t("servers.noHostedNodes", "No proxy nodes deployed on this server yet")}
                action={
                  canManage ? (
                    <LinkButton href={`/admin/nodes?create=1&server=${server.id}`} variant="secondary" icon={Plus}>
                      {t("servers.addNodeHere", "Add proxy node")}
                    </LinkButton>
                  ) : undefined
                }
              />
            ) : (
              <div className="flex flex-col divide-y divide-kumo-line">
                {hostedNodes.map((node) => (
                  <div key={node.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-kumo-strong">{node.name}</strong>
                      {node.protocol && <Badge variant="secondary">{protocols[node.protocol]}</Badge>}
                      {node.core && <Badge variant="outline">{coreNames[node.core]}</Badge>}
                      <span className="font-mono text-xs text-kumo-subtle">
                        {node.host}:{node.port}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Chip tone={nodeRuntimeTone(node.runtime_state)}>
                        {t(`runtime.${node.runtime_state === "missing_core" ? "binary" : node.runtime_state === "offline" ? "disconnected" : node.runtime_state === "disabled" ? "inactive" : node.runtime_state}`, node.runtime_state)}
                      </Chip>
                      <Chip tone={node.show ? "green" : "neutral"}>
                        {node.show ? t("published", "Published") : t("filter.hidden", "Hidden")}
                      </Chip>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      )}

      {tab === "connection" && (
        <ServerConnection server={server} now={now} canEnroll={canEnroll} go={go} />
      )}

      {tab === "cores" && (
        <ServerCores server={server} hostedNodes={hostedNodes} now={now} canManage={canManage} go={go} />
      )}

      <ServerFormModal open={editOpen} server={server} onClose={() => setEditOpen(false)} />
    </>
  );
}
