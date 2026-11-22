import { describe, expect, test } from "bun:test";
import { compileVisualOverlay, extractVisualOverlay } from "../../../src/features/routing/native-editor";
import { parseBulkRules, RULE_PACKS, SCENARIO_PRESETS } from "../../../src/features/routing/presets";

describe("visual routing builders", () => {
  test("parses and deduplicates bulk imported rules while skipping comments", () => {
    const parsed = parseBulkRules(
      "# comment\nexample.com\nexample.com, internal.net;\ngeosite:cn\ngeoip:private\n  \nfoo.bar",
      "domain_suffix",
      "direct",
    );
    expect(parsed).toEqual([
      { kind: "domain_suffix", action: "direct", value: "example.com" },
      { kind: "domain_suffix", action: "direct", value: "internal.net" },
      { kind: "geosite", action: "direct", value: "cn" },
      { kind: "geoip", action: "direct", value: "private" },
      { kind: "domain_suffix", action: "direct", value: "foo.bar" },
    ]);
  });

  test("parses Clash / Mihomo rule syntax lines including GeoIP, GeoSite, Port, Process and Policy Groups", () => {
    const groups = [{ id: "ai", name: "AI Services", kind: "select" as const }];
    const input = [
      "# Clash rules",
      "- DOMAIN-SUFFIX,openai.com,ai",
      "DOMAIN,auth.example.com,DIRECT",
      "DOMAIN-KEYWORD,google,PROXY",
      "GEOIP,CN,DIRECT,no-resolve",
      "GEOSITE,category-ads-all,REJECT",
      "DST-PORT,443,PROXY",
      "PROCESS-NAME,qbittorrent,DIRECT",
      "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
      "- IP-CIDR6,fc00::/7,REJECT,no-resolve",
      "DOMAIN-SUFFIX,openai.com,PROXY",
    ].join("\n");
    const parsed = parseBulkRules(input, "domain_suffix", "proxy", undefined, groups);
    expect(parsed).toEqual([
      { kind: "domain_suffix", action: "group", group_id: "ai", value: "openai.com" },
      { kind: "domain", action: "direct", value: "auth.example.com" },
      { kind: "domain_keyword", action: "proxy", value: "google" },
      { kind: "geoip", action: "direct", value: "CN" },
      { kind: "geosite", action: "block", value: "category-ads-all" },
      { kind: "port", action: "proxy", value: "443" },
      { kind: "process_name", action: "direct", value: "qbittorrent" },
      { kind: "ip_cidr", action: "direct", value: "192.168.0.0/16" },
      { kind: "ip_cidr", action: "block", value: "fc00::/7" },
    ]);
  });

  test("ships valid split-routing scenarios with first-class GeoIP/GeoSite rules and policy groups", () => {
    expect(RULE_PACKS.length).toBeGreaterThanOrEqual(8);
    expect(SCENARIO_PRESETS.length).toBe(4);
    for (const scenario of SCENARIO_PRESETS) {
      expect(scenario.rules.length).toBeGreaterThan(0);
    }
    const bypass = SCENARIO_PRESETS.find((s) => s.id === "bypass-cn-lan")!;
    expect(bypass.groups.some((g) => g.id === "auto")).toBe(true);
    expect(bypass.rules.some((r) => r.kind === "geoip" && r.value === "cn")).toBe(true);
    expect(bypass.rules.some((r) => r.kind === "geosite" && r.value === "cn")).toBe(true);

    const allInOne = SCENARIO_PRESETS.find((s) => s.id === "bypass-cn-ads-ai")!;
    expect(allInOne.groups.map((g) => g.id)).toEqual(["auto", "ai", "streaming"]);
    expect(allInOne.rules.some((r) => r.action === "group" && r.group_id === "ai")).toBe(true);
  });

  test("compiles and round-trips xray visual routing overrides", () => {
    const compiled = compileVisualOverlay("xray", {
      dnsServers: ["1.1.1.1", "8.8.8.8"],
      enableSniffing: false,
      fakeIp: false,
      domainStrategy: "IPOnDemand",
      extraRules: [
        { matchType: "geosite", value: "cn", action: "direct" },
        { matchType: "protocol", value: "bittorrent", action: "block" },
      ],
      ruleProviders: [],
    });
    expect(compiled).not.toBeNull();
    const extracted = extractVisualOverlay("xray", compiled!);
    expect(extracted.dnsServers).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(extracted.domainStrategy).toBe("IPOnDemand");
    expect(extracted.extraRules).toEqual([
      { matchType: "geosite", value: "cn", action: "direct" },
      { matchType: "protocol", value: "bittorrent", action: "block" },
    ]);
  });

  test("compiles and round-trips mihomo DNS, sniffer and rule-providers", () => {
    const compiled = compileVisualOverlay("mihomo", {
      dnsServers: ["https://dns.google/dns-query"],
      enableSniffing: true,
      fakeIp: true,
      domainStrategy: "prefer_ipv4",
      extraRules: [],
      ruleProviders: [{ name: "reject", url: "https://example.net/reject.yaml", behavior: "domain", interval: 3600 }],
    });
    expect(compiled).not.toBeNull();
    const extracted = extractVisualOverlay("mihomo", compiled!);
    expect(extracted.fakeIp).toBe(true);
    expect(extracted.enableSniffing).toBe(true);
    expect(extracted.dnsServers).toEqual(["https://dns.google/dns-query"]);
    expect(extracted.ruleProviders).toEqual([
      { name: "reject", url: "https://example.net/reject.yaml", behavior: "domain", interval: 3600 },
    ]);
  });
});
