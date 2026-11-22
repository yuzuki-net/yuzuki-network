import type { RoleSummary } from "../session/model";

export const root = "/api/v1/admin";
export const serversPath = `${root}/servers`;
export const nodesPath = `${root}/nodes`;

export const coreNames = { xray: "xray-core", "sing-box": "sing-box", mihomo: "mihomo" } as const;
export type Core = keyof typeof coreNames;
export const allCores: readonly Core[] = ["xray", "sing-box", "mihomo"];
export type CoreSource = "managed" | "configured" | "system";
export type Formats = [boolean, boolean, boolean, boolean];

export type Capability = { core: Core; version: string; source?: CoreSource; path?: string | null };
export type HostInfo = { os: string; arch: string; core_management: boolean };
export type InstanceState = "running" | "stopped" | "failed" | "missing_core";
export type RuntimeStatus = {
  instance_id: string;
  running: boolean;
  state?: InstanceState;
  error?: string | null;
};

export type Server = {
  id: string;
  name: string;
  remark: string;
  default_host: string | null;
  last_seen_at: string | null;
  applied_revision: string | null;
  deployment_error: string | null;
  enrollment_expires_at: string | null;
  agent_session: boolean;
  capabilities: Capability[];
  runtime_status: RuntimeStatus[] | null;
  host_info?: HostInfo | null;
  config_warnings: string[];
  created_at: string;
  deleted_at: string | null;
  location: string | null;
  node_count: number;
  enabled_node_count: number;
};

export type ServerInput = {
  name: string;
  remark: string;
  default_host: string | null;
};

