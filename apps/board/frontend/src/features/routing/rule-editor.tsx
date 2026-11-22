import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { InputGroup } from "@cloudflare/kumo/components/input-group";
import { Pagination } from "@cloudflare/kumo/components/pagination";
import { Select } from "@cloudflare/kumo/components/select";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  DotsSixVertical,
  Lightning,
  MagnifyingGlass,
  Plus,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { useEffect, useState, type DragEvent } from "react";
import { Chip, Empty, Modal } from "../../components/console-ui";
import { DataTable, DataToolbar, type Column } from "../../components/data-table";
import { useT } from "../../i18n";
import {
  actionLabels,
  decodeTarget,
  encodeTarget,
  kindLabels,
  type MatchKind,
  type RouteGroup,
  type Rule,
} from "./model";
import { parseBulkRules, RULE_PACKS } from "./presets";

export { parseBulkRules };

const examples: Record<MatchKind, string> = {
  domain: "example.net",
  domain_suffix: "openai.com",
  domain_keyword: "google",
  ip_cidr: "192.168.0.0/16",
  geoip: "cn / private / us / telegram",
  geosite: "cn / openai / category-ads-all / netflix",
  port: "443 or 8000-8080",
  protocol: "bittorrent / quic",
  process_name: "qbittorrent",
  rule_set: "custom-ads",
};

const PERF_WARNING_THRESHOLD = 500;
const PAGE_SIZES = [20, 50, 100];

function actionTone(action: Rule["action"]): "blue" | "green" | "red" | "amber" {
  if (action === "block") return "red";
  if (action === "direct") return "green";
  if (action === "group") return "amber";
  return "blue";
}

