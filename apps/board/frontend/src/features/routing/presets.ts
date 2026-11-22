import type { Core } from "../nodes/model";
import type { Action, MatchKind, RouteGroup, Rule, RuleSet } from "./model";

export type RulePack = {
  id: string;
  label: string;
  description: string;
  action: Action;
  rules: Rule[];
};

export type ScenarioPreset = {
  id: string;
  name: string;
  badge?: string;
  description: string;
  defaultAction: Action;
  defaultGroupId?: string | null;
  groups: RouteGroup[];
  ruleSets: RuleSet[];
  rules: Rule[];
  native: Partial<Record<Core, Record<string, unknown>>>;
};

export const RULE_PACKS: readonly RulePack[] = [
  {
    id: "private-lan",
    label: "Private & LAN direct (GeoIP + CIDR)",
    description: "GeoIP/GeoSite private plus RFC1918 & IPv6 ULA ranges",
    action: "direct",
    rules: [
      { kind: "geoip", action: "direct", value: "private" },
      { kind: "geosite", action: "direct", value: "private" },
      { kind: "ip_cidr", action: "direct", value: "10.0.0.0/8" },
      { kind: "ip_cidr", action: "direct", value: "172.16.0.0/12" },
      { kind: "ip_cidr", action: "direct", value: "192.168.0.0/16" },
      { kind: "ip_cidr", action: "direct", value: "127.0.0.0/8" },
      { kind: "ip_cidr", action: "direct", value: "fc00::/7" },
    ],
  },
  {
    id: "cn-geo",
    label: "Mainland China direct (GeoSite + GeoIP)",
    description: "Auto-compiles to geosite:cn / geoip:cn (Xray & Mihomo) and SRS rule-sets (sing-box)",
    action: "direct",
    rules: [
      { kind: "geosite", action: "direct", value: "cn" },
      { kind: "geoip", action: "direct", value: "cn" },
    ],
  },
  {
    id: "ai-services",
    label: "AI services proxy",
    description: "OpenAI / ChatGPT, Claude, Gemini, Perplexity, Cursor, Copilot",
    action: "proxy",
    rules: [
      { kind: "geosite", action: "proxy", value: "openai" },
      { kind: "geosite", action: "proxy", value: "anthropic" },
      { kind: "domain_suffix", action: "proxy", value: "chatgpt.com" },
      { kind: "domain_suffix", action: "proxy", value: "claude.ai" },
      { kind: "domain_suffix", action: "proxy", value: "gemini.google.com" },
      { kind: "domain_suffix", action: "proxy", value: "generativelanguage.googleapis.com" },
      { kind: "domain_suffix", action: "proxy", value: "perplexity.ai" },
      { kind: "domain_suffix", action: "proxy", value: "cursor.sh" },
      { kind: "domain_suffix", action: "proxy", value: "x.ai" },
    ],
  },
  {
    id: "streaming",
    label: "Global streaming media proxy",
    description: "YouTube, Netflix, Disney+, Spotify, Twitch, TikTok",
    action: "proxy",
    rules: [
      { kind: "geosite", action: "proxy", value: "youtube" },
      { kind: "geosite", action: "proxy", value: "netflix" },
      { kind: "geosite", action: "proxy", value: "disney" },
      { kind: "geosite", action: "proxy", value: "spotify" },
      { kind: "domain_suffix", action: "proxy", value: "twitch.tv" },
      { kind: "domain_suffix", action: "proxy", value: "tiktok.com" },
    ],
  },
  {
    id: "im-dev",
    label: "IM & developer ecosystem proxy",
    description: "Telegram, Discord, GitHub, Docker, npm, PyPI, HuggingFace",
    action: "proxy",
    rules: [
      { kind: "geosite", action: "proxy", value: "telegram" },
      { kind: "geoip", action: "proxy", value: "telegram" },
      { kind: "geosite", action: "proxy", value: "github" },
      { kind: "domain_suffix", action: "proxy", value: "discord.com" },
      { kind: "domain_suffix", action: "proxy", value: "docker.io" },
      { kind: "domain_suffix", action: "proxy", value: "npmjs.org" },
      { kind: "domain_suffix", action: "proxy", value: "pypi.org" },
      { kind: "domain_suffix", action: "proxy", value: "huggingface.co" },
    ],
  },
  {
    id: "common-ads",
    label: "Ad & tracker block (GeoSite)",
    description: "Blocks geosite:category-ads-all plus common ad networks",
    action: "block",
    rules: [
      { kind: "geosite", action: "block", value: "category-ads-all" },
      { kind: "domain_suffix", action: "block", value: "doubleclick.net" },
      { kind: "domain_suffix", action: "block", value: "googlesyndication.com" },
    ],
  },
  {
    id: "cn-direct",
    label: "Mainland China common domains direct",
    description: ".cn, WeChat, QQ, Taobao, JD, Alipay, Baidu, Bilibili, Douyin",
    action: "direct",
    rules: [
      { kind: "domain_suffix", action: "direct", value: "cn" },
      { kind: "domain_suffix", action: "direct", value: "qq.com" },
      { kind: "domain_suffix", action: "direct", value: "weixin.qq.com" },
      { kind: "domain_suffix", action: "direct", value: "taobao.com" },
      { kind: "domain_suffix", action: "direct", value: "jd.com" },
      { kind: "domain_suffix", action: "direct", value: "alipay.com" },
      { kind: "domain_suffix", action: "direct", value: "baidu.com" },
      { kind: "domain_suffix", action: "direct", value: "bilibili.com" },
      { kind: "domain_suffix", action: "direct", value: "douyin.com" },
    ],
  },
  {
    id: "apple-ms",
    label: "Apple & Microsoft CDN direct",
    description: "iCloud CN, App Store CDN, Windows Update, connectivity check",
    action: "direct",
    rules: [
      { kind: "geosite", action: "direct", value: "apple-cn" },
      { kind: "domain_suffix", action: "direct", value: "icloud.com.cn" },
      { kind: "domain_suffix", action: "direct", value: "windowsupdate.com" },
      { kind: "domain_suffix", action: "direct", value: "msftconnecttest.com" },
    ],
  },
];