export type CoreCatalogItem = {
  core: Core;
  recommended_version: string;
  listener_protocols: string[];
};
export type CoreCatalog = { cores: CoreCatalogItem[] };
export type CoreTask = {
  id: string;
  server_id: string;
  core: Core | null;
  action: "install" | "remove" | "probe";
  target_version: string | null;
  download_url: string | null;
  stage: string;
  status: "pending" | "running" | "succeeded" | "failed";
  message: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export const protocols = {
  vless: "VLESS",
  vmess: "VMess",
  trojan: "Trojan",
  hysteria2: "Hysteria2",
  tuic: "TUIC v5",
  anytls: "AnyTLS",
  shadowsocks: "Shadowsocks",
  shadowsocks2022: "Shadowsocks 2022",
  wireguard: "WireGuard",
  hysteria: "Hysteria v1",
  naive: "NaiveProxy",
  socks5: "SOCKS5",
  http: "HTTP",
} as const;
export type Protocol = keyof typeof protocols;

export type NodeMode = "managed" | "relay" | "external" | "custom";
export type NodeVisibility = "all" | "roles";
export type XhttpMode = "auto" | "packet-up" | "stream-up" | "stream-one";

export type Network =
  | {
      kind: "ws";
      path: string;
      host?: string | null;
      max_early_data?: number | null;
      early_data_header_name?: string | null;
    }
  | { kind: "http_upgrade"; path: string; host?: string | null }
  | { kind: "grpc"; service_name: string; multi_mode?: boolean }
  | { kind: "xhttp"; path: string; host?: string | null; mode?: XhttpMode | null };

export type Fingerprint =
  | "chrome"
  | "firefox"
  | "safari"
  | "edge"
  | "ios"
  | "android"
  | "random"
  | "randomized";

export type ManagedReality = {
  private_key: string;
  public_key: string;
  short_id: string;
  fingerprint: Fingerprint;
  handshake_server?: string | null;
  handshake_port?: number | null;
  spider_x?: string | null;
};

export type Reality = {
  public_key: string;
  short_id: string;
  fingerprint?: Fingerprint;
  spider_x?: string | null;
};

export const shadowsocks2022Ciphers = {
  "2022-blake3-aes-128-gcm": "AES-128-GCM",
  "2022-blake3-aes-256-gcm": "AES-256-GCM",
  "2022-blake3-chacha20-poly1305": "ChaCha20-Poly1305",
} as const;
export type Shadowsocks2022Cipher = keyof typeof shadowsocks2022Ciphers;

export type ProtocolOptions =
  | {
      kind: "hysteria2";
      obfs_password?: string | null;
      up_mbps?: number | null;
      down_mbps?: number | null;
      ports?: string | null;
      pin_sha256?: string | null;
      ignore_client_bandwidth?: boolean;
    }
  | { kind: "hysteria"; obfs_password?: string; up_mbps: number; down_mbps: number }
  | {
      kind: "tuic";
      congestion_control?: string | null;
      udp_relay_mode?: string | null;
      zero_rtt_handshake?: boolean;
      heartbeat?: string | null;
    }
  | { kind: "shadowsocks2022"; cipher: Shadowsocks2022Cipher; server_key: string }
  | {
      kind: "wire_guard";
      private_key: string;
      peer_public_key: string;
      preshared_key?: string | null;
      local_address: string[];
      reserved?: [number, number, number] | null;
      mtu?: number | null;
    };

export type ManagedProtocolConfig = {
  protocol: Protocol;
  listen_host?: string | null;
  server_name?: string | null;
  certificate?: string | null;
  key?: string | null;
  method?: string | null;
  network?: Network | null;
  reality?: ManagedReality | null;
  flow?: "xtls-rprx-vision" | null;
  alpn?: string[] | null;
  fingerprint?: Fingerprint | null;
  allow_insecure?: boolean;
  credential?: string | null;
  username?: string | null;
  options?: ProtocolOptions | null;
};

export type ExternalProtocolConfig = {
  protocol: Protocol;
  server_name?: string | null;
  method?: string | null;
  network?: Network | null;
  reality?: Reality | null;
  flow?: "xtls-rprx-vision" | null;
  alpn?: string[] | null;
  fingerprint?: Fingerprint | null;
  allow_insecure?: boolean;
  credential?: string | null;
  username?: string | null;
  options?: ProtocolOptions | null;
};

export type NativeEndpoint = { section: "outbound" | "endpoint"; config: unknown };
export type Meter =
  | { kind: "user_stats"; addr: string }
  | { kind: "dedicated_traffic"; addr: string; access_id: string; secret: string };

export type ProxyNode = {
  id: string;
  name: string;
  mode: NodeMode;
  server_id: string | null;
  server_name: string | null;
  server_online: boolean;
  parent_id: string | null;
  parent_name: string | null;
  relay_count: number;
  core: Core | null;
  enabled: boolean;
  show: boolean;
  sort_order: number;
  rate: number;
  effective_rate: number;
  tags: string[];
  visibility: NodeVisibility;
  roles: RoleSummary[];
  protocol: Protocol | null;
  host: string;
  port: number | null;
  listen_port: number | null;
  formats: Formats;
  meter_enabled: boolean;
  meter_port: number | null;
  protocol_config?: ManagedProtocolConfig | ExternalProtocolConfig | null;
  meter_config?: Meter | null;
  native_server_config?: unknown;
  native_client_overrides?: Partial<Record<Core, NativeEndpoint>> | null;
  runtime_state: string;
  runtime_error: string | null;
  online_sources: number;
  uploaded: string;
  downloaded: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ProxyNodeInput = {
  name: string;
  mode: NodeMode;
  server_id?: string | null;
  parent_id?: string | null;
  core?: Core | null;
  enabled: boolean;
  show: boolean;
  sort_order: number;
  rate: number;
  tags: string[];
  visibility: NodeVisibility;
  role_ids: string[];
  protocol?: Protocol | null;
  host: string;
  port?: number | null;
  listen_port?: number | null;
  protocol_config?: ManagedProtocolConfig | ExternalProtocolConfig | null;
  meter_enabled: boolean;
  meter_config?: Meter | null;
  native_server_config?: unknown;
  native_client_overrides?: Partial<Record<Core, NativeEndpoint>>;
};

export type ProxyNodePatch = {
  show?: boolean;
  enabled?: boolean;
  sort_order?: number;
  rate?: number;
};

export type PresetId =
  | "vless-reality"
  | "vless-reality-xhttp"
  | "vless-ws"
  | "hysteria2"
  | "tuic"
  | "anytls"
  | "trojan-tls"
  | "ss2022"
  | "vmess-ws";

export type ProtocolPreset = {
  id: PresetId;
  name: string;
  badge?: string;
  summary: string;
  protocol: Protocol;
  serverCores: Core[];
  defaultCore: Core;
  defaultPort: number;
  needsCert: boolean;
  isReality?: boolean;
  network?: "tcp" | "ws" | "grpc" | "http_upgrade" | "xhttp";
  vision?: boolean;
};

export const PROTOCOL_PRESETS: readonly ProtocolPreset[] = [
  {
    id: "vless-reality",
    name: "VLESS + REALITY + Vision",
    badge: "Recommended",
    summary: "Direct anti-censorship connection. No TLS certificate needed.",
    protocol: "vless",
    serverCores: ["xray", "sing-box"],
    defaultCore: "xray",
    defaultPort: 443,
    needsCert: false,
    isReality: true,
    network: "tcp",
    vision: true,
  },
  {
    id: "vless-reality-xhttp",
    name: "VLESS + REALITY + XHTTP",
    badge: "Xray SplitHTTP",
    summary: "Next-gen Xray SplitHTTP transport with REALITY stealth & CDN friendliness.",
    protocol: "vless",
    serverCores: ["xray"],
    defaultCore: "xray",
    defaultPort: 443,
    needsCert: false,
    isReality: true,
    network: "xhttp",
  },
  {
    id: "vless-ws",
    name: "VLESS + WebSocket / gRPC + TLS",
    badge: "CDN ready",
    summary: "Ideal behind Cloudflare or reverse proxies with WS, HTTPUpgrade, or gRPC.",
    protocol: "vless",
    serverCores: ["xray", "sing-box", "mihomo"],
    defaultCore: "sing-box",
    defaultPort: 443,
    needsCert: true,
    network: "ws",
  },
  {
    id: "hysteria2",
    name: "Hysteria2",
    badge: "High speed",
    summary: "QUIC/UDP protocol with bandwidth control, Salamander obfs & port hopping.",
    protocol: "hysteria2",
    serverCores: ["sing-box", "xray", "mihomo"],
    defaultCore: "sing-box",
    defaultPort: 443,
    needsCert: true,
  },
  {
    id: "tuic",
    name: "TUIC v5",
    summary: "Low-latency multiplexed QUIC proxy with BBR & 0-RTT handshake.",
    protocol: "tuic",
    serverCores: ["sing-box", "mihomo"],
    defaultCore: "sing-box",
    defaultPort: 443,
    needsCert: true,
  },
  {
    id: "anytls",
    name: "AnyTLS",
    summary: "Lightweight TLS-padded transport resisting fingerprint analysis.",
    protocol: "anytls",
    serverCores: ["sing-box", "mihomo"],
    defaultCore: "sing-box",
    defaultPort: 443,
    needsCert: true,
  },
  {
    id: "trojan-tls",
    name: "Trojan + TLS",
    summary: "Classic HTTPS-like encrypted tunnel supporting TCP, WS, and gRPC.",
    protocol: "trojan",
    serverCores: ["sing-box", "xray", "mihomo"],
    defaultCore: "sing-box",
    defaultPort: 443,
    needsCert: true,
    network: "tcp",
  },
  {
    id: "ss2022",
    name: "Shadowsocks 2022",
    summary: "Ultra-low CPU overhead. No domain or TLS certificate needed.",
    protocol: "shadowsocks2022",
    serverCores: ["sing-box", "xray", "mihomo"],
    defaultCore: "sing-box",
    defaultPort: 8388,
    needsCert: false,
  },
  {
    id: "vmess-ws",
    name: "VMess + WebSocket + TLS",
    summary: "Broad compatibility with legacy clients and CDN relays.",
    protocol: "vmess",
    serverCores: ["xray", "sing-box", "mihomo"],
    defaultCore: "xray",
    defaultPort: 443,
    needsCert: true,
    network: "ws",
  },
];

export const supportsTransport = (protocol: Protocol) =>
  protocol === "vless" || protocol === "vmess" || protocol === "trojan";

export const requiresTls = (protocol: Protocol) =>
  ["trojan", "hysteria2", "hysteria", "tuic", "anytls", "naive"].includes(protocol);

export function portableTargets(
  protocol: Protocol,
  serverName = "",
  networkKind?: string,
): Core[] {
  if (networkKind === "xhttp") return ["xray"];
  if (protocol === "naive") return ["sing-box"];
  if (protocol === "hysteria" || protocol === "tuic" || protocol === "anytls") return ["sing-box", "mihomo"];
  if (protocol === "socks5" && serverName) return ["xray", "mihomo"];
  return ["xray", "sing-box", "mihomo"];
}

export function pickBestCore(preset: ProtocolPreset, capabilities: readonly { core: Core }[]): Core {
  for (const preferred of preset.serverCores) {
    if (capabilities.some((cap) => cap.core === preferred)) return preferred;
  }
  return preset.defaultCore;
}

export function detectPreset(node?: ProxyNode | null): ProtocolPreset {
  if (!node || !node.protocol) return PROTOCOL_PRESETS[0];
  const cfg = node.protocol_config as ManagedProtocolConfig | undefined;
  if (node.protocol === "vless" && cfg?.reality) {
    if (cfg.network?.kind === "xhttp") {
      return PROTOCOL_PRESETS.find((p) => p.id === "vless-reality-xhttp") ?? PROTOCOL_PRESETS[0];
    }
    return PROTOCOL_PRESETS[0];
  }
  if (node.protocol === "vless") {
    return PROTOCOL_PRESETS.find((p) => p.id === "vless-ws") ?? PROTOCOL_PRESETS[2];
  }
  const match = PROTOCOL_PRESETS.find((p) => p.protocol === node.protocol);
  return match ?? PROTOCOL_PRESETS[0];
}

export function serverKey(cipher: Shadowsocks2022Cipher) {
  const length = cipher === "2022-blake3-aes-128-gcm" ? 16 : 32;
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(length))));
}

