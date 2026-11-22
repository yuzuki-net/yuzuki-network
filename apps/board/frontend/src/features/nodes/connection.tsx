import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Input } from "@cloudflare/kumo/components/input";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { CheckCircle, DownloadSimple, Key } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useResource } from "../../app/query";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, FormActions, Modal, SectionCard } from "../../components/console-ui";
import { CopyValue } from "../../components/copy-value";
import { dateTime } from "../../components/format";
import { CodePreview, StepGuide, type StepItem } from "../../components/kumo-ext";
import { useT } from "../../i18n";
import {
  coreNames,
  coreVersion,
  serverHealth,
  serverHealthTone,
  serversPath,
  type Server,
  type ServerTab,
} from "./model";

type Enrollment = { token: string; expires_seconds: number };

function escapeToml(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function ServerConnection({
  server,
  now,
  canEnroll,
  go,
}: {
  server: Server;
  now: number;
  canEnroll: boolean;
  go?: (tab: ServerTab) => void;
}) {
  const t = useT("nodes");
  const client = useQueryClient();
  const toast = useKumoToastManager();
  const control = useResource<{ available: boolean }>(`${serversPath}/control`);
  const [identity, setIdentity] = useState<{ token: string; expires: number } | null>(null);
  const [confirm, setConfirm] = useState<"replace" | "revoke" | null>(null);

  const [boardUrl, setBoardUrl] = useState(`https://${location.hostname || "control.example.net"}:3443`);
  const [caCert, setCaCert] = useState("/etc/yuzuki/control-ca.crt");
  const [stateDir, setStateDir] = useState("/var/lib/yuzuki-node");
  const [configPath, setConfigPath] = useState("/etc/yuzuki/node.toml");
  const [downloadMirror, setDownloadMirror] = useState("");
  const [useXray, setUseXray] = useState(false);
  const [xrayPath, setXrayPath] = useState("/usr/local/bin/xray");
  const [useSingbox, setUseSingbox] = useState(false);
  const [singboxPath, setSingboxPath] = useState("/usr/local/bin/sing-box");
  const [useMihomo, setUseMihomo] = useState(false);
  const [mihomoPath, setMihomoPath] = useState("/usr/local/bin/mihomo");

  const path = `${serversPath}/${server.id}/enrollment`;
  const refresh = () => void client.invalidateQueries({ queryKey: [serversPath] });

  const issue = useMutation({
    mutationFn: () => api<Enrollment>(path, "POST"),
    onSuccess: ({ token, expires_seconds }) => {
      setIdentity({ token, expires: Date.now() + expires_seconds * 1000 });
      setConfirm(null);
      toast.add({ title: t("connect.issued", "Enrollment token issued"), variant: "success" });
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: () => api(path, "DELETE"),
    onSuccess: () => {
      setIdentity(null);
      setConfirm(null);
      toast.add({ title: t("connect.revoked", "Node identities revoked"), variant: "success" });
      refresh();
    },
  });

  const generatedToml = useMemo(() => {
    const lines = [
      `board_url = "${escapeToml(boardUrl.trim())}"`,
      `ca_certificate = "${escapeToml(caCert.trim())}"`,
      `state_dir = "${escapeToml(stateDir.trim())}"`,
      "",
      "[core_management]",
      "enabled = true",
      "detect_system_binaries = true",
    ];
    if (downloadMirror.trim()) {
      lines.push(`download_mirror = "${escapeToml(downloadMirror.trim())}"`);
    }
    const pinned: string[] = [];
    if (useXray && xrayPath.trim()) pinned.push(`xray = "${escapeToml(xrayPath.trim())}"`);
    if (useSingbox && singboxPath.trim()) pinned.push(`sing-box = "${escapeToml(singboxPath.trim())}"`);
    if (useMihomo && mihomoPath.trim()) pinned.push(`mihomo = "${escapeToml(mihomoPath.trim())}"`);
    if (pinned.length > 0) {
      lines.push("", "[binaries]", ...pinned);
    }
    return lines.join("\n");
  }, [boardUrl, caCert, stateDir, downloadMirror, useXray, xrayPath, useSingbox, singboxPath, useMihomo, mihomoPath]);

  const enrollCommand = useMemo(
    () =>
      `read -rs YUZUKI_ENROLLMENT_TOKEN\nexport YUZUKI_ENROLLMENT_TOKEN\nyuzuki-node --config "${configPath}" enroll\nunset YUZUKI_ENROLLMENT_TOKEN`,
    [configPath],
  );
  const startCommand = `yuzuki-node --config "${configPath}" run`;
  const systemdUnit = useMemo(
    () => `[Unit]
Description=Yuzuki Node Agent (${server.name})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/yuzuki-node --config ${configPath} run
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target`,
    [configPath, server.name],
  );

  const pendingToken = !!server.enrollment_expires_at && Date.parse(server.enrollment_expires_at) > now;
  const showToken = identity && identity.expires > now && pendingToken;
  const pending = issue.isPending || revoke.isPending;
  const currentHealth = serverHealth(server, now);
  const isOnline = currentHealth === "recent";

  const steps: StepItem[] = [
    {
      id: "config",
      title: t("connect.prepare", "Prepare the host"),
      description: t(
        "connect.zeroConfigHelp",
        "No pre-installed Xray, sing-box, or Mihomo is required. Connect this host first, then install and manage cores visually from the panel.",
      ),
      status: server.last_seen_at ? "done" : "current",
      content: (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label={t("connect.boardUrl", "Board control URL")}
              value={boardUrl}
              dir="ltr"
              onChange={(e) => setBoardUrl(e.target.value)}
            />
            <Input
              label={t("connect.configPath", "Config file path on host")}
              value={configPath}
              dir="ltr"
              onChange={(e) => setConfigPath(e.target.value)}
            />
            <Input
              label={t("connect.caCert", "Control CA certificate path")}
              value={caCert}
              dir="ltr"
              onChange={(e) => setCaCert(e.target.value)}
            />
            <Input
              label={t("connect.stateDir", "State directory")}
              value={stateDir}
              dir="ltr"
              onChange={(e) => setStateDir(e.target.value)}
            />
          </div>

          <Collapsible.Root>
            <Collapsible.Trigger className="text-xs font-medium text-kumo-subtle hover:text-kumo-strong">
              {t("connect.advancedBinaries", "Optional: configure download mirror or manual binary paths")}
            </Collapsible.Trigger>
            <Collapsible.Panel className="flex flex-col gap-3 pt-2">
              <Input
                label={t("connect.downloadMirror", "GitHub release mirror prefix (optional)")}
                value={downloadMirror}
                dir="ltr"
                placeholder="https://mirror.example.net/"
                onChange={(e) => setDownloadMirror(e.target.value)}
              />
              <div className="grid gap-2.5 rounded-lg border border-kumo-line bg-kumo-recessed/30 p-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Checkbox label="xray-core" checked={useXray} onCheckedChange={setUseXray} />
                  {useXray && <Input aria-label="xray path" dir="ltr" value={xrayPath} onChange={(e) => setXrayPath(e.target.value)} />}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Checkbox label="sing-box" checked={useSingbox} onCheckedChange={setUseSingbox} />
                  {useSingbox && <Input aria-label="sing-box path" dir="ltr" value={singboxPath} onChange={(e) => setSingboxPath(e.target.value)} />}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Checkbox label="mihomo" checked={useMihomo} onCheckedChange={setUseMihomo} />
                  {useMihomo && <Input aria-label="mihomo path" dir="ltr" value={mihomoPath} onChange={(e) => setMihomoPath(e.target.value)} />}
                </div>
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>

          <CodePreview title={configPath} code={generatedToml} lang="bash" />
        </div>
      ),
    },
    {
      id: "enroll",
      title: t("connect.enroll", "Enroll this host"),
      description: t("connect.enrollHelp", "Pass a one-time token to the enrollment command on the host. It expires after 15 minutes."),
      status: server.last_seen_at ? "done" : pendingToken ? "current" : "pending",
      content: (
        <div className="flex flex-col gap-3">
          {canEnroll && (
            <div>
              <Button
                variant="primary"
                icon={Key}
                disabled={!control.data?.available}
                loading={issue.isPending}
                onClick={() => {
                  issue.reset();
                  if (pendingToken) setConfirm("replace");
                  else issue.mutate();
                }}
              >
                {pendingToken ? t("connect.replace", "Replace enrollment token") : t("connect.issue", "Generate enrollment token")}
              </Button>
            </div>
          )}
          {showToken && (
            <div className="flex flex-col gap-1.5">
              <CopyValue label={t("connect.token", "Enrollment token")} value={identity.token} secret />
              <p className="text-xs text-kumo-subtle">
                {t("connect.tokenHelp", "Copy the token before leaving this view. It can be used once.")}
              </p>
            </div>
          )}
          {pendingToken && server.enrollment_expires_at && (
            <p className="text-xs text-kumo-subtle">
              {t("connect.expires", "Token expires {date}.", { date: dateTime(server.enrollment_expires_at) })}
            </p>
          )}
          {canEnroll && <CodePreview title={t("connect.enrollCommand", "Bash enrollment commands")} code={enrollCommand} lang="bash" />}
        </div>
      ),
    },
    {
      id: "start",
      title: t("connect.start", "Start the agent"),
      description: t("connect.startHelp", "Run the agent on the host and leave it running. Watch this page for the heartbeat before publishing the node."),
      status: isOnline ? "done" : server.last_seen_at ? "current" : "pending",
      content: (
        <div className="flex flex-col gap-3">
          <CodePreview title={t("connect.startCommand", "Start command")} code={startCommand} lang="bash" />
          <Collapsible.Root>
            <Collapsible.Trigger className="text-xs font-medium text-kumo-subtle hover:text-kumo-strong">
              {t("connect.systemd", "Show systemd unit example")}
            </Collapsible.Trigger>
            <Collapsible.Panel className="pt-2">
              <CodePreview title="yuzuki-node.service" code={systemdUnit} lang="bash" />
            </Collapsible.Panel>
          </Collapsible.Root>
        </div>
      ),
    },
    {
      id: "verify",
      title: t("connect.verify", "Verify heartbeat & reported cores"),
      description: server.last_seen_at
        ? t("lastHeartbeat", "Last heartbeat {date}", { date: dateTime(server.last_seen_at) })
        : t("connect.noHeartbeat", "Waiting for the first heartbeat"),
      status: isOnline ? "done" : "pending",
      content: server.last_seen_at ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {server.capabilities.length ? (
              server.capabilities.map(({ core, version }) => (
                <div
                  key={core}
                  className="inline-flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-recessed/40 px-3 py-2 text-xs"
                >
                  <CheckCircle size={15} style={{ color: "var(--brand-accent)" }} weight="fill" aria-hidden />
                  <strong className="text-kumo-strong">{coreNames[core]}</strong>
                  <Chip tone="neutral">{coreVersion(version, t("connect.version", "Version unavailable"))}</Chip>
                </div>
              ))
            ) : (
              <p className="text-xs text-kumo-subtle">
                {t(
                  "connect.noCoresManaged",
                  "Agent connected with no cores installed yet. Open Core runtimes to install xray-core, sing-box, or mihomo visually.",
                )}
              </p>
            )}
          </div>
          {go && (
            <div>
              <Button variant="primary" size="sm" icon={DownloadSimple} onClick={() => go("cores")}>
                {t("cores.openManager", "Open core runtimes manager")}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-kumo-subtle">
          {t("connect.waitingAgent", "This page refreshes automatically every 5 seconds while you complete host setup.")}
        </p>
      ),
    },
  ];

  return (
    <>
      <SectionCard
        title={t("connect.title", "Node agent connection")}
        description={t("connect.help", "The Yuzuki Node agent connects to Board over WebSocket with mutual TLS.")}
        action={<Chip tone={serverHealthTone(currentHealth)}>{t(`health.${currentHealth}`, currentHealth)}</Chip>}
      >
        <div className="flex flex-col gap-4">
          <Banner error={control.error || (!confirm && (issue.error || revoke.error))} />
          {control.data?.available === false && (
            <KumoBanner
              size="sm"
              variant="alert"
              title={t("connect.disabled", "Board control listener is disabled")}
              description={t(
                "connect.disabledHelp",
                "Configure the [control] section in the Board configuration, restart Board, then return here to generate a token.",
              )}
            />
          )}
          <StepGuide steps={steps} />
        </div>
      </SectionCard>

      {canEnroll && (server.last_seen_at !== null || pendingToken) && (
        <SectionCard
          title={t("connect.identity", "Manage node identity")}
          description={t(
            "connect.identityHelp",
            "Revoke the pending token and all issued identities if this host is retired or its credentials are compromised.",
          )}
        >
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              revoke.reset();
              setConfirm("revoke");
            }}
          >
            {t("connect.revoke", "Revoke identities")}
          </Button>
        </SectionCard>
      )}

      <Modal
        open={confirm !== null}
        title={
          confirm === "revoke"
            ? t("connect.revokeTitle", "Revoke identities?")
            : t("connect.replaceTitle", "Replace enrollment token?")
        }
        description={
          confirm === "revoke"
            ? t("connect.revokeHelp", "The agent’s current identity stops working. Enroll the host again to reconnect.")
            : t("connect.replaceHelp", "The previous enrollment token stops working immediately.")
        }
        pending={pending}
        onClose={() => setConfirm(null)}
      >
        <form
          className="form-fields"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirm === "revoke") revoke.mutate();
            else if (confirm) issue.mutate();
          }}
        >
          <Banner error={confirm === "revoke" ? revoke.error : issue.error} />
          <FormActions
            onClose={() => setConfirm(null)}
            pending={pending}
            destructive
            label={
              confirm === "revoke"
                ? t("connect.revoke", "Revoke identities")
                : t("connect.replace", "Replace enrollment token")
            }
          />
        </form>
      </Modal>
    </>
  );
}