function packRules(id: string): Rule[] {
  return RULE_PACKS.find((p) => p.id === id)?.rules ?? [];
}

export const SCENARIO_PRESETS: readonly ScenarioPreset[] = [
  {
    id: "bypass-cn-lan",
    name: "Bypass China & LAN",
    badge: "Recommended",
    description:
      "Direct for private/LAN and Mainland China via first-class GeoIP & GeoSite rules (compiled natively for Xray, sing-box SRS, and Mihomo), with an Auto Select latency group.",
    defaultAction: "proxy",
    groups: [
      {
        id: "auto",
        name: "⚡ Auto Select",
        kind: "url_test",
        interval_secs: 300,
      },
    ],
    ruleSets: [],
    rules: [
      { kind: "geoip", action: "direct", value: "private" },
      { kind: "geosite", action: "direct", value: "private" },
      { kind: "geosite", action: "direct", value: "cn" },
      { kind: "geoip", action: "direct", value: "cn" },
    ],
    native: {
      mihomo: {
        sniffer: {
          enable: true,
          sniff: { TLS: { ports: [443, 8443] }, HTTP: { ports: [80, "8080-8880"] } },
        },
      },
      "sing-box": {
        route: { auto_detect_interface: true },
      },
    },
  },
  {
    id: "bypass-cn-ads-ai",
    name: "Bypass CN + AdBlock + AI & Media Groups",
    badge: "All-in-one",
    description:
      "Creates dedicated AI Services, Streaming Media, and Auto Select policy groups; blocks ads, routes AI & streaming to their own groups, and bypasses LAN & Mainland China.",
    defaultAction: "proxy",
    groups: [
      {
        id: "auto",
        name: "⚡ Auto Select",
        kind: "url_test",
        interval_secs: 300,
      },
      {
        id: "ai",
        name: "🤖 AI Services",
        kind: "select",
        node_filter: "US|JP|SG|TW|美国|日本|新加坡",
        include_auto: true,
      },
      {
        id: "streaming",
        name: "🎬 Streaming Media",
        kind: "select",
        include_auto: true,
      },
    ],
    ruleSets: [],
    rules: [
      { kind: "geosite", action: "block", value: "category-ads-all" },
      { kind: "geosite", action: "group", group_id: "ai", value: "openai" },
      { kind: "geosite", action: "group", group_id: "ai", value: "anthropic" },
      { kind: "domain_suffix", action: "group", group_id: "ai", value: "chatgpt.com" },
      { kind: "domain_suffix", action: "group", group_id: "ai", value: "claude.ai" },
      { kind: "domain_suffix", action: "group", group_id: "ai", value: "gemini.google.com" },
      { kind: "geosite", action: "group", group_id: "streaming", value: "youtube" },
      { kind: "geosite", action: "group", group_id: "streaming", value: "netflix" },
      { kind: "geosite", action: "group", group_id: "streaming", value: "disney" },
      { kind: "geoip", action: "direct", value: "private" },
      { kind: "geosite", action: "direct", value: "private" },
      { kind: "geosite", action: "direct", value: "cn" },
      { kind: "geoip", action: "direct", value: "cn" },
    ],
    native: {
      mihomo: {
        sniffer: {
          enable: true,
          sniff: { TLS: { ports: [443, 8443] }, HTTP: { ports: [80, "8080-8880"] } },
        },
      },
      "sing-box": {
        route: { auto_detect_interface: true },
      },
    },
  },
  {
    id: "global-proxy",
    name: "Global proxy (LAN direct)",
    description: "Route all internet traffic through proxy nodes while keeping private/LAN addresses direct.",
    defaultAction: "proxy",
    groups: [
      {
        id: "auto",
        name: "⚡ Auto Select",
        kind: "url_test",
        interval_secs: 300,
      },
    ],
    ruleSets: [],
    rules: [...packRules("private-lan")],
    native: {},
  },
  {
    id: "whitelist-proxy",
    name: "Whitelist (Direct by default)",
    description: "Direct connection by default; only AI services, global streaming, IM & developer tools use proxy.",
    defaultAction: "direct",
    groups: [],
    ruleSets: [],
    rules: [
      ...packRules("common-ads"),
      ...packRules("ai-services"),
      ...packRules("streaming"),
      ...packRules("im-dev"),
    ],
    native: {},
  },
];

