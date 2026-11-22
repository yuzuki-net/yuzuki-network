import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { Folders, GlobeHemisphereWest, Plus, Trash } from "@phosphor-icons/react";
import { Chip, Empty } from "../../components/console-ui";
import { useT } from "../../i18n";
import {
  groupKindLabels,
  type GroupKind,
  type RouteGroup,
  type RuleSet,
  type RuleSetBehavior,
} from "./model";

const QUICK_GROUPS: readonly RouteGroup[] = [
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
    include_direct: false,
  },
  {
    id: "streaming",
    name: "🎬 Streaming Media",
    kind: "select",
    include_auto: true,
    include_direct: false,
  },
  {
    id: "telegram",
    name: "💬 Telegram",
    kind: "select",
    include_auto: true,
    include_direct: false,
  },
];

function slugify(raw: string, fallback: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned || fallback;
}

export function GroupsEditor({
  groups,
  ruleSets,
  disabled = false,
  onChangeGroups,
  onChangeRuleSets,
}: {
  groups: RouteGroup[];
  ruleSets: RuleSet[];
  disabled?: boolean;
  onChangeGroups?: (next: RouteGroup[]) => void;
  onChangeRuleSets?: (next: RuleSet[]) => void;
}) {
  const t = useT("routing");
  const kindItems = Object.fromEntries(
    Object.entries(groupKindLabels).map(([k, v]) => [k, t(`groups.kind.${k}`, v)]),
  );

  function addGroup(template?: RouteGroup) {
    if (!onChangeGroups) return;
    if (template) {
      if (groups.some((g) => g.id === template.id)) return;
      onChangeGroups([...groups, { ...template }]);
      return;
    }
    const baseNum = groups.length + 1;
    let id = `group-${baseNum}`;
    let n = baseNum;
    while (groups.some((g) => g.id === id)) {
      n += 1;
      id = `group-${n}`;
    }
    onChangeGroups([
      ...groups,
      {
        id,
        name: t("groups.defaultName", "Group {n}", { n }),
        kind: "select",
        include_auto: true,
      },
    ]);
  }

  function updateGroup(index: number, patch: Partial<RouteGroup>) {
    if (!onChangeGroups) return;
    onChangeGroups(groups.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  }

  function addRuleSet() {
    if (!onChangeRuleSets) return;
    const baseNum = ruleSets.length + 1;
    let tag = `ruleset-${baseNum}`;
    let n = baseNum;
    while (ruleSets.some((r) => r.tag === tag)) {
      n += 1;
      tag = `ruleset-${n}`;
    }
    onChangeRuleSets([
      ...ruleSets,
      { tag, sing_box_url: "", mihomo_url: "", behavior: "classical", interval_secs: 86400 },
    ]);
  }

  function updateRuleSet(index: number, patch: Partial<RuleSet>) {
    if (!onChangeRuleSets) return;
    onChangeRuleSets(ruleSets.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Policy Groups */}
      <section className="panel">
        <header className="panel-header">
          <div>
            <h2 className="flex items-center gap-2">
              <Folders size={16} aria-hidden />
              <span>{t("groups.title", "Policy groups")}</span>
              <span className="text-xs font-normal text-kumo-subtle tabular-nums">({groups.length})</span>
            </h2>
            <p className="muted text-xs">
              {t(
                "groups.help",
                "Create dedicated proxy groups (e.g. AI Services, Streaming, Auto Select) compiled to Mihomo proxy-groups, sing-box selector/urltest, and Xray balancers.",
              )}
            </p>
          </div>
          {onChangeGroups && (
            <Button variant="secondary" size="sm" icon={Plus} type="button" disabled={disabled} onClick={() => addGroup()}>
              {t("groups.add", "Add group")}
            </Button>
          )}
        </header>

        <div className="panel-body flex flex-col gap-3">
          {onChangeGroups && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-kumo-subtle">{t("groups.quickAdd", "Quick add:")}</span>
              {QUICK_GROUPS.map((preset) => {
                const exists = groups.some((g) => g.id === preset.id);
                return (
                  <Button
                    key={preset.id}
                    type="button"
                    variant="secondary"
                    size="xs"
                    disabled={disabled || exists}
                    onClick={() => addGroup(preset)}
                  >
                    + {t(`groups.preset.${preset.id}`, preset.name)}
                  </Button>
                );
              })}
            </div>
          )}

          {groups.length === 0 ? (
            <Empty title={t("groups.empty", "No custom policy groups")}>
              {t(
                "groups.emptyHelp",
                "All proxy rules use the default group unless you define custom policy groups here.",
              )}
            </Empty>
          ) : !onChangeGroups ? (
            <div className="grid gap-3 md:grid-cols-2">
              {groups.map((group) => (
                <div
                  key={group.id}
                  className="flex flex-col gap-1.5 rounded-lg border border-kumo-line bg-kumo-recessed/30 p-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm text-kumo-strong">{group.name}</strong>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="secondary">{kindItems[group.kind]}</Badge>
                      <code className="text-[11px] text-kumo-subtle">{group.id}</code>
                    </div>
                  </div>
                  {group.node_filter && (
                    <p className="text-xs text-kumo-subtle">
                      {t("groups.filterSummary", "Node filter: {filter}", { filter: group.node_filter })}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map((group, index) => (
                <div
                  key={index}
                  className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Chip tone="blue">{group.name || group.id}</Chip>
                      <Badge variant="outline">{kindItems[group.kind]}</Badge>
                    </div>
                    <Tooltip
                      content={t("groups.remove", "Remove group")}
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          shape="square"
                          size="xs"
                          icon={Trash}
                          disabled={disabled}
                          aria-label={t("groups.remove", "Remove group")}
                          onClick={() => onChangeGroups(groups.filter((_, i) => i !== index))}
                        />
                      }
                    />
                  </div>

                  <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Input
                      label={t("groups.name", "Display name")}
                      value={group.name}
                      maxLength={64}
                      required
                      disabled={disabled}
                      placeholder="🤖 AI Services"
                      onChange={(e) => updateGroup(index, { name: e.target.value })}
                    />
                    <Input
                      label={t("groups.id", "Group ID")}
                      value={group.id}
                      maxLength={40}
                      dir="ltr"
                      required
                      disabled={disabled}
                      description={t("groups.idHint", "ASCII slug used in rules & Xray tags.")}
                      onChange={(e) => updateGroup(index, { id: slugify(e.target.value, group.id) })}
                    />
                    <Select
                      label={t("groups.kindLabel", "Strategy")}
                      value={group.kind}
                      disabled={disabled}
                      items={kindItems}
                      onValueChange={(val: GroupKind | null) => val && updateGroup(index, { kind: val })}
                    />
                    <Input
                      label={t("groups.nodeFilter", "Node filter (optional)")}
                      value={group.node_filter ?? ""}
                      dir="ltr"
                      disabled={disabled}
                      placeholder="US|JP|SG|!HK"
                      description={t("groups.nodeFilterHint", "Use | to match keywords and ! to exclude. Blank = all nodes.")}
                      onChange={(e) => updateGroup(index, { node_filter: e.target.value || null })}
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-4">
                    {group.kind === "select" ? (
                      <>
                        <Checkbox
                          label={t("groups.includeAuto", "Include auto-test group option")}
                          checked={Boolean(group.include_auto)}
                          disabled={disabled}
                          onCheckedChange={(include_auto) => updateGroup(index, { include_auto })}
                        />
                        <Checkbox
                          label={t("groups.includeDirect", "Allow DIRECT option")}
                          checked={Boolean(group.include_direct)}
                          disabled={disabled}
                          onCheckedChange={(include_direct) => updateGroup(index, { include_direct })}
                        />
                        <Checkbox
                          label={t("groups.includeReject", "Allow REJECT option")}
                          checked={Boolean(group.include_reject)}
                          disabled={disabled}
                          onCheckedChange={(include_reject) => updateGroup(index, { include_reject })}
                        />
                      </>
                    ) : (
                      <div className="grid w-full items-start gap-3 sm:grid-cols-2">
                        <Input
                          label={t("groups.testUrl", "Health-check URL (optional)")}
                          type="url"
                          dir="ltr"
                          value={group.test_url ?? ""}
                          disabled={disabled}
                          placeholder="http://www.gstatic.com/generate_204"
                          onChange={(e) => updateGroup(index, { test_url: e.target.value || null })}
                        />
                        <Input
                          label={t("groups.interval", "Test interval (seconds)")}
                          type="number"
                          min={30}
                          max={86400}
                          value={group.interval_secs !== null && group.interval_secs !== undefined ? String(group.interval_secs) : ""}
                          disabled={disabled}
                          placeholder="300"
                          onChange={(e) => {
                            const v = e.target.value.trim();
                            updateGroup(index, { interval_secs: v ? Number(v) : null });
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Remote Rule-Sets (Collapsible) */}
      <section className="panel">
        <Collapsible.Root defaultOpen={ruleSets.length > 0}>
          <Collapsible.Trigger className="routing-disclosure">
            <span className="flex items-center gap-2">
              <GlobeHemisphereWest size={16} aria-hidden />
              <span>{t("ruleSets.title", "Custom remote rule sets (SRS / Mihomo rule-providers)")}</span>
              {ruleSets.length > 0 && <Chip tone="blue">{ruleSets.length}</Chip>}
            </span>
          </Collapsible.Trigger>
          <Collapsible.Panel className="panel-body flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="muted text-xs">
                {t(
                  "ruleSets.help",
                  "Built-in GeoIP & GeoSite rules already auto-inject official SRS rule-sets for sing-box. Define extra custom remote rule-sets here and reference them by tag.",
                )}
              </p>
              {onChangeRuleSets && (
                <Button variant="secondary" size="xs" icon={Plus} type="button" disabled={disabled} onClick={addRuleSet}>
                  {t("ruleSets.add", "Add rule set")}
                </Button>
              )}
            </div>

            {ruleSets.length === 0 ? (
              <p className="text-xs text-kumo-subtle">
                {t("ruleSets.empty", "No custom remote rule sets configured.")}
              </p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {ruleSets.map((rs, idx) => (
                  <div
                    key={idx}
                    className="grid items-start gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-3 lg:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)_8.5rem_auto]"
                  >
                    <Input
                      label={t("ruleSets.tag", "Tag")}
                      value={rs.tag}
                      dir="ltr"
                      disabled={!onChangeRuleSets || disabled}
                      placeholder="custom-ads"
                      onChange={(e) => updateRuleSet(idx, { tag: slugify(e.target.value, rs.tag) })}
                    />
                    <Input
                      label={t("ruleSets.singBoxUrl", "sing-box URL (.srs / .json)")}
                      type="url"
                      dir="ltr"
                      value={rs.sing_box_url ?? ""}
                      disabled={!onChangeRuleSets || disabled}
                      placeholder="https://.../rule.srs"
                      onChange={(e) => updateRuleSet(idx, { sing_box_url: e.target.value || null })}
                    />
                    <Input
                      label={t("ruleSets.mihomoUrl", "Mihomo URL (.yaml / .mrs)")}
                      type="url"
                      dir="ltr"
                      value={rs.mihomo_url ?? ""}
                      disabled={!onChangeRuleSets || disabled}
                      placeholder="https://.../rule.yaml"
                      onChange={(e) => updateRuleSet(idx, { mihomo_url: e.target.value || null })}
                    />
                    <Select
                      label={t("ruleSets.behavior", "Behavior")}
                      value={rs.behavior}
                      disabled={!onChangeRuleSets || disabled}
                      items={{ classical: "classical", domain: "domain", ipcidr: "ipcidr" }}
                      onValueChange={(val: RuleSetBehavior | null) => val && updateRuleSet(idx, { behavior: val })}
                    />
                    {onChangeRuleSets && (
                      <div className="lg:mt-7">
                        <Tooltip
                          content={t("rules.remove", "Remove")}
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              shape="square"
                              size="sm"
                              icon={Trash}
                              disabled={disabled}
                              aria-label={t("rules.remove", "Remove")}
                              onClick={() => onChangeRuleSets(ruleSets.filter((_, i) => i !== idx))}
                            />
                          }
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Collapsible.Panel>
        </Collapsible.Root>
      </section>
    </div>
  );
}
