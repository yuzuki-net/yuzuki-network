import { describe, expect, test } from "bun:test";
import {
  allCores,
  compareSemver,
  formatRate,
  isServerOnline,
  nodeNeedsAttention,
  pickBestCore,
  PROTOCOL_PRESETS,
  serverUrl,
  type ProxyNode,
  type Server,
} from "../../../src/features/nodes/model";

const baseServer: Server = {
  id: "server-1",
  name: "ZeroCore",
  remark: "",
  default_host: "jp.example.com",
  last_seen_at: "2026-11-21T18:00:00Z",
  applied_revision: null,
  deployment_error: null,
  enrollment_expires_at: null,
  agent_session: true,
  capabilities: [],
  runtime_status: [],
  host_info: { os: "linux", arch: "amd64", core_management: true },
  config_warnings: [],
  created_at: "2026-11-21T17:00:00Z",
  deleted_at: null,
  location: null,
  node_count: 0,
  enabled_node_count: 0,
};

const baseNode: ProxyNode = {
  id: "node-1",
  name: "Tokyo REALITY",
  mode: "managed",
  server_id: "server-1",
  server_name: "ZeroCore",
  server_online: true,
  parent_id: null,
  parent_name: null,
  relay_count: 0,
  core: "xray",
  enabled: true,
  show: true,
  sort_order: 0,
  rate: 1.0,
  effective_rate: 1.0,
  tags: ["IEPL"],
  visibility: "all",
  roles: [],
  protocol: "vless",
  host: "jp.example.com",
  port: 443,
  listen_port: 443,
  formats: [true, true, true, true],
  meter_enabled: true,
  meter_port: 20001,
  runtime_state: "running",
  runtime_error: null,
  online_sources: 0,
  uploaded: "0",
  downloaded: "0",
  created_at: "2026-11-21T17:00:00Z",
  updated_at: "2026-11-21T17:00:00Z",
  deleted_at: null,
};

describe("server & proxy node helpers", () => {
  test("lists all three supported server cores", () => {
    expect(allCores).toEqual(["xray", "sing-box", "mihomo"]);
  });

  test("detects online servers within the 60s heartbeat window", () => {
    const now = Date.parse("2026-11-21T18:00:30Z");
    expect(isServerOnline(baseServer, now)).toBe(true);
    expect(isServerOnline({ ...baseServer, agent_session: false }, now)).toBe(false);
    expect(isServerOnline(baseServer, Date.parse("2026-11-21T18:02:00Z"))).toBe(false);
    expect(isServerOnline({ ...baseServer, last_seen_at: null }, now)).toBe(false);
  });

  test("compares installed and baseline semantic versions", () => {
    expect(compareSemver("26.11.9", "26.11.9")).toBe("current");
    expect(compareSemver("26.12.0", "26.11.9")).toBe("current");
    expect(compareSemver("1.13.9", "1.14.4")).toBe("outdated");
    expect(compareSemver("unknown", "1.14.4")).toBe("unknown");
  });

  test("builds server URL for cores tab", () => {
    expect(serverUrl("server-1", "cores")).toBe("/admin/servers?server=server-1&tab=cores");
    expect(serverUrl("server-1")).toBe("/admin/servers?server=server-1");
  });

  test("picks best installed core for protocol presets", () => {
    const vlessReality = PROTOCOL_PRESETS.find((p) => p.id === "vless-reality")!;
    expect(pickBestCore(vlessReality, [{ core: "sing-box" }])).toBe("sing-box");
    expect(pickBestCore(vlessReality, [{ core: "xray" }, { core: "sing-box" }])).toBe("xray");
    expect(pickBestCore(vlessReality, [])).toBe("xray");
  });

  test("formats traffic rates and detects attention states", () => {
    expect(formatRate(1)).toBe("1.0x");
    expect(formatRate(0.5)).toBe("0.5x");
    expect(formatRate(2.5)).toBe("2.5x");
    expect(nodeNeedsAttention(baseNode)).toBe(false);
    expect(nodeNeedsAttention({ ...baseNode, runtime_state: "failed" })).toBe(true);
    expect(nodeNeedsAttention({ ...baseNode, runtime_state: "failed", enabled: false })).toBe(false);
    expect(nodeNeedsAttention({ ...baseNode, runtime_state: "failed", deleted_at: "2026-11-21T19:00:00Z" })).toBe(false);
  });
});