export function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function generateRealityKeypair(): Promise<{ privateKey: string; publicKey: string } | null> {
  try {
    const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const pubJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    if (privJwk.d && pubJwk.x) {
      return { privateKey: privJwk.d, publicKey: pubJwk.x };
    }
  } catch {
    /* WebCrypto X25519 unsupported in this environment */
  }
  return null;
}

export function isServerOnline(server: Server, now: number) {
  return server.agent_session && server.last_seen_at !== null && now - Date.parse(server.last_seen_at) <= 60_000;
}

export type ServerHealth = "error" | "waiting" | "disconnected" | "stale" | "connecting" | "stopped" | "recent";

export function serverHealth(server: Server, now: number): ServerHealth {
  if (server.deployment_error) return "error";
  if (server.last_seen_at === null) return "waiting";
  if (!server.agent_session) return "disconnected";
  if (now - Date.parse(server.last_seen_at) > 60_000) return "stale";
  if (server.runtime_status === null) return "connecting";
  if (server.runtime_status.some(({ running }) => !running)) return "stopped";
  return "recent";
}

export function serverHealthTone(state: ServerHealth): "green" | "amber" | "red" | "blue" | "neutral" {
  if (state === "recent") return "green";
  if (state === "error" || state === "stopped") return "red";
  if (state === "stale" || state === "disconnected") return "amber";
  if (state === "connecting") return "blue";
  return "neutral";
}

