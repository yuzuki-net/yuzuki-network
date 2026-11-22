import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { DiceFive, DownloadSimple, Key } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, FormActions, Modal } from "../../components/console-ui";
import { english, useT } from "../../i18n";
import type { Role } from "../session/model";
import {
  coreNames,
  detectPreset,
  generateRealityKeypair,
  isServerOnline,
  nodesPath,
  pickBestCore,
  portableTargets,
  PROTOCOL_PRESETS,
  protocols,
  randomHex,
  requiresTls,
  serverKey,
  serversPath,
  shadowsocks2022Ciphers,
  supportsTransport,
  type Core,
  type CoreTask,
  type ExternalProtocolConfig,
  type Fingerprint,
  type ManagedProtocolConfig,
  type NativeEndpoint,
  type Network,
  type NodeMode,
  type NodeVisibility,
  type Protocol,
  type ProtocolOptions,
  type ProtocolPreset,
  type ProxyNode,
  type ProxyNodeInput,
  type Server,
  type Shadowsocks2022Cipher,
  type XhttpMode,
} from "./model";

const RATE_PRESETS = ["0.5", "1", "1.5", "2"];
const FINGERPRINTS: Record<Fingerprint, string> = {
  chrome: "Chrome",
  firefox: "Firefox",
  safari: "Safari",
  edge: "Edge",
  ios: "iOS",
  android: "Android",
  random: "Random",
  randomized: "Randomized",
};
const XHTTP_MODES: Record<XhttpMode, string> = {
  auto: "auto",
  "packet-up": "packet-up",
  "stream-up": "stream-up",
  "stream-one": "stream-one",
};
const SS_LEGACY_METHODS: Record<string, string> = {
  "chacha20-ietf-poly1305": "ChaCha20-IETF-Poly1305",
  "aes-128-gcm": "AES-128-GCM",
  "aes-256-gcm": "AES-256-GCM",
};
const TUIC_CONGESTION: Record<string, string> = {
  bbr: "BBR",
  cubic: "CUBIC",
  new_reno: "New Reno",
};
const TUIC_UDP_MODES: Record<string, string> = {
  native: "Native",
  quic: "QUIC",
};

type TransportChoice = "tcp" | "ws" | "grpc" | "http_upgrade" | "xhttp";

function looksLikeDomain(value: string) {
  const trimmed = value.trim();
  return !!trimmed && !/^\d+\.\d+\.\d+\.\d+$/.test(trimmed) && !trimmed.includes(":");
}

function parseOptionalUint(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseAlpnList(raw: string): string[] | undefined {
  const items = raw
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseReservedTriplet(raw: string): [number, number, number] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(/[,，\s]+/).map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error("WireGuard reserved must be 3 numbers between 0 and 255 (e.g. 1, 2, 3).");
  }
  return [parts[0], parts[1], parts[2]];
}

export type NodeEditorTarget = {
  mode: "create" | "edit";
  node?: ProxyNode;
  initialMode?: NodeMode;
  initialServerId?: string;
  initialCore?: Core;
  initialParentId?: string;
};

