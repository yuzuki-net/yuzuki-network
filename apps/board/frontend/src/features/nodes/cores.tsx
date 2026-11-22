import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import {
  ArrowClockwise,
  CheckCircle,
  Cpu,
  DownloadSimple,
  Plus,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, FormActions, Modal, SectionCard } from "../../components/console-ui";
import { dateTime } from "../../components/format";
import { ActionTooltip, ConfirmDeleteDialog } from "../../components/kumo-ext";
import { english, useT } from "../../i18n";
import {
  allCores,
  compareSemver,
  coreNames,
  coreVersion,
  isServerOnline,
  protocols,
  serversPath,
  type Core,
  type CoreCatalog,
  type CoreSource,
  type CoreTask,
  type Protocol,
  type ProxyNode,
  type Server,
  type ServerTab,
} from "./model";

export function ServerCores({
  server,
  hostedNodes,
  now,
  canManage,
  go,
}: {
  server: Server;
  hostedNodes: ProxyNode[];
  now: number;
  canManage: boolean;
  go: (tab: ServerTab) => void;
}) {
  const t = useT("nodes");
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const [installTarget, setInstallTarget] = useState<Core | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Core | null>(null);

  const catalog = useQuery({
    queryKey: [`${serversPath}/cores/catalog`],
    queryFn: ({ signal }) => api<CoreCatalog>(`${serversPath}/cores/catalog`, "GET", undefined, signal),
    staleTime: 60_000,
  });

  const tasksUrl = `${serversPath}/${server.id}/cores/tasks`;
  const tasks = useQuery({
    queryKey: [tasksUrl],
    queryFn: ({ signal }) => api<CoreTask[]>(tasksUrl, "GET", undefined, signal),
    refetchInterval: (query) => {
      const list = query.state.data ?? [];
      return list.some((item) => item.status === "pending" || item.status === "running") ? 2_000 : 10_000;
    },
  });

  const online = isServerOnline(server, now);
  const coreMgmtDisabled = server.host_info?.core_management === false;
  const canRemoteOperate = canManage && online && !coreMgmtDisabled;

  const refreshAll = () => {
    void cache.invalidateQueries({ queryKey: [serversPath] });
    void cache.invalidateQueries({ queryKey: [tasksUrl] });
  };

  const probe = useMutation({
    mutationFn: () => api<CoreTask>(`${serversPath}/${server.id}/cores/probe`, "POST"),
    onSuccess: () => {
      toast.add({ title: t("cores.probeQueued", "Core detection requested on node"), variant: "success" });
      refreshAll();
    },
  });

  const remove = useMutation({
    mutationFn: (core: Core) => api<CoreTask>(`${serversPath}/${server.id}/cores/${core}`, "DELETE"),
    onSuccess: (_task, core) => {
      setRemoveTarget(null);
      toast.add({
        title: t("cores.removeQueued", "Removing {core} from node", { core: coreNames[core] }),
        variant: "success",
      });
      refreshAll();
    },
  });

  const taskList = tasks.data ?? [];

  function latestTaskFor(core: Core): CoreTask | undefined {
    return taskList.find((task) => task.core === core);
  }

  function sourceLabel(source?: CoreSource) {
    if (source === "managed") return t("cores.source.managed", "Panel managed");
    if (source === "system") return t("cores.source.system", "System PATH");
    return t("cores.source.configured", "node.toml");
  }

  function stageLabel(stage: string) {
    const map: Record<string, string> = {
      queued: t("cores.stage.queued", "Queued"),
      downloading: t("cores.stage.downloading", "Downloading"),
      verifying: t("cores.stage.verifying", "Verifying checksum"),
      extracting: t("cores.stage.extracting", "Extracting binary"),
      testing: t("cores.stage.testing", "Testing executable"),
      installing: t("cores.stage.installing", "Installing"),
      removing: t("cores.stage.removing", "Removing"),
      probing: t("cores.stage.probing", "Probing host"),
      completed: t("cores.stage.completed", "Completed"),
      failed: english("nodes", "cores.stage.failed", "Failed"),
    };
    return map[stage] ?? stage;
  }

  const catalogByCore = new Map((catalog.data?.cores ?? []).map((item) => [item.core, item]));
  const removeNodesCount = removeTarget
    ? hostedNodes.filter((item) => item.core === removeTarget && item.enabled && !item.deleted_at).length
    : 0;

  return (
    <div className="flex flex-col gap-4">
      <SectionCard
        title={t("cores.title", "Server core runtimes")}
        description={t(
          "cores.help",
          "Install, upgrade, or remove xray-core, sing-box, and mihomo directly on this server without editing node.toml.",
        )}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {server.host_info && (
              <Chip tone="blue">
                <span className="inline-flex items-center gap-1 font-mono text-xs">
                  <Cpu size={13} aria-hidden />
                  {server.host_info.os}/{server.host_info.arch}
                </span>
              </Chip>
            )}
            {canManage && (
              <Button
                variant="secondary"
                size="sm"
                icon={ArrowClockwise}
                loading={probe.isPending}
                disabled={!online}
                onClick={() => probe.mutate()}
              >
                {t("cores.rescan", "Rescan host")}
              </Button>
            )}
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <Banner error={catalog.error || tasks.error || probe.error} />

          {!online && (
            <KumoBanner
              size="sm"
              variant="alert"
              title={t("cores.offlineTitle", "Agent is offline")}
              description={t(
                "cores.offlineHelp",
                "Connect the node agent first. Once connected, you can install xray-core, sing-box, or mihomo directly from this page.",
              )}
              action={
                <Button variant="secondary" size="sm" onClick={() => go("connection")}>
                  {t("steps.connection", "Open connection setup")}
                </Button>
              }
            />
          )}

          {online && coreMgmtDisabled && (
            <KumoBanner
              size="sm"
              variant="alert"
              title={t("cores.disabledTitle", "Remote core management is disabled on this node")}
              description={t(
                "cores.disabledHelp",
                "Set [core_management] enabled = true in node.toml and restart the agent to allow remote installation and removal.",
              )}
            />
          )}

          <div className="node-cores-grid">
            {allCores.map((core) => {
              const cap = server.capabilities.find((entry) => entry.core === core);
              const meta = catalogByCore.get(core);
              const recommended = meta?.recommended_version ?? "";
              const installedVer = cap ? coreVersion(cap.version, t("connect.version", "Version unavailable")) : null;
              const cmp = installedVer && recommended ? compareSemver(installedVer, recommended) : "unknown";
              const coreNodes = hostedNodes.filter((item) => item.core === core && !item.deleted_at);
              const runningCount = coreNodes.filter((item) => item.runtime_state === "running").length;
              const task = latestTaskFor(core);
              const busy = task?.status === "pending" || task?.status === "running";
              const canRemove = canRemoteOperate && cap?.source === "managed" && !busy && runningCount === 0;

              return (
                <LayerCard key={core} render={<section />} className="node-core-card">
                  <div className="flex w-full items-start justify-between gap-2">
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-kumo-strong">{coreNames[core]}</h3>
                        {busy ? (
                          <Chip tone="blue">{stageLabel(task.stage)}</Chip>
                        ) : cap ? (
                          <Chip tone="green">{t("cores.installed", "Installed")}</Chip>
                        ) : (
                          <Chip tone="neutral">{t("cores.notInstalled", "Not installed")}</Chip>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-kumo-subtle">
                        {cap ? (
                          <>
                            <span className="font-mono text-kumo-default">v{installedVer}</span>
                            <span>·</span>
                            <span>{sourceLabel(cap.source)}</span>
                            {cmp === "outdated" && recommended && (
                              <Chip tone="amber">
                                {t("cores.upgradeAvailable", "Baseline v{ver}", { ver: recommended })}
                              </Chip>
                            )}
                          </>
                        ) : (
                          <span>
                            {recommended
                              ? t("cores.recommended", "Recommended v{ver}", { ver: recommended })
                              : t("cores.readyToInstall", "Ready to install from panel")}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {cap?.path && (
                    <code
                      dir="ltr"
                      title={cap.path}
                      className="w-full truncate rounded border border-kumo-line bg-kumo-recessed/40 px-2 py-1 text-[11px] text-kumo-subtle"
                    >
                      {cap.path}
                    </code>
                  )}

                  {meta && meta.listener_protocols.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {meta.listener_protocols.slice(0, 6).map((proto) => (
                        <Badge key={proto} variant="secondary" className="text-[11px]">
                          {protocols[proto as Protocol] ?? proto}
                        </Badge>
                      ))}
                      {meta.listener_protocols.length > 6 && (
                        <Badge variant="secondary" className="text-[11px]">
                          +{meta.listener_protocols.length - 6}
                        </Badge>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2 text-xs text-kumo-subtle">
                    <span>
                      {t("cores.instanceStats", "{total} instances · {running} running", {
                        total: coreNodes.length,
                        running: runningCount,
                      })}
                    </span>
                    {coreNodes.length > 0 && (
                      <LinkButton variant="ghost" size="xs" href={`/admin/nodes?server=${server.id}`}>
                        {t("cores.viewInstances", "View")}
                      </LinkButton>
                    )}
                  </div>

                  {busy && task && (
                    <div className="flex w-full items-center gap-2 rounded-md border border-kumo-line bg-kumo-tint/60 px-3 py-2 text-xs text-kumo-default">
                      <ArrowClockwise size={14} className="shrink-0 animate-spin" aria-hidden />
                      <span className="truncate">{task.message || stageLabel(task.stage)}</span>
                    </div>
                  )}

                  {!busy && task?.status === "failed" && task.error && (
                    <div className="flex w-full items-start gap-2 rounded-md border border-kumo-danger/40 bg-kumo-danger/10 px-3 py-2 text-xs text-kumo-danger">
                      <WarningCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
                      <span className="break-words">{task.error}</span>
                    </div>
                  )}

                  {!busy && task?.status === "succeeded" && task.action === "install" && cap && (
                    <div className="flex w-full items-center gap-1.5 text-xs text-kumo-subtle">
                      <CheckCircle size={14} className="shrink-0 text-kumo-success" aria-hidden />
                      <span className="truncate">
                        {t("cores.lastUpdated", "Updated {date}", { date: dateTime(task.updated_at) })}
                      </span>
                    </div>
                  )}

                  <div className="mt-auto flex w-full flex-wrap items-center gap-2 border-t border-kumo-line pt-2">
                    {canManage && (
                      <Button
                        variant={cap ? "secondary" : "primary"}
                        size="sm"
                        icon={DownloadSimple}
                        disabled={!canRemoteOperate || busy}
                        onClick={() => setInstallTarget(core)}
                      >
                        {cap
                          ? cmp === "outdated"
                            ? t("cores.upgrade", "Upgrade")
                            : t("cores.reinstall", "Change version")
                          : t("cores.install", "Install")}
                      </Button>
                    )}
                    {canManage && cap && (
                      <LinkButton
                        variant="ghost"
                        size="sm"
                        icon={Plus}
                        href={`/admin/nodes?create=1&server=${server.id}&core=${core}`}
                      >
                        {t("cores.createService", "New service")}
                      </LinkButton>
                    )}
                    {canManage && cap?.source === "managed" && (
                      <ActionTooltip
                        content={
                          runningCount > 0
                            ? t("cores.cannotRemoveRunning", "Disable running instances using this core before removing it.")
                            : t("cores.removeTip", "Remove panel-managed binary from host")
                        }
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          aria-label={t("cores.remove", "Uninstall")}
                          disabled={!canRemove}
                          onClick={() => {
                            remove.reset();
                            setRemoveTarget(core);
                          }}
                        >
                          <Trash size={15} />
                        </Button>
                      </ActionTooltip>
                    )}
                  </div>
                </LayerCard>
              );
            })}
          </div>
        </div>
      </SectionCard>

      {taskList.length > 0 && (
        <SectionCard
          title={t("cores.historyTitle", "Recent core operations")}
          description={t("cores.historyHelp", "Latest remote install, removal, and host detection jobs for this node.")}
        >
          <div className="flex flex-col divide-y divide-kumo-line">
            {taskList.slice(0, 8).map((task) => (
              <div key={task.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip
                    tone={
                      task.status === "succeeded"
                        ? "green"
                        : task.status === "failed"
                          ? "red"
                          : "blue"
                    }
                  >
                    {stageLabel(task.stage)}
                  </Chip>
                  <strong className="text-kumo-strong">
                    {task.core ? coreNames[task.core] : t("cores.allCores", "All cores")}
                  </strong>
                  <span className="text-kumo-subtle">
                    {task.action === "install"
                      ? t("cores.action.install", "Install {version}", { version: task.target_version ?? "" }).trim()
                      : task.action === "remove"
                        ? t("cores.action.remove", "Uninstall")
                        : t("cores.action.probe", "Rescan")}
                  </span>
                  {(task.error || task.message) && (
                    <span className={task.error ? "text-kumo-danger" : "text-kumo-subtle"}>
                      — {task.error ?? task.message}
                    </span>
                  )}
                </div>
                <span className="tabular-nums text-kumo-subtle">{dateTime(task.updated_at)}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <InstallCoreModal
        open={installTarget !== null}
        server={server}
        core={installTarget}
        recommended={installTarget ? catalogByCore.get(installTarget)?.recommended_version ?? "" : ""}
        onClose={() => setInstallTarget(null)}
        onStarted={() => {
          setInstallTarget(null);
          refreshAll();
        }}
      />

      <ConfirmDeleteDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        resourceType={t("cores.resourceType", "managed core binary")}
        resourceName={removeTarget ? coreNames[removeTarget] : ""}
        confirmLabel={t("cores.remove", "Uninstall")}
        description={
          removeTarget
            ? removeNodesCount > 0
              ? t(
                  "cores.removeWarnInstances",
                  "{core} still has {count} enabled instance(s). Removing the binary will prevent those instances from starting until reinstalled.",
                  { core: coreNames[removeTarget], count: removeNodesCount },
                )
              : t(
                  "cores.removeConfirm",
                  "Remove the panel-managed {core} binary from this server? Existing instance definitions in Board will remain intact.",
                  { core: coreNames[removeTarget] },
                )
            : undefined
        }
        pending={remove.isPending}
        error={remove.error instanceof Error ? remove.error.message : undefined}
        onConfirm={() => {
          if (removeTarget) remove.mutate(removeTarget);
        }}
      />
    </div>
  );
}

function InstallCoreModal({
  open,
  server,
  core,
  recommended,
  onClose,
  onStarted,
}: {
  open: boolean;
  server: Server;
  core: Core | null;
  recommended: string;
  onClose: () => void;
  onStarted: () => void;
}) {
  const t = useT("nodes");
  return (
    <Modal
      open={open && core !== null}
      onClose={onClose}
      title={
        core
          ? t("cores.installTitle", "Install or update {core}", { core: coreNames[core] })
          : t("cores.install", "Install")
      }
      description={
        server.host_info
          ? t("cores.installDesc", "Downloads and verifies the release package directly on {node} ({os}/{arch}).", {
              node: server.name,
              os: server.host_info.os,
              arch: server.host_info.arch,
            })
          : t("cores.installDescGeneric", "Downloads and verifies the release package directly on {node}.", {
              node: server.name,
            })
      }
    >
      {core && (
        <InstallCoreForm
          key={`${server.id}-${core}-${recommended}`}
          serverId={server.id}
          core={core}
          recommended={recommended}
          onClose={onClose}
          onStarted={onStarted}
        />
      )}
    </Modal>
  );
}

function InstallCoreForm({
  serverId,
  core,
  recommended,
  onClose,
  onStarted,
}: {
  serverId: string;
  core: Core;
  recommended: string;
  onClose: () => void;
  onStarted: () => void;
}) {
  const t = useT("nodes");
  const toast = useKumoToastManager();
  const [version, setVersion] = useState(recommended);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [sha256, setSha256] = useState("");

  const install = useMutation({
    mutationFn: () =>
      api<CoreTask>(`${serversPath}/${serverId}/cores/${core}/install`, "POST", {
        version: version.trim() || undefined,
        download_url: downloadUrl.trim() || undefined,
        sha256: sha256.trim() || undefined,
      }),
    onSuccess: () => {
      toast.add({
        title: t("cores.installQueued", "Installing {core} on node…", { core: coreNames[core] }),
        variant: "success",
      });
      onStarted();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!install.isPending) install.mutate();
  }

  return (
    <form className="form-fields" onSubmit={submit}>
      <Input
        label={t("cores.versionLabel", "Release version")}
        value={version}
        dir="ltr"
        placeholder={recommended || "1.0.0"}
        description={
          recommended
            ? t("cores.versionHelp", "Recommended baseline version is {ver}. Leave as-is for tested compatibility.", {
                ver: recommended,
              })
            : t("cores.versionCustomHelp", "Enter a release tag version (without leading v).")
        }
        onChange={(e) => setVersion(e.target.value)}
      />

      <Collapsible.Root>
        <Collapsible.Trigger className="text-xs font-medium text-kumo-subtle hover:text-kumo-strong">
          {t("cores.advancedSource", "Advanced: custom download URL or SHA-256 verification")}
        </Collapsible.Trigger>
        <Collapsible.Panel className="node-optional">
          <Input
            label={t("cores.downloadUrl", "Custom package URL (optional)")}
            value={downloadUrl}
            dir="ltr"
            placeholder="https://mirror.example.com/..."
            description={t(
              "cores.downloadUrlHelp",
              "Supports .zip, .tar.gz, .gz, or direct executable URLs. Overrides GitHub Releases.",
            )}
            onChange={(e) => setDownloadUrl(e.target.value)}
          />
          <Input
            label={t("cores.sha256", "Expected SHA-256 checksum (optional)")}
            value={sha256}
            dir="ltr"
            placeholder="64-character hex digest"
            onChange={(e) => setSha256(e.target.value)}
          />
        </Collapsible.Panel>
      </Collapsible.Root>

      <Banner error={install.error} />
      <FormActions
        onClose={onClose}
        pending={install.isPending}
        label={t("cores.startInstall", "Start installation")}
      />
    </form>
  );
}
