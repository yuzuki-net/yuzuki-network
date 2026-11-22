export const routingUrl = "/api/v1/admin/routing";
export const actions = ["proxy", "direct", "block", "group"] as const;
export const kinds = [
  "domain",
  "domain_suffix",
  "domain_keyword",
  "ip_cidr",
  "geoip",
  "geosite",
  "port",
  "protocol",
  "process_name",
  "rule_set",
] as const;

export type Action = (typeof actions)[number];
export type MatchKind = (typeof kinds)[number];
export type GroupKind = "select" | "url_test" | "fallback" | "load_balance";
export type RuleSetBehavior = "classical" | "domain" | "ipcidr";

export type RouteGroup = {
  id: string;
  name: string;
  kind: GroupKind;
  node_filter?: string | null;
  include_direct?: boolean;
  include_reject?: boolean;
  include_auto?: boolean;
  test_url?: string | null;
  interval_secs?: number | null;
};

export type RuleSet = {
  tag: string;
  sing_box_url?: string | null;
  mihomo_url?: string | null;
  behavior: RuleSetBehavior;
  interval_secs?: number | null;
};

export type Rule = {
  kind: MatchKind;
  action: Action;
  value: string;
  group_id?: string | null;
};

export type Policy = {
  default_action: Action;
  default_group_id?: string | null;
  groups?: RouteGroup[];
  rule_sets?: RuleSet[];
  rules: Rule[];
  native?: Record<string, unknown>;
};

export type PolicyState = { revision: number; draft: Policy | null; published: Policy };

export const kindLabels: Record<MatchKind, string> = {
  domain: "Exact domain",
  domain_suffix: "Domain suffix",
  domain_keyword: "Domain keyword",
  ip_cidr: "IP CIDR range",
  geoip: "GeoIP country / private",
  geosite: "GeoSite category",
  port: "Destination port",
  protocol: "Protocol",
  process_name: "Process name",
  rule_set: "Remote rule set",
};

export const actionLabels: Record<Action, string> = {
  proxy: "Default proxy",
  direct: "Connect directly",
  block: "Block",
  group: "Policy group",
};

export const groupKindLabels: Record<GroupKind, string> = {
  select: "Manual select",
  url_test: "Auto fastest (URL test)",
  fallback: "Fallback (failover)",
  load_balance: "Load balance",
};

export function encodeTarget(action: Action, groupId?: string | null): string {
  if (action === "group" && groupId) return `group:${groupId}`;
  return action === "group" ? "proxy" : action;
}

export function decodeTarget(encoded: string): { action: Action; group_id?: string } {
  if (encoded.startsWith("group:")) {
    return { action: "group", group_id: encoded.slice(6) };
  }
  return { action: encoded as Exclude<Action, "group"> };
}
