import type { ClientPreset } from "../portal/options";
import { absoluteLink, type FormatCode, type SubscriptionLink } from "./links";

export type ClientImportEntry = {
  id: ClientPreset;
  name: string;
  subtitle: string;
  formats: readonly FormatCode[];
  href: string;
};

export type PlatformId = "ios" | "android" | "windows" | "macos" | "linux";

export type PlatformClientSpec = {
  key: string;
  preset: ClientPreset;
  name: string;
  badge?: string;
  preferredFormats: readonly FormatCode[];
  build: (url: string, name: string) => string;
};

export type ResolvedPlatformClient = {
  key: string;
  preset: ClientPreset;
  name: string;
  badge?: string;
  format: FormatCode | null;
  href: string | null;
  url: string | null;
};

function toBase64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const CLIENT_CATALOG: {
  id: ClientPreset;
  name: string;
  subtitle: string;
  formats: readonly FormatCode[];
  build: (url: string, name: string) => string;
}[] = [
  {
    id: "clash",
    name: "Clash Verge / Mihomo Party",
    subtitle: "mihomo YAML",
    formats: [2],
    build: (url, name) =>
      `clash://install-config?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
  },
  {
    id: "singbox",
    name: "sing-box",
    subtitle: "sing-box JSON",
    formats: [1],
    build: (url, name) =>
      `sing-box://import-remote-profile?url=${encodeURIComponent(url)}#${encodeURIComponent(name)}`,
  },
  {
    id: "shadowrocket",
    name: "Shadowrocket",
    subtitle: "iOS / iPadOS · Universal URI / YAML",
    formats: [3, 2, 1],
    build: (url, name) =>
      `shadowrocket://add/sub://${toBase64Utf8(url)}?remark=${encodeURIComponent(name)}`,
  },
  {
    id: "v2rayn",
    name: "v2rayN / v2rayNG",
    subtitle: "Universal URI / xray-core",
    formats: [3, 0],
    build: (url, name) =>
      `v2rayng://install-sub?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
  },
  {
    id: "hiddify",
    name: "Hiddify",
    subtitle: "Cross-platform",
    formats: [1, 2, 3],
    build: (url, name) => `hiddify://import/${url}#${encodeURIComponent(name)}`,
  },
];

export const PLATFORM_CLIENTS: Record<PlatformId, readonly PlatformClientSpec[]> = {
  ios: [
    {
      key: "shadowrocket",
      preset: "shadowrocket",
      name: "Shadowrocket",
      badge: "recommended",
      preferredFormats: [3, 2, 1],
      build: (url, name) =>
        `shadowrocket://add/sub://${toBase64Utf8(url)}?remark=${encodeURIComponent(name)}`,
    },
    {
      key: "singbox-ios",
      preset: "singbox",
      name: "sing-box (SFI)",
      preferredFormats: [1],
      build: (url, name) =>
        `sing-box://import-remote-profile?url=${encodeURIComponent(url)}#${encodeURIComponent(name)}`,
    },
    {
      key: "stash",
      preset: "clash",
      name: "Stash",
      preferredFormats: [2],
      build: (url, name) =>
        `stash://install-config?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
    },
    {
      key: "hiddify-ios",
      preset: "hiddify",
      name: "Hiddify",
      preferredFormats: [1, 2, 3],
      build: (url, name) => `hiddify://import/${url}#${encodeURIComponent(name)}`,
    },
  ],
  android: [
    {
      key: "clash-android",
      preset: "clash",
      name: "Clash Meta / FlClash",
      badge: "recommended",
      preferredFormats: [2],
      build: (url, name) =>
        `clash://install-config?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
    },
    {
      key: "v2rayng",
      preset: "v2rayn",
      name: "v2rayNG",
      preferredFormats: [3, 0],
      build: (url, name) =>
        `v2rayng://install-sub?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
    },
    {
      key: "singbox-android",
      preset: "singbox",
      name: "sing-box (SFA)",
      preferredFormats: [1],
      build: (url, name) =>
        `sing-box://import-remote-profile?url=${encodeURIComponent(url)}#${encodeURIComponent(name)}`,
    },
    {
      key: "hiddify-android",
      preset: "hiddify",
      name: "Hiddify",
      preferredFormats: [1, 2, 3],
      build: (url, name) => `hiddify://import/${url}#${encodeURIComponent(name)}`,
    },
  ],
  windows: [
    {
      key: "clash-win",
      preset: "clash",
      name: "Clash Verge / Mihomo Party",
      badge: "recommended",
      preferredFormats: [2],
      build: (url, name) =>
        `clash://install-config?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
    },
    {
      key: "v2rayn-win",
      preset: "v2rayn",
      name: "v2rayN",
      preferredFormats: [3, 0],
      build: (url, name) =>
        `v2rayng://install-sub?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
    },
    {
      key: "hiddify-win",
      preset: "hiddify",
      name: "Hiddify",
      preferredFormats: [1, 2, 3],
      build: (url, name) => `hiddify://import/${url}#${encodeURIComponent(name)}`,
    },
    {
      key: "singbox-win",
      preset: "singbox",
      name: "sing-box",
      preferredFormats: [1],
      build: (url, name) =>
        `sing-box://import-remote-profile?url=${encodeURIComponent(url)}#${encodeURIComponent(name)}`,
    },
  ],
  macos: [
    {
      key: "clash-mac",
      preset: "clash",
      name: "Clash Verge / Mihomo Party",
      badge: "recommended",
      preferredFormats: [2],
      build: (url, name) =>
        `clash://install-config?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
    },
    {
      key: "singbox-mac",
      preset: "singbox",
      name: "sing-box (SFM)",
      preferredFormats: [1],
      build: (url, name) =>
        `sing-box://import-remote-profile?url=${encodeURIComponent(url)}#${encodeURIComponent(name)}`,
    },
    {
      key: "hiddify-mac",
      preset: "hiddify",
      name: "Hiddify",
      preferredFormats: [1, 2, 3],
      build: (url, name) => `hiddify://import/${url}#${encodeURIComponent(name)}`,
    },
    {
      key: "shadowrocket-mac",
      preset: "shadowrocket",
      name: "Shadowrocket (Apple Silicon)",
      preferredFormats: [3, 2, 1],
      build: (url, name) =>
        `shadowrocket://add/sub://${toBase64Utf8(url)}?remark=${encodeURIComponent(name)}`,
    },
  ],
  linux: [
    {
      key: "clash-linux",
      preset: "clash",
      name: "Clash Verge / Mihomo Party",
      badge: "recommended",
      preferredFormats: [2],
      build: (url, name) =>
        `clash://install-config?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
    },
    {
      key: "hiddify-linux",
      preset: "hiddify",
      name: "Hiddify",
      preferredFormats: [1, 2, 3],
      build: (url, name) => `hiddify://import/${url}#${encodeURIComponent(name)}`,
    },
    {
      key: "singbox-linux",
      preset: "singbox",
      name: "sing-box",
      preferredFormats: [1],
      build: (url, name) =>
        `sing-box://import-remote-profile?url=${encodeURIComponent(url)}#${encodeURIComponent(name)}`,
    },
  ],
};

