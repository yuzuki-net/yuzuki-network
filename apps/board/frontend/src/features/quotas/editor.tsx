import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { ArrowCounterClockwise, Plus, Trash } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useResource } from "../../app/query";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, FormActions, Loading, Modal } from "../../components/console-ui";
import { bytes, dateTime, percent } from "../../components/format";
import { english, useLocale, useT } from "../../i18n";
import { displayName, type Account } from "../session/model";
import { decimalInput, quotaAmount, unitLabels, type Unit } from "./amount";
import {
  quotaGrantsPath,
  quotaPath,
  quotaPlansPath,
  quotaPolicyPath,
  type DurationKind,
  type GrantInput,
  type QuotaDetails,
  type QuotaGrant,
  type QuotaPlan,
  type QuotaPolicyInput,
  type ResetMode,
  type RoleLinkLimits,
} from "./model";
import { RoleLinkFields } from "./role-link-fields";
import "./style.css";

export { quotaPath } from "./model";

const TRANSFER_PRESETS: { label: string; value?: string; unit?: Unit; unlimited?: boolean }[] = [
  { label: "10 GiB", value: "10", unit: "GiB" },
  { label: "50 GiB", value: "50", unit: "GiB" },
  { label: "100 GiB", value: "100", unit: "GiB" },
  { label: "500 GiB", value: "500", unit: "GiB" },
  { label: "1 TiB", value: "1", unit: "TiB" },
  { label: "Unlimited", unlimited: true },
];

const DURATION_PRESETS: { label: string; kind: DurationKind; value: string }[] = [
  { label: "10d", kind: "days", value: "10" },
  { label: "20d", kind: "days", value: "20" },
  { label: "1mo", kind: "months", value: "1" },
  { label: "3mo", kind: "months", value: "3" },
  { label: "1yr", kind: "years", value: "1" },
];

export function formatGrantDuration(
  kind: DurationKind,
  value: number | null,
  reset: ResetMode,
  t: (key: string, fallback: string, values?: Record<string, string | number>) => string,
): string {
  if (kind === "unlimited" || !value) {
    return t("duration.unlimited", "Never expires");
  }
  const unitLabel = t(`durationUnit.${kind}`, kind);
  const base = t("duration.valueUnit", "{value} {unit}", { value, unit: unitLabel });
  return reset === "cycle"
    ? t("duration.cycle", "{duration} · Resets each cycle", { duration: base })
    : t("duration.oneTime", "{duration} · One-time", { duration: base });
}

export function QuotaEditor({ user, onClose }: { user?: Account; onClose: () => void }) {
  const t = useT("quotas");
  const [pending, setPending] = useState(false);
  const status = useResource<QuotaDetails>(quotaPolicyPath(user?.id ?? ""), !!user);
  const plans = useResource<QuotaPlan[]>(quotaPlansPath, !!user);
  return (
    <Modal
      title={status.data?.can_edit ? t("editQuota", "Edit quota") : t("viewQuota", "Quota policy")}
      description={user && displayName(user)}
      open={!!user}
      onClose={onClose}
      pending={pending}
      large
    >
      {user &&
        (status.isPending ? (
          <Loading label={t("loadingPolicy", "Loading quota policy…")} />
        ) : status.isError ? (
          <Banner error={status.error} />
        ) : (
          <QuotaForm
            key={user.id}
            id={user.id}
            policy={status.data}
            plans={plans.data ?? []}
            onClose={onClose}
            onPending={setPending}
          />
        ))}
    </Modal>
  );
}

