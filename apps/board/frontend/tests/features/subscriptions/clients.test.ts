import { describe, expect, test } from "bun:test";
import { buildClientImports, detectClientBadge, resolvePlatformImports } from "../../../src/features/subscriptions/clients";
import { absoluteLink, type SubscriptionLink } from "../../../src/features/subscriptions/links";

describe("subscription client helpers", () => {
  test("builds format-matched import URIs and routes Shadowrocket to Universal/Mihomo/sing-box (not xray JSON)", () => {
    const url = "https://sub.example.net/documents/tok123?f=2";
    const mihomoAll = buildClientImports(2, url, "Meridian");
    expect(mihomoAll.map((c) => c.id)).toEqual(["clash", "shadowrocket", "hiddify"]);
    expect(mihomoAll[0].href).toContain("clash://install-config?url=");

    const xrayAll = buildClientImports(0, "https://sub.example.net/documents/tok123?f=0", "Meridian");
    expect(xrayAll.map((c) => c.id)).toEqual(["v2rayn"]);

    const universalAll = buildClientImports(3, "https://sub.example.net/documents/tok123?f=3", "Meridian");
    expect(universalAll.map((c) => c.id)).toEqual(["shadowrocket", "v2rayn", "hiddify"]);

    const filtered = buildClientImports(2, url, "Meridian", ["clash"]);
    expect(filtered.map((c) => c.id)).toEqual(["clash"]);

    const singbox = buildClientImports(1, "https://sub.example.net/documents/tok123?f=1", "My Node");
    expect(singbox.some((c) => c.id === "singbox" && c.href.startsWith("sing-box://import-remote-profile?url="))).toBe(true);
  });

  test("resolves platform quick imports to optimal link formats", () => {
    const links: SubscriptionLink[] = [
      { id: "1", name: "Xray", format: 0, path: "/documents/a?f=0", created_at: "", last_used_at: null, within_limit: true },
      { id: "2", name: "Sing", format: 1, path: "/documents/b?f=1", created_at: "", last_used_at: null, within_limit: true },
      { id: "3", name: "Mihomo", format: 2, path: "/documents/c?f=2", created_at: "", last_used_at: null, within_limit: true },
      { id: "4", name: "Universal", format: 3, path: "/documents/d?f=3", created_at: "", last_used_at: null, within_limit: true },
    ];
    const ios = resolvePlatformImports("ios", links, "Meridian", "https://sub.example.net");
    const shadowrocket = ios.find((c) => c.key === "shadowrocket")!;
    expect(shadowrocket.format).toBe(3);
    expect(shadowrocket.href).toStartWith("shadowrocket://add/sub://");
  });

  test("resolves custom subscription base URL without double slashes", () => {
    expect(absoluteLink("/documents/abc?f=0", "https://cdn.example.net/")).toBe(
      "https://cdn.example.net/documents/abc?f=0",
    );
    expect(absoluteLink("documents/abc?f=1", "https://cdn.example.net/sub")).toBe(
      "https://cdn.example.net/sub/documents/abc?f=1",
    );
  });

  test("detects common proxy client families from client name", () => {
    expect(detectClientBadge("Clash-Verge/2.0")).toBe("Mihomo");
    expect(detectClientBadge("sing-box 1.11")).toBe("sing-box");
    expect(detectClientBadge("Shadowrocket/2200")).toBe("Shadowrocket");
    expect(detectClientBadge("v2rayNG/1.9")).toBe("Xray");
    expect(detectClientBadge("curl/8.0")).toBeNull();
  });
});