export function NodeEditorModal({
  target,
  servers,
  nodes,
  roles,
  now,
  onClose,
}: {
  target: NodeEditorTarget | null;
  servers: Server[];
  nodes: ProxyNode[];
  roles: Role[];
  now: number;
  onClose: () => void;
}) {
  const t = useT("nodes");
  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      large
      title={
        target?.mode === "edit"
          ? t("editor.editTitle", "Edit proxy node")
          : t("editor.createTitle", "Add proxy node")
      }
      description={
        target?.mode === "edit"
          ? t("editor.editDesc", "Update node routing, protocol settings, multiplier, or role visibility.")
          : t("editor.createDesc", "Create a managed server node, relay entry, external endpoint, or custom runtime.")
      }
    >
      {target && (
        <NodeEditorForm
          key={
            target.node?.id ??
            `new-${target.initialMode ?? "managed"}-${target.initialServerId ?? ""}-${target.initialParentId ?? ""}`
          }
          target={target}
          servers={servers}
          nodes={nodes}
          roles={roles}
          now={now}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

function NodeEditorForm({
  target,
  servers,
  nodes,
  roles,
  now,
  onClose,
}: {
  target: NodeEditorTarget;
  servers: Server[];
  nodes: ProxyNode[];
  roles: Role[];
  now: number;
  onClose: () => void;
}) {
  const t = useT("nodes");
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const existing = target.node;
  const activeServers = servers.filter((s) => !s.deleted_at);
  const relayCandidates = nodes.filter(
    (n) => !n.deleted_at && n.mode !== "relay" && n.id !== existing?.id,
  );
  const selectableRoles = roles.filter((r) => !r.locked);

  const initialMode: NodeMode = existing?.mode ?? target.initialMode ?? "managed";
  const initialPreset = detectPreset(existing);
  const existingCfg = (existing?.protocol_config ?? null) as ManagedProtocolConfig | ExternalProtocolConfig | null;
  const managedCfg = existing?.mode === "managed" ? (existingCfg as ManagedProtocolConfig | null) : null;
  const existingNet = existingCfg?.network ?? null;
  const existingOpts = existingCfg?.options ?? null;

  const [mode, setMode] = useState<NodeMode>(initialMode);
  const [name, setName] = useState(existing?.name ?? "");
  const [tagsText, setTagsText] = useState((existing?.tags ?? []).join(", "));
  const [rate, setRate] = useState(existing ? String(existing.rate) : "1");
  const [sortOrder, setSortOrder] = useState(existing ? String(existing.sort_order) : "0");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [show, setShow] = useState(existing?.show ?? true);
  const [visibility, setVisibility] = useState<NodeVisibility>(existing?.visibility ?? "all");
  const [roleIds, setRoleIds] = useState<string[]>(existing?.roles.map((r) => r.id) ?? []);

  // Server & Core (for managed / custom)
  const defaultServer =
    activeServers.find((s) => s.id === (existing?.server_id ?? target.initialServerId)) ?? activeServers[0];
  const [serverId, setServerId] = useState<string>(existing?.server_id ?? target.initialServerId ?? defaultServer?.id ?? "");
  const selectedServer = activeServers.find((s) => s.id === serverId);

  // Relay parent
  const defaultParent =
    relayCandidates.find((n) => n.id === (existing?.parent_id ?? target.initialParentId)) ?? relayCandidates[0];
  const [parentId, setParentId] = useState<string>(existing?.parent_id ?? target.initialParentId ?? defaultParent?.id ?? "");

  // Managed preset & protocol fields
  const [presetId, setPresetId] = useState<ProtocolPreset["id"]>(initialPreset.id);
  const preset = PROTOCOL_PRESETS.find((p) => p.id === presetId) ?? PROTOCOL_PRESETS[0];
  const [core, setCore] = useState<Core>(
    existing?.core ??
      target.initialCore ??
      pickBestCore(initialPreset, selectedServer?.capabilities ?? []),
  );
  const [host, setHost] = useState(existing?.host ?? defaultServer?.default_host ?? "");
  const [port, setPort] = useState(String(existing?.port ?? initialPreset.defaultPort));
  const [customListen, setCustomListen] = useState(
    Boolean(existing?.listen_port && existing.listen_port !== existing.port),
  );
  const [listenPort, setListenPort] = useState(String(existing?.listen_port ?? existing?.port ?? initialPreset.defaultPort));
  const [meterEnabled, setMeterEnabled] = useState(existing?.meter_enabled ?? true);

  // Protocol-specific fields (managed & external)
  const [externalProtocol, setExternalProtocol] = useState<Protocol>(existing?.protocol ?? "vless");
  const [sni, setSni] = useState(existingCfg?.server_name ?? (initialPreset.isReality ? "www.microsoft.com" : ""));
  const [certificate, setCertificate] = useState(managedCfg?.certificate ?? "/etc/yuzuki/server.crt");
  const [keyPath, setKeyPath] = useState(managedCfg?.key ?? "/etc/yuzuki/server.key");
  const [alpnText, setAlpnText] = useState((existingCfg?.alpn ?? []).join(", "));
  const [tlsFingerprint, setTlsFingerprint] = useState<"" | Fingerprint>(existingCfg?.fingerprint ?? "");
  const [allowInsecure, setAllowInsecure] = useState(Boolean(existingCfg?.allow_insecure));

  // Transport fields
  const [network, setNetwork] = useState<TransportChoice>(
    existingNet?.kind ?? (initialPreset.network ?? "tcp"),
  );
  const [wsPath, setWsPath] = useState(
    existingNet && "path" in existingNet ? existingNet.path : "/ws",
  );
  const [transportHost, setTransportHost] = useState(
    existingNet && "host" in existingNet ? existingNet.host ?? "" : "",
  );
  const [wsMaxEarlyData, setWsMaxEarlyData] = useState(
    existingNet?.kind === "ws" && existingNet.max_early_data ? String(existingNet.max_early_data) : "",
  );
  const [wsEarlyDataHeader, setWsEarlyDataHeader] = useState(
    existingNet?.kind === "ws" ? existingNet.early_data_header_name ?? "" : "",
  );
  const [grpcService, setGrpcService] = useState(
    existingNet?.kind === "grpc" ? existingNet.service_name : "grpc",
  );
  const [grpcMultiMode, setGrpcMultiMode] = useState(
    existingNet?.kind === "grpc" ? Boolean(existingNet.multi_mode) : false,
  );
  const [xhttpMode, setXhttpMode] = useState<XhttpMode>(
    existingNet?.kind === "xhttp" && existingNet.mode ? existingNet.mode : "auto",
  );

  // REALITY & Vision fields
  const [vision, setVision] = useState(existing ? existingCfg?.flow === "xtls-rprx-vision" : Boolean(initialPreset.vision));
  const [useReality, setUseReality] = useState(existing ? Boolean(existingCfg?.reality) : Boolean(initialPreset.isReality));
  const [realityPrivateKey, setRealityPrivateKey] = useState(managedCfg?.reality?.private_key ?? "");
  const [realityPublicKey, setRealityPublicKey] = useState(existingCfg?.reality?.public_key ?? "");
  const [realityShortId, setRealityShortId] = useState(existingCfg?.reality?.short_id ?? randomHex(4));
  const [fingerprint, setFingerprint] = useState<Fingerprint>(existingCfg?.reality?.fingerprint ?? "chrome");
  const [realityHandshakeServer, setRealityHandshakeServer] = useState(
    managedCfg?.reality?.handshake_server ?? "",
  );
  const [realityHandshakePort, setRealityHandshakePort] = useState(
    managedCfg?.reality?.handshake_port ? String(managedCfg.reality.handshake_port) : "443",
  );
  const [realitySpiderX, setRealitySpiderX] = useState(existingCfg?.reality?.spider_x ?? "");
  const [realityFallbackWarn, setRealityFallbackWarn] = useState(false);

  // Hysteria2 / Hysteria v1 fields
  const [obfsPassword, setObfsPassword] = useState(
    existingOpts && "obfs_password" in existingOpts ? existingOpts.obfs_password ?? "" : "",
  );
  const [hy2UpMbps, setHy2UpMbps] = useState(
    existingOpts && ("up_mbps" in existingOpts) && existingOpts.up_mbps ? String(existingOpts.up_mbps) : "",
  );
  const [hy2DownMbps, setHy2DownMbps] = useState(
    existingOpts && ("down_mbps" in existingOpts) && existingOpts.down_mbps ? String(existingOpts.down_mbps) : "",
  );
  const [hy2Ports, setHy2Ports] = useState(
    existingOpts?.kind === "hysteria2" ? existingOpts.ports ?? "" : "",
  );
  const [hy2PinSha256, setHy2PinSha256] = useState(
    existingOpts?.kind === "hysteria2" ? existingOpts.pin_sha256 ?? "" : "",
  );
  const [hy2IgnoreBandwidth, setHy2IgnoreBandwidth] = useState(
    existingOpts?.kind === "hysteria2" ? Boolean(existingOpts.ignore_client_bandwidth) : false,
  );

  // TUIC fields
  const [tuicCongestion, setTuicCongestion] = useState(
    existingOpts?.kind === "tuic" ? existingOpts.congestion_control ?? "bbr" : "bbr",
  );
  const [tuicUdpMode, setTuicUdpMode] = useState(
    existingOpts?.kind === "tuic" ? existingOpts.udp_relay_mode ?? "native" : "native",
  );
  const [tuicZeroRtt, setTuicZeroRtt] = useState(
    existingOpts?.kind === "tuic" ? Boolean(existingOpts.zero_rtt_handshake) : false,
  );
  const [tuicHeartbeat, setTuicHeartbeat] = useState(
    existingOpts?.kind === "tuic" ? existingOpts.heartbeat ?? "10s" : "10s",
  );

  // Shadowsocks fields
  const [ssCipher, setSsCipher] = useState<Shadowsocks2022Cipher>(
    existingOpts?.kind === "shadowsocks2022" ? existingOpts.cipher : "2022-blake3-aes-128-gcm",
  );
  const [ssServerKey, setSsServerKey] = useState(
    existingOpts?.kind === "shadowsocks2022" ? existingOpts.server_key : "",
  );
  const [ssMethod, setSsMethod] = useState(existingCfg?.method ?? "chacha20-ietf-poly1305");

  // WireGuard fields (external)
  const [wgPrivateKey, setWgPrivateKey] = useState(
    existingOpts?.kind === "wire_guard" ? existingOpts.private_key : "",
  );
  const [wgPeerPublicKey, setWgPeerPublicKey] = useState(
    existingOpts?.kind === "wire_guard" ? existingOpts.peer_public_key : "",
  );
  const [wgPresharedKey, setWgPresharedKey] = useState(
    existingOpts?.kind === "wire_guard" ? existingOpts.preshared_key ?? "" : "",
  );
  const [wgLocalAddress, setWgLocalAddress] = useState(
    existingOpts?.kind === "wire_guard" ? existingOpts.local_address.join(", ") : "172.16.0.2/32",
  );
  const [wgReserved, setWgReserved] = useState(
    existingOpts?.kind === "wire_guard" && existingOpts.reserved ? existingOpts.reserved.join(", ") : "",
  );
  const [wgMtu, setWgMtu] = useState(
    existingOpts?.kind === "wire_guard" && existingOpts.mtu ? String(existingOpts.mtu) : "1280",
  );

  // External static credential / username
  const [extCredential, setExtCredential] = useState(existingCfg?.credential ?? "");
  const [extUsername, setExtUsername] = useState(existingCfg?.username ?? "");

  // Custom server & native client overrides JSON
  const [customServerJson, setCustomServerJson] = useState(
    existing?.native_server_config
      ? JSON.stringify(existing.native_server_config, null, 2)
      : '{\n  "inbounds": [],\n  "outbounds": [{ "type": "direct" }]\n}',
  );
  const [nativeOverridesJson, setNativeOverridesJson] = useState(
    existing?.native_client_overrides && Object.keys(existing.native_client_overrides).length > 0
      ? JSON.stringify(existing.native_client_overrides, null, 2)
      : "",
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  const installCore = useMutation({
    mutationFn: (targetCore: Core) =>
      api<CoreTask>(`${serversPath}/${serverId}/cores/${targetCore}/install`, "POST", {}),
    onSuccess: (_data, targetCore) => {
      toast.add({
        title: t("cores.installQueued", "Installing {core} on node…", { core: coreNames[targetCore] }),
        variant: "success",
      });
      void cache.invalidateQueries({ queryKey: [serversPath] });
    },
  });

  const save = useMutation({
    mutationFn: (payload: ProxyNodeInput) =>
      api<ProxyNode>(
        existing ? `${nodesPath}/${existing.id}` : nodesPath,
        existing ? "PUT" : "POST",
        payload,
      ),
    onSuccess: () => {
      toast.add({
        title: existing ? t("editor.saved", "Node updated") : t("editor.created", "Node created"),
        variant: "success",
      });
      void cache.invalidateQueries({ queryKey: [`${nodesPath}?include_deleted=true`] });
      void cache.invalidateQueries({ queryKey: [nodesPath] });
      void cache.invalidateQueries({ queryKey: [`${serversPath}?include_deleted=true`] });
      void cache.invalidateQueries({ queryKey: [serversPath] });
      onClose();
    },
  });

  function selectPreset(next: ProtocolPreset) {
    setPresetId(next.id);
    setPort(String(next.defaultPort));
    if (!customListen) setListenPort(String(next.defaultPort));
    setNetwork(next.network ?? "tcp");
    setVision(Boolean(next.vision));
    setUseReality(Boolean(next.isReality));
    if (next.isReality && !sni.trim()) setSni("www.microsoft.com");
    if (next.network === "xhttp" && (!wsPath.trim() || wsPath === "/ws")) setWsPath("/xhttp");
    if (!next.serverCores.includes(core)) {
      setCore(pickBestCore(next, selectedServer?.capabilities ?? []));
    }
    if (next.protocol === "shadowsocks2022" && !ssServerKey) {
      setSsServerKey(serverKey(ssCipher));
    }
  }

  function selectServer(nextId: string) {
    setServerId(nextId);
    const nextServer = activeServers.find((s) => s.id === nextId);
    if (nextServer?.default_host && !host.trim()) {
      setHost(nextServer.default_host);
    }
    if (mode === "managed" && nextServer) {
      if (!nextServer.capabilities.some((c) => c.core === core)) {
        setCore(pickBestCore(preset, nextServer.capabilities));
      }
    }
  }

  async function handleGenerateReality() {
    setRealityFallbackWarn(false);
    const pair = await generateRealityKeypair();
    if (pair) {
      setRealityPrivateKey(pair.privateKey);
      setRealityPublicKey(pair.publicKey);
      if (!realityShortId.trim()) setRealityShortId(randomHex(4));
    } else {
      setRealityFallbackWarn(true);
    }
  }

  function buildNetwork(proto: Protocol): Network | undefined {
    if (!supportsTransport(proto) || network === "tcp") return undefined;
    if (network === "grpc") {
      return {
        kind: "grpc",
        service_name: grpcService.trim() || "grpc",
        ...(grpcMultiMode ? { multi_mode: true } : {}),
      };
    }
    const cleanPath = wsPath.trim();
    const normalizedPath = cleanPath ? (cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`) : "/ws";
    const cleanHost = transportHost.trim() || undefined;
    if (network === "ws") {
      return {
        kind: "ws",
        path: normalizedPath,
        ...(cleanHost ? { host: cleanHost } : {}),
        ...(parseOptionalUint(wsMaxEarlyData) ? { max_early_data: parseOptionalUint(wsMaxEarlyData) } : {}),
        ...(wsEarlyDataHeader.trim() ? { early_data_header_name: wsEarlyDataHeader.trim() } : {}),
      };
    }
    if (network === "http_upgrade") {
      return {
        kind: "http_upgrade",
        path: normalizedPath,
        ...(cleanHost ? { host: cleanHost } : {}),
      };
    }
    return {
      kind: "xhttp",
      path: normalizedPath,
      ...(cleanHost ? { host: cleanHost } : {}),
      mode: xhttpMode,
    };
  }

  function buildProtocolOptions(proto: Protocol): ProtocolOptions | undefined {
    if (proto === "hysteria2") {
      const obfs = obfsPassword.trim() || undefined;
      const up = parseOptionalUint(hy2UpMbps);
      const down = parseOptionalUint(hy2DownMbps);
      const ports = hy2Ports.trim() || undefined;
      const pin = hy2PinSha256.trim() || undefined;
      if (obfs || up || down || ports || pin || hy2IgnoreBandwidth) {
        return {
          kind: "hysteria2",
          ...(obfs ? { obfs_password: obfs } : {}),
          ...(up ? { up_mbps: up } : {}),
          ...(down ? { down_mbps: down } : {}),
          ...(ports ? { ports } : {}),
          ...(pin ? { pin_sha256: pin } : {}),
          ...(hy2IgnoreBandwidth ? { ignore_client_bandwidth: true } : {}),
        };
      }
      return undefined;
    }
    if (proto === "hysteria") {
      return {
        kind: "hysteria",
        up_mbps: parseOptionalUint(hy2UpMbps) ?? 50,
        down_mbps: parseOptionalUint(hy2DownMbps) ?? 200,
        ...(obfsPassword.trim() ? { obfs_password: obfsPassword.trim() } : {}),
      };
    }
    if (proto === "tuic") {
      return {
        kind: "tuic",
        congestion_control: tuicCongestion || "bbr",
        udp_relay_mode: tuicUdpMode || "native",
        zero_rtt_handshake: tuicZeroRtt,
        ...(tuicHeartbeat.trim() ? { heartbeat: tuicHeartbeat.trim() } : {}),
      };
    }
    if (proto === "shadowsocks2022") {
      if (!ssServerKey.trim()) {
        throw new Error(english("nodes", "wizard.errSsKey", "Generate or enter a Shadowsocks 2022 server key."));
      }
      return { kind: "shadowsocks2022", cipher: ssCipher, server_key: ssServerKey.trim() };
    }
    if (proto === "wireguard") {
      const addrs = wgLocalAddress
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!wgPrivateKey.trim() || !wgPeerPublicKey.trim() || addrs.length === 0) {
        throw new Error(english("nodes", "editor.errWireguard", "WireGuard requires private key, peer public key, and local address CIDR."));
      }
      return {
        kind: "wire_guard",
        private_key: wgPrivateKey.trim(),
        peer_public_key: wgPeerPublicKey.trim(),
        ...(wgPresharedKey.trim() ? { preshared_key: wgPresharedKey.trim() } : {}),
        local_address: addrs,
        ...(wgReserved.trim() ? { reserved: parseReservedTriplet(wgReserved) } : {}),
        ...(parseOptionalUint(wgMtu) ? { mtu: parseOptionalUint(wgMtu) } : {}),
      };
    }
    return undefined;
  }

  function parseNativeOverrides(): Partial<Record<Core, NativeEndpoint>> | undefined {
    const trimmed = nativeOverridesJson.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as Partial<Record<Core, NativeEndpoint>>;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("invalid");
      }
      return parsed;
    } catch {
      throw new Error(english("nodes", "editor.errNativeJson", "Native client overrides must be valid JSON."));
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (save.isPending) return;
    setValidationError(null);

    try {
      const cleanName = name.trim();
      if (!cleanName) throw new Error(english("nodes", "editor.errName", "Enter a node name."));
      const parsedRate = Number(rate);
      if (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100) {
        throw new Error(english("nodes", "editor.errRate", "Traffic multiplier must be between 0 and 100."));
      }
      const parsedOrder = Number.parseInt(sortOrder || "0", 10);
      const tags = tagsText
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const nativeOverrides = parseNativeOverrides();

      if (mode === "managed") {
        if (!serverId) throw new Error(english("nodes", "editor.errServer", "Select a host server."));
        const cleanHost = host.trim();
        if (!cleanHost) throw new Error(english("nodes", "wizard.errHost", "Enter the public server IP or domain clients will connect to."));
        const clientPort = Number(port);
        const srvPort = customListen ? Number(listenPort) : clientPort;
        if (!Number.isInteger(clientPort) || clientPort < 1 || clientPort > 65535 || !Number.isInteger(srvPort) || srvPort < 1 || srvPort > 65535) {
          throw new Error(english("nodes", "wizard.errPort", "Ports must be whole numbers between 1 and 65535."));
        }
        const effectiveSni = sni.trim() || (preset.isReality ? "www.microsoft.com" : looksLikeDomain(cleanHost) ? cleanHost : "");
        const cfg: ManagedProtocolConfig = {
          protocol: preset.protocol,
          listen_host: "0.0.0.0",
        };
        if (effectiveSni && preset.protocol !== "shadowsocks2022" && preset.protocol !== "shadowsocks") {
          cfg.server_name = effectiveSni;
        }
        if (preset.needsCert) {
          if (!certificate.trim() || !keyPath.trim()) {
            throw new Error(english("nodes", "wizard.errCert", "Provide the server TLS certificate and private key paths."));
          }
          cfg.certificate = certificate.trim();
          cfg.key = keyPath.trim();
        }
        const net = buildNetwork(preset.protocol);
        if (net) cfg.network = net;

        if (preset.isReality) {
          if (!realityPrivateKey.trim() || !realityPublicKey.trim()) {
            throw new Error(english("nodes", "wizard.errReality", "Generate or paste both REALITY private key and public key."));
          }
          cfg.reality = {
            private_key: realityPrivateKey.trim(),
            public_key: realityPublicKey.trim(),
            short_id: realityShortId.trim(),
            fingerprint,
            handshake_server: realityHandshakeServer.trim() || effectiveSni,
            handshake_port: parseOptionalUint(realityHandshakePort) ?? 443,
            ...(realitySpiderX.trim() ? { spider_x: realitySpiderX.trim() } : {}),
          };
          if (network === "tcp" && vision) {
            cfg.flow = "xtls-rprx-vision";
          }
        } else if (preset.protocol !== "shadowsocks2022" && preset.protocol !== "shadowsocks") {
          const alpn = parseAlpnList(alpnText);
          if (alpn) cfg.alpn = alpn;
          if (tlsFingerprint) cfg.fingerprint = tlsFingerprint;
          if (allowInsecure) cfg.allow_insecure = true;
          if (preset.protocol === "vless" && network === "tcp" && vision) {
            cfg.flow = "xtls-rprx-vision";
          }
        }

        const opts = buildProtocolOptions(preset.protocol);
        if (opts) cfg.options = opts;

        save.mutate({
          name: cleanName,
          mode: "managed",
          server_id: serverId,
          core: network === "xhttp" ? "xray" : core,
          enabled,
          show,
          sort_order: Number.isNaN(parsedOrder) ? 0 : parsedOrder,
          rate: parsedRate,
          tags,
          visibility,
          role_ids: visibility === "roles" ? roleIds : [],
          protocol: preset.protocol,
          host: cleanHost,
          port: clientPort,
          listen_port: srvPort,
          protocol_config: cfg,
          meter_enabled: meterEnabled,
          native_client_overrides: nativeOverrides,
        });
        return;
      }

      if (mode === "relay") {
        if (!parentId) throw new Error(english("nodes", "editor.errParent", "Select a parent node to relay traffic to."));
        const cleanHost = host.trim();
        const clientPort = Number(port);
        if (!cleanHost) throw new Error(english("nodes", "wizard.errHost", "Enter the public server IP or domain clients will connect to."));
        if (!Number.isInteger(clientPort) || clientPort < 1 || clientPort > 65535) {
          throw new Error(english("nodes", "wizard.errPort", "Ports must be whole numbers between 1 and 65535."));
        }
        save.mutate({
          name: cleanName,
          mode: "relay",
          parent_id: parentId,
          enabled,
          show,
          sort_order: Number.isNaN(parsedOrder) ? 0 : parsedOrder,
          rate: parsedRate,
          tags,
          visibility,
          role_ids: visibility === "roles" ? roleIds : [],
          host: cleanHost,
          port: clientPort,
          meter_enabled: false,
          native_client_overrides: nativeOverrides,
        });
        return;
      }

      if (mode === "external") {
        const cleanHost = host.trim();
        const clientPort = Number(port);
        if (!cleanHost && !nativeOverrides) {
          throw new Error(english("nodes", "wizard.errHost", "Enter the public server IP or domain clients will connect to."));
        }
        if (cleanHost && (!Number.isInteger(clientPort) || clientPort < 1 || clientPort > 65535)) {
          throw new Error(english("nodes", "wizard.errPort", "Ports must be whole numbers between 1 and 65535."));
        }
        let extCfg: ExternalProtocolConfig | null = null;
        if (cleanHost) {
          extCfg = { protocol: externalProtocol };
          const hasTls =
            externalProtocol !== "shadowsocks" &&
            externalProtocol !== "shadowsocks2022" &&
            externalProtocol !== "wireguard";
          if (hasTls && sni.trim()) {
            extCfg.server_name = sni.trim();
          }
          if (externalProtocol === "shadowsocks") extCfg.method = ssMethod;
          const net = buildNetwork(externalProtocol);
          if (net) extCfg.network = net;

          const canReality = externalProtocol === "vless" && (network === "tcp" || network === "grpc" || network === "xhttp");
          if (canReality && useReality) {
            extCfg.reality = {
              public_key: realityPublicKey.trim(),
              short_id: realityShortId.trim(),
              fingerprint,
              ...(realitySpiderX.trim() ? { spider_x: realitySpiderX.trim() } : {}),
            };
          } else if (hasTls) {
            const alpn = parseAlpnList(alpnText);
            if (alpn) extCfg.alpn = alpn;
            if (tlsFingerprint) extCfg.fingerprint = tlsFingerprint;
            if (allowInsecure) extCfg.allow_insecure = true;
          }
          if (externalProtocol === "vless" && network === "tcp" && vision) {
            extCfg.flow = "xtls-rprx-vision";
          }
          if (extCredential.trim() && externalProtocol !== "wireguard") {
            extCfg.credential = extCredential.trim();
          }
          if (extUsername.trim() && ["socks5", "http", "naive"].includes(externalProtocol)) {
            extCfg.username = extUsername.trim();
          }
          const opts = buildProtocolOptions(externalProtocol);
          if (opts) extCfg.options = opts;
        }
        save.mutate({
          name: cleanName,
          mode: "external",
          enabled,
          show,
          sort_order: Number.isNaN(parsedOrder) ? 0 : parsedOrder,
          rate: parsedRate,
          tags,
          visibility,
          role_ids: visibility === "roles" ? roleIds : [],
          protocol: cleanHost ? externalProtocol : null,
          host: cleanHost,
          port: cleanHost ? clientPort : null,
          protocol_config: extCfg,
          meter_enabled: false,
          native_client_overrides: nativeOverrides,
        });
        return;
      }

      // Custom mode
      if (!serverId) throw new Error(english("nodes", "editor.errServer", "Select a host server."));
      let parsedServerConfig: unknown;
      try {
        parsedServerConfig = JSON.parse(customServerJson);
        if (typeof parsedServerConfig !== "object" || parsedServerConfig === null || Array.isArray(parsedServerConfig)) {
          throw new Error("not object");
        }
      } catch {
        throw new Error(english("nodes", "editor.errServerJson", "Custom server configuration must be a valid JSON object."));
      }
      if (!nativeOverrides || Object.keys(nativeOverrides).length === 0) {
        throw new Error(english("nodes", "editor.errCustomOverrides", "Custom nodes require at least one native client override (xray, sing-box, or mihomo)."));
      }
      save.mutate({
        name: cleanName,
        mode: "custom",
        server_id: serverId,
        core,
        enabled,
        show,
        sort_order: Number.isNaN(parsedOrder) ? 0 : parsedOrder,
        rate: parsedRate,
        tags,
        visibility,
        role_ids: visibility === "roles" ? roleIds : [],
        host: host.trim(),
        port: port.trim() ? Number(port) : null,
        meter_enabled: meterEnabled,
        native_server_config: parsedServerConfig,
        native_client_overrides: nativeOverrides,
      });
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : String(err));
    }
  }

  const serverOnline = selectedServer ? isServerOnline(selectedServer, now) : false;
  const effectiveCore: Core = mode === "managed" && network === "xhttp" ? "xray" : core;
  const coreInstalled = selectedServer?.capabilities.some((c) => c.core === effectiveCore) ?? false;
  const activeProto: Protocol = mode === "managed" ? preset.protocol : externalProtocol;
  const targets =
    mode === "managed" || mode === "external"
      ? portableTargets(activeProto, sni, network)
      : [];

  const transportItems =
    activeProto === "vless"
      ? { tcp: "TCP", ws: "WebSocket", grpc: "gRPC", http_upgrade: "HTTPUpgrade", xhttp: "XHTTP (SplitHTTP)" }
      : { tcp: "TCP", ws: "WebSocket", grpc: "gRPC", http_upgrade: "HTTPUpgrade" };

  const showTlsParams =
    !useReality &&
    activeProto !== "shadowsocks" &&
    activeProto !== "shadowsocks2022" &&
    activeProto !== "wireguard";

  return (
    <form className="form-fields node-editor" onSubmit={submit}>
      {!existing && (
        <Tabs
          variant="segmented"
          className="w-fit max-w-full"
          value={mode}
          onValueChange={(next) => setMode(next as NodeMode)}
          tabs={[
            { value: "managed", label: t("mode.managed", "Managed") },
            { value: "relay", label: t("mode.relay", "Relay") },
            { value: "external", label: t("mode.external", "External") },
            { value: "custom", label: t("mode.custom", "Custom") },
          ]}
        />
      )}

      {/* Common identity & display metadata */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label={t("editor.name", "Node name")}
          value={name}
          maxLength={80}
          required
          placeholder="Tokyo REALITY 01"
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label={t("editor.tags", "Tags (comma separated)")}
          value={tagsText}
          placeholder="IEPL, 0.5x, Streaming"
          onChange={(e) => setTagsText(e.target.value)}
        />
      </div>

      {/* Mode-specific host / parent / protocol configuration */}
      {mode === "managed" && (
        <>
          {activeServers.length === 0 ? (
            <KumoBanner
              size="sm"
              variant="alert"
              title={t("editor.noServersTitle", "No managed servers registered yet")}
              description={t("editor.noServersDesc", "Add a host server first, or switch to External mode to publish an existing server.")}
              action={
                <LinkButton href="/admin/servers?create=1" size="sm" variant="secondary">
                  {t("servers.add", "Add server")}
                </LinkButton>
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label={t("editor.server", "Host server")}
                value={serverId}
                items={Object.fromEntries(
                  activeServers.map((s) => [
                    s.id,
                    `${s.name}${isServerOnline(s, now) ? "" : ` (${t("servers.offlineShort", "offline")})`}`,
                  ]),
                )}
                onValueChange={(next: string | null) => {
                  if (next) selectServer(next);
                }}
              />
              <Select
                label={t("editor.core", "Server runtime core")}
                value={effectiveCore}
                items={Object.fromEntries(
                  (network === "xhttp" ? (["xray"] as Core[]) : preset.serverCores).map((c) => [
                    c,
                    `${coreNames[c]}${selectedServer?.capabilities.some((cap) => cap.core === c) ? " ✓" : ""}`,
                  ]),
                )}
                onValueChange={(next: Core | null) => {
                  if (next) setCore(next);
                }}
              />
            </div>
          )}

          {selectedServer && !coreInstalled && (
            <KumoBanner
              size="sm"
              variant="alert"
              title={t("wizard.coreMissing", "{core} is not installed on this server yet", {
                core: coreNames[effectiveCore],
              })}
              description={
                serverOnline
                  ? t("wizard.coreMissingInstall", "Install it right now from the panel, or save this service first and install the core later.")
                  : t("wizard.coreMissingOffline", "You can still save this service now; it will start automatically once the node is online and the core is installed.")
              }
              action={
                serverOnline ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    icon={DownloadSimple}
                    loading={installCore.isPending}
                    onClick={() => installCore.mutate(effectiveCore)}
                  >
                    {t("wizard.installCoreNow", "Install {core}", { core: coreNames[effectiveCore] })}
                  </Button>
                ) : undefined
              }
            />
          )}

          {/* Protocol Presets */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
              {t("wizard.step1", "1. Choose a protocol preset")}
            </span>
            <div className="wizard-preset-grid">
              {PROTOCOL_PRESETS.map((item) => {
                const active = item.id === preset.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`wizard-preset-card ${active ? "is-active" : ""}`}
                    onClick={() => selectPreset(item)}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <strong className="text-sm text-kumo-strong">{item.name}</strong>
                      {item.badge && (
                        <Badge variant={active ? "primary" : "secondary"}>
                          {t(`wizard.badge.${item.id}`, item.badge)}
                        </Badge>
                      )}
                    </div>
                    <span className="text-xs text-kumo-subtle">
                      {t(`wizard.preset.${item.id}`, item.summary)}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-kumo-subtle">
              {t("wizard.bridgeSummary", "Runs 1 {core} server instance → auto-generates subscriptions for {clients}.", {
                core: coreNames[effectiveCore],
                clients: [...targets.map((c) => coreNames[c]), "Universal URI"].join(", "),
              })}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Input
                label={t("wizard.publicHost", "Public address (domain or IP)")}
                value={host}
                dir="ltr"
                required
                placeholder="jp1.example.com"
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            <Input
              label={t("wizard.publicPort", "Client port")}
              type="number"
              min={1}
              max={65535}
              value={port}
              required
              onChange={(e) => {
                setPort(e.target.value);
                if (!customListen) setListenPort(e.target.value);
              }}
            />
          </div>

          {/* Transport selector for VLESS / VMess / Trojan */}
          {supportsTransport(preset.protocol) && (
            <div className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label={t("editor.transport", "Transport")}
                  value={network}
                  items={
                    preset.isReality
                      ? { tcp: "TCP", grpc: "gRPC", xhttp: "XHTTP (SplitHTTP)" }
                      : transportItems
                  }
                  onValueChange={(next: string | null) => {
                    if (next) {
                      const nextNet = next as TransportChoice;
                      setNetwork(nextNet);
                      if (nextNet === "xhttp") setCore("xray");
                    }
                  }}
                />
                {preset.protocol === "vless" && network === "tcp" && (
                  <div className="sm:mt-8">
                    <Switch label="XTLS-Vision (xtls-rprx-vision)" checked={vision} onCheckedChange={setVision} />
                  </div>
                )}
              </div>

              {(network === "ws" || network === "http_upgrade" || network === "xhttp") && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label={t("wizard.wsPath", "Path")}
                    value={wsPath}
                    dir="ltr"
                    placeholder={network === "xhttp" ? "/xhttp" : "/ws"}
                    onChange={(e) => setWsPath(e.target.value)}
                  />
                  <Input
                    label={t("editor.transportHost", "Host header (optional)")}
                    value={transportHost}
                    dir="ltr"
                    placeholder="cdn.example.com"
                    onChange={(e) => setTransportHost(e.target.value)}
                  />
                  {network === "xhttp" && (
                    <Select
                      label={t("editor.xhttpMode", "XHTTP mode")}
                      value={xhttpMode}
                      items={XHTTP_MODES}
                      onValueChange={(v: XhttpMode | null) => {
                        if (v) setXhttpMode(v);
                      }}
                    />
                  )}
                  {network === "ws" && (
                    <>
                      <Input
                        label={t("editor.wsEarlyData", "Max early data (optional)")}
                        type="number"
                        min={0}
                        value={wsMaxEarlyData}
                        placeholder="2048"
                        onChange={(e) => setWsMaxEarlyData(e.target.value)}
                      />
                      <Input
                        label={t("editor.wsEarlyDataHeader", "Early data header name")}
                        value={wsEarlyDataHeader}
                        dir="ltr"
                        placeholder="Sec-WebSocket-Protocol"
                        onChange={(e) => setWsEarlyDataHeader(e.target.value)}
                      />
                    </>
                  )}
                </div>
              )}

              {network === "grpc" && (
                <div className="grid items-start gap-3 sm:grid-cols-2">
                  <Input
                    label={t("editor.grpcService", "gRPC service name")}
                    value={grpcService}
                    dir="ltr"
                    placeholder="grpc"
                    onChange={(e) => setGrpcService(e.target.value)}
                  />
                  <div className="sm:mt-8">
                    <Switch label={t("editor.grpcMultiMode", "gRPC multi-mode")} checked={grpcMultiMode} onCheckedChange={setGrpcMultiMode} />
                  </div>
                </div>
              )}
            </div>
          )}

          {preset.isReality && (
            <div className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-kumo-strong">
                  {t("wizard.realityKeys", "REALITY X25519 keypair & Short ID")}
                </span>
                <Button type="button" variant="secondary" size="xs" icon={Key} onClick={() => void handleGenerateReality()}>
                  {t("wizard.generateKeypair", "Generate keypair")}
                </Button>
              </div>
              {realityFallbackWarn && (
                <p className="text-xs text-kumo-subtle">
                  {t(
                    "wizard.realityFallback",
                    "Browser X25519 generation is unavailable here. Run `xray x25519` or `sing-box generate reality-keypair` on your server and paste both keys below.",
                  )}
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label={t("wizard.realitySni", "Camouflage target (SNI)")}
                  value={sni}
                  dir="ltr"
                  placeholder="www.microsoft.com"
                  onChange={(e) => setSni(e.target.value)}
                />
                <Select
                  label={t("wizard.fingerprint", "TLS fingerprint")}
                  value={fingerprint}
                  items={FINGERPRINTS}
                  onValueChange={(next: Fingerprint | null) => {
                    if (next) setFingerprint(next);
                  }}
                />
                <SensitiveInput
                  label={t("wizard.realityPrivate", "Server private key")}
                  value={realityPrivateKey}
                  dir="ltr"
                  onChange={(e) => setRealityPrivateKey(e.target.value)}
                />
                <Input
                  label={t("wizard.realityPublic", "Client public key")}
                  value={realityPublicKey}
                  dir="ltr"
                  onChange={(e) => setRealityPublicKey(e.target.value)}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex items-end gap-1.5">
                  <div className="min-w-0 flex-1">
                    <Input
                      label={t("wizard.shortId", "Short ID")}
                      value={realityShortId}
                      dir="ltr"
                      onChange={(e) => setRealityShortId(e.target.value)}
                    />
                  </div>
                  <Button type="button" variant="secondary" shape="square" icon={DiceFive} aria-label={t("wizard.generate", "Generate")} onClick={() => setRealityShortId(randomHex(4))} />
                </div>
                <Input
                  label={t("editor.realityDest", "Handshake server (optional)")}
                  value={realityHandshakeServer}
                  dir="ltr"
                  placeholder={sni || "www.microsoft.com"}
                  onChange={(e) => setRealityHandshakeServer(e.target.value)}
                />
                <Input
                  label={t("editor.realityPort", "Handshake port")}
                  type="number"
                  min={1}
                  max={65535}
                  value={realityHandshakePort}
                  onChange={(e) => setRealityHandshakePort(e.target.value)}
                />
              </div>
              <Input
                label={t("editor.spiderX", "SpiderX path (optional)")}
                value={realitySpiderX}
                dir="ltr"
                placeholder="/"
                onChange={(e) => setRealitySpiderX(e.target.value)}
              />
            </div>
          )}

          {preset.needsCert && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label={t("wizard.sni", "TLS server name (SNI)")}
                value={sni}
                dir="ltr"
                placeholder={looksLikeDomain(host) ? host : "example.com"}
                onChange={(e) => setSni(e.target.value)}
              />
              <Input
                label={t("editor.alpn", "ALPN (comma separated, optional)")}
                value={alpnText}
                dir="ltr"
                placeholder="h2, http/1.1"
                onChange={(e) => setAlpnText(e.target.value)}
              />
              <Input
                label={t("wizard.certPath", "TLS certificate file path")}
                value={certificate}
                dir="ltr"
                required
                onChange={(e) => setCertificate(e.target.value)}
              />
              <Input
                label={t("wizard.keyPath", "TLS private key file path")}
                value={keyPath}
                dir="ltr"
                required
                onChange={(e) => setKeyPath(e.target.value)}
              />
            </div>
          )}

          {preset.protocol === "hysteria2" && (
            <div className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label={t("wizard.obfsPassword", "Salamander obfuscation password (optional)")}
                  value={obfsPassword}
                  dir="ltr"
                  placeholder={t("wizard.obfsOptional", "Leave blank for standard Hysteria2")}
                  onChange={(e) => setObfsPassword(e.target.value)}
                />
                <Input
                  label={t("editor.hy2Ports", "Port hopping range (optional)")}
                  value={hy2Ports}
                  dir="ltr"
                  placeholder="20000-40000"
                  onChange={(e) => setHy2Ports(e.target.value)}
                />
                <Input
                  label={t("editor.upMbps", "Upload bandwidth (Mbps, optional)")}
                  type="number"
                  min={1}
                  value={hy2UpMbps}
                  placeholder="100"
                  onChange={(e) => setHy2UpMbps(e.target.value)}
                />
                <Input
                  label={t("editor.downMbps", "Download bandwidth (Mbps, optional)")}
                  type="number"
                  min={1}
                  value={hy2DownMbps}
                  placeholder="500"
                  onChange={(e) => setHy2DownMbps(e.target.value)}
                />
                <Input
                  label={t("editor.pinSha256", "Certificate SHA-256 pin (optional)")}
                  value={hy2PinSha256}
                  dir="ltr"
                  onChange={(e) => setHy2PinSha256(e.target.value)}
                />
                <div className="sm:mt-8">
                  <Switch
                    label={t("editor.ignoreClientBw", "Ignore client bandwidth limits")}
                    checked={hy2IgnoreBandwidth}
                    onCheckedChange={setHy2IgnoreBandwidth}
                  />
                </div>
              </div>
            </div>
          )}

          {preset.protocol === "tuic" && (
            <div className="grid gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-3 sm:grid-cols-2">
              <Select
                label={t("editor.tuicCongestion", "Congestion control")}
                value={tuicCongestion}
                items={TUIC_CONGESTION}
                onValueChange={(v: string | null) => {
                  if (v) setTuicCongestion(v);
                }}
              />
              <Select
                label={t("editor.tuicUdpMode", "UDP relay mode")}
                value={tuicUdpMode}
                items={TUIC_UDP_MODES}
                onValueChange={(v: string | null) => {
                  if (v) setTuicUdpMode(v);
                }}
              />
              <Input
                label={t("editor.tuicHeartbeat", "Heartbeat interval")}
                value={tuicHeartbeat}
                dir="ltr"
                placeholder="10s"
                onChange={(e) => setTuicHeartbeat(e.target.value)}
              />
              <div className="sm:mt-8">
                <Switch
                  label={t("editor.tuicZeroRtt", "0-RTT handshake")}
                  checked={tuicZeroRtt}
                  onCheckedChange={setTuicZeroRtt}
                />
              </div>
            </div>
          )}

          {preset.protocol === "shadowsocks2022" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label={t("wizard.ssCipher", "Cipher")}
                value={ssCipher}
                items={shadowsocks2022Ciphers}
                onValueChange={(next: Shadowsocks2022Cipher | null) => {
                  if (next) {
                    setSsCipher(next);
                    setSsServerKey(serverKey(next));
                  }
                }}
              />
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <SensitiveInput
                    label={t("wizard.ssServerKey", "Server key")}
                    value={ssServerKey}
                    dir="ltr"
                    onChange={(e) => setSsServerKey(e.target.value)}
                  />
                </div>
                <Button type="button" variant="secondary" icon={DiceFive} onClick={() => setSsServerKey(serverKey(ssCipher))}>
                  {t("wizard.generate", "Generate")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {mode === "relay" && (
        <>
          {relayCandidates.length === 0 ? (
            <KumoBanner
              size="sm"
              variant="alert"
              title={t("editor.noParentsTitle", "No landing nodes available")}
              description={t("editor.noParentsDesc", "Create at least one Managed, External, or Custom node before adding a Relay entry.")}
            />
          ) : (
            <Select
              label={t("editor.parentNode", "Parent landing node")}
              value={parentId}
              items={Object.fromEntries(
                relayCandidates.map((n) => [
                  n.id,
                  `${n.name}${n.protocol ? ` (${protocols[n.protocol]})` : ""}`,
                ]),
              )}
              onValueChange={(next: string | null) => {
                if (next) setParentId(next);
              }}
            />
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Input
                label={t("editor.relayHost", "Relay entry address (domain or IP)")}
                value={host}
                dir="ltr"
                required
                placeholder="cn-relay.example.com"
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            <Input
              label={t("editor.relayPort", "Relay entry port")}
              type="number"
              min={1}
              max={65535}
              value={port}
              required
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
          <p className="text-xs text-kumo-subtle">
            {t(
              "editor.relayHelp",
              "Inherits protocol, TLS/REALITY credentials, and user metering from the parent landing node while publishing this entry address to subscribers.",
            )}
          </p>
        </>
      )}

      {mode === "external" && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Select
              label={t("editor.protocol", "Protocol")}
              value={externalProtocol}
              items={protocols}
              onValueChange={(next: Protocol | null) => {
                if (next) setExternalProtocol(next);
              }}
            />
            <Input
              label={t("wizard.publicHost", "Public address (domain or IP)")}
              value={host}
              dir="ltr"
              placeholder="ext.example.com"
              onChange={(e) => setHost(e.target.value)}
            />
            <Input
              label={t("wizard.publicPort", "Client port")}
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>

          {externalProtocol !== "wireguard" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <SensitiveInput
                label={t("editor.staticCredential", "Static UUID / password (optional)")}
                value={extCredential}
                dir="ltr"
                description={t("editor.staticCredentialHint", "Leave blank to use each subscriber's per-account access ID.")}
                onChange={(e) => setExtCredential(e.target.value)}
              />
              {["socks5", "http", "naive"].includes(externalProtocol) && (
                <Input
                  label={t("editor.staticUsername", "Static username (optional)")}
                  value={extUsername}
                  dir="ltr"
                  onChange={(e) => setExtUsername(e.target.value)}
                />
              )}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {externalProtocol !== "shadowsocks" && externalProtocol !== "shadowsocks2022" && externalProtocol !== "wireguard" && (
              <Input
                label={t("wizard.sni", "TLS server name (SNI)")}
                value={sni}
                dir="ltr"
                placeholder={requiresTls(externalProtocol) ? "example.com" : ""}
                onChange={(e) => setSni(e.target.value)}
              />
            )}
            {externalProtocol === "shadowsocks" && (
              <Select
                label={t("wizard.ssCipher", "Cipher")}
                value={ssMethod}
                items={SS_LEGACY_METHODS}
                onValueChange={(next: string | null) => {
                  if (next) setSsMethod(next);
                }}
              />
            )}
            {supportsTransport(externalProtocol) && (
              <Select
                label={t("editor.transport", "Transport")}
                value={network}
                items={transportItems}
                onValueChange={(next: string | null) => {
                  if (next) setNetwork(next as TransportChoice);
                }}
              />
            )}
            {supportsTransport(externalProtocol) && (network === "ws" || network === "http_upgrade" || network === "xhttp") && (
              <>
                <Input label={t("wizard.wsPath", "Path")} value={wsPath} dir="ltr" onChange={(e) => setWsPath(e.target.value)} />
                <Input label={t("editor.transportHost", "Host header (optional)")} value={transportHost} dir="ltr" onChange={(e) => setTransportHost(e.target.value)} />
                {network === "xhttp" && (
                  <Select
                    label={t("editor.xhttpMode", "XHTTP mode")}
                    value={xhttpMode}
                    items={XHTTP_MODES}
                    onValueChange={(v: XhttpMode | null) => {
                      if (v) setXhttpMode(v);
                    }}
                  />
                )}
              </>
            )}
            {supportsTransport(externalProtocol) && network === "grpc" && (
              <>
                <Input label={t("editor.grpcService", "gRPC service name")} value={grpcService} dir="ltr" onChange={(e) => setGrpcService(e.target.value)} />
                <div className="sm:mt-8">
                  <Switch label={t("editor.grpcMultiMode", "gRPC multi-mode")} checked={grpcMultiMode} onCheckedChange={setGrpcMultiMode} />
                </div>
              </>
            )}
          </div>

          {externalProtocol === "vless" && (network === "tcp" || network === "grpc" || network === "xhttp") && (
            <div className="flex flex-wrap gap-4">
              <Switch label="REALITY" checked={useReality} onCheckedChange={setUseReality} />
              {network === "tcp" && <Switch label="XTLS-Vision" checked={vision} onCheckedChange={setVision} />}
            </div>
          )}
          {externalProtocol === "vless" && (network === "tcp" || network === "grpc" || network === "xhttp") && useReality && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label={t("wizard.realityPublic", "Client public key")} value={realityPublicKey} dir="ltr" onChange={(e) => setRealityPublicKey(e.target.value)} />
              <Input label={t("wizard.shortId", "Short ID")} value={realityShortId} dir="ltr" onChange={(e) => setRealityShortId(e.target.value)} />
              <Select
                label={t("wizard.fingerprint", "TLS fingerprint")}
                value={fingerprint}
                items={FINGERPRINTS}
                onValueChange={(next: Fingerprint | null) => {
                  if (next) setFingerprint(next);
                }}
              />
              <Input label={t("editor.spiderX", "SpiderX path (optional)")} value={realitySpiderX} dir="ltr" onChange={(e) => setRealitySpiderX(e.target.value)} />
            </div>
          )}
          {(externalProtocol === "hysteria2" || externalProtocol === "hysteria") && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label={t("wizard.obfsPassword", "Salamander obfuscation password (optional)")}
                value={obfsPassword}
                dir="ltr"
                onChange={(e) => setObfsPassword(e.target.value)}
              />
              {externalProtocol === "hysteria2" && (
                <Input label={t("editor.hy2Ports", "Port hopping range (optional)")} value={hy2Ports} dir="ltr" placeholder="20000-40000" onChange={(e) => setHy2Ports(e.target.value)} />
              )}
              <Input label={t("editor.upMbps", "Upload bandwidth (Mbps)")} type="number" min={1} value={hy2UpMbps} onChange={(e) => setHy2UpMbps(e.target.value)} />
              <Input label={t("editor.downMbps", "Download bandwidth (Mbps)")} type="number" min={1} value={hy2DownMbps} onChange={(e) => setHy2DownMbps(e.target.value)} />
            </div>
          )}
          {externalProtocol === "tuic" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label={t("editor.tuicCongestion", "Congestion control")} value={tuicCongestion} items={TUIC_CONGESTION} onValueChange={(v: string | null) => { if (v) setTuicCongestion(v); }} />
              <Select label={t("editor.tuicUdpMode", "UDP relay mode")} value={tuicUdpMode} items={TUIC_UDP_MODES} onValueChange={(v: string | null) => { if (v) setTuicUdpMode(v); }} />
              <Input label={t("editor.tuicHeartbeat", "Heartbeat interval")} value={tuicHeartbeat} dir="ltr" onChange={(e) => setTuicHeartbeat(e.target.value)} />
              <div className="sm:mt-8">
                <Switch label={t("editor.tuicZeroRtt", "0-RTT handshake")} checked={tuicZeroRtt} onCheckedChange={setTuicZeroRtt} />
              </div>
            </div>
          )}
          {externalProtocol === "shadowsocks2022" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label={t("wizard.ssCipher", "Cipher")}
                value={ssCipher}
                items={shadowsocks2022Ciphers}
                onValueChange={(next: Shadowsocks2022Cipher | null) => {
                  if (next) setSsCipher(next);
                }}
              />
              <SensitiveInput
                label={t("wizard.ssServerKey", "Server key")}
                value={ssServerKey}
                dir="ltr"
                onChange={(e) => setSsServerKey(e.target.value)}
              />
            </div>
          )}
          {externalProtocol === "wireguard" && (
            <div className="grid gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-3 sm:grid-cols-2">
              <SensitiveInput label={t("editor.wgPrivateKey", "Private key")} value={wgPrivateKey} dir="ltr" required onChange={(e) => setWgPrivateKey(e.target.value)} />
              <Input label={t("editor.wgPeerPublicKey", "Peer public key")} value={wgPeerPublicKey} dir="ltr" required onChange={(e) => setWgPeerPublicKey(e.target.value)} />
              <Input label={t("editor.wgLocalAddr", "Local address CIDR (comma separated)")} value={wgLocalAddress} dir="ltr" required placeholder="172.16.0.2/32" onChange={(e) => setWgLocalAddress(e.target.value)} />
              <SensitiveInput label={t("editor.wgPsk", "Pre-shared key (optional)")} value={wgPresharedKey} dir="ltr" onChange={(e) => setWgPresharedKey(e.target.value)} />
              <Input label={t("editor.wgReserved", "Reserved bytes (e.g. 1, 2, 3)")} value={wgReserved} dir="ltr" onChange={(e) => setWgReserved(e.target.value)} />
              <Input label={t("editor.wgMtu", "MTU")} type="number" min={576} max={9000} value={wgMtu} onChange={(e) => setWgMtu(e.target.value)} />
            </div>
          )}
        </>
      )}

      {mode === "custom" && (
        <>
          {activeServers.length === 0 ? (
            <KumoBanner
              size="sm"
              variant="alert"
              title={t("editor.noServersTitle", "No managed servers registered yet")}
              description={t("editor.noServersDesc", "Add a host server first, or switch to External mode to publish an existing server.")}
              action={
                <LinkButton href="/admin/servers?create=1" size="sm" variant="secondary">
                  {t("servers.add", "Add server")}
                </LinkButton>
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label={t("editor.server", "Host server")}
                value={serverId}
                items={Object.fromEntries(activeServers.map((s) => [s.id, s.name]))}
                onValueChange={(next: string | null) => {
                  if (next) setServerId(next);
                }}
              />
              <Select
                label={t("editor.core", "Server runtime core")}
                value={core}
                items={coreNames}
                onValueChange={(next: Core | null) => {
                  if (next) setCore(next);
                }}
              />
            </div>
          )}
          <Textarea
            label={t("editor.customServerConfig", "Server configuration JSON")}
            value={customServerJson}
            rows={7}
            dir="ltr"
            onChange={(e) => setCustomServerJson(e.target.value)}
          />
          <Textarea
            label={t("editor.nativeOverrides", "Native client overrides JSON (xray / sing-box / mihomo)")}
            value={nativeOverridesJson}
            rows={6}
            dir="ltr"
            placeholder={'{\n  "sing-box": { "section": "outbound", "config": { "type": "vless", ... } }\n}'}
            onChange={(e) => setNativeOverridesJson(e.target.value)}
          />
        </>
      )}

      {/* Billing multiplier, sorting & visibility */}
      <div className="grid gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Input
            label={t("editor.rate", "Traffic multiplier")}
            type="number"
            min={0}
            max={100}
            step="0.1"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
          <div className="flex flex-wrap gap-1">
            {RATE_PRESETS.map((presetRate) => (
              <Button
                key={presetRate}
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => setRate(presetRate)}
              >
                {presetRate}x
              </Button>
            ))}
          </div>
        </div>
        <Input
          label={t("editor.sortOrder", "Sort order")}
          type="number"
          step={1}
          value={sortOrder}
          description={t("editor.sortOrderHelp", "Lower numbers appear first in subscriptions.")}
          onChange={(e) => setSortOrder(e.target.value)}
        />
        <Select
          label={t("editor.visibility", "Visibility")}
          value={visibility}
          items={{
            all: t("visibility.all", "All subscribers"),
            roles: t("visibility.roles", "Specific roles"),
          }}
          onValueChange={(next: NodeVisibility | null) => {
            if (next) setVisibility(next);
          }}
        />
      </div>

      {visibility === "roles" && (
        <div className="flex flex-col gap-2 rounded-lg border border-kumo-line p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-kumo-strong">
              {t("editor.visibleRoles", "Allowed roles")}
            </span>
            <Chip tone="blue">{t("editor.adminsAlwaysSee", "Administrators always have access")}</Chip>
          </div>
          <div className="flex flex-wrap gap-3">
            {selectableRoles.map((role) => (
              <Checkbox
                key={role.id}
                label={role.name}
                checked={roleIds.includes(role.id)}
                onCheckedChange={(checked) =>
                  setRoleIds((prev) =>
                    checked ? Array.from(new Set([...prev, role.id])) : prev.filter((id) => id !== role.id),
                  )
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* Runtime & publication switches */}
      <div className="flex flex-wrap gap-5">
        <Switch
          label={t("editor.showSwitch", "Show in subscriptions")}
          checked={show}
          onCheckedChange={setShow}
        />
        {(mode === "managed" || mode === "custom") && (
          <Switch
            label={t("editor.enabledSwitch", "Run on server")}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        )}
      </div>

      {/* Collapsible Advanced Options */}
      {mode !== "custom" && (
        <Collapsible.Root>
          <Collapsible.Trigger className="text-xs font-medium text-kumo-subtle hover:text-kumo-strong">
            {t("editor.advanced", "Advanced options (TLS fingerprint, ALPN, listen port, metering, native overrides)")}
          </Collapsible.Trigger>
          <Collapsible.Panel className="node-optional">
            {(mode === "managed" || mode === "external") && showTlsParams && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label={t("wizard.fingerprint", "TLS fingerprint")}
                  value={tlsFingerprint}
                  items={{ "": t("editor.fingerprintDefault", "Client default"), ...FINGERPRINTS }}
                  onValueChange={(next: string | null) => setTlsFingerprint((next ?? "") as "" | Fingerprint)}
                />
                {mode === "external" && (
                  <Input
                    label={t("editor.alpn", "ALPN (comma separated, optional)")}
                    value={alpnText}
                    dir="ltr"
                    placeholder="h2, http/1.1"
                    onChange={(e) => setAlpnText(e.target.value)}
                  />
                )}
                <div className="sm:mt-8">
                  <Switch
                    label={t("editor.allowInsecure", "Allow insecure TLS certificate (self-signed)")}
                    checked={allowInsecure}
                    onCheckedChange={setAllowInsecure}
                  />
                </div>
              </div>
            )}
            {mode === "managed" && (
              <div className="flex flex-col gap-3">
                <Switch
                  label={t("wizard.customListenPort", "Use a different server listen port (e.g. behind CDN or NAT)")}
                  checked={customListen}
                  onCheckedChange={setCustomListen}
                />
                {customListen && (
                  <Input
                    label={t("wizard.listenPort", "Server listen port")}
                    type="number"
                    min={1}
                    max={65535}
                    value={listenPort}
                    onChange={(e) => setListenPort(e.target.value)}
                  />
                )}
                <Switch
                  label={t("editor.autoMeter", "Enable automatic per-user traffic metering")}
                  checked={meterEnabled}
                  onCheckedChange={setMeterEnabled}
                />
              </div>
            )}
            <Textarea
              label={t("editor.nativeOverrides", "Native client overrides JSON (xray / sing-box / mihomo)")}
              value={nativeOverridesJson}
              rows={4}
              dir="ltr"
              placeholder={t("editor.nativeOverridesPlaceholder", "Optional JSON map keyed by xray, sing-box, or mihomo")}
              onChange={(e) => setNativeOverridesJson(e.target.value)}
            />
          </Collapsible.Panel>
        </Collapsible.Root>
      )}

      <Banner error={validationError ? new Error(validationError) : save.error || installCore.error} />

      <FormActions
        onClose={onClose}
        pending={save.isPending}
        label={existing ? t("editor.save", "Save node") : t("editor.create", "Create node")}
      />
    </form>
  );
}
