import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { TagInput } from "@cloudflare/kumo/components/tag-input";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { Code, MagicWand, Plus, SlidersHorizontal, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { Chip } from "../../components/console-ui";
import { CodePreview, HelpTip } from "../../components/kumo-ext";
import { english, useT } from "../../i18n";
import { coreNames, type Core } from "../nodes/model";

export type NativeDraft = Partial<Record<Core, string>>;

export type VisualOverlay = {
  dnsServers: string[];
  enableSniffing: boolean;
  fakeIp: boolean;
  domainStrategy: string;
  extraRules: { matchType: "geosite" | "geoip" | "protocol"; value: string; action: "proxy" | "direct" | "block" }[];
  ruleProviders: { name: string; url: string; behavior: "domain" | "ipcidr" | "classical"; interval: number }[];
};

const entries = Object.entries(coreNames) as [Core, string][];
const coreTabs = entries.map(([value, label]) => ({ value, label }));

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === "object" && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
}

export function extractVisualOverlay(core: Core, raw: Record<string, unknown>): VisualOverlay {
  const result: VisualOverlay = {
    dnsServers: [],
    enableSniffing: false,
    fakeIp: false,
    domainStrategy: core === "xray" ? "IPIfNonMatch" : "prefer_ipv4",
    extraRules: [],
    ruleProviders: [],
  };
  if (core === "xray") {
    const dns = asRecord(raw.dns);
    if (Array.isArray(dns.servers)) {
      result.dnsServers = dns.servers.filter((s): s is string => typeof s === "string");
    }
    const routing = asRecord(raw.routing);
    if (typeof routing.domainStrategy === "string") result.domainStrategy = routing.domainStrategy;
    if (Array.isArray(routing.rules)) {
      for (const item of routing.rules) {
        const r = asRecord(item);
        const tag = r.outboundTag;
        const action = tag === "direct" ? "direct" : tag === "block" ? "block" : "proxy";
        if (Array.isArray(r.domain)) {
          for (const d of r.domain) {
            if (typeof d === "string" && d.startsWith("geosite:")) {
              result.extraRules.push({ matchType: "geosite", value: d.slice(8), action });
            }
          }
        }
        if (Array.isArray(r.ip)) {
          for (const ip of r.ip) {
            if (typeof ip === "string" && ip.startsWith("geoip:")) {
              result.extraRules.push({ matchType: "geoip", value: ip.slice(6), action });
            }
          }
        }
        if (Array.isArray(r.protocol)) {
          for (const proto of r.protocol) {
            if (typeof proto === "string") {
              result.extraRules.push({ matchType: "protocol", value: proto, action });
            }
          }
        }
      }
    }
  } else if (core === "sing-box") {
    const dns = asRecord(raw.dns);
    if (Array.isArray(dns.servers)) {
      result.dnsServers = dns.servers
        .map((s) => (typeof s === "string" ? s : typeof asRecord(s).address === "string" ? String(asRecord(s).address) : ""))
        .filter(Boolean);
    }
    if (asRecord(dns.fakeip).enabled === true) result.fakeIp = true;
    const route = asRecord(raw.route);
    if (route.auto_detect_interface === true) result.enableSniffing = true;
    if (Array.isArray(route.rules)) {
      for (const item of route.rules) {
        const r = asRecord(item);
        const action = r.outbound === "direct" ? "direct" : r.outbound === "block" ? "block" : "proxy";
        if (Array.isArray(r.protocol)) {
          for (const p of r.protocol) {
            if (typeof p === "string") result.extraRules.push({ matchType: "protocol", value: p, action });
          }
        }
      }
    }
  } else if (core === "mihomo") {
    const dns = asRecord(raw.dns);
    if (Array.isArray(dns.nameserver)) {
      result.dnsServers = dns.nameserver.filter((s): s is string => typeof s === "string");
    }
    if (dns["enhanced-mode"] === "fake-ip") result.fakeIp = true;
    if (asRecord(raw.sniffer).enable === true) result.enableSniffing = true;
    const providers = asRecord(raw["rule-providers"]);
    for (const [name, conf] of Object.entries(providers)) {
      const c = asRecord(conf);
      if (typeof c.url === "string") {
        const behavior = c.behavior === "ipcidr" || c.behavior === "classical" ? c.behavior : "domain";
        result.ruleProviders.push({
          name,
          url: c.url,
          behavior,
          interval: typeof c.interval === "number" ? c.interval : 86400,
        });
      }
    }
  }
  return result;
}

