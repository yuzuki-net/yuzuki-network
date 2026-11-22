import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { Info, Plus, ShieldCheck, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { Chip, SectionCard } from "../../components/console-ui";
import { CodePreview, HelpTip } from "../../components/kumo-ext";
import type {
  ClientPreset,
  InfoNodePlacement,
  NavLink,
  SubscriptionInfoNodes,
  SubscriptionUi,
} from "../../features/portal/options";
import { useT, type Translator } from "../../i18n";

const CLIENT_OPTIONS: { id: ClientPreset; name: string; formats: string; scheme: string }[] = [
  { id: "clash", name: "Clash Verge / Mihomo Party", formats: "mihomo", scheme: "clash://install-config?url=..." },
  { id: "singbox", name: "sing-box", formats: "sing-box", scheme: "sing-box://import-remote-profile?url=..." },
  { id: "shadowrocket", name: "Shadowrocket", formats: "Universal URI / mihomo / sing-box", scheme: "shadowrocket://add/sub://..." },
  { id: "v2rayn", name: "v2rayN / v2rayNG", formats: "Universal URI / xray-core", scheme: "v2rayng://install-sub?url=..." },
  { id: "hiddify", name: "Hiddify", formats: "sing-box / mihomo / Universal URI", scheme: "hiddify://import/..." },
];

const TEMPLATE_VARIABLES = [
  { token: "{remaining}", sample: "75.00 GB" },
  { token: "{used}", sample: "25.00 GB" },
  { token: "{total}", sample: "100.00 GB" },
  { token: "{percent}", sample: "25.0%" },
  { token: "{expire_date}", sample: "2026-12-31" },
  { token: "{reset_date}", sample: "2026-12-31" },
  { token: "{devices}", sample: "2" },
  { token: "{max_devices}", sample: "5" },
  { token: "{panel_name}", sample: "Meridian" },
  { token: "{panel_url}", sample: "https://panel.example.com" },
  { token: "{email}", sample: "alice@example.com" },
] as const;

function renderSampleInfoNodes(
  cfg: SubscriptionInfoNodes,
  panelName: string,
  panelUrl: string | null,
  copy: Translator,
): string[] {
  const url = panelUrl?.trim() || "https://panel.example.com";
  const name = panelName.trim() || "Meridian";
  const lines: string[] = [];
  if (cfg.show_traffic) {
    lines.push(copy("remaining_traffic", undefined, { remaining: "75.00 GB", total: "100.00 GB" }));
  }
  if (cfg.show_expiry) lines.push(copy("next_reset", undefined, { date: "2026-12-31" }));
  if (cfg.show_website && panelUrl?.trim()) {
    lines.push(copy("website", undefined, { url }));
  }
  for (const raw of cfg.custom_templates) {
    const rendered = raw
      .replaceAll("{used}", "25.00 GB")
      .replaceAll("{remaining}", "75.00 GB")
      .replaceAll("{total}", "100.00 GB")
      .replaceAll("{percent}", "25.0%")
      .replaceAll("{expire_date}", "2026-12-31")
      .replaceAll("{reset_date}", "2026-12-31")
      .replaceAll("{devices}", "2")
      .replaceAll("{max_devices}", "5")
      .replaceAll("{panel_name}", name)
      .replaceAll("{panel_url}", url)
      .replaceAll("{email}", "alice@example.com")
      .trim();
    if (rendered) lines.push(rendered);
  }
  return lines;
}

function renderSampleHeaders(value: SubscriptionUi, panelName: string, panelUrl: string | null): string {
  const lines: string[] = ["content-type: application/yaml"];
  if (value.include_userinfo_header) {
    lines.push("subscription-userinfo: upload=0; download=26843545600; total=107374182400; expire=1798675200");
  }
  lines.push(`profile-update-interval: ${value.profile_update_interval_hours || 24}`);
  if (panelUrl?.trim()) {
    lines.push(`profile-web-page-url: ${panelUrl.trim()}`);
  }
  if (value.include_filename_header) {
    const title = panelName.trim() || "Meridian";
    lines.push(
      `content-disposition: attachment; filename="subscription.yaml"; filename*=UTF-8''${encodeURIComponent(`${title}.yaml`)}`,
    );
  }
  return lines.join("\n");
}

export function SubscriptionSettings({
  value,
  panelName,
  panelUrl,
  disabled,
  onChange,
}: {
  value: SubscriptionUi;
  panelName: string;
  panelUrl: string | null;
  disabled: boolean;
  onChange: (changes: Partial<SubscriptionUi>) => void;
}) {
  const t = useT("settings");
  const copy = useT("subscription-info");
  const [activeTemplateIdx, setActiveTemplateIdx] = useState<number | null>(null);

  const info = value.info_nodes;

  function updateInfo(patch: Partial<SubscriptionInfoNodes>) {
    onChange({ info_nodes: { ...info, ...patch } });
  }

  function toggleClient(id: ClientPreset, checked: boolean) {
    const next = checked
      ? Array.from(new Set([...value.enabled_clients, id]))
      : value.enabled_clients.filter((item) => item !== id);
    onChange({ enabled_clients: next });
  }

  function addSupportLink() {
    if (value.support_links.length >= 6) return;
    onChange({
      support_links: [...value.support_links, { label: "", url: "https://", external: true }],
    });
  }

  function updateSupportLink(index: number, patch: Partial<NavLink>) {
    onChange({
      support_links: value.support_links.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    });
  }

  function addTemplate() {
    if (info.custom_templates.length >= 5) return;
    const next = [...info.custom_templates, ""];
    updateInfo({ custom_templates: next });
    setActiveTemplateIdx(next.length - 1);
  }

  function insertVariable(token: string) {
    if (disabled) return;
    if (info.custom_templates.length === 0) {
      updateInfo({ custom_templates: [token] });
      setActiveTemplateIdx(0);
      return;
    }
    const targetIdx =
      activeTemplateIdx !== null && activeTemplateIdx < info.custom_templates.length
        ? activeTemplateIdx
        : info.custom_templates.length - 1;
    const next = info.custom_templates.map((line, i) =>
      i === targetIdx ? `${line}${line && !line.endsWith(" ") ? " " : ""}${token}` : line,
    );
    updateInfo({ custom_templates: next });
  }

  const previewNodes = renderSampleInfoNodes(info, panelName, panelUrl, copy);
  const defaultGroupName = copy("group_name");
  const customGroupName = info.group_name.trim();
  const previewGroupName = customGroupName && customGroupName !== "group" ? customGroupName : defaultGroupName;
  const previewHeaders = renderSampleHeaders(value, panelName, panelUrl);

  return (
    <div className="flex flex-col gap-5">
      <SectionCard
        title={t("subscription.title", "Subscriptions & client onboarding")}
        description={t(
          "subscription.description",
          "Configure how subscription links, QR codes and one-click client imports appear in the personal overview.",
        )}
      >
        <div className="form-fields">
          <div className="grid items-start gap-4 lg:grid-cols-3">
            <Input
              label={t("subscription.baseUrl", "External subscription base URL")}
              labelTooltip={t(
                "subscription.baseUrlTooltip",
                "Optional dedicated domain for /documents/{token} links (useful when separating panel and subscription CDN domains).",
              )}
              type="url"
              dir="ltr"
              value={value.base_url ?? ""}
              maxLength={512}
              disabled={disabled}
              placeholder="https://sub.example.net"
              description={t("subscription.baseUrlHint", "Leave blank to use the current browser origin.")}
              onChange={(e) => onChange({ base_url: e.target.value || null })}
            />
            <Select
              label={t("subscription.defaultFormat", "Default client format")}
              labelTooltip={t(
                "subscription.defaultFormatTooltip",
                "Preferred subscription format for new links and quick copy actions.",
              )}
              value={String(value.default_format)}
              disabled={disabled}
              items={{
                "3": "Universal (Base64 URI)",
                "2": "mihomo (YAML)",
                "1": "sing-box (JSON)",
                "0": "xray-core (JSON)",
              }}
              onValueChange={(next: string | null) => {
                if (next === "0" || next === "1" || next === "2" || next === "3") {
                  onChange({ default_format: Number(next) as 0 | 1 | 2 | 3 });
                }
              }}
            />
            <Input
              label={t("subscription.guideUrl", "Client setup guide URL")}
              type="url"
              dir="ltr"
              value={value.guide_url ?? ""}
              maxLength={2048}
              disabled={disabled}
              placeholder="https://docs.example.net/getting-started"
              description={t("subscription.guideUrlHint", "Shown as a quick Help / Guide button on the subscriber Quick Connect card.")}
              onChange={(e) => onChange({ guide_url: e.target.value || null })}
            />
          </div>

          <div className="grid items-stretch gap-3 sm:grid-cols-2">
            <div className="flex items-start justify-between gap-4 rounded-lg border border-kumo-line bg-kumo-recessed/30 px-4 py-3.5">
              <div>
                <p className="text-sm font-medium text-kumo-strong">
                  {t("subscription.autoProvision", "Auto-create default subscription links")}
                </p>
                <p className="text-xs text-kumo-subtle">
                  {t(
                    "subscription.autoProvisionHint",
                    "Automatically generates default links for every enabled format when a new account is created.",
                  )}
                </p>
              </div>
              <Switch
                aria-label={t("subscription.autoProvision", "Auto-create default subscription links")}
                checked={value.auto_provision_links}
                disabled={disabled}
                onCheckedChange={(auto_provision_links) => onChange({ auto_provision_links })}
              />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border border-kumo-line bg-kumo-recessed/30 px-4 py-3.5">
              <div>
                <p className="text-sm font-medium text-kumo-strong">
                  {t("subscription.showQr", "Show QR code modal for subscription links")}
                </p>
                <p className="text-xs text-kumo-subtle">
                  {t("subscription.showQrHint", "Allows mobile clients to scan and import remote profiles directly.")}
                </p>
              </div>
              <Switch
                aria-label={t("subscription.showQr", "Show QR code modal for subscription links")}
                checked={value.show_qr_code}
                disabled={disabled}
                onCheckedChange={(show_qr_code) => onChange({ show_qr_code })}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            <div>
              <span className="text-sm font-medium text-kumo-strong">
                {t("subscription.clientsTitle", "Enabled one-click import clients")}
              </span>
              <p className="text-xs text-kumo-subtle">
                {t("subscription.clientsHint", "Only clients matching the active subscription format are shown in the subscriber import menu.")}
              </p>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {CLIENT_OPTIONS.map((client) => (
                <div
                  key={client.id}
                  className="flex items-start justify-between gap-2 rounded-lg border border-kumo-line bg-kumo-base p-3"
                >
                  <Checkbox
                    checked={value.enabled_clients.includes(client.id)}
                    disabled={disabled}
                    onCheckedChange={(checked) => toggleClient(client.id, checked)}
                    label={
                      <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium text-kumo-strong">{client.name}</span>
                        <span className="text-xs text-kumo-subtle">{client.formats}</span>
                        <code className="text-[11px] text-kumo-subtle" dir="ltr">{client.scheme}</code>
                      </span>
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={t("subscription.headersTitle", "Subscription HTTP response headers")}
        description={t(
          "subscription.headersDesc",
          "Standard headers read by Clash Verge, Mihomo Party, Shadowrocket, Hiddify, sing-box and v2rayN to render native traffic bars and auto-update timers.",
        )}
      >
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <div className="form-fields">
            <div className="grid items-stretch gap-3 sm:grid-cols-2">
              <div className="flex items-start justify-between gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/30 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-kumo-strong">
                    {t("subscription.userinfoHeader", "Send subscription-userinfo header")}
                  </p>
                  <p className="text-xs text-kumo-subtle">
                    {t("subscription.userinfoHeaderHint", "Displays native traffic usage & expiry progress bars in clients.")}
                  </p>
                </div>
                <Switch
                  aria-label={t("subscription.userinfoHeader", "Send subscription-userinfo header")}
                  checked={value.include_userinfo_header}
                  disabled={disabled}
                  onCheckedChange={(include_userinfo_header) => onChange({ include_userinfo_header })}
                />
              </div>

              <div className="flex items-start justify-between gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/30 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-kumo-strong">
                    {t("subscription.filenameHeader", "Send profile filename header")}
                  </p>
                  <p className="text-xs text-kumo-subtle">
                    {t("subscription.filenameHeaderHint", "Automatically names the imported profile after your panel.")}
                  </p>
                </div>
                <Switch
                  aria-label={t("subscription.filenameHeader", "Send profile filename header")}
                  checked={value.include_filename_header}
                  disabled={disabled}
                  onCheckedChange={(include_filename_header) => onChange({ include_filename_header })}
                />
              </div>
            </div>

            <Input
              label={t("subscription.updateInterval", "Client auto-update interval (hours)")}
              type="number"
              min={1}
              max={720}
              value={String(value.profile_update_interval_hours)}
              disabled={disabled}
              description={t("subscription.updateIntervalHint", "Sent via profile-update-interval (1–720 hours).")}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                if (Number.isFinite(parsed)) {
                  onChange({ profile_update_interval_hours: Math.max(1, Math.min(720, Math.round(parsed))) });
                }
              }}
            />
          </div>

          <CodePreview
            title={t("subscription.headersPreview", "Response header preview")}
            code={previewHeaders}
            lang="jsonc"
          />
        </div>
      </SectionCard>

      <SectionCard
        title={t("subscription.infoNodesTitle", "Virtual status & usage info nodes")}
        description={t(
          "subscription.infoNodesDesc",
          "Display usage, expiry date, website URL, and custom notices directly inside every client's node list.",
        )}
      >
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.85fr)]">
          <div className="form-fields">
          <div className="rounded-lg border border-kumo-line bg-kumo-recessed/30 px-4 py-3.5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-start gap-2.5">
                <ShieldCheck size={18} className="mt-0.5 shrink-0 text-kumo-success" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-kumo-strong">
                    {t("subscription.infoNodesEnable", "Enable virtual info nodes in subscriptions")}
                  </p>
                  <p className="text-xs text-kumo-subtle">
                    {t(
                      "subscription.infoNodesSafeHint",
                      "Injected as visible display nodes across xray-core, sing-box, and mihomo subscriptions.",
                    )}
                  </p>
                </div>
              </div>
              <Switch
                aria-label={t("subscription.infoNodesEnable", "Enable virtual info nodes in subscriptions")}
                checked={info.enabled}
                disabled={disabled}
                onCheckedChange={(enabled) => updateInfo({ enabled })}
              />
            </div>
          </div>

          {info.enabled && (
            <>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-kumo-strong">
                    {t("subscription.infoFormats", "Target subscription formats")}
                  </span>
                  <HelpTip
                    content={t(
                      "subscription.infoFormatsTip",
                      "Enabled for all three client formats by default so every client shows usage and expiry nodes.",
                    )}
                  />
                </div>
                <div className="flex flex-wrap gap-3">
                  <Checkbox
                    label="xray-core (JSON)"
                    checked={info.formats.xray}
                    disabled={disabled}
                    onCheckedChange={(xray) => updateInfo({ formats: { ...info.formats, xray } })}
                  />
                  <Checkbox
                    label="sing-box (JSON)"
                    checked={info.formats.sing_box}
                    disabled={disabled}
                    onCheckedChange={(sing_box) => updateInfo({ formats: { ...info.formats, sing_box } })}
                  />
                  <Checkbox
                    label="mihomo (YAML)"
                    checked={info.formats.mihomo}
                    disabled={disabled}
                    onCheckedChange={(mihomo) => updateInfo({ formats: { ...info.formats, mihomo } })}
                  />
                  <Checkbox
                    label="Universal (Base64 URI)"
                    checked={info.formats.universal}
                    disabled={disabled}
                    onCheckedChange={(universal) => updateInfo({ formats: { ...info.formats, universal } })}
                  />
                </div>
              </div>

              <div className="edit-grid">
                <Select
                  label={t("subscription.infoPlacement", "Node list placement")}
                  value={info.placement}
                  disabled={disabled}
                  items={{
                    prepend_to_group: t("subscription.placementPrepend", "Top of main node list (Recommended)"),
                    append_to_group: t("subscription.placementAppend", "Append to end of main node list"),
                    dedicated_group: t("subscription.placementDedicated", "Dedicated top info group"),
                  }}
                  onValueChange={(next) => {
                    if (next === "prepend_to_group" || next === "append_to_group" || next === "dedicated_group") {
                      updateInfo({ placement: next as InfoNodePlacement });
                    }
                  }}
                />
                {info.placement === "dedicated_group" && (
                  <Input
                    label={t("subscription.infoGroupName", "Info group title")}
                    value={info.group_name}
                    maxLength={40}
                    disabled={disabled}
                    placeholder={defaultGroupName}
                    onChange={(e) => updateInfo({ group_name: e.target.value })}
                  />
                )}
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-kumo-strong">
                  {t("subscription.builtInRows", "Built-in dynamic info rows")}
                </span>
                <div className="grid gap-2.5 sm:grid-cols-3">
                  <div className="rounded-lg border border-kumo-line bg-kumo-base p-3">
                    <Checkbox
                      label={t("subscription.showTraffic", "Remaining / used traffic")}
                      checked={info.show_traffic}
                      disabled={disabled}
                      onCheckedChange={(show_traffic) => updateInfo({ show_traffic })}
                    />
                  </div>
                  <div className="rounded-lg border border-kumo-line bg-kumo-base p-3">
                    <Checkbox
                      label={t("subscription.showExpiry", "Expiry / reset date")}
                      checked={info.show_expiry}
                      disabled={disabled}
                      onCheckedChange={(show_expiry) => updateInfo({ show_expiry })}
                    />
                  </div>
                  <div className="rounded-lg border border-kumo-line bg-kumo-base p-3">
                    <Checkbox
                      label={t("subscription.showWebsite", "Panel website URL")}
                      checked={info.show_website}
                      disabled={disabled}
                      onCheckedChange={(show_website) => updateInfo({ show_website })}
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2.5 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="text-sm font-medium text-kumo-strong">
                      {t("subscription.customTemplates", "Custom info node lines")}
                    </span>
                    <p className="text-xs text-kumo-subtle">
                      {t("subscription.customTemplatesHint", "Add up to 5 extra lines. Click a variable below to insert it.")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    icon={Plus}
                    disabled={disabled || info.custom_templates.length >= 5}
                    onClick={addTemplate}
                  >
                    {t("subscription.addTemplate", "Add line")}
                  </Button>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {TEMPLATE_VARIABLES.map((v) => (
                    <button
                      key={v.token}
                      type="button"
                      disabled={disabled}
                      className="rounded-md border border-kumo-line bg-kumo-base px-2 py-0.5 font-mono text-[11px] text-kumo-default hover:border-kumo-interact hover:text-kumo-strong disabled:opacity-50"
                      title={v.sample}
                      onClick={() => insertVariable(v.token)}
                    >
                      {v.token}
                    </button>
                  ))}
                </div>

                {info.custom_templates.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {info.custom_templates.map((line, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <Input
                            aria-label={t("subscription.templateLine", "Custom info line {index}", { index: index + 1 })}
                            value={line}
                            maxLength={120}
                            disabled={disabled}
                            placeholder={copy("custom_template_example")}
                            onFocus={() => setActiveTemplateIdx(index)}
                            onChange={(e) =>
                              updateInfo({
                                custom_templates: info.custom_templates.map((item, i) =>
                                  i === index ? e.target.value : item,
                                ),
                              })
                            }
                          />
                        </div>
                        <Tooltip
                          content={t("common.remove", "Remove")}
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              shape="square"
                              size="sm"
                              icon={Trash}
                              disabled={disabled}
                              aria-label={t("common.remove", "Remove")}
                              onClick={() =>
                                updateInfo({
                                  custom_templates: info.custom_templates.filter((_, i) => i !== index),
                                })
                              }
                            />
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          </div>

          <aside className="flex flex-col gap-2.5 rounded-lg border border-kumo-line bg-kumo-recessed/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-kumo-strong">
                <Info size={15} aria-hidden />
                <span>{t("subscription.infoPreviewTitle", "Client node list preview")}</span>
              </div>
              <Chip tone="blue">
                {info.placement === "dedicated_group"
                  ? previewGroupName
                  : info.placement === "append_to_group"
                    ? "group (bottom)"
                    : "group (top)"}
              </Chip>
            </div>
            {!info.enabled || previewNodes.length === 0 ? (
              <p className="text-xs text-kumo-subtle">
                {t("subscription.infoPreviewEmpty", "Enable at least one built-in row or add a custom line to preview.")}
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {previewNodes.map((label, idx) => (
                  <li
                    key={idx}
                    className="flex items-center justify-between gap-2 rounded-md border border-kumo-line bg-kumo-base px-3 py-1.5 text-xs text-kumo-strong"
                  >
                    <span className="truncate font-medium">{label}</span>
                    <Badge variant="secondary">INFO</Badge>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      </SectionCard>

      <SectionCard
        title={t("subscription.supportLinks", "Workspace help & support links")}
        description={t("subscription.supportLinksDesc", "Add up to 6 quick links (docs, Telegram channel, Discord, support tickets) shown in the Personal Overview.")}
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={Plus}
            disabled={disabled || value.support_links.length >= 6}
            onClick={addSupportLink}
          >
            {t("branding.addLink", "Add link")}
          </Button>
        }
      >
        {value.support_links.length === 0 ? (
          <p className="text-sm text-kumo-subtle">
            {t("subscription.noSupportLinks", "No support links configured yet.")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {value.support_links.map((link, index) => (
              <div
                key={index}
                className="grid items-start gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/30 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto]"
              >
                <Input
                  label={t("branding.linkLabel", "Label")}
                  value={link.label}
                  maxLength={48}
                  required
                  disabled={disabled}
                  placeholder={t("subscription.supportPlaceholder", "Telegram Support")}
                  onChange={(e) => updateSupportLink(index, { label: e.target.value })}
                />
                <Input
                  label={t("branding.linkUrl", "URL")}
                  type="url"
                  dir="ltr"
                  value={link.url}
                  maxLength={2048}
                  required
                  disabled={disabled}
                  placeholder="https://t.me/example"
                  onChange={(e) => updateSupportLink(index, { url: e.target.value })}
                />
                <div className="md:mt-7">
                  <Tooltip
                    content={t("common.remove", "Remove")}
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        shape="square"
                        size="sm"
                        icon={Trash}
                        disabled={disabled}
                        aria-label={t("common.remove", "Remove")}
                        onClick={() =>
                          onChange({ support_links: value.support_links.filter((_, i) => i !== index) })
                        }
                      />
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