function mapClashAction(
  token: string | undefined,
  fallbackAction: Action,
  fallbackGroupId?: string,
  groups: readonly RouteGroup[] = [],
): { action: Action; group_id?: string } {
  if (!token) return { action: fallbackAction, ...(fallbackAction === "group" && fallbackGroupId ? { group_id: fallbackGroupId } : {}) };
  const clean = token.trim();
  const upper = clean.toUpperCase();
  if (upper === "DIRECT") return { action: "direct" };
  if (upper === "REJECT" || upper === "REJECT-DROP" || upper === "BLOCK") return { action: "block" };
  if (upper === "PROXY" || upper === "GROUP" || upper === "GLOBAL" || upper === "SELECT") return { action: "proxy" };
  const matchedGroup = groups.find(
    (g) => g.id.toLowerCase() === clean.toLowerCase() || g.name.toLowerCase() === clean.toLowerCase(),
  );
  if (matchedGroup) return { action: "group", group_id: matchedGroup.id };
  return { action: fallbackAction, ...(fallbackAction === "group" && fallbackGroupId ? { group_id: fallbackGroupId } : {}) };
}

const CLASH_KINDS: Record<string, MatchKind> = {
  DOMAIN: "domain",
  "DOMAIN-SUFFIX": "domain_suffix",
  "DOMAIN-KEYWORD": "domain_keyword",
  "IP-CIDR": "ip_cidr",
  "IP-CIDR6": "ip_cidr",
  GEOIP: "geoip",
  GEOSITE: "geosite",
  "DST-PORT": "port",
  "PROCESS-NAME": "process_name",
  "RULE-SET": "rule_set",
};

/**
 * Parses either plain newline/comma/semicolon lists, Xray prefixes (geosite:cn, geoip:cn, full:, domain:),
 * OR Clash/Mihomo rule lines such as:
 *   DOMAIN-SUFFIX,openai.com,PROXY
 *   GEOIP,CN,DIRECT,no-resolve
 *   GEOSITE,category-ads-all,REJECT
 *   DST-PORT,443,PROXY
 */
export function parseBulkRules(
  text: string,
  defaultKind: MatchKind,
  defaultAction: Action,
  defaultGroupId?: string,
  groups: readonly RouteGroup[] = [],
): Rule[] {
  const seen = new Set<string>();
  const parsed: Rule[] = [];
  const defaultTarget =
    defaultAction === "group" && defaultGroupId
      ? { action: "group" as const, group_id: defaultGroupId }
      : { action: defaultAction === "group" ? ("proxy" as const) : defaultAction };

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const stripped = trimmed.replace(/^-\s+/, "").replace(/^['"]|['"]$/g, "").trim();

    const clashMatch = stripped.match(
      /^(DOMAIN-SUFFIX|DOMAIN-KEYWORD|DOMAIN|IP-CIDR6|IP-CIDR|GEOIP|GEOSITE|DST-PORT|PROCESS-NAME|RULE-SET)\s*,\s*([^,\s]+)(?:\s*,\s*([^,]+))?/i,
    );
    if (clashMatch) {
      const kind = CLASH_KINDS[clashMatch[1].toUpperCase()];
      const value = clashMatch[2].trim();
      const targetToken = clashMatch[3]?.split(",")[0]?.trim();
      const target = mapClashAction(targetToken, defaultAction, defaultGroupId, groups);
      const dedupeKey = `${kind}:${value.toLowerCase()}`;
      if (value && !seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        parsed.push({ kind, value, ...target });
      }
      continue;
    }

    for (const part of stripped.split(/[,;]+/)) {
      const cleaned = part.trim();
      if (!cleaned || cleaned.startsWith("#")) continue;
      let kind: MatchKind = defaultKind;
      let value = cleaned;
      if (/^geosite:/i.test(cleaned)) {
        kind = "geosite";
        value = cleaned.slice(8);
      } else if (/^geoip:/i.test(cleaned)) {
        kind = "geoip";
        value = cleaned.slice(6);
      } else if (/^full:/i.test(cleaned)) {
        kind = "domain";
        value = cleaned.slice(5);
      } else if (/^domain:/i.test(cleaned)) {
        kind = "domain_suffix";
        value = cleaned.slice(7);
      } else if (/^keyword:/i.test(cleaned)) {
        kind = "domain_keyword";
        value = cleaned.slice(8);
      }
      const dedupeKey = `${kind}:${value.toLowerCase()}`;
      if (!value || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      parsed.push({ kind, value, ...defaultTarget });
    }
  }
  return parsed;
}