function QuotaForm({
  id,
  policy,
  plans,
  onClose,
  onPending,
}: {
  id: string;
  policy: QuotaDetails;
  plans: QuotaPlan[];
  onClose: () => void;
  onPending: (pending: boolean) => void;
}) {
  const t = useT("quotas");
  const { locale } = useLocale();
  const toast = useKumoToastManager();
  const cache = useQueryClient();

  // Issue grant state
  const [showIssue, setShowIssue] = useState(policy.grants.filter((g) => !g.revoked).length === 0);
  const [issueMode, setIssueMode] = useState<"plan" | "custom">(plans.length > 0 ? "plan" : "custom");
  const [selectedPlanId, setSelectedPlanId] = useState(plans[0]?.id ?? "");
  const [grantName, setGrantName] = useState("");
  const [grantUnlimited, setGrantUnlimited] = useState(false);
  const [grantValue, setGrantValue] = useState("100");
  const [grantUnit, setGrantUnit] = useState<Unit>("GiB");
  const [durationKind, setDurationKind] = useState<DurationKind>("months");
  const [durationValue, setDurationValue] = useState("1");
  const [resetMode, setResetMode] = useState<ResetMode>("cycle");
  const [grantPriority, setGrantPriority] = useState("0");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [issueValidation, setIssueValidation] = useState<unknown>();

  // Policy override state (devices + 4-format link limits)
  const [overrideDevices, setOverrideDevices] = useState(
    policy.override_max_devices !== null ? String(policy.override_max_devices) : "",
  );
  const [limits, setLimits] = useState<RoleLinkLimits>(policy.link_limits);
  const [policyValidation, setPolicyValidation] = useState<unknown>();

  const invalidateAll = () => {
    void cache.invalidateQueries({
      predicate: (query) => {
        const url = String(query.queryKey[0]);
        return url.startsWith(quotaPath) || url.startsWith("/api/v1/admin/users") || url.startsWith("/api/v1/me");
      },
    });
  };

  const issueGrant = useMutation({
    mutationFn: (payload: GrantInput) => api(quotaGrantsPath(id), "POST", payload),
    onSuccess: () => {
      toast.add({ title: t("grants.issued", "Quota package added"), variant: "success" });
      setGrantName("");
      setReplaceExisting(false);
      setShowIssue(false);
      invalidateAll();
    },
    onSettled: () => onPending(false),
  });

  const revokeGrant = useMutation({
    mutationFn: (grantId: string) => api(`${quotaGrantsPath(id)}/${grantId}`, "DELETE"),
    onSuccess: () => {
      toast.add({ title: t("grants.revoked", "Quota package removed"), variant: "success" });
      invalidateAll();
    },
  });

  const resetGrant = useMutation({
    mutationFn: (grantId: string) => api(`${quotaGrantsPath(id)}/${grantId}/reset`, "POST"),
    onSuccess: () => {
      toast.add({ title: t("grants.resetToast", "Package usage reset to 0"), variant: "success" });
      invalidateAll();
    },
  });

  const updatePolicy = useMutation({
    mutationFn: (next: QuotaPolicyInput) => api(quotaPolicyPath(id), "PUT", next),
    onSuccess: () => {
      toast.add({ title: t("saved", "Quota overrides saved"), variant: "success" });
      invalidateAll();
      onClose();
    },
    onSettled: () => onPending(false),
  });

  const disabled = !policy.can_edit;
  const activeGrants = policy.grants.filter((g) => !g.revoked);

  function submitGrant(event: FormEvent) {
    event.preventDefault();
    if (disabled || issueGrant.isPending) return;
    setIssueValidation(null);
    try {
      if (issueMode === "plan") {
        if (!selectedPlanId) throw new Error(english("quotas", "grants.errPlan", "Select a quota plan template."));
        onPending(true);
        issueGrant.mutate({
          plan_id: selectedPlanId,
          ...(grantName.trim() ? { name: grantName.trim() } : {}),
          replace_existing: replaceExisting,
        });
        return;
      }

      let quotaBytes: string | null = null;
      if (!grantUnlimited) {
        try {
          quotaBytes = quotaAmount(decimalInput(grantValue, locale), grantUnit).toString();
        } catch {
          throw new Error(english("quotas", "invalidTransfer", "Enter an allowance equivalent to whole bytes, within the supported range."));
        }
      }
      let parsedDuration: number | null = null;
      if (durationKind !== "unlimited") {
        const d = Number(durationValue);
        if (!Number.isInteger(d) || d < 1 || d > 36500) {
          throw new Error(english("quotas", "invalidCalendarDuration", "Enter a whole duration value between 1 and 36500."));
        }
        parsedDuration = d;
      }
      const parsedPriority = Number.parseInt(grantPriority || "0", 10);
      onPending(true);
      issueGrant.mutate({
        name: grantName.trim() || t("grants.customDefaultName", "Custom package"),
        quota_bytes: quotaBytes,
        duration_kind: durationKind,
        duration_value: parsedDuration,
        reset_mode: durationKind === "unlimited" ? "none" : resetMode,
        priority: Number.isNaN(parsedPriority) ? 0 : parsedPriority,
        replace_existing: replaceExisting,
      });
    } catch (err) {
      setIssueValidation(err);
    }
  }

  function submitPolicy(event: FormEvent) {
    event.preventDefault();
    if (disabled || updatePolicy.isPending) return;
    setPolicyValidation(null);
    try {
      let maxDevices: number | null = null;
      if (overrideDevices.trim() !== "") {
        const parsed = Number(overrideDevices);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
          throw new Error(english("quotas", "invalidDevices", "Enter a device limit between 0 and 1000."));
        }
        maxDevices = parsed;
      }
      onPending(true);
      updatePolicy.mutate({ max_devices: maxDevices, link_limits: limits });
    } catch (err) {
      setPolicyValidation(err);
    }
  }

  function stateTone(state: QuotaGrant["state"]): "green" | "blue" | "amber" | "neutral" {
    if (state === "available") return "green";
    if (state === "scheduled") return "blue";
    return "amber";
  }

  return (
    <div className="flex flex-col gap-5 quota-editor">
      {/* Live Account Quota Summary */}
      <dl className="quota-current">
        <div>
          <dt>{t("windowUsed", "Transfer used")}</dt>
          <dd>{bytes(policy.used_bytes)}</dd>
        </div>
        <div>
          <dt>{t("currentLimit", "Total allowance")}</dt>
          <dd>{policy.quota_bytes === null ? t("unlimited", "Unlimited") : bytes(policy.quota_bytes)}</dd>
        </div>
        <div>
          <dt>{t("remaining", "Remaining")}</dt>
          <dd>{policy.remaining_bytes === null ? t("unlimited", "Unlimited") : bytes(policy.remaining_bytes)}</dd>
        </div>
        <div>
          <dt>{t("registeredDevices", "Device bindings")}</dt>
          <dd>
            {policy.active_devices}
            {policy.max_devices !== null ? ` / ${policy.max_devices}` : ""}
          </dd>
        </div>
      </dl>

      {/* Section 1: Stackable Quota Packages (Grants) */}
      <div className="flex flex-col gap-3 rounded-lg border border-kumo-line p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-kumo-strong">
              {t("grants.title", "Active quota packages ({count})", { count: activeGrants.length })}
            </h3>
            <p className="text-xs text-kumo-subtle">
              {t(
                "grants.help",
                "Multiple packages stack automatically. Traffic deducts in waterfall order: highest priority first, then earliest expiring/resetting before permanent add-ons.",
              )}
            </p>
          </div>
          {!disabled && (
            <Button
              type="button"
              variant={showIssue ? "secondary" : "primary"}
              size="xs"
              icon={Plus}
              onClick={() => setShowIssue((v) => !v)}
            >
              {showIssue ? t("grants.hideForm", "Cancel") : t("grants.addPackage", "Add / stack package")}
            </Button>
          )}
        </div>

        <Banner error={revokeGrant.error || resetGrant.error} />

        {activeGrants.length === 0 ? (
          <p className="rounded-md border border-dashed border-kumo-line bg-kumo-recessed/30 px-3 py-3 text-xs text-kumo-subtle">
            {t("grants.empty", "This account has no active quota packages. Add a package below to grant subscription access.")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {activeGrants.map((grant) => (
              <div
                key={grant.id}
                className="flex flex-col gap-2 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <strong className="text-sm text-kumo-strong">{grant.name}</strong>
                    <Chip tone={stateTone(grant.state)}>{t(grant.state, grant.state)}</Chip>
                    <Badge variant="secondary">
                      {formatGrantDuration(grant.duration_kind, grant.duration_value, grant.reset_mode, t)}
                    </Badge>
                    {grant.priority !== 0 && (
                      <Badge variant="outline">
                        {t("grants.priorityBadge", "Priority {n}", { n: grant.priority })}
                      </Badge>
                    )}
                  </div>
                  {!disabled && (
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        icon={ArrowCounterClockwise}
                        loading={resetGrant.isPending}
                        onClick={() => resetGrant.mutate(grant.id)}
                      >
                        {t("grants.reset", "Reset")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        icon={Trash}
                        loading={revokeGrant.isPending}
                        onClick={() => revokeGrant.mutate(grant.id)}
                      >
                        {t("grants.remove", "Remove")}
                      </Button>
                    </div>
                  )}
                </div>

                {grant.quota_bytes === null ? (
                  <p className="text-xs text-kumo-subtle">
                    {t("usedUnlimited", "{used} · Unlimited", { used: bytes(grant.used_bytes) })}
                  </p>
                ) : (
                  <Meter
                    label={t("usedOf", "{used} of {limit}", {
                      used: bytes(grant.used_bytes),
                      limit: bytes(grant.quota_bytes),
                    })}
                    value={percent(grant.used_bytes, grant.quota_bytes)}
                    customValue={`${bytes(grant.used_bytes)} / ${bytes(grant.quota_bytes)}`}
                  />
                )}

                {(grant.cycle_ends_at || grant.expires_at) && (
                  <p className="text-[11px] text-kumo-subtle">
                    {grant.reset_mode === "cycle" && grant.cycle_ends_at
                      ? t("nextReset", "Next reset: {date}", { date: dateTime(grant.cycle_ends_at) })
                      : grant.expires_at
                        ? t("previewExpiry", "Ends: {date}", { date: dateTime(grant.expires_at) })
                        : null}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Inline Issue / Stack Package Form */}
        {!disabled && showIssue && (
          <form
            className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-base p-3.5"
            onSubmit={submitGrant}
          >
            <div className="grid items-start gap-3 sm:grid-cols-2">
              <Select
                label={t("grants.sourceMode", "Package source")}
                value={issueMode}
                items={{
                  plan: t("grants.fromPlan", "From quota plan template"),
                  custom: t("grants.custom", "Custom ad-hoc package"),
                }}
                onValueChange={(v: string | null) => {
                  if (v === "plan" || v === "custom") setIssueMode(v);
                }}
              />
              {issueMode === "plan" ? (
                <Select
                  label={t("grants.selectPlan", "Quota plan")}
                  value={selectedPlanId}
                  items={Object.fromEntries(
                    plans.map((p) => [
                      p.id,
                      `${p.name} (${p.quota_bytes === null ? t("unlimited", "Unlimited") : bytes(p.quota_bytes)})`,
                    ]),
                  )}
                  onValueChange={(v: string | null) => {
                    if (v) setSelectedPlanId(v);
                  }}
                />
              ) : (
                <Input
                  label={t("grants.packageName", "Package name")}
                  value={grantName}
                  placeholder={t("grants.packageNamePlaceholder", "e.g. 50 GiB Add-on Pack")}
                  onChange={(e) => setGrantName(e.target.value)}
                />
              )}
            </div>

            {issueMode === "custom" && (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-kumo-subtle">{t("quickPresets", "Presets:")}</span>
                  {TRANSFER_PRESETS.map((preset) => (
                    <Button
                      key={preset.label}
                      type="button"
                      variant="secondary"
                      size="xs"
                      onClick={() => {
                        if (preset.unlimited) {
                          setGrantUnlimited(true);
                        } else {
                          setGrantUnlimited(false);
                          setGrantValue(preset.value!);
                          setGrantUnit(preset.unit!);
                        }
                      }}
                    >
                      {preset.unlimited ? t("unlimited", "Unlimited") : preset.label}
                    </Button>
                  ))}
                </div>

                <Switch
                  label={t("plans.unlimitedTransfer", "Unlimited transfer allowance")}
                  checked={grantUnlimited}
                  onCheckedChange={setGrantUnlimited}
                />

                {!grantUnlimited && (
                  <div className="quota-inputs">
                    <Input
                      label={t("transferLimit", "Transfer limit")}
                      inputMode="decimal"
                      value={grantValue}
                      required
                      onChange={(e) => setGrantValue(e.target.value)}
                    />
                    <Select
                      label={t("transferUnit", "Transfer unit")}
                      items={{ ...unitLabels, bytes: t("bytes", "Bytes") }}
                      value={grantUnit}
                      onValueChange={(v: Unit | null) => {
                        if (v) setGrantUnit(v);
                      }}
                    />
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-kumo-subtle">{t("durationPresets", "Duration:")}</span>
                  {DURATION_PRESETS.map((p) => (
                    <Button
                      key={p.label}
                      type="button"
                      variant="secondary"
                      size="xs"
                      onClick={() => {
                        setDurationKind(p.kind);
                        setDurationValue(p.value);
                      }}
                    >
                      {p.label}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    onClick={() => {
                      setDurationKind("unlimited");
                      setResetMode("none");
                    }}
                  >
                    {t("duration.unlimited", "Never expires")}
                  </Button>
                </div>

                <div className="grid items-start gap-3 sm:grid-cols-3">
                  <Select
                    label={t("plans.durationKind", "Duration unit")}
                    value={durationKind}
                    items={{
                      unlimited: t("duration.unlimited", "Never expires"),
                      hours: t("durationUnit.hours", "Hours"),
                      days: t("durationUnit.days", "Days"),
                      months: t("durationUnit.months", "Calendar months"),
                      years: t("durationUnit.years", "Calendar years"),
                    }}
                    onValueChange={(v: DurationKind | null) => {
                      if (v) {
                        setDurationKind(v);
                        if (v === "unlimited") setResetMode("none");
                      }
                    }}
                  />
                  {durationKind !== "unlimited" && (
                    <>
                      <Input
                        label={t("plans.durationValue", "Duration length")}
                        type="number"
                        min={1}
                        max={36500}
                        value={durationValue}
                        required
                        onChange={(e) => setDurationValue(e.target.value)}
                      />
                      <Select
                        label={t("plans.resetMode", "Reset behavior")}
                        value={resetMode}
                        items={{
                          cycle: t("resetMode.cycle", "Reset each cycle"),
                          none: t("resetMode.none", "One-time (no reset)"),
                        }}
                        onValueChange={(v: ResetMode | null) => {
                          if (v) setResetMode(v);
                        }}
                      />
                    </>
                  )}
                </div>

                <div className="max-w-xs">
                  <Input
                    label={t("plans.priority", "Deduction priority")}
                    type="number"
                    value={grantPriority}
                    description={t("plans.priorityHint", "Higher priority packages are consumed first.")}
                    onChange={(e) => setGrantPriority(e.target.value)}
                  />
                </div>
              </>
            )}

            <Switch
              label={t("grants.replaceExisting", "Replace all existing active packages (leave off to stack)")}
              checked={replaceExisting}
              onCheckedChange={setReplaceExisting}
            />

            <Banner error={issueValidation || issueGrant.error} />

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setShowIssue(false)}>
                {t("close", "Close")}
              </Button>
              <Button type="submit" variant="primary" size="sm" loading={issueGrant.isPending}>
                {t("grants.issueButton", "Issue package")}
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* Section 2: Account Device & Link Limit Overrides */}
      <form className="form-fields" onSubmit={submitPolicy}>
        <Input
          label={t("deviceOverride", "Account device limit override (optional)")}
          type="number"
          inputMode="numeric"
          min={0}
          max={1000}
          step={1}
          disabled={disabled || updatePolicy.isPending}
          value={overrideDevices}
          placeholder={
            policy.max_devices !== null
              ? t("inheritedValue", "Effective: {count}", { count: policy.max_devices })
              : t("unlimited", "Unlimited")
          }
          description={t(
            "deviceOverrideHint",
            "Leave blank to inherit from active quota packages. Set a number to override specifically for this account.",
          )}
          onChange={(e) => setOverrideDevices(e.target.value)}
        />

        <RoleLinkFields
          context="account"
          value={limits}
          inherited={policy.inherited_link_limits}
          onChange={setLimits}
          disabled={disabled || updatePolicy.isPending}
        />

        <Banner error={policyValidation || updatePolicy.error} />

        {policy.can_edit ? (
          <FormActions
            pending={updatePolicy.isPending}
            onClose={onClose}
            label={t("saveOverrides", "Save overrides")}
          />
        ) : (
          <div className="dialog-actions">
            <Button variant="secondary" type="button" onClick={onClose}>
              {t("close", "Close")}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
