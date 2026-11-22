import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Select } from "@cloudflare/kumo/components/select";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { ArrowCounterClockwise, Check, FloppyDisk, Sparkle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useResource } from "../../app/query";
import { useConsoleLocation, useConsoleNavigate } from "../../app/router";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, Empty, FormActions, Loading, Modal, PageHeader } from "../../components/console-ui";
import { GroupsEditor } from "../../features/routing/groups-editor";
import {
  actionLabels,
  decodeTarget,
  encodeTarget,
  routingUrl,
  type Policy,
  type PolicyState,
  type RouteGroup,
} from "../../features/routing/model";
import { NativeEditor, parseNative, type NativeDraft } from "../../features/routing/native-editor";
import { SCENARIO_PRESETS, type ScenarioPreset } from "../../features/routing/presets";
import { RoutingPreview } from "../../features/routing/preview";
import { RulesEditor } from "../../features/routing/rule-editor";
import { useCan } from "../../features/session/context";
import { useT } from "../../i18n";
import "./style.css";

export default function Routing() {
  const t = useT("routing");
  const state = useResource<PolicyState>(routingUrl);
  return (
    <>
      <PageHeader
        title={t("title", "Subscription routing")}
        description={t("help", "Choose how client profiles handle traffic, organize policy groups, and publish changes when ready.")}
      />
      <Banner error={state.error} />
      {state.isPending ? <Loading label={t("loading", "Loading routing policy…")} /> : state.data && <PolicyEditor state={state.data} />}
    </>
  );
}

type Operation = { kind: "publish" } | { kind: "restore"; revision: number } | { kind: "discard" };