export type ServerTab = "overview" | "connection" | "cores";

export function serverUrl(id: string, tab: ServerTab = "overview") {
  const params = new URLSearchParams({ server: id });
  if (tab !== "overview") params.set("tab", tab);
  return `/admin/servers?${params}`;
}

export function nodeRuntimeTone(state: string): "green" | "amber" | "red" | "blue" | "neutral" {
  if (state === "running" || state === "external") return "green";
  if (state === "failed" || state === "missing_core") return "red";
  if (state === "stopped" || state === "offline") return "amber";
  if (state === "pending") return "blue";
  return "neutral";
}

export function nodeNeedsAttention(node: ProxyNode): boolean {
  if (node.deleted_at) return false;
  if (!node.enabled) return false;
  return ["failed", "missing_core", "stopped", "offline"].includes(node.runtime_state);
}

export function formatRate(rate: number): string {
  const rounded = Math.round(rate * 100) / 100;
  return `${Number.isInteger(rounded) ? `${rounded}.0` : rounded}x`;
}

export function coreVersion(report: string, unknown: string) {
  return report.match(/\bv?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1] ?? (report || unknown);
}

export function compareSemver(installed: string, recommended: string): "current" | "outdated" | "unknown" {
  const a = installed.match(/(\d+)\.(\d+)\.(\d+)/);
  const b = recommended.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!a || !b) return "unknown";
  for (let i = 1; i <= 3; i += 1) {
    const left = Number(a[i]);
    const right = Number(b[i]);
    if (left < right) return "outdated";
    if (left > right) return "current";
  }
  return "current";
}
