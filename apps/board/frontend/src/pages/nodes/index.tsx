import { Badge } from "@cloudflare/kumo/components/badge";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowDown,
  ArrowUp,
  CopySimple,
  Eye,
  EyeSlash,
  GitBranch,
  HardDrives,
  PencilSimple,
  Play,
  Plus,
  Stop,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useResource } from "../../app/query";
import { useConsoleLocation, useConsoleNavigate } from "../../app/router";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, Empty, FormActions, Modal, PageHeader } from "../../components/console-ui";
import {
  DataTable,
  DataToolbar,
  RowActions,
  useTableSelection,
  type ActiveFilterChip,
  type Column,
} from "../../components/data-table";
import { bytes, dateTime } from "../../components/format";
import { ConfirmDeleteDialog } from "../../components/kumo-ext";
import { useCatalog } from "../../features/access/catalog";
import {
  coreNames,
  formatRate,
  nodeNeedsAttention,
  nodeRuntimeTone,
  nodesPath,
  protocols,
  serversPath,
  serverUrl,
  type Core,
  type NodeVisibility,
  type ProxyNode,
  type Server,
} from "../../features/nodes/model";
import { NodeEditorModal, type NodeEditorTarget } from "../../features/nodes/node-editor";
import { useCan } from "../../features/session/context";
import { formats } from "../../features/subscriptions/links";
import { english, useT } from "../../i18n";
import "./style.css";

type ViewFilter = "all" | "running" | "hidden" | "attention" | "trash";