export function RulesEditor({
  rules,
  groups = [],
  disabled = false,
  onChange,
}: {
  rules: Rule[];
  groups?: RouteGroup[];
  disabled?: boolean;
  onChange?: (rules: Rule[]) => void;
}) {
  const t = useT("routing");
  const [search, setSearch] = useState("");
  const [targetFilter, setTargetFilter] = useState<string>("all");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkKind, setBulkKind] = useState<MatchKind>("domain_suffix");
  const [bulkTarget, setBulkTarget] = useState<string>("proxy");
  const [bulkText, setBulkText] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(20);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());

  const names = Object.fromEntries(Object.entries(kindLabels).map(([key, label]) => [key, t(`kind.${key}`, label)]));
  const baseActions = {
    proxy: t("action.proxy", actionLabels.proxy),
    direct: t("action.direct", actionLabels.direct),
    block: t("action.block", actionLabels.block),
  };
  const targetItems: Record<string, string> = {
    ...baseActions,
    ...Object.fromEntries(groups.map((g) => [`group:${g.id}`, t("action.groupTarget", "Group: {name}", { name: g.name })])),
  };

  function labelForRuleTarget(rule: Rule): string {
    if (rule.action === "group") {
      const grp = groups.find((g) => g.id === rule.group_id);
      return grp ? grp.name : rule.group_id ?? t("action.group", actionLabels.group);
    }
    return baseActions[rule.action];
  }

  function valueFieldLabel(kind: MatchKind): string {
    switch (kind) {
      case "ip_cidr":
        return t("rules.network", "Network range");
      case "geoip":
        return t("rules.geoipValue", "GeoIP code");
      case "geosite":
        return t("rules.geositeValue", "GeoSite category");
      case "port":
        return t("rules.portValue", "Port / range");
      case "protocol":
        return t("rules.protocolValue", "Protocol");
      case "process_name":
        return t("rules.processValue", "Process name");
      case "rule_set":
        return t("rules.ruleSetValue", "Rule set tag");
      case "domain_keyword":
        return t("rules.keywordValue", "Keyword");
      default:
        return t("rules.domain", "Domain");
    }
  }

  if (!onChange) {
    type Entry = Rule & { order: number };
    const filteredPublished = rules
      .map((rule, index) => ({ ...rule, order: index + 1 }))
      .filter(
        (rule) =>
          (targetFilter === "all" || encodeTarget(rule.action, rule.group_id) === targetFilter) &&
          (!search.trim() ||
            rule.value.toLowerCase().includes(search.trim().toLowerCase()) ||
            labelForRuleTarget(rule).toLowerCase().includes(search.trim().toLowerCase())),
      );
    const columns: Column<Entry>[] = [
      { key: "order", title: t("rules.order", "Order"), width: "4.5rem", cell: (rule) => rule.order },
      { key: "kind", title: t("rules.match", "Match"), omitOnMobile: true, cell: (rule) => names[rule.kind] ?? rule.kind },
      { key: "value", title: t("rules.value", "Value"), cell: (rule) => <code dir="ltr">{rule.value}</code> },
      {
        key: "action",
        title: t("rules.action", "Target"),
        cell: (rule) => <Chip tone={actionTone(rule.action)}>{labelForRuleTarget(rule)}</Chip>,
      },
    ];
    return (
      <DataTable
        label={t("rules.published", "Published rules")}
        rows={filteredPublished}
        columns={columns}
        rowId={(rule) => String(rule.order)}
        layout="auto"
        pagination={{ defaultPageSize: 20, storageKey: "routing-published-rules" }}
        toolbar={
          rules.length > 0 && (
            <DataToolbar
              quickFilters={{
                label: t("rules.action", "Target"),
                value: targetFilter,
                onChange: setTargetFilter,
                options: [
                  { value: "all", label: t("rules.allActions", "All targets"), count: rules.length },
                  { value: "proxy", label: baseActions.proxy, count: rules.filter((r) => r.action === "proxy").length },
                  { value: "direct", label: baseActions.direct, count: rules.filter((r) => r.action === "direct").length },
                  { value: "block", label: baseActions.block, count: rules.filter((r) => r.action === "block").length },
                  ...groups.map((g) => ({
                    value: `group:${g.id}`,
                    label: g.name,
                    count: rules.filter((r) => r.action === "group" && r.group_id === g.id).length,
                  })),
                ],
              }}
              search={{
                label: t("rules.filter", "Filter rules"),
                placeholder: t("rules.filterPlaceholder", "Filter by domain, GeoIP, GeoSite, CIDR or group…"),
                value: search,
                onChange: setSearch,
                resultCount: filteredPublished.length,
              }}
              onClear={
                search || targetFilter !== "all"
                  ? () => {
                      setSearch("");
                      setTargetFilter("all");
                    }
                  : undefined
              }
            />
          )
        }
        empty={
          <Empty title={search || targetFilter !== "all" ? t("rules.noMatch", "No rules match your filter") : t("rules.empty", "No rules configured")}>
            {search || targetFilter !== "all" ? undefined : t("rules.default", "All traffic follows the default action.")}
          </Empty>
        }
      />
    );
  }

  const change = onChange;

  function set(index: number, value: Partial<Rule>) {
    change(rules.map((rule, row) => (row === index ? { ...rule, ...value } : rule)));
  }

  function move(index: number, delta: number) {
    const next = [...rules];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setSelectedIndices(new Set());
    change(next);
  }

  function moveTo(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= rules.length || to >= rules.length) return;
    const next = [...rules];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setSelectedIndices(new Set());
    change(next);
  }

  function appendUnique(items: Rule[]) {
    const existing = new Set(rules.map((r) => `${r.kind}:${r.value.trim().toLowerCase()}`));
    const fresh = items.filter((r) => !existing.has(`${r.kind}:${r.value.trim().toLowerCase()}`));
    if (!fresh.length) return;
    change([...rules, ...fresh]);
  }

  const add = () => {
    const next = [...rules, { kind: "domain_suffix" as const, action: "proxy" as const, value: "" }];
    change(next);
    setPage(Math.max(1, Math.ceil(next.length / perPage)));
  };

  const duplicate = (index: number) => {
    const next = [...rules];
    next.splice(index + 1, 0, { ...rules[index] });
    change(next);
  };

  const term = search.trim().toLowerCase();
  const visibleEntries = rules
    .map((rule, index) => ({ rule, index }))
    .filter(
      ({ rule }) =>
        (targetFilter === "all" || encodeTarget(rule.action, rule.group_id) === targetFilter) &&
        (!term ||
          rule.value.toLowerCase().includes(term) ||
          rule.kind.includes(term) ||
          labelForRuleTarget(rule).toLowerCase().includes(term)),
    );

  const totalPages = Math.max(1, Math.ceil(visibleEntries.length / perPage));
  const safePage = Math.min(page, totalPages);
  const pageEntries = visibleEntries.slice((safePage - 1) * perPage, safePage * perPage);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageIndices = pageEntries.map((e) => e.index);
  const allPageSelected = pageIndices.length > 0 && pageIndices.every((idx) => selectedIndices.has(idx));
  const somePageSelected = pageIndices.some((idx) => selectedIndices.has(idx));

  function toggleSelectPage(checked: boolean) {
    const next = new Set(selectedIndices);
    for (const idx of pageIndices) {
      if (checked) next.add(idx);
      else next.delete(idx);
    }
    setSelectedIndices(next);
  }

  function toggleSelectOne(index: number, checked: boolean) {
    const next = new Set(selectedIndices);
    if (checked) next.add(index);
    else next.delete(index);
    setSelectedIndices(next);
  }

  function bulkSetTarget(encoded: string) {
    const decoded = decodeTarget(encoded);
    change(
      rules.map((rule, idx) =>
        selectedIndices.has(idx)
          ? { ...rule, action: decoded.action, group_id: decoded.group_id ?? undefined }
          : rule,
      ),
    );
    setSelectedIndices(new Set());
  }

  function bulkDeleteSelected() {
    change(rules.filter((_, idx) => !selectedIndices.has(idx)));
    setSelectedIndices(new Set());
  }

  function handleDrop(targetIndex: number, event: DragEvent) {
    event.preventDefault();
    if (dragIndex !== null) moveTo(dragIndex, targetIndex);
    setDragIndex(null);
  }

  const decodedBulkTarget = decodeTarget(bulkTarget);
  const parsedBulkCount = parseBulkRules(
    bulkText,
    bulkKind,
    decodedBulkTarget.action,
    decodedBulkTarget.group_id,
    groups,
  ).length;

  const filterPills = [
    { key: "all", label: t("rules.allActions", "All targets"), count: rules.length },
    { key: "proxy", label: baseActions.proxy, count: rules.filter((r) => r.action === "proxy").length },
    { key: "direct", label: baseActions.direct, count: rules.filter((r) => r.action === "direct").length },
    { key: "block", label: baseActions.block, count: rules.filter((r) => r.action === "block").length },
    ...groups.map((g) => ({
      key: `group:${g.id}`,
      label: g.name,
      count: rules.filter((r) => r.action === "group" && r.group_id === g.id).length,
    })),
  ];

  return (
    <>
      <section className="panel">
        <header className="panel-header">
          <div>
            <h2>
              {t("rules.title", "Rules")}{" "}
              <span className="text-xs font-normal text-kumo-subtle tabular-nums">
                ({t("rules.totalCount", "{count} rules", { count: rules.length })})
              </span>
            </h2>
            <p className="muted text-xs">
              {t(
                "rules.help",
                "The first matching rule wins. Supports Domain, GeoIP, GeoSite, IP CIDR, Port, Protocol, Process, and Remote Rule-Sets across all cores.",
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Button variant="secondary" size="sm" type="button" icon={Lightning} disabled={disabled}>
                    {t("rules.presets", "Add preset")}
                  </Button>
                }
              />
              <DropdownMenu.Content align="end" className="min-w-72">
                <DropdownMenu.Group>
                  <DropdownMenu.Label>{t("rules.presetPacks", "Common rule packs")}</DropdownMenu.Label>
                  {RULE_PACKS.map((pack) => (
                    <DropdownMenu.Item key={pack.id} onClick={() => appendUnique(pack.rules)}>
                      <span className="flex w-full items-center justify-between gap-3">
                        <span className="flex flex-col">
                          <span className="font-medium">{t(`rules.preset.${pack.id}`, pack.label)}</span>
                          <span className="text-xs text-kumo-subtle">
                            {t("rules.presetCount", "{count} rules", { count: pack.rules.length })}
                          </span>
                        </span>
                        <Chip tone={actionTone(pack.action)}>
                          {pack.action === "group" ? t("action.group", actionLabels.group) : baseActions[pack.action]}
                        </Chip>
                      </span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Group>
              </DropdownMenu.Content>
            </DropdownMenu>

            <Button
              variant="secondary"
              size="sm"
              type="button"
              icon={UploadSimple}
              disabled={disabled}
              onClick={() => {
                setBulkText("");
                setBulkOpen(true);
              }}
            >
              {t("rules.bulkAdd", "Bulk import")}
            </Button>

            <Button variant="primary" size="sm" icon={Plus} type="button" disabled={disabled} onClick={add}>
              {t("rules.add", "Add rule")}
            </Button>
          </div>
        </header>

        {rules.length > PERF_WARNING_THRESHOLD && (
          <div className="border-b border-kumo-line px-5 py-3">
            <KumoBanner
              size="sm"
              variant="alert"
              title={t("rules.perfTitle", "Large inline rule list ({count} rules)", { count: rules.length })}
              description={t(
                "rules.perfDesc",
                "For huge domain or IP lists, consider GeoSite, GeoIP, or Remote Rule-Sets for faster matching and smaller subscriptions.",
              )}
            />
          </div>
        )}

        {rules.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-line bg-kumo-recessed/30 px-5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Checkbox
                  aria-label={t("rules.selectPage", "Select rules on this page")}
                  checked={allPageSelected}
                  indeterminate={somePageSelected && !allPageSelected}
                  disabled={disabled || pageEntries.length === 0}
                  onCheckedChange={toggleSelectPage}
                />
              </div>
              <div className="data-quick-filters !p-0" role="tablist" aria-label={t("rules.action", "Target")}>
                {filterPills.map((pill) => (
                  <button
                    key={pill.key}
                    type="button"
                    role="tab"
                    aria-selected={targetFilter === pill.key}
                    className={`data-quick-pill ${targetFilter === pill.key ? "is-active" : ""}`}
                    onClick={() => {
                      setTargetFilter(pill.key);
                      setPage(1);
                    }}
                  >
                    <span>{pill.label}</span>
                    <span className="data-quick-pill-count tabular-nums">{pill.count}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="w-full max-w-xs">
              <InputGroup>
                <InputGroup.Addon align="start">
                  <MagnifyingGlass size={14} className="text-kumo-subtle" aria-hidden />
                </InputGroup.Addon>
                <InputGroup.Input
                  type="text"
                  aria-label={t("rules.filter", "Filter rules")}
                  placeholder={t("rules.filterPlaceholder", "Filter by domain, GeoIP, GeoSite, CIDR or group…")}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
                {search && (
                  <InputGroup.Addon align="end">
                    <button
                      type="button"
                      className="data-search-clear"
                      aria-label={t("rules.clearSearch", "Clear filter")}
                      onClick={() => setSearch("")}
                    >
                      <X size={13} aria-hidden />
                    </button>
                  </InputGroup.Addon>
                )}
              </InputGroup>
            </div>
          </div>
        )}

        {selectedIndices.size > 0 && (
          <div className="data-selection">
            <span role="status">
              {t("rules.selectedCount", "{count} selected", { count: selectedIndices.size })}
            </span>
            <div className="actions">
              <Button type="button" variant="secondary" size="xs" disabled={disabled} onClick={() => bulkSetTarget("proxy")}>
                {t("rules.setProxy", "Set Proxy")}
              </Button>
              <Button type="button" variant="secondary" size="xs" disabled={disabled} onClick={() => bulkSetTarget("direct")}>
                {t("rules.setDirect", "Set Direct")}
              </Button>
              <Button type="button" variant="secondary" size="xs" disabled={disabled} onClick={() => bulkSetTarget("block")}>
                {t("rules.setBlock", "Set Block")}
              </Button>
              {groups.map((g) => (
                <Button
                  key={g.id}
                  type="button"
                  variant="secondary"
                  size="xs"
                  disabled={disabled}
                  onClick={() => bulkSetTarget(`group:${g.id}`)}
                >
                  {g.name}
                </Button>
              ))}
              <Button type="button" variant="destructive" size="xs" icon={Trash} disabled={disabled} onClick={bulkDeleteSelected}>
                {t("rules.deleteSelected", "Delete selected")}
              </Button>
              <Button type="button" variant="ghost" size="xs" onClick={() => setSelectedIndices(new Set())}>
                {t("rules.clearSelection", "Clear")}
              </Button>
            </div>
          </div>
        )}

        {rules.length ? (
          <>
            <div className="flex flex-col gap-2.5 p-5">
              {pageEntries.length === 0 ? (
                <Empty title={t("rules.noMatch", "No rules match your filter")} />
              ) : (
                pageEntries.map(({ rule, index }) => (
                  <fieldset
                    className={`routing-rule ${dragIndex === index ? "opacity-50" : ""}`}
                    key={index}
                    draggable={!disabled && !term && targetFilter === "all"}
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(e) => {
                      if (!disabled && !term && targetFilter === "all") e.preventDefault();
                    }}
                    onDrop={(e) => handleDrop(index, e)}
                    onDragEnd={() => setDragIndex(null)}
                  >
                    <div className="flex items-center justify-between gap-2 pb-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          aria-label={t("rules.selectOne", "Select rule {count}", { count: index + 1 })}
                          checked={selectedIndices.has(index)}
                          disabled={disabled}
                          onCheckedChange={(checked) => toggleSelectOne(index, checked)}
                        />
                        {!disabled && !term && targetFilter === "all" && (
                          <span
                            className="cursor-grab text-kumo-subtle hover:text-kumo-default"
                            title={t("rules.dragHint", "Drag to reorder")}
                            aria-hidden
                          >
                            <DotsSixVertical size={16} />
                          </span>
                        )}
                        <span className="text-xs font-semibold text-kumo-subtle tabular-nums">#{index + 1}</span>
                        <Chip tone={actionTone(rule.action)}>{labelForRuleTarget(rule)}</Chip>
                      </div>
                      <div className="flex items-center gap-1">
                        <Tooltip
                          content={t("rules.up", "Move up")}
                          render={
                            <Button
                              variant="ghost"
                              shape="square"
                              size="xs"
                              aria-label={t("rules.moveUp", "Move rule {count} up", { count: index + 1 })}
                              icon={ArrowUp}
                              type="button"
                              disabled={disabled || index === 0}
                              onClick={() => move(index, -1)}
                            />
                          }
                        />
                        <Tooltip
                          content={t("rules.down", "Move down")}
                          render={
                            <Button
                              variant="ghost"
                              shape="square"
                              size="xs"
                              aria-label={t("rules.moveDown", "Move rule {count} down", { count: index + 1 })}
                              icon={ArrowDown}
                              type="button"
                              disabled={disabled || index === rules.length - 1}
                              onClick={() => move(index, 1)}
                            />
                          }
                        />
                        <Tooltip
                          content={t("rules.duplicate", "Duplicate rule")}
                          render={
                            <Button
                              variant="ghost"
                              shape="square"
                              size="xs"
                              aria-label={t("rules.duplicate", "Duplicate rule")}
                              icon={Copy}
                              type="button"
                              disabled={disabled}
                              onClick={() => duplicate(index)}
                            />
                          }
                        />
                        <Tooltip
                          content={t("rules.remove", "Remove rule")}
                          render={
                            <Button
                              variant="ghost"
                              shape="square"
                              size="xs"
                              aria-label={t("rules.removeOne", "Remove rule {count}", { count: index + 1 })}
                              icon={Trash}
                              type="button"
                              disabled={disabled}
                              onClick={() => {
                                setSelectedIndices(new Set());
                                change(rules.filter((_, row) => row !== index));
                              }}
                            />
                          }
                        />
                      </div>
                    </div>
                    <div className="routing-row">
                      <Select
                        label={t("rules.match", "Match")}
                        items={names}
                        value={rule.kind}
                        disabled={disabled}
                        onValueChange={(value: MatchKind | null) => {
                          if (value) set(index, { kind: value });
                        }}
                      />
                      <Input
                        label={valueFieldLabel(rule.kind)}
                        value={rule.value}
                        dir="ltr"
                        disabled={disabled}
                        placeholder={examples[rule.kind]}
                        onChange={(event) => set(index, { value: event.target.value })}
                        required
                      />
                      <Select
                        label={t("rules.action", "Target")}
                        items={targetItems}
                        value={encodeTarget(rule.action, rule.group_id)}
                        disabled={disabled}
                        onValueChange={(value: string | null) => {
                          if (!value) return;
                          const decoded = decodeTarget(value);
                          set(index, { action: decoded.action, group_id: decoded.group_id ?? undefined });
                        }}
                      />
                    </div>
                  </fieldset>
                ))
              )}
            </div>

            {visibleEntries.length > perPage && (
              <div className="data-pagination-wrap">
                <Pagination
                  className="data-pagination"
                  page={safePage}
                  perPage={perPage}
                  totalCount={visibleEntries.length}
                  setPage={setPage}
                >
                  <Pagination.Info />
                  <Pagination.Separator />
                  <Pagination.PageSize
                    value={perPage}
                    options={PAGE_SIZES}
                    onChange={(nextSize) => {
                      setPerPage(nextSize);
                      setPage(1);
                    }}
                  />
                  <Pagination.Controls controls="full" />
                </Pagination>
              </div>
            )}
          </>
        ) : (
          <Empty
            title={t("rules.empty", "No rules configured")}
            action={
              <Button variant="primary" icon={Plus} type="button" onClick={add} disabled={disabled}>
                {t("rules.add", "Add rule")}
              </Button>
            }
          >
            {t("rules.empty.help", "Add individual rules, apply a preset pack, or bulk import domains, GeoIP/GeoSite, and Clash rules.")}
          </Empty>
        )}
      </section>

      <Modal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title={t("rules.bulkTitle", "Bulk import routing rules")}
        description={t(
          "rules.bulkDescClash",
          "Paste plain domains/CIDRs, Xray prefixes (geosite:cn, geoip:cn), OR Clash rules (e.g. DOMAIN-SUFFIX,openai.com,PROXY or GEOIP,CN,DIRECT,no-resolve). Duplicates are skipped automatically.",
        )}
      >
        <div className="form-fields">
          <div className="edit-grid">
            <Select
              label={t("rules.defaultMatch", "Default match (for plain lines)")}
              items={names}
              value={bulkKind}
              onValueChange={(value: MatchKind | null) => {
                if (value) setBulkKind(value);
              }}
            />
            <Select
              label={t("rules.defaultAction", "Default target (for plain lines)")}
              items={targetItems}
              value={bulkTarget}
              onValueChange={(value: string | null) => {
                if (value) setBulkTarget(value);
              }}
            />
          </div>
          <Textarea
            label={t("rules.bulkValues", "Rules list")}
            rows={8}
            dir="ltr"
            value={bulkText}
            placeholder={"GEOSITE,openai,ai\nGEOIP,CN,DIRECT,no-resolve\nDOMAIN-SUFFIX,example.com,PROXY\nIP-CIDR,192.168.0.0/16,DIRECT,no-resolve\ngeosite:category-ads-all"}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <div className="dialog-actions">
            <Button type="button" variant="secondary" onClick={() => setBulkOpen(false)}>
              {t("rules.cancel", "Cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={parsedBulkCount === 0}
              onClick={() => {
                const items = parseBulkRules(
                  bulkText,
                  bulkKind,
                  decodedBulkTarget.action,
                  decodedBulkTarget.group_id,
                  groups,
                );
                if (items.length) appendUnique(items);
                setBulkOpen(false);
              }}
            >
              {t("rules.bulkConfirm", "Add {count} rules", { count: parsedBulkCount })}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