export function compileVisualOverlay(
  core: Core,
  visual: VisualOverlay,
  base: Record<string, unknown> = {},
): Record<string, unknown> | null {
  const next: Record<string, unknown> = { ...base };

  if (core === "xray") {
    if (visual.dnsServers.length) next.dns = { ...asRecord(next.dns), servers: visual.dnsServers };
    else delete next.dns;

    const rules: Record<string, unknown>[] = visual.extraRules
      .filter((r) => r.value.trim())
      .map((r) => {
        const outboundTag = r.action === "direct" ? "direct" : r.action === "block" ? "block" : "proxy";
        if (r.matchType === "geosite") return { type: "field", domain: [`geosite:${r.value.trim()}`], outboundTag };
        if (r.matchType === "geoip") return { type: "field", ip: [`geoip:${r.value.trim()}`], outboundTag };
        return { type: "field", protocol: [r.value.trim()], outboundTag };
      });
    if (rules.length || visual.domainStrategy !== "IPIfNonMatch") {
      next.routing = {
        ...asRecord(next.routing),
        domainStrategy: visual.domainStrategy,
        ...(rules.length ? { rules } : {}),
      };
    } else {
      delete next.routing;
    }
  } else if (core === "sing-box") {
    if (visual.dnsServers.length || visual.fakeIp) {
      next.dns = {
        ...asRecord(next.dns),
        ...(visual.dnsServers.length
          ? { servers: visual.dnsServers.map((addr, idx) => ({ tag: `dns-${idx + 1}`, address: addr })) }
          : {}),
        ...(visual.fakeIp ? { fakeip: { enabled: true, inet4_range: "198.18.0.0/15" } } : {}),
      };
    } else {
      delete next.dns;
    }
    const rules = visual.extraRules
      .filter((r) => r.value.trim())
      .map((r) => ({
        ...(r.matchType === "protocol" ? { protocol: [r.value.trim()] } : { rule_set: [r.value.trim()] }),
        outbound: r.action,
      }));
    if (rules.length || visual.enableSniffing) {
      next.route = {
        ...asRecord(next.route),
        ...(visual.enableSniffing ? { auto_detect_interface: true } : {}),
        ...(rules.length ? { rules } : {}),
      };
    } else {
      delete next.route;
    }
  } else if (core === "mihomo") {
    if (visual.dnsServers.length || visual.fakeIp) {
      next.dns = {
        ...asRecord(next.dns),
        enable: true,
        ...(visual.fakeIp ? { "enhanced-mode": "fake-ip" } : {}),
        ...(visual.dnsServers.length ? { nameserver: visual.dnsServers } : {}),
      };
    } else {
      delete next.dns;
    }
    if (visual.enableSniffing) {
      next.sniffer = { enable: true, sniff: { TLS: { ports: [443, 8443] }, HTTP: { ports: [80, "8080-8880"] } } };
    } else {
      delete next.sniffer;
    }
    const validProviders = visual.ruleProviders.filter((p) => p.name.trim() && p.url.trim());
    if (validProviders.length) {
      next["rule-providers"] = Object.fromEntries(
        validProviders.map((p) => [
          p.name.trim(),
          { type: "http", behavior: p.behavior, url: p.url.trim(), interval: p.interval },
        ]),
      );
    } else {
      delete next["rule-providers"];
    }
  }

  return Object.keys(next).length > 0 ? next : null;
}