export default function NodesPage() {
  const t = useT("nodes");
  const canManage = useCan("nodes.manage");
  const href = useConsoleLocation();
  const navigate = useConsoleNavigate();
  const cache = useQueryClient();
  const toast = useKumoToastManager();

  const params = new URL(href, location.origin).searchParams;
  const queryServer = params.get("server") ?? "all";
  const queryAttention = params.get("attention") === "1";
  const queryCreate = params.get("create") === "1";
  const queryCore = params.get("core") as Core | null;

  const nodes = useResource<ProxyNode[]>(`${nodesPath}?include_deleted=true`, true, 10_000);
  const servers = useResource<Server[]>(`${serversPath}?include_deleted=true`, true, 15_000);
  const { roles } = useCatalog();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  const [view, setView] = useState<ViewFilter>(queryAttention ? "attention" : "all");
  const [search, setSearch] = useState("");
  const [serverFilter, setServerFilter] = useState<string>(queryServer);
  const [protocolFilter, setProtocolFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [editorTarget, setEditorTarget] = useState<NodeEditorTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProxyNode | null>(null);
  const [deleteCascade, setDeleteCascade] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<ProxyNode | null>(null);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchModal, setBatchModal] = useState<"rate" | "visibility" | null>(null);
  const [batchRate, setBatchRate] = useState("1");
  const [batchVisibility, setBatchVisibility] = useState<NodeVisibility>("all");
  const [batchRoleIds, setBatchRoleIds] = useState<string[]>([]);

  useEffect(() => {
    setServerFilter(queryServer);
  }, [queryServer]);

  useEffect(() => {
    if (queryAttention) setView("attention");
  }, [queryAttention]);

  useEffect(() => {
    if (queryCreate && canManage) {
      setEditorTarget({
        mode: "create",
        initialMode: "managed",
        initialServerId: queryServer !== "all" ? queryServer : undefined,
        initialCore: queryCore ?? undefined,
      });
      const next = new URL(href, location.origin);
      next.searchParams.delete("create");
      next.searchParams.delete("core");
      navigate(next.pathname + next.search, true);
    }
  }, [queryCreate, canManage, queryServer, queryCore, href, navigate]);

  const allNodes = nodes.data ?? [];
  const activeNodes = useMemo(() => allNodes.filter((n) => !n.deleted_at), [allNodes]);
  const trashedNodes = useMemo(() => allNodes.filter((n) => Boolean(n.deleted_at)), [allNodes]);
  const activeServers = useMemo(() => (servers.data ?? []).filter((s) => !s.deleted_at), [servers.data]);

  const allTags = useMemo(
    () => Array.from(new Set(activeNodes.flatMap((n) => n.tags))).sort(),
    [activeNodes],
  );

  const selection = useTableSelection(JSON.stringify([view, search, serverFilter, protocolFilter, tagFilter]));

  const refreshAll = () => {
    void cache.invalidateQueries({ queryKey: [`${nodesPath}?include_deleted=true`] });
    void cache.invalidateQueries({ queryKey: [nodesPath] });
    void cache.invalidateQueries({ queryKey: [`${serversPath}?include_deleted=true`] });
  };

  const patchShow = useMutation({
    mutationFn: ({ id, show }: { id: string; show: boolean }) =>
      api<ProxyNode>(`${nodesPath}/${id}`, "PATCH", { show }),
    onSuccess: () => refreshAll(),
  });

  const patchEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<ProxyNode>(`${nodesPath}/${id}`, "PATCH", { enabled }),
    onSuccess: (_res, vars) => {
      toast.add({
        title: vars.enabled ? t("instances.enabledToast", "Instance enabled") : t("instances.disabledToast", "Instance disabled"),
        variant: "success",
      });
      refreshAll();
    },
  });

  const cloneNode = useMutation({
    mutationFn: (id: string) => api<ProxyNode>(`${nodesPath}/${id}/clone`, "POST"),
    onSuccess: () => {
      toast.add({ title: t("nodes.cloned", "Node cloned (hidden by default)"), variant: "success" });
      refreshAll();
    },
  });

  const restartNode = useMutation({
    mutationFn: (id: string) => api(`${nodesPath}/${id}/restart`, "POST"),
    onSuccess: () => {
      toast.add({ title: t("instances.restartSent", "Restart signal sent to node"), variant: "success" });
      refreshAll();
    },
  });

  const reorderNodes = useMutation({
    mutationFn: (items: { id: string; sort_order: number }[]) =>
      api(`${nodesPath}/reorder`, "POST", { items }),
    onSuccess: () => refreshAll(),
  });

  const softDelete = useMutation({
    mutationFn: ({ id, cascade }: { id: string; cascade: boolean }) =>
      api(`${nodesPath}/${id}?cascade=${cascade}`, "DELETE"),
    onSuccess: () => {
      setDeleteTarget(null);
      setDeleteCascade(false);
      toast.add({ title: t("trash.movedNode", "Node moved to trash"), variant: "success" });
      refreshAll();
    },
  });

  const restoreNode = useMutation({
    mutationFn: (id: string) => api<ProxyNode>(`${nodesPath}/${id}/restore`, "POST"),
    onSuccess: () => {
      toast.add({ title: t("trash.restoredNode", "Node restored (disabled and hidden)"), variant: "success" });
      refreshAll();
    },
  });

  const purgeNode = useMutation({
    mutationFn: (id: string) => api(`${nodesPath}/${id}/purge`, "DELETE"),
    onSuccess: () => {
      setPurgeTarget(null);
      toast.add({ title: t("trash.purgedNode", "Node permanently deleted"), variant: "success" });
      refreshAll();
    },
  });

  const emptyTrash = useMutation({
    mutationFn: () => api<{ purged: number }>(`${nodesPath}/trash`, "DELETE"),
    onSuccess: (res) => {
      setEmptyTrashOpen(false);
      toast.add({
        title: t("trash.emptied", "{count} trashed items permanently deleted", { count: res.purged }),
        variant: "success",
      });
      refreshAll();
    },
  });

  const batchOp = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ updated: number }>(`${nodesPath}/batch`, "POST", body),
    onSuccess: (res) => {
      setBatchModal(null);
      setBatchDeleteOpen(false);
      selection.clear();
      toast.add({ title: t("batch.updated", "{count} nodes updated", { count: res.updated }), variant: "success" });
      refreshAll();
    },
  });

  function moveOrder(row: ProxyNode, delta: -1 | 1) {
    const idx = activeNodes.findIndex((n) => n.id === row.id);
    const swapIdx = idx + delta;
    if (idx < 0 || swapIdx < 0 || swapIdx >= activeNodes.length) return;
    const reordered = [...activeNodes];
    const [moved] = reordered.splice(idx, 1);
    reordered.splice(swapIdx, 0, moved);
    reorderNodes.mutate(reordered.map((n, i) => ({ id: n.id, sort_order: i * 10 })));
  }

  const rows = useMemo(() => {
    const base =
      view === "trash"
        ? trashedNodes
        : activeNodes.filter((n) => {
            if (view === "running") return n.runtime_state === "running" || n.runtime_state === "external";
            if (view === "hidden") return !n.show;
            if (view === "attention") return nodeNeedsAttention(n);
            return true;
          });
    const term = search.trim().toLowerCase();
    return base.filter((n) => {
      if (serverFilter !== "all" && n.server_id !== serverFilter) return false;
      if (protocolFilter !== "all" && n.protocol !== protocolFilter) return false;
      if (tagFilter !== "all" && !n.tags.includes(tagFilter)) return false;
      if (!term) return true;
      return (
        n.name.toLowerCase().includes(term) ||
        n.host.toLowerCase().includes(term) ||
        (n.server_name ?? "").toLowerCase().includes(term) ||
        n.tags.some((tag) => tag.toLowerCase().includes(term))
      );
    });
  }, [view, activeNodes, trashedNodes, search, serverFilter, protocolFilter, tagFilter]);

  function runtimeLabel(state: string): string {
    const map: Record<string, string> = {
      running: t("runtime.running", "Running"),
      stopped: t("runtime.stopped", "Stopped"),
      failed: english("nodes", "runtime.failed", "Failed"),
      missing_core: english("nodes", "runtime.binary", "Binary unavailable"),
      offline: english("nodes", "runtime.disconnected", "Agent disconnected"),
      disabled: t("runtime.inactive", "Inactive"),
      pending: t("runtime.pending", "Awaiting runtime report"),
      external: t("runtime.external", "External"),
    };
    return map[state] ?? state;
  }

  const activeFilters: ActiveFilterChip[] = [];
  if (search.trim()) {
    activeFilters.push({ key: "q", label: t("inventory.search", "Search nodes"), value: search.trim(), onRemove: () => setSearch("") });
  }
  if (serverFilter !== "all") {
    const srvName = activeServers.find((s) => s.id === serverFilter)?.name ?? serverFilter;
    activeFilters.push({ key: "server", label: t("editor.server", "Host server"), value: srvName, onRemove: () => setServerFilter("all") });
  }
  if (protocolFilter !== "all") {
    activeFilters.push({
      key: "protocol",
      label: t("editor.protocol", "Protocol"),
      value: protocols[protocolFilter as keyof typeof protocols] ?? protocolFilter,
      onRemove: () => setProtocolFilter("all"),
    });
  }
  if (tagFilter !== "all") {
    activeFilters.push({ key: "tag", label: t("table.tags", "Tag"), value: tagFilter, onRemove: () => setTagFilter("all") });
  }

  const activeColumns: Column<ProxyNode>[] = [
    ...(canManage
      ? [
          {
            key: "order",
            title: t("table.order", "Order"),
            width: "5.5rem",
            omitOnMobile: true,
            cell: (row: ProxyNode) => {
              const idx = activeNodes.findIndex((n) => n.id === row.id);
              return (
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="xs"
                    shape="square"
                    aria-label={t("order.up", "Move up")}
                    disabled={idx <= 0 || reorderNodes.isPending}
                    onClick={() => moveOrder(row, -1)}
                  >
                    <ArrowUp size={12} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    shape="square"
                    aria-label={t("order.down", "Move down")}
                    disabled={idx < 0 || idx >= activeNodes.length - 1 || reorderNodes.isPending}
                    onClick={() => moveOrder(row, 1)}
                  >
                    <ArrowDown size={12} />
                  </Button>
                </div>
              );
            },
          } satisfies Column<ProxyNode>,
        ]
      : []),
    {
      key: "name",
      title: t("inventory.node", "Node"),
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <strong className="text-kumo-strong">{row.name}</strong>
            {row.protocol && <Badge variant="secondary">{protocols[row.protocol]}</Badge>}
            {row.mode === "relay" && (
              <Chip tone="blue">
                <span className="inline-flex items-center gap-1">
                  <GitBranch size={11} aria-hidden />
                  {t("mode.relayFrom", "Relay → {parent}", { parent: row.parent_name ?? "?" })}
                </span>
              </Chip>
            )}
            {row.mode === "external" && <Chip tone="neutral">{t("mode.external", "External")}</Chip>}
            {row.mode === "custom" && <Chip tone="neutral">{t("mode.custom", "Custom")}</Chip>}
          </div>
          {row.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {row.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="text-[10px]">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "address",
      title: t("table.address", "Address"),
      omitOnMobile: true,
      cell: (row) => (
        <div className="flex flex-col gap-0.5 whitespace-nowrap font-mono text-xs">
          <span dir="ltr" className="text-kumo-default">
            {row.host ? `${row.host}${row.port ? `:${row.port}` : ""}` : "—"}
          </span>
          {row.listen_port && row.listen_port !== row.port && (
            <span dir="ltr" className="text-[11px] text-kumo-subtle">
              {t("table.listenPort", "listen :{port}", { port: row.listen_port })}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "server",
      title: t("table.server", "Server / Core"),
      omitOnMobile: true,
      cell: (row) =>
        row.server_id ? (
          <div className="flex flex-col gap-0.5 whitespace-nowrap">
            <LinkButton
              href={serverUrl(row.server_id)}
              variant="ghost"
              size="xs"
              className="w-fit px-1"
            >
              <span
                className={`inline-block size-2 rounded-full ${row.server_online ? "bg-emerald-500" : "bg-neutral-400"}`}
                aria-hidden
              />
              <span>{row.server_name}</span>
            </LinkButton>
            {row.core && <span className="px-1 text-[11px] text-kumo-subtle">{coreNames[row.core]}</span>}
          </div>
        ) : (
          <span className="text-xs text-kumo-subtle">—</span>
        ),
    },
    {
      key: "rate",
      title: t("table.rate", "Rate"),
      omitOnMobile: true,
      cell: (row) => (
        <span className="whitespace-nowrap">
          <Chip tone={row.rate === 1 ? "neutral" : row.rate < 1 ? "green" : "amber"}>
            {formatRate(row.rate)}
          </Chip>
        </span>
      ),
    },
    {
      key: "visibility",
      title: t("table.visibility", "Visibility"),
      omitOnMobile: true,
      cell: (row) =>
        row.visibility === "all" ? (
          <span className="whitespace-nowrap">
            <Chip tone="neutral">{t("visibility.allShort", "All")}</Chip>
          </span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.roles.map((r) => (
              <Badge key={r.id} variant="secondary">
                {r.name}
              </Badge>
            ))}
          </div>
        ),
    },
    {
      key: "formats",
      title: t("endpoints.formats", "Client formats"),
      omitOnMobile: true,
      cell: (row) => (
        <div className="flex min-w-36 flex-wrap gap-1">
          {formats.map(({ code, name }) =>
            row.formats[code] ? (
              <Badge key={code} variant="success" appearance="dot" className="whitespace-nowrap">
                {name}
              </Badge>
            ) : null,
          )}
        </div>
      ),
    },
    {
      key: "runtime",
      title: t("table.runtime", "Status & usage"),
      cell: (row) => {
        const total = String(BigInt(row.uploaded || "0") + BigInt(row.downloaded || "0"));
        const chip = (
          <Chip tone={nodeRuntimeTone(row.runtime_state)}>
            {row.runtime_error ? (
              <span className="inline-flex items-center gap-1 whitespace-nowrap">
                <WarningCircle size={12} aria-hidden />
                {runtimeLabel(row.runtime_state)}
              </span>
            ) : (
              <span className="whitespace-nowrap">{runtimeLabel(row.runtime_state)}</span>
            )}
          </Chip>
        );
        return (
          <div className="flex flex-col gap-0.5 whitespace-nowrap">
            {row.runtime_error ? <Tooltip content={row.runtime_error} render={<span>{chip}</span>} /> : chip}
            <span className="text-[11px] tabular-nums text-kumo-subtle">
              {row.online_sources > 0
                ? t("table.onlineUsage", "{sources} online · {traffic}", { sources: row.online_sources, traffic: bytes(total) })
                : bytes(total)}
            </span>
          </div>
        );
      },
    },
    {
      key: "show",
      title: t("table.show", "Show"),
      width: "4.5rem",
      cell: (row) => (
        <Switch
          aria-label={t("table.toggleShow", "Show {name} in subscriptions", { name: row.name })}
          checked={row.show}
          disabled={!canManage || patchShow.isPending}
          onCheckedChange={(checked) => patchShow.mutate({ id: row.id, show: checked })}
        />
      ),
    },
    ...(canManage
      ? [
          {
            key: "actions",
            title: "",
            width: "4rem",
            end: true,
            sticky: true,
            cell: (row: ProxyNode) => (
              <RowActions
                item={row.name}
                actions={[
                  {
                    label: t("editor.edit", "Edit node"),
                    icon: PencilSimple,
                    run: () => setEditorTarget({ mode: "edit", node: row }),
                  },
                  {
                    label: t("actions.clone", "Clone node"),
                    icon: CopySimple,
                    run: () => cloneNode.mutate(row.id),
                  },
                  ...(row.mode !== "relay"
                    ? [
                        {
                          label: t("actions.addRelay", "Add relay entry"),
                          icon: GitBranch,
                          run: () =>
                            setEditorTarget({
                              mode: "create",
                              initialMode: "relay",
                              initialParentId: row.id,
                            }),
                        },
                      ]
                    : []),
                  ...(row.mode === "managed" || row.mode === "custom"
                    ? [
                        {
                          label: row.enabled
                            ? t("instances.disable", "Disable instance")
                            : t("instances.enable", "Enable instance"),
                          icon: row.enabled ? Stop : Play,
                          run: () => patchEnabled.mutate({ id: row.id, enabled: !row.enabled }),
                        },
                        {
                          label: t("instances.restart", "Restart on node"),
                          icon: ArrowClockwise,
                          run: () => restartNode.mutate(row.id),
                        },
                      ]
                    : []),
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
          } satisfies Column<ProxyNode>,
        ]
      : []),
  ];

  const trashColumns: Column<ProxyNode>[] = [
    {
      key: "name",
      title: t("inventory.node", "Node"),
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <strong className="text-kumo-strong">{row.name}</strong>
          <span className="font-mono text-xs text-kumo-subtle">
            {row.host ? `${row.host}${row.port ? `:${row.port}` : ""}` : row.mode}
          </span>
        </div>
      ),
    },
    {
      key: "server",
      title: t("table.server", "Server / Core"),
      cell: (row) => (
        <span className="text-xs text-kumo-subtle">
          {row.server_name ?? "—"} {row.core ? `· ${coreNames[row.core]}` : ""}
        </span>
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
            cell: (row: ProxyNode) => (
              <div className="flex items-center justify-end gap-1.5">
                <Button
                  variant="secondary"
                  size="xs"
                  icon={ArrowCounterClockwise}
                  loading={restoreNode.isPending}
                  onClick={() => restoreNode.mutate(row.id)}
                >
                  {t("trash.restore", "Restore")}
                </Button>
                <Button
                  variant="destructive"
                  size="xs"
                  icon={Trash}
                  onClick={() => {
                    purgeNode.reset();
                    setPurgeTarget(row);
                  }}
                >
                  {t("trash.purge", "Delete forever")}
                </Button>
              </div>
            ),
          } satisfies Column<ProxyNode>,
        ]
      : []),
  ];

  const selectedIds = Array.from(selection.ids);
  const attentionCount = activeNodes.filter(nodeNeedsAttention).length;
  const runningCount = activeNodes.filter((n) => n.runtime_state === "running" || n.runtime_state === "external").length;
  const hiddenCount = activeNodes.filter((n) => !n.show).length;

  return (
    <>
      <PageHeader
        title={t("title", "Nodes")}
        description={t(
          "nodes.subtitle",
          "Manage proxy lines, protocols, relays, billing multipliers, role visibility, and live subscription publication.",
        )}
        action={
          <>
            <LinkButton href="/admin/servers" variant="secondary" icon={HardDrives}>
              {t("servers.manageLink", "Manage servers")}
            </LinkButton>
            {canManage && view === "trash" && trashedNodes.length > 0 && (
              <Button variant="destructive" icon={Trash} onClick={() => setEmptyTrashOpen(true)}>
                {t("trash.emptyTrash", "Empty trash")}
              </Button>
            )}
            {canManage && (
              <Button
                variant="primary"
                icon={Plus}
                onClick={() => setEditorTarget({ mode: "create", initialMode: "managed" })}
              >
                {t("add", "Add node")}
              </Button>
            )}
          </>
        }
      />

      <Banner error={nodes.error || servers.error || patchShow.error || patchEnabled.error || cloneNode.error || restartNode.error || batchOp.error} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          variant="segmented"
          value={view}
          onValueChange={(next) => setView(next as ViewFilter)}
          tabs={[
            { value: "all", label: `${t("inventory.all", "All nodes")} (${activeNodes.length})` },
            { value: "running", label: `${t("runtime.running", "Running")} (${runningCount})` },
            { value: "hidden", label: `${t("filter.hidden", "Hidden")} (${hiddenCount})` },
            { value: "attention", label: `${t("inventory.attention", "Needs attention")} (${attentionCount})` },
            { value: "trash", label: `${t("trash.tab", "Trash")} (${trashedNodes.length})` },
          ]}
        />
      </div>

      <DataTable
        label={t("inventory", "Node inventory")}
        rows={rows}
        columns={view === "trash" ? trashColumns : activeColumns}
        rowId={(row) => row.id}
        layout="auto"
        busy={nodes.isFetching}
        selection={
          canManage && view !== "trash"
            ? {
                ...selection,
                name: (row) => row.name,
                eligible: () => true,
                disabled: batchOp.isPending,
                actions: (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={Eye}
                      disabled={batchOp.isPending}
                      onClick={() => batchOp.mutate({ ids: selectedIds, action: "show" })}
                    >
                      {t("batch.show", "Show")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={EyeSlash}
                      disabled={batchOp.isPending}
                      onClick={() => batchOp.mutate({ ids: selectedIds, action: "hide" })}
                    >
                      {t("batch.hide", "Hide")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={batchOp.isPending}
                      onClick={() => batchOp.mutate({ ids: selectedIds, action: "enable" })}
                    >
                      {t("batch.enable", "Start")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={batchOp.isPending}
                      onClick={() => batchOp.mutate({ ids: selectedIds, action: "disable" })}
                    >
                      {t("batch.disable", "Stop")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={batchOp.isPending}
                      onClick={() => {
                        setBatchRate("1");
                        setBatchModal("rate");
                      }}
                    >
                      {t("batch.setRate", "Set rate")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={batchOp.isPending}
                      onClick={() => {
                        setBatchVisibility("all");
                        setBatchRoleIds([]);
                        setBatchModal("visibility");
                      }}
                    >
                      {t("batch.setVisibility", "Visibility")}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      icon={Trash}
                      disabled={batchOp.isPending}
                      onClick={() => setBatchDeleteOpen(true)}
                    >
                      {t("trash.delete", "Delete")}
                    </Button>
                  </div>
                ),
              }
            : undefined
        }
        toolbar={
          <DataToolbar
            search={{
              label: t("inventory.search", "Search nodes"),
              placeholder: t("inventory.searchPlaceholder", "Name, address, server, or tag"),
              value: search,
              onChange: setSearch,
              resultCount: rows.length,
            }}
            activeFilters={activeFilters}
            onClear={
              activeFilters.length > 0
                ? () => {
                    setSearch("");
                    setServerFilter("all");
                    setProtocolFilter("all");
                    setTagFilter("all");
                  }
                : undefined
            }
            onRefresh={() => refreshAll()}
            refreshing={nodes.isFetching}
            options={
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  aria-label={t("editor.server", "Host server")}
                  value={serverFilter}
                  items={{
                    all: t("filter.allServers", "All servers"),
                    ...Object.fromEntries(activeServers.map((s) => [s.id, s.name])),
                  }}
                  onValueChange={(v: string | null) => setServerFilter(v ?? "all")}
                />
                <Select
                  aria-label={t("editor.protocol", "Protocol")}
                  value={protocolFilter}
                  items={{ all: t("filter.allProtocols", "All protocols"), ...protocols }}
                  onValueChange={(v: string | null) => setProtocolFilter(v ?? "all")}
                />
                {allTags.length > 0 && (
                  <Select
                    aria-label={t("table.tags", "Tag")}
                    value={tagFilter}
                    items={{
                      all: t("filter.allTags", "All tags"),
                      ...Object.fromEntries(allTags.map((tag) => [tag, tag])),
                    }}
                    onValueChange={(v: string | null) => setTagFilter(v ?? "all")}
                  />
                )}
              </div>
            }
          />
        }
        empty={
          <Empty
            title={
              view === "trash"
                ? t("trash.emptyNodes", "Trash is empty")
                : activeFilters.length > 0
                  ? t("inventory.empty.filtered", "No matching nodes")
                  : t("inventory.empty", "No nodes configured")
            }
            action={
              view !== "trash" && canManage ? (
                <Button
                  variant="primary"
                  icon={Plus}
                  onClick={() => setEditorTarget({ mode: "create", initialMode: "managed" })}
                >
                  {t("add", "Add node")}
                </Button>
              ) : undefined
            }
          />
        }
      />

      <NodeEditorModal
        target={editorTarget}
        servers={servers.data ?? []}
        nodes={allNodes}
        roles={roles.data ?? []}
        now={now}
        onClose={() => setEditorTarget(null)}
      />

      {/* Soft delete dialog */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        pending={softDelete.isPending}
        title={t("trash.deleteNodeTitle", "Move node to trash?")}
        description={
          deleteTarget
            ? t(
                "trash.deleteNodeDesc",
                "\"{name}\" will be stopped on the server, hidden from subscriptions, and moved to Trash. Historical traffic statistics remain intact.",
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
            {deleteTarget.relay_count > 0 && (
              <div className="flex flex-col gap-2 rounded-lg border border-kumo-line bg-kumo-recessed/30 p-3">
                <p className="text-xs text-kumo-default">
                  {t(
                    "trash.hasRelays",
                    "This node has {count} active relay node(s) pointing to it.",
                    { count: deleteTarget.relay_count },
                  )}
                </p>
                <Checkbox
                  label={t("trash.cascadeRelays", "Also move dependent relay nodes to trash")}
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

      {/* Hard delete (purge) dialog */}
      <ConfirmDeleteDialog
        open={purgeTarget !== null}
        onClose={() => setPurgeTarget(null)}
        resourceType={t("trash.nodeResource", "proxy node")}
        resourceName={purgeTarget?.name ?? ""}
        requireName
        confirmLabel={t("trash.purge", "Delete forever")}
        description={t(
          "trash.purgeNodeDesc",
          "This permanently deletes the node configuration from the database and cannot be undone. Historical billing records are preserved.",
        )}
        pending={purgeNode.isPending}
        error={purgeNode.error instanceof Error ? purgeNode.error.message : undefined}
        onConfirm={() => {
          if (purgeTarget) purgeNode.mutate(purgeTarget.id);
        }}
      />

      {/* Empty trash dialog */}
      <ConfirmDeleteDialog
        open={emptyTrashOpen}
        onClose={() => setEmptyTrashOpen(false)}
        resourceType={t("trash.nodeResource", "proxy node")}
        resourceName={t("trash.tab", "Trash")}
        confirmLabel={t("trash.emptyTrash", "Empty trash")}
        description={t(
          "trash.emptyNodesDesc",
          "Permanently delete all {count} trashed proxy node(s)? This cannot be undone.",
          { count: trashedNodes.length },
        )}
        pending={emptyTrash.isPending}
        error={emptyTrash.error instanceof Error ? emptyTrash.error.message : undefined}
        onConfirm={() => emptyTrash.mutate()}
      />

      {/* Batch soft delete confirmation */}
      <ConfirmDeleteDialog
        open={batchDeleteOpen}
        onClose={() => setBatchDeleteOpen(false)}
        resourceType={t("trash.nodeResource", "proxy node")}
        resourceName={t("batch.selectedCount", "{count} nodes", { count: selectedIds.length })}
        confirmLabel={t("trash.delete", "Delete")}
        description={t(
          "batch.deleteDesc",
          "Move {count} selected proxy node(s) and their dependent relays to Trash? You can restore them later from Trash.",
          { count: selectedIds.length },
        )}
        pending={batchOp.isPending}
        error={batchOp.error instanceof Error ? batchOp.error.message : undefined}
        onConfirm={() => batchOp.mutate({ ids: selectedIds, action: "delete", cascade: true })}
      />

      {/* Batch Rate / Visibility modal */}
      <Modal
        open={batchModal !== null}
        onClose={() => setBatchModal(null)}
        pending={batchOp.isPending}
        title={
          batchModal === "rate"
            ? t("batch.setRateTitle", "Set traffic multiplier")
            : t("batch.setVisibilityTitle", "Set role visibility")
        }
      >
        <form
          className="form-fields"
          onSubmit={(e) => {
            e.preventDefault();
            if (batchModal === "rate") {
              batchOp.mutate({ ids: selectedIds, action: "set_rate", rate: Number(batchRate) });
            } else if (batchModal === "visibility") {
              batchOp.mutate({
                ids: selectedIds,
                action: "set_visibility",
                visibility: batchVisibility,
                role_ids: batchVisibility === "roles" ? batchRoleIds : [],
              });
            }
          }}
        >
          {batchModal === "rate" ? (
            <Input
              label={t("editor.rate", "Traffic multiplier")}
              type="number"
              min={0}
              max={100}
              step="0.1"
              value={batchRate}
              onChange={(e) => setBatchRate(e.target.value)}
            />
          ) : (
            <>
              <Select
                label={t("editor.visibility", "Visibility")}
                value={batchVisibility}
                items={{
                  all: t("visibility.all", "All subscribers"),
                  roles: t("visibility.roles", "Specific roles"),
                }}
                onValueChange={(v: NodeVisibility | null) => {
                  if (v) setBatchVisibility(v);
                }}
              />
              {batchVisibility === "roles" && (
                <div className="flex flex-wrap gap-3">
                  {(roles.data ?? [])
                    .filter((r) => !r.locked)
                    .map((role) => (
                      <Checkbox
                        key={role.id}
                        label={role.name}
                        checked={batchRoleIds.includes(role.id)}
                        onCheckedChange={(checked) =>
                          setBatchRoleIds((prev) =>
                            checked ? Array.from(new Set([...prev, role.id])) : prev.filter((id) => id !== role.id),
                          )
                        }
                      />
                    ))}
                </div>
              )}
            </>
          )}
          <Banner error={batchOp.error} />
          <FormActions
            onClose={() => setBatchModal(null)}
            pending={batchOp.isPending}
            label={t("batch.apply", "Apply to {count} nodes", { count: selectedIds.length })}
          />
        </form>
      </Modal>
    </>
  );
}