function PolicyEditor({ state }: { state: PolicyState }) {
  const t = useT("routing");
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const navigate = useConsoleNavigate();
  const href = useConsoleLocation();
  const edit = useCan("routing.edit");
  const publish = useCan("routing.publish");
  const canDraft = edit || publish;
  const tab = new URL(href, location.origin).searchParams.get("tab");
  const view = tab && ["live", "preview", "history", ...(canDraft ? ["draft"] : [])].includes(tab) ? tab : canDraft ? "draft" : "live";
  const setView = (value: string) => navigate("/admin/routing?" + new URLSearchParams({ tab: value }));
  const [changes, setChanges] = useState<Policy>();
  const [native, setNative] = useState<NativeDraft>({});
  const [operation, setOperation] = useState<Operation>();
  const [validation, setValidation] = useState<unknown>();
  const dirty = !!changes || Object.keys(native).length !== 0;
  const draft = changes ?? state.draft ?? state.published;
  const draftGroups = draft.groups ?? [];
  const draftRuleSets = draft.rule_sets ?? [];
  const revisions = useResource<number[]>(`${routingUrl}/revisions`, view === "history");

  const save = useMutation({
    mutationFn: (policy: Policy) => api(routingUrl, "PUT", policy),
    onSuccess: (_, policy) => {
      cache.setQueryData<PolicyState>([routingUrl], (current) => current && { ...current, draft: policy });
      setChanges(undefined);
      setNative({});
      toast.add({ title: t("toast.saved", "Routing draft saved"), variant: "success" });
      void cache.invalidateQueries({ queryKey: [routingUrl] });
    },
  });

  const apply = useMutation({
    mutationFn: (op: Operation) => {
      if (op.kind === "discard") return state.draft ? api(`${routingUrl}/draft`, "DELETE") : Promise.resolve();
      return api(op.kind === "publish" ? `${routingUrl}/publish` : `${routingUrl}/revisions/${op.revision}`, "POST");
    },
    onSuccess: (_, op) => {
      setOperation(undefined);
      if (op.kind === "discard") {
        setChanges(undefined);
        setNative({});
        setValidation(undefined);
        save.reset();
        cache.setQueryData<PolicyState>([routingUrl], (current) => current && { ...current, draft: null });
      }
      const title =
        op.kind === "discard"
          ? t("toast.discarded", "Routing draft discarded")
          : op.kind === "publish"
            ? t("toast.published", "Routing policy published")
            : t("toast.restored", "Routing revision restored");
      toast.add({ title, variant: "success" });
      void cache.invalidateQueries({ queryKey: [routingUrl] });
      void cache.invalidateQueries({ queryKey: [`${routingUrl}/revisions`] });
      void cache.invalidateQueries({ queryKey: ["/api/v1/me/subscriptions"] });
      if (op.kind !== "discard") setView("live");
    },
  });

  const tabs = [
    ...(canDraft ? [{ value: "draft", label: t("tabs.draft", "Draft") }] : []),
    { value: "live", label: t("tabs.live", "Published") },
    { value: "preview", label: t("tabs.preview", "Test rules") },
    { value: "history", label: t("tabs.history", "Revision history") },
  ];

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!edit || !dirty || save.isPending) return;
    try {
      setValidation(null);
      save.mutate({
        ...draft,
        groups: draftGroups,
        rule_sets: draftRuleSets,
        native: parseNative(draft.native, native),
      });
    } catch (error) {
      setValidation(error);
    }
  }

  function confirm(next: Operation) {
    apply.reset();
    setOperation(next);
  }

  function updateGroups(nextGroups: RouteGroup[]) {
    const validIds = new Set(nextGroups.map((g) => g.id));
    const cleanedRules = draft.rules.map((r) =>
      r.action === "group" && (!r.group_id || !validIds.has(r.group_id))
        ? { ...r, action: "proxy" as const, group_id: undefined }
        : r,
    );
    const defaultInvalid = draft.default_action === "group" && (!draft.default_group_id || !validIds.has(draft.default_group_id));
    setChanges({
      ...draft,
      default_action: defaultInvalid ? "proxy" : draft.default_action,
      default_group_id: defaultInvalid ? null : draft.default_group_id,
      groups: nextGroups,
      rules: cleanedRules,
    });
  }

  function applyScenario(scenario: ScenarioPreset) {
    setChanges({
      default_action: scenario.defaultAction,
      default_group_id: scenario.defaultGroupId ?? null,
      groups: scenario.groups.map((g) => ({ ...g })),
      rule_sets: scenario.ruleSets.map((rs) => ({ ...rs })),
      rules: scenario.rules.map((r) => ({ ...r })),
      native: scenario.native,
    });
    const nextNative: NativeDraft = {
      xray: scenario.native.xray ? JSON.stringify(scenario.native.xray, null, 2) : "",
      "sing-box": scenario.native["sing-box"] ? JSON.stringify(scenario.native["sing-box"], null, 2) : "",
      mihomo: scenario.native.mihomo ? JSON.stringify(scenario.native.mihomo, null, 2) : "",
    };
    setNative(nextNative);
    setValidation(undefined);
    toast.add({
      title: t("scenarios.applied", "Applied template: {name}", { name: t(`scenarios.${scenario.id}.name`, scenario.name) }),
      variant: "success",
    });
  }

  return (
    <>
      <Tabs variant="underline" className="routing-tabs" value={view} onValueChange={setView} tabs={tabs} />
      {view === "draft" && (
        <>
          <KumoBanner
            size="sm"
            variant="secondary"
            title={dirty ? t("draft.unsaved", "Unsaved draft changes") : state.draft ? t("draft.saved", "Saved draft") : t("draft.start", "Start a draft")}
            description={t("draft.status", "Subscribers currently receive revision {revision}. Only publishing changes the live policy.", { revision: state.revision })}
          />
          {edit && (
            <section className="panel">
              <header className="panel-header">
                <div>
                  <h2 className="flex items-center gap-2">
                    <Sparkle size={16} aria-hidden />
                    {t("scenarios.title", "Quick split-routing templates")}
                  </h2>
                  <p className="muted text-xs">
                    {t("scenarios.help", "Apply a ready-to-use routing template with GeoIP/GeoSite rules and policy groups across Xray, sing-box, and Mihomo.")}
                  </p>
                </div>
              </header>
              <div className="panel-body">
                <div className="routing-scenarios-grid">
                  {SCENARIO_PRESETS.map((scenario) => (
                    <div key={scenario.id} className="routing-scenario-card">
                      <div className="flex w-full items-center justify-between gap-2">
                        <strong className="text-sm text-kumo-strong">
                          {t(`scenarios.${scenario.id}.name`, scenario.name)}
                        </strong>
                        {scenario.badge && (
                          <Chip tone={scenario.id === "bypass-cn-lan" ? "green" : "blue"}>
                            {t(`scenarios.${scenario.id}.badge`, scenario.badge)}
                          </Chip>
                        )}
                      </div>
                      <p className="text-xs leading-relaxed text-kumo-subtle">
                        {t(`scenarios.${scenario.id}.desc`, scenario.description)}
                      </p>
                      <div className="mt-auto flex w-full items-center justify-between gap-2 pt-2">
                        <span className="text-[11px] text-kumo-subtle tabular-nums">
                          {t("scenarios.summaryGroups", "{groups} groups · {rules} rules", {
                            groups: scenario.groups.length,
                            rules: scenario.rules.length,
                          })}
                        </span>
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          disabled={save.isPending}
                          onClick={() => applyScenario(scenario)}
                        >
                          {t("scenarios.apply", "Apply to draft")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}
          <form className="routing-form" onSubmit={submit}>
            <DefaultAction
              policy={draft}
              onChange={
                edit
                  ? (encoded) => {
                      const decoded = decodeTarget(encoded);
                      setChanges({
                        ...draft,
                        default_action: decoded.action,
                        default_group_id: decoded.group_id ?? null,
                      });
                    }
                  : undefined
              }
              disabled={save.isPending}
            />
            <GroupsEditor
              groups={draftGroups}
              ruleSets={draftRuleSets}
              disabled={save.isPending}
              onChangeGroups={edit ? updateGroups : undefined}
              onChangeRuleSets={edit ? (rule_sets) => setChanges({ ...draft, rule_sets }) : undefined}
            />
            <RulesEditor
              rules={draft.rules}
              groups={draftGroups}
              disabled={save.isPending}
              onChange={edit ? (rules) => setChanges({ ...draft, rules }) : undefined}
            />
            <NativeEditor current={draft.native} drafts={native} onChange={edit ? setNative : undefined} />
            <Banner error={validation || save.error} />
            <div className="routing-actions">
              {edit && (dirty || state.draft) && (
                <Button variant="ghost" type="button" disabled={save.isPending} onClick={() => confirm({ kind: "discard" })}>
                  {t("draft.discard", "Discard draft")}
                </Button>
              )}
              {edit && (
                <Button variant={dirty ? "primary" : "secondary"} type="submit" icon={FloppyDisk} disabled={!dirty} loading={save.isPending}>
                  {t("draft.save", "Save draft")}
                </Button>
              )}
              {publish && (
                <Button variant="primary" type="button" icon={Check} disabled={!state.draft || dirty || save.isPending} onClick={() => confirm({ kind: "publish" })}>
                  {t("draft.publish", "Publish draft")}
                </Button>
              )}
            </div>
          </form>
        </>
      )}
      {view === "live" && (
        <>
          {canDraft && state.draft && (
            <KumoBanner
              size="sm"
              variant="secondary"
              title={t("live.draft", "Saved draft available")}
              action={
                <Button variant="secondary" onClick={() => setView("draft")}>
                  {t("live.openDraft", "Open draft")}
                </Button>
              }
            />
          )}
          <DefaultAction policy={state.published} revision={state.revision} />
          <GroupsEditor groups={state.published.groups ?? []} ruleSets={state.published.rule_sets ?? []} />
          <RulesEditor rules={state.published.rules} groups={state.published.groups ?? []} />
          <NativeEditor current={state.published.native} drafts={{}} />
        </>
      )}
      {view === "preview" && (
        <RoutingPreview
          published={state.published}
          draft={canDraft && (dirty || state.draft) ? draft : undefined}
          nativeChanged={Object.keys(native).length > 0}
        />
      )}
      {view === "history" && (
        <section className="panel">
          <header className="panel-header">
            <div>
              <h2>{t("history.title", "Published revisions")}</h2>
              <p className="muted">{t("history.help", "Restore an earlier revision as the live policy.")}</p>
            </div>
          </header>
          <Banner error={revisions.error} />
          {revisions.isPending ? (
            <Loading label={t("history.loading", "Loading revision history…")} />
          ) : revisions.data?.length ? (
            <ul className="routing-revisions">
              {revisions.data.map((revision) => (
                <li key={revision}>
                  <strong>{t("history.revision", "Revision {revision}", { revision })}</strong>
                  {revision === state.revision ? (
                    <Chip tone="green">{t("history.live", "Live")}</Chip>
                  ) : (
                    publish && (
                      <Button
                        variant="secondary"
                        icon={ArrowCounterClockwise}
                        type="button"
                        aria-label={t("history.restoreLabel", "Restore revision {revision}", { revision })}
                        disabled={dirty}
                        onClick={() => confirm({ kind: "restore", revision })}
                      >
                        {t("history.restore", "Restore")}
                      </Button>
                    )
                  )}
                </li>
              ))}
            </ul>
          ) : (
            !revisions.isError && <Empty title={t("history.empty", "No published revisions")} />
          )}
          {dirty && (
            <div className="panel-body">
              <KumoBanner size="sm" variant="secondary" description={t("history.dirty", "Save your draft changes before restoring a revision.")} />
            </div>
          )}
        </section>
      )}
      <Modal
        open={operation?.kind === "discard" ? edit : !!operation && publish}
        title={
          operation?.kind === "discard"
            ? t("confirm.discard", "Discard routing draft?")
            : operation?.kind === "restore"
              ? t("confirm.restore", "Restore revision {revision}?", { revision: operation.revision })
              : t("confirm.publish", "Publish routing policy?")
        }
        description={
          operation?.kind === "discard"
            ? t("confirm.discardHelp", "Delete the draft and any unsaved edits.")
            : t("confirm.applyHelp", "The selected policy applies to clients on their next subscription refresh.")
        }
        pending={apply.isPending}
        onClose={() => setOperation(undefined)}
      >
        <form
          className="form-fields"
          onSubmit={(event) => {
            event.preventDefault();
            if (operation) apply.mutate(operation);
          }}
        >
          <Banner error={apply.error} />
          <FormActions
            pending={apply.isPending}
            destructive={operation?.kind === "discard"}
            label={
              operation?.kind === "discard"
                ? t("draft.discard", "Discard draft")
                : operation?.kind === "restore"
                  ? t("history.restoreAction", "Restore revision")
                  : t("confirm.publishAction", "Publish policy")
            }
            onClose={() => setOperation(undefined)}
          />
        </form>
      </Modal>
    </>
  );
}

function DefaultAction({
  policy,
  revision,
  onChange,
  disabled,
}: {
  policy: Policy;
  revision?: number;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useT("routing");
  const groups = policy.groups ?? [];
  const items: Record<string, string> = {
    proxy: t("action.proxy", actionLabels.proxy),
    direct: t("action.direct", actionLabels.direct),
    block: t("action.block", actionLabels.block),
    ...Object.fromEntries(groups.map((g) => [`group:${g.id}`, t("action.groupTarget", "Group: {name}", { name: g.name })])),
  };
  const currentValue = encodeTarget(policy.default_action, policy.default_group_id);
  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h2>{t("fallback.title", "Default action")}</h2>
          <p className="muted">{t("fallback.help", "Applies when traffic matches none of the rules below.")}</p>
        </div>
        {revision !== undefined && <Chip tone="green">{t("fallback.revision", "Live revision {revision}", { revision })}</Chip>}
      </header>
      <div className="panel-body">
        {onChange ? (
          <div className="max-w-sm">
            <Select
              aria-label={t("fallback.title", "Default action")}
              items={items}
              value={currentValue}
              disabled={disabled}
              onValueChange={(value: string | null) => {
                if (value) onChange(value);
              }}
            />
          </div>
        ) : (
          <strong>{items[currentValue] ?? currentValue}</strong>
        )}
      </div>
    </section>
  );
}