export function NativeEditor({
  current,
  drafts,
  onChange,
}: {
  current?: Record<string, unknown>;
  drafts: NativeDraft;
  onChange?: (drafts: NativeDraft) => void;
}) {
  const t = useT("routing");
  const [format, setFormat] = useState<Core>("xray");
  const [editorMode, setEditorMode] = useState<"visual" | "json">("visual");
  const rawText = drafts[format] ?? (current?.[format] === undefined ? "" : JSON.stringify(current[format], null, 2));

  let parsedObj: Record<string, unknown> = {};
  let jsonError: string | null = null;
  if (rawText.trim()) {
    try {
      const val = JSON.parse(rawText);
      if (val && typeof val === "object" && !Array.isArray(val)) parsedObj = val as Record<string, unknown>;
      else jsonError = english("routing", "native.object", "Enter a JSON object.");
    } catch (e) {
      jsonError = e instanceof Error ? e.message : String(e);
    }
  }

  const visual = extractVisualOverlay(format, parsedObj);

  function updateVisual(patch: Partial<VisualOverlay>) {
    if (!onChange) return;
    const merged = { ...visual, ...patch };
    const compiled = compileVisualOverlay(format, merged, parsedObj);
    onChange({ ...drafts, [format]: compiled ? JSON.stringify(compiled, null, 2) : "" });
  }

  function formatJson() {
    if (!onChange || !rawText.trim() || jsonError) return;
    onChange({ ...drafts, [format]: JSON.stringify(parsedObj, null, 2) });
  }

  const configuredCount = entries.filter(([key]) => {
    const val = drafts[key] ?? (current?.[key] === undefined ? "" : JSON.stringify(current[key]));
    return val.trim().length > 0;
  }).length;

  return (
    <section className="panel routing-native">
      <Collapsible.Root defaultOpen={configuredCount > 0}>
        <Collapsible.Trigger className="routing-disclosure">
          <span className="flex items-center gap-2">
            <span>{t("native.title", "Advanced native overrides")}</span>
            {configuredCount > 0 && (
              <Chip tone="blue">{t("native.activeCount", "{count} configured", { count: configuredCount })}</Chip>
            )}
          </span>
        </Collapsible.Trigger>
        <Collapsible.Panel className="panel-body flow">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="muted text-xs">
              {t(
                "native.help",
                "Customize core-specific DNS, sniffing, rule providers, or GeoIP/GeoSite overrides without manually writing JSON.",
              )}
            </p>
            {onChange && (
              <Tabs
                variant="segmented"
                value={editorMode}
                onValueChange={(val) => setEditorMode(val as "visual" | "json")}
                tabs={[
                  { value: "visual", label: t("native.visualMode", "Visual builder") },
                  { value: "json", label: t("native.jsonMode", "Raw JSON") },
                ]}
              />
            )}
          </div>

          <div className="border-b border-kumo-line">
            <Tabs variant="underline" value={format} tabs={coreTabs} onValueChange={(val) => setFormat(val as Core)} />
          </div>

          {!onChange ? (
            rawText ? (
              <CodePreview title={`${coreNames[format]} native override`} code={rawText} lang="jsonc" />
            ) : (
              <p className="muted text-sm">{t("native.empty", "No override for this format.")}</p>
            )
          ) : editorMode === "visual" ? (
            <div className="flex flex-col gap-4">
              {jsonError && (
                <p className="text-xs text-kumo-danger">
                  {english("routing", "native.switchToFix", "Current raw JSON has a syntax error. Switch to Raw JSON mode to fix or clear it.")}
                </p>
              )}

              <TagInput
                label={t("native.dnsServers", "Custom DNS servers")}
                labelTooltip={t(
                  "native.dnsTip",
                  "Press Enter after each server (e.g. 1.1.1.1, 8.8.8.8, https://dns.google/dns-query).",
                )}
                value={visual.dnsServers}
                placeholder="1.1.1.1"
                onValueChange={(dnsServers) => updateVisual({ dnsServers })}
              />

              <div className="grid gap-3 sm:grid-cols-2">
                {format === "xray" && (
                  <Select
                    label={t("native.domainStrategy", "Domain resolution strategy")}
                    value={visual.domainStrategy}
                    items={{
                      IPIfNonMatch: "IPIfNonMatch (Recommended)",
                      AsIs: "AsIs",
                      IPOnDemand: "IPOnDemand",
                    }}
                    onValueChange={(val: string | null) => val && updateVisual({ domainStrategy: val })}
                  />
                )}
                {(format === "sing-box" || format === "mihomo") && (
                  <>
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/30 px-3.5 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-kumo-strong">
                          {format === "mihomo" ? t("native.sniffer", "Enable traffic sniffer") : t("native.autoInterface", "Auto detect interface")}
                        </span>
                        <HelpTip content={t("native.snifferTip", "Improves domain-based routing accuracy for proxied TLS/HTTP connections.")} />
                      </div>
                      <Switch
                        checked={visual.enableSniffing}
                        onCheckedChange={(enableSniffing) => updateVisual({ enableSniffing })}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/30 px-3.5 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-kumo-strong">{t("native.fakeIp", "Enable FakeIP DNS")}</span>
                        <HelpTip content={t("native.fakeIpTip", "Reduces DNS latency by returning synthetic IP addresses locally.")} />
                      </div>
                      <Switch
                        checked={visual.fakeIp}
                        onCheckedChange={(fakeIp) => updateVisual({ fakeIp })}
                      />
                    </div>
                  </>
                )}
              </div>

              {(format === "xray" || format === "sing-box") && (
                <div className="flex flex-col gap-2.5 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <SlidersHorizontal size={15} className="text-kumo-subtle" aria-hidden />
                      <span className="text-sm font-semibold text-kumo-strong">
                        {t("native.extraRules", "Geo / protocol routing rules")}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      icon={Plus}
                      onClick={() =>
                        updateVisual({
                          extraRules: [
                            ...visual.extraRules,
                            { matchType: format === "xray" ? "geosite" : "protocol", value: "", action: "direct" },
                          ],
                        })
                      }
                    >
                      {t("native.addExtraRule", "Add entry")}
                    </Button>
                  </div>
                  {visual.extraRules.length === 0 ? (
                    <p className="text-xs text-kumo-subtle">
                      {t("native.noExtraRules", "Add GeoSite, GeoIP, or protocol-based matchers (e.g. cn, private, bittorrent).")}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {visual.extraRules.map((item, idx) => (
                        <div
                          key={idx}
                          className="grid items-start gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_9rem_auto]"
                        >
                          <Select
                            aria-label={t("native.matchType", "Matcher")}
                            value={item.matchType}
                            items={
                              format === "xray"
                                ? { geosite: "GeoSite", geoip: "GeoIP", protocol: "Protocol" }
                                : { protocol: "Protocol", geosite: "Rule Set" }
                            }
                            onValueChange={(val) => {
                              if (!val) return;
                              updateVisual({
                                extraRules: visual.extraRules.map((r, i) =>
                                  i === idx ? { ...r, matchType: val as typeof item.matchType } : r,
                                ),
                              });
                            }}
                          />
                          <Input
                            aria-label={t("native.matchValue", "Value")}
                            value={item.value}
                            dir="ltr"
                            placeholder={item.matchType === "protocol" ? "bittorrent" : "cn"}
                            onChange={(e) =>
                              updateVisual({
                                extraRules: visual.extraRules.map((r, i) =>
                                  i === idx ? { ...r, value: e.target.value } : r,
                                ),
                              })
                            }
                          />
                          <Select
                            aria-label={t("rules.action", "Action")}
                            value={item.action}
                            items={{ proxy: t("action.proxy", "Proxy"), direct: t("action.direct", "Direct"), block: t("action.block", "Block") }}
                            onValueChange={(val) => {
                              if (!val) return;
                              updateVisual({
                                extraRules: visual.extraRules.map((r, i) =>
                                  i === idx ? { ...r, action: val as typeof item.action } : r,
                                ),
                              });
                            }}
                          />
                          <Tooltip
                            content={t("rules.remove", "Remove")}
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                shape="square"
                                size="sm"
                                icon={Trash}
                                aria-label={t("rules.remove", "Remove")}
                                onClick={() =>
                                  updateVisual({ extraRules: visual.extraRules.filter((_, i) => i !== idx) })
                                }
                              />
                            }
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {format === "mihomo" && (
                <div className="flex flex-col gap-2.5 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-kumo-strong">
                      {t("native.ruleProviders", "Mihomo rule-providers")}
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      icon={Plus}
                      onClick={() =>
                        updateVisual({
                          ruleProviders: [
                            ...visual.ruleProviders,
                            { name: "", url: "https://", behavior: "domain", interval: 86400 },
                          ],
                        })
                      }
                    >
                      {t("native.addProvider", "Add provider")}
                    </Button>
                  </div>
                  {visual.ruleProviders.length === 0 ? (
                    <p className="text-xs text-kumo-subtle">
                      {t("native.noProviders", "Subscribe to remote HTTP rule-set files for Mihomo / Clash Verge.")}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2.5">
                      {visual.ruleProviders.map((prov, idx) => (
                        <div
                          key={idx}
                          className="grid items-start gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_8rem_auto]"
                        >
                          <Input
                            label={t("native.providerName", "Name")}
                            value={prov.name}
                            placeholder="reject"
                            dir="ltr"
                            onChange={(e) =>
                              updateVisual({
                                ruleProviders: visual.ruleProviders.map((p, i) =>
                                  i === idx ? { ...p, name: e.target.value } : p,
                                ),
                              })
                            }
                          />
                          <Input
                            label={t("native.providerUrl", "Remote URL")}
                            type="url"
                            value={prov.url}
                            dir="ltr"
                            placeholder="https://example.net/rules.yaml"
                            onChange={(e) =>
                              updateVisual({
                                ruleProviders: visual.ruleProviders.map((p, i) =>
                                  i === idx ? { ...p, url: e.target.value } : p,
                                ),
                              })
                            }
                          />
                          <Select
                            label={t("native.providerBehavior", "Behavior")}
                            value={prov.behavior}
                            items={{ domain: "domain", ipcidr: "ipcidr", classical: "classical" }}
                            onValueChange={(val) => {
                              if (!val) return;
                              updateVisual({
                                ruleProviders: visual.ruleProviders.map((p, i) =>
                                  i === idx ? { ...p, behavior: val as typeof prov.behavior } : p,
                                ),
                              });
                            }}
                          />
                          <div className="sm:mt-7">
                            <Tooltip
                              content={t("rules.remove", "Remove")}
                              render={
                                <Button
                                  type="button"
                                  variant="ghost"
                                  shape="square"
                                  size="sm"
                                  icon={Trash}
                                  aria-label={t("rules.remove", "Remove")}
                                  onClick={() =>
                                    updateVisual({ ruleProviders: visual.ruleProviders.filter((_, i) => i !== idx) })
                                  }
                                />
                              }
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {rawText.trim() && !jsonError && (
                <CodePreview title={t("native.generatedPreview", "Generated {core} overlay JSON", { core: coreNames[format] })} code={rawText} lang="jsonc" />
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {rawText.trim() ? (
                    jsonError ? (
                      <Chip tone="red">{english("routing", "native.invalidJson", "Invalid JSON")}</Chip>
                    ) : (
                      <Chip tone="green">{t("native.validJson", "Valid JSON")}</Chip>
                    )
                  ) : (
                    <Chip tone="neutral">{t("native.blank", "Empty")}</Chip>
                  )}
                  {jsonError && <span className="text-xs text-kumo-danger">{jsonError}</span>}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button type="button" variant="secondary" size="xs" icon={MagicWand} disabled={!rawText.trim() || !!jsonError} onClick={formatJson}>
                    {t("native.format", "Format")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    icon={Code}
                    disabled={!rawText.trim()}
                    onClick={() => onChange({ ...drafts, [format]: "" })}
                  >
                    {t("native.clear", "Clear")}
                  </Button>
                </div>
              </div>
              <Textarea
                label={t("native.config", "{core} native configuration", { core: coreNames[format] })}
                className="code-editor"
                rows={10}
                spellCheck={false}
                value={rawText}
                dir="ltr"
                placeholder={t("native.placeholder", "Leave blank to use the common policy")}
                onChange={(event) => onChange({ ...drafts, [format]: event.target.value })}
              />
            </div>
          )}
        </Collapsible.Panel>
      </Collapsible.Root>
    </section>
  );
}

export function parseNative(current: Record<string, unknown> | undefined, drafts: NativeDraft) {
  const parsed = { ...current };
  for (const [key, raw] of Object.entries(drafts) as [Core, string][]) {
    const value = raw.trim();
    if (!value) {
      delete parsed[key];
      continue;
    }
    try {
      const overlay = JSON.parse(value);
      if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
        throw Error(english("routing", "native.object", "Enter a JSON object."));
      }
      parsed[key] = overlay;
    } catch (error) {
      throw Error(
        english("routing", "native.error", "{core} override: {message}", {
          core: coreNames[key],
          message: String(error instanceof Error ? error.message : error),
        }),
      );
    }
  }
  return parsed;
}