export function detectPlatform(): PlatformId {
  if (typeof navigator === "undefined") return "windows";
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux/i.test(ua)) return "linux";
  return "windows";
}

export function resolvePlatformImports(
  platform: PlatformId,
  links: readonly SubscriptionLink[],
  profileName: string,
  baseUrl?: string | null,
  enabledClients?: readonly ClientPreset[],
): ResolvedPlatformClient[] {
  const allowed = enabledClients ? new Set(enabledClients) : null;
  const active = links.filter((l) => l.within_limit);
  return PLATFORM_CLIENTS[platform]
    .filter((spec) => !allowed || allowed.has(spec.preset))
    .map((spec) => {
      let matched: SubscriptionLink | undefined;
      for (const fmt of spec.preferredFormats) {
        matched = active.find((l) => l.format === fmt);
        if (matched) break;
      }
      const url = matched ? absoluteLink(matched.path, baseUrl) : null;
      return {
        key: spec.key,
        preset: spec.preset,
        name: spec.name,
        badge: spec.badge,
        format: matched?.format ?? null,
        url,
        href: url ? spec.build(url, matched?.name || profileName) : null,
      };
    });
}

export function buildClientImports(
  format: FormatCode,
  subscriptionUrl: string,
  profileName: string,
  enabledClients?: readonly ClientPreset[],
): ClientImportEntry[] {
  const allowed = enabledClients ? new Set(enabledClients) : null;
  return CLIENT_CATALOG.filter(
    (entry) => entry.formats.includes(format) && (!allowed || allowed.has(entry.id)),
  ).map((entry) => ({
    id: entry.id,
    name: entry.name,
    subtitle: entry.subtitle,
    formats: entry.formats,
    href: entry.build(subscriptionUrl, profileName),
  }));
}

export function detectClientBadge(clientName: string): string | null {
  const lower = clientName.toLowerCase();
  if (lower.includes("clash") || lower.includes("mihomo") || lower.includes("stash") || lower.includes("flclash")) {
    return "Mihomo";
  }
  if (lower.includes("sing-box") || lower.includes("singbox") || lower.includes("sfi") || lower.includes("sfa")) {
    return "sing-box";
  }
  if (lower.includes("shadowrocket")) return "Shadowrocket";
  if (lower.includes("hiddify")) return "Hiddify";
  if (lower.includes("v2ray") || lower.includes("xray") || lower.includes("nekoray") || lower.includes("nekobox")) {
    return "Xray";
  }
  return null;
}
