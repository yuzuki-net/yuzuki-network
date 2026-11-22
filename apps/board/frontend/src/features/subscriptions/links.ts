import type { CountTuple, QuotaStatus } from "../quotas/model";

export const subscriptionsUrl = "/api/v1/me/subscriptions";
export const provisionSubscriptionsUrl = "/api/v1/me/subscriptions/provision";
export const subscriptionDevicesUrl = "/api/v1/me/subscription-devices";
export const subscriberNodesUrl = "/api/v1/me/nodes";

export type SubscriberNode = {
  id: string;
  name: string;
  location: string | null;
  online: boolean;
  rate: number;
  tags: string[];
  protocols: string[];
  formats: [boolean, boolean, boolean, boolean];
};

export const formats = [
  { key: "xray", code: 0, name: "xray-core", type: "JSON", clients: "v2rayN, v2rayNG, Nekoray" },
  { key: "sing-box", code: 1, name: "sing-box", type: "JSON", clients: "sing-box, Hiddify, Karing" },
  { key: "mihomo", code: 2, name: "mihomo", type: "YAML", clients: "Clash Verge, Mihomo Party, FlClash, Stash" },
  { key: "universal", code: 3, name: "Universal", type: "URI", clients: "Shadowrocket, v2rayNG, v2rayN, Loon, Karing" },
] as const;

export type FormatCode = (typeof formats)[number]["code"];
export type SubscriptionLink = {
  id: string;
  name: string;
  format: FormatCode;
  path: string;
  created_at: string;
  last_used_at: string | null;
  within_limit: boolean;
};

export type SubscriptionSnapshot = {
  links: SubscriptionLink[];
  effective_link_limits: CountTuple;
  endpoints: CountTuple;
  requires_proxy: boolean;
  quota: QuotaStatus;
};

export type SubscriptionDevice = {
  id: string;
  client_name: string;
  first_seen_at: string;
  last_seen_at: string;
};
export type SubscriptionDevices = { active_for_days: number; items: SubscriptionDevice[] };

export function absoluteLink(path: string, customBaseUrl?: string | null) {
  const base = customBaseUrl?.trim();
  if (base) {
    const cleanBase = base.replace(/\/+$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    return `${cleanBase}${cleanPath}`;
  }
  return new URL(path, location.origin).href;
}

export function countLinks(current: SubscriptionSnapshot): CountTuple {
  const counts: CountTuple = [0, 0, 0, 0];
  for (const link of current.links) counts[link.format] += 1;
  return counts;
}
