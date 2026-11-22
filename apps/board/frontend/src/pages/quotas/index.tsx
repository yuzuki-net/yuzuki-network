import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Select } from "@cloudflare/kumo/components/select";
import { Switch } from "@cloudflare/kumo/components/switch";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useResource } from "../../app/query";
import { useConsoleLocation, useConsoleNavigate } from "../../app/router";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, Empty, FormActions, Modal, PageHeader } from "../../components/console-ui";
import { DataTable, DataToolbar, RowActions, type ActiveFilterChip, type Column } from "../../components/data-table";
import { bytes, percent } from "../../components/format";
import { ConfirmDeleteDialog } from "../../components/kumo-ext";
import { useDirectory } from "../../features/directory/query";
import { decimalInput, existingAmount, quotaAmount, unitLabels, type Unit } from "../../features/quotas/amount";
import { formatGrantDuration, QuotaEditor, quotaPath } from "../../features/quotas/editor";
import {
  inheritedLinkLimits,
  quotaPlansPath,
  type DurationKind,
  type QuotaPlan,
  type QuotaPlanInput,
  type ResetMode,
  type RoleLinkLimits,
} from "../../features/quotas/model";
import { RoleLinkFields } from "../../features/quotas/role-link-fields";
import { useCan } from "../../features/session/context";
import { displayName, type Account } from "../../features/session/model";
import { english, useLocale, useT } from "../../i18n";
import "./style.css";

type AccessFilter = "all" | "available" | "exhausted" | "expired" | "scheduled" | "inactive";

const PLAN_TRANSFER_PRESETS: { label: string; value?: string; unit?: Unit; unlimited?: boolean }[] = [
  { label: "50 GiB", value: "50", unit: "GiB" },
  { label: "100 GiB", value: "100", unit: "GiB" },
  { label: "500 GiB", value: "500", unit: "GiB" },
  { label: "1 TiB", value: "1", unit: "TiB" },
  { label: "Unlimited", unlimited: true },
];

const PLAN_DURATION_PRESETS: { label: string; kind: DurationKind; value: string }[] = [
  { label: "10d", kind: "days", value: "10" },
  { label: "20d", kind: "days", value: "20" },
  { label: "1mo", kind: "months", value: "1" },
  { label: "3mo", kind: "months", value: "3" },
  { label: "1yr", kind: "years", value: "1" },
];

export default function Quotas() {
  const t = useT("quotas");
  const { locale } = useLocale();
  const href = useConsoleLocation();
  const navigate = useConsoleNavigate();
  const params = new URL(href, location.origin).searchParams;
  const activeTab = params.get("tab") === "plans" ? "plans" : "accounts";

  const directory = useDirectory(quotaPath);
  const plans = useResource<QuotaPlan[]>(quotaPlansPath);
  const canEdit = useCan("quotas.manage");
  const cache = useQueryClient();
  const toast = useKumoToastManager();

  const [selected, setSelected] = useState<Account>();
  const [accessFilter, setAccessFilter] = useState<AccessFilter>("all");
  const [planSearch, setPlanSearch] = useState("");
  const [planModal, setPlanModal] = useState<{ open: boolean; plan?: QuotaPlan }>({ open: false });
  const [deletePlanTarget, setDeletePlanTarget] = useState<QuotaPlan | null>(null);

  const { result } = directory;
  const filters = !!directory.query || directory.filter !== "all" || accessFilter !== "all";
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const labels = {
    available: t("available", "Available"),
    scheduled: t("scheduled", "Scheduled"),
    expired: t("expired", "Expired"),
    exhausted: t("exhausted", "Limit reached"),
    inactive: t("inactive", "Account inactive"),
  };

  const deletePlan = useMutation({
    mutationFn: (id: string) => api(`${quotaPlansPath}/${id}`, "DELETE"),
    onSuccess: () => {
      setDeletePlanTarget(null);
      toast.add({ title: t("plans.deleted", "Quota plan deleted"), variant: "success" });
      void cache.invalidateQueries({ queryKey: [quotaPlansPath] });
    },
  });

  const allItems = result.data?.items ?? [];
  const visibleItems =
    accessFilter === "all"
      ? allItems
      : allItems.filter((row) => (row.quota?.state ?? (row.active ? "available" : "inactive")) === accessFilter);

  const visiblePlans = (plans.data ?? []).filter((p) => {
    const q = planSearch.trim().toLowerCase();
    return !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
  });

  const activeFilters: ActiveFilterChip[] = [];
  if (directory.query.trim()) {
    activeFilters.push({
      key: "q",
      label: t("searchAccounts", "Search accounts"),
      value: directory.query.trim(),
      onRemove: () => directory.changeQuery(""),
    });
  }
  if (directory.filter !== "all") {
    activeFilters.push({
      key: "status",
      label: t("status", "Status"),
      value: directory.filter === "true" ? t("active", "Active") : t("inactiveFilter", "Inactive"),
      onRemove: () => directory.changeFilter("all"),
    });
  }
  if (accessFilter !== "all") {
    activeFilters.push({
      key: "access",
      label: t("subscriptionAccess", "Access"),
      value: labels[accessFilter],
      onRemove: () => setAccessFilter("all"),
    });
  }

  const accountColumns: Column<Account>[] = [
    {
      key: "account",
      title: t("account", "Account"),
      cell: (row) => (
        <div className="quota-account">
          <strong className="text-kumo-strong">{displayName(row)}</strong>
          {row.display_name && <p className="muted text-xs">{row.email}</p>}
        </div>
      ),
    },
    {
      key: "usage",
      title: t("windowUsed", "Transfer used"),
      cell: (row) => {
        const used = row.quota?.used_bytes ?? row.used_bytes;
        const limit = row.quota ? row.quota.quota_bytes : row.quota_bytes;
        return limit === null ? (
          <span>{t("usedUnlimited", "{used} · Unlimited", { used: bytes(used) })}</span>
        ) : (
          <Meter
            className="quota-meter"
            label={t("usedOf", "{used} of {limit}", { used: bytes(used), limit: bytes(limit) })}
            value={percent(used, limit)}
            customValue={new Intl.NumberFormat(locale, { style: "percent" }).format(percent(used, limit) / 100)}
          />
        );
      },
    },
    {
      key: "packages",
      title: t("packagesCol", "Active packages"),
      omitOnMobile: true,
      cell: ({ quota }) => {
        const active = (quota?.grants ?? []).filter((g) => !g.revoked && g.state === "available");
        if (active.length === 0) return <span className="text-xs text-kumo-subtle">—</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {active.slice(0, 2).map((g) => (
              <Badge key={g.id} variant="secondary">
                {g.name}
              </Badge>
            ))}
            {active.length > 2 && <Badge variant="outline">+{active.length - 2}</Badge>}
          </div>
        );
      },
    },
    {
      key: "period",
      title: t("periodType", "Next reset / expiry"),
      omitOnMobile: true,
      cell: ({ quota }) => {
        const active = (quota?.grants ?? []).filter((g) => !g.revoked && g.state === "available");
        if (!quota?.window_ends_at) {
          return <span className="text-xs text-kumo-subtle">{t("duration.unlimited", "Never expires")}</span>;
        }
        const isReset = active.some((g) => g.reset_mode === "cycle" && g.cycle_ends_at === quota.window_ends_at);
        return (
          <span className="text-xs text-kumo-default">
            {isReset
              ? t("resetDate", "Resets {date}", { date: date.format(new Date(quota.window_ends_at)) })
              : t("endDate", "Ends {date}", { date: date.format(new Date(quota.window_ends_at)) })}
          </span>
        );
      },
    },
    {
      key: "status",
      title: t("subscriptionAccess", "Access"),
      width: "9.5rem",
      cell: (row) => {
        const state = row.quota?.state ?? (row.active ? "available" : "inactive");
        return (
          <Chip tone={state === "available" ? "green" : state === "scheduled" ? "blue" : "amber"}>
            {labels[state]}
          </Chip>
        );
      },
    },
    {
      key: "actions",
      title: "",
      width: "4rem",
      end: true,
      sticky: true,
      cell: (row) => (
        <RowActions
          item={displayName(row)}
          actions={[
            {
              label: canEdit ? t("editQuota", "Edit quota") : t("viewQuota", "Quota policy"),
              icon: PencilSimple,
              run: () => setSelected(row),
            },
          ]}
        />
      ),
    },
  ];

  const planColumns: Column<QuotaPlan>[] = [
    {
      key: "name",
      title: t("plans.name", "Plan name"),
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <strong className="text-kumo-strong">{row.name}</strong>
            {row.built_in && <Chip tone="green">{t("plans.builtIn", "Built-in")}</Chip>}
          </div>
          {row.description && <p className="muted text-xs">{row.description}</p>}
        </div>
      ),
    },
    {
      key: "allowance",
      title: t("currentLimit", "Allowance"),
      cell: (row) => (
        <span className="font-medium text-kumo-strong">
          {row.quota_bytes === null ? t("unlimited", "Unlimited") : bytes(row.quota_bytes)}
        </span>
      ),
    },
    {
      key: "duration",
      title: t("plans.durationCol", "Duration & reset"),
      omitOnMobile: true,
      cell: (row) => (
        <Badge variant="secondary">
          {formatGrantDuration(row.duration_kind, row.duration_value, row.reset_mode, t)}
        </Badge>
      ),
    },
    {
      key: "devices",
      title: t("plans.devicesCol", "Devices"),
      omitOnMobile: true,
      cell: (row) => (
        <span className="text-xs text-kumo-default">
          {row.max_devices === null ? t("unlimited", "Unlimited") : row.max_devices}
        </span>
      ),
    },
    {
      key: "priority",
      title: t("plans.priorityCol", "Priority"),
      omitOnMobile: true,
      cell: (row) => <span className="tabular-nums text-xs">{row.priority}</span>,
    },
    ...(canEdit
      ? [
          {
            key: "actions",
            title: "",
            width: "4rem",
            end: true,
            sticky: true,
            cell: (row: QuotaPlan) => (
              <RowActions
                item={row.name}
                actions={[
                  {
                    label: t("plans.edit", "Edit plan"),
                    icon: PencilSimple,
                    run: () => setPlanModal({ open: true, plan: row }),
                  },
                  ...(!row.built_in
                    ? [
                        {
                          label: t("plans.delete", "Delete plan"),
                          icon: Trash,
                          danger: true,
                          run: () => setDeletePlanTarget(row),
                        },
                      ]
                    : []),
                ]}
              />
            ),
          } satisfies Column<QuotaPlan>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={t("title", "Quotas")}
        description={t("description", "Manage reusable quota plan templates, stackable account packages, calendar cycles, and device limits.")}
        action={
          canEdit && activeTab === "plans" ? (
            <Button variant="primary" icon={Plus} onClick={() => setPlanModal({ open: true })}>
              {t("plans.create", "Create quota plan")}
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          variant="segmented"
          value={activeTab}
          onValueChange={(next) => navigate(next === "plans" ? "/admin/quotas?tab=plans" : "/admin/quotas")}
          tabs={[
            { value: "accounts", label: t("tabs.accounts", "Account quotas") },
            {
              value: "plans",
              label: `${t("tabs.plans", "Quota plans")} (${plans.data?.length ?? 0})`,
            },
          ]}
        />
      </div>

      <Banner error={activeTab === "accounts" ? result.error : plans.error || deletePlan.error} />

      {activeTab === "accounts" ? (
        <DataTable
          label={t("inventory", "Account quotas")}
          rows={visibleItems}
          columns={accountColumns}
          rowId={(row) => row.id}
          layout="auto"
          busy={result.isFetching}
          page={
            result.data && {
              index: directory.page,
              size: result.data.page_size,
              count: result.data.total,
              change: directory.setPage,
            }
          }
          toolbar={
            <DataToolbar
              quickFilters={{
                label: t("subscriptionAccess", "Access"),
                value: accessFilter,
                onChange: (value) => setAccessFilter(value as AccessFilter),
                options: [
                  { value: "all", label: t("accessAll", "All states") },
                  { value: "available", label: labels.available },
                  { value: "exhausted", label: labels.exhausted },
                  { value: "expired", label: labels.expired },
                  { value: "scheduled", label: labels.scheduled },
                  { value: "inactive", label: labels.inactive },
                ],
              }}
              search={{
                label: t("searchAccounts", "Search accounts"),
                placeholder: t("searchHint", "Name or email"),
                value: directory.query,
                onChange: directory.changeQuery,
                resultCount: accessFilter === "all" ? result.data?.total : visibleItems.length,
              }}
              activeFilters={activeFilters}
              onClear={
                filters
                  ? () => {
                      setAccessFilter("all");
                      directory.clear();
                    }
                  : undefined
              }
              onRefresh={() => void result.refetch()}
              refreshing={result.isFetching}
              options={
                <Select
                  aria-label={t("status", "Status")}
                  value={directory.filter}
                  items={{
                    all: t("allAccounts", "All accounts"),
                    true: t("active", "Active"),
                    false: t("inactiveFilter", "Inactive"),
                  }}
                  onValueChange={(value: string | null) => directory.changeFilter(value ?? "all")}
                />
              }
            />
          }
          empty={<Empty title={filters ? t("noMatches", "No matching accounts") : t("noAccounts", "No accounts yet")} />}
        />
      ) : (
        <DataTable
          label={t("tabs.plans", "Quota plans")}
          rows={visiblePlans}
          columns={planColumns}
          rowId={(row) => row.id}
          layout="auto"
          busy={plans.isFetching}
          toolbar={
            <DataToolbar
              search={{
                label: t("plans.search", "Search plans"),
                placeholder: t("plans.searchPlaceholder", "Plan name or description"),
                value: planSearch,
                onChange: setPlanSearch,
                resultCount: visiblePlans.length,
              }}
              onRefresh={() => void plans.refetch()}
              refreshing={plans.isFetching}
            />
          }
          empty={
            <Empty
              title={t("plans.empty", "No quota plans yet")}
              action={
                canEdit ? (
                  <Button variant="primary" icon={Plus} onClick={() => setPlanModal({ open: true })}>
                    {t("plans.create", "Create quota plan")}
                  </Button>
                ) : undefined
              }
            />
          }
        />
      )}

      <QuotaEditor user={selected} onClose={() => setSelected(undefined)} />

      <QuotaPlanModal
        open={planModal.open}
        plan={planModal.plan}
        onClose={() => setPlanModal({ open: false })}
      />

      <ConfirmDeleteDialog
        open={deletePlanTarget !== null}
        onClose={() => setDeletePlanTarget(null)}
        resourceType={t("plans.resource", "quota plan")}
        resourceName={deletePlanTarget?.name ?? ""}
        confirmLabel={t("plans.delete", "Delete plan")}
        description={t(
          "plans.deleteDesc",
          "Existing grants already issued to accounts will remain active and unaffected. Roles using this plan as default will revert to no default plan.",
        )}
        pending={deletePlan.isPending}
        error={deletePlan.error instanceof Error ? deletePlan.error.message : undefined}
        onConfirm={() => {
          if (deletePlanTarget) deletePlan.mutate(deletePlanTarget.id);
        }}
      />
    </>
  );
}

function QuotaPlanModal({
  open,
  plan,
  onClose,
}: {
  open: boolean;
  plan?: QuotaPlan;
  onClose: () => void;
}) {
  const t = useT("quotas");
  return (
    <Modal
      open={open}
      onClose={onClose}
      large
      title={plan ? t("plans.edit", "Edit quota plan") : t("plans.create", "Create quota plan")}
      description={t(
        "plans.modalDesc",
        "Define reusable transfer allowance, calendar duration, cycle reset behavior, and priority for new-user defaults or stackable add-on packs.",
      )}
    >
      {open && <QuotaPlanForm key={plan?.id ?? "new"} plan={plan} onClose={onClose} />}
    </Modal>
  );
}

function QuotaPlanForm({ plan, onClose }: { plan?: QuotaPlan; onClose: () => void }) {
  const t = useT("quotas");
  const { locale } = useLocale();
  const cache = useQueryClient();
  const toast = useKumoToastManager();

  const existing = existingAmount(plan?.quota_bytes ?? null);
  const [name, setName] = useState(plan?.name ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [unlimited, setUnlimited] = useState(plan ? plan.quota_bytes === null : false);
  const [value, setValue] = useState(plan?.quota_bytes ? existing.value : "100");
  const [unit, setUnit] = useState<Unit>(plan?.quota_bytes ? existing.unit : "GiB");
  const [durationKind, setDurationKind] = useState<DurationKind>(plan?.duration_kind ?? "months");
  const [durationValue, setDurationValue] = useState(plan?.duration_value ? String(plan.duration_value) : "1");
  const [resetMode, setResetMode] = useState<ResetMode>(plan?.reset_mode ?? "cycle");
  const [maxDevices, setMaxDevices] = useState(plan?.max_devices !== null && plan?.max_devices !== undefined ? String(plan.max_devices) : "");
  const [priority, setPriority] = useState(plan ? String(plan.priority) : "0");
  const [limits, setLimits] = useState<RoleLinkLimits>(plan?.link_limits ?? inheritedLinkLimits);
  const [validation, setValidation] = useState<unknown>();

  const save = useMutation({
    mutationFn: (payload: QuotaPlanInput) =>
      api<QuotaPlan>(plan ? `${quotaPlansPath}/${plan.id}` : quotaPlansPath, plan ? "PUT" : "POST", payload),
    onSuccess: () => {
      toast.add({
        title: plan ? t("plans.saved", "Quota plan updated") : t("plans.created", "Quota plan created"),
        variant: "success",
      });
      void cache.invalidateQueries({ queryKey: [quotaPlansPath] });
      void cache.invalidateQueries({ queryKey: ["/api/v1/admin/roles"] });
      onClose();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (save.isPending) return;
    setValidation(null);
    try {
      const cleanName = name.trim();
      if (!cleanName) throw new Error(english("quotas", "plans.errName", "Enter a plan name."));
      let quotaBytes: string | null = null;
      if (!unlimited) {
        try {
          quotaBytes = quotaAmount(decimalInput(value, locale), unit).toString();
        } catch {
          throw new Error(english("quotas", "invalidTransfer", "Enter an allowance equivalent to whole bytes, within the supported range."));
        }
      }
      let parsedDur: number | null = null;
      if (durationKind !== "unlimited") {
        const d = Number(durationValue);
        if (!Number.isInteger(d) || d < 1 || d > 36500) {
          throw new Error(english("quotas", "invalidCalendarDuration", "Enter a whole duration value between 1 and 36500."));
        }
        parsedDur = d;
      }
      let parsedDevices: number | null = null;
      if (maxDevices.trim() !== "") {
        const d = Number(maxDevices);
        if (!Number.isInteger(d) || d < 0 || d > 1000) {
          throw new Error(english("quotas", "invalidDevices", "Enter a device limit between 0 and 1000."));
        }
        parsedDevices = d;
      }
      const parsedPriority = Number.parseInt(priority || "0", 10);

      save.mutate({
        name: cleanName,
        description: description.trim(),
        quota_bytes: quotaBytes,
        duration_kind: durationKind,
        duration_value: parsedDur,
        reset_mode: durationKind === "unlimited" ? "none" : resetMode,
        max_devices: parsedDevices,
        link_limits: limits,
        priority: Number.isNaN(parsedPriority) ? 0 : parsedPriority,
      });
    } catch (err) {
      setValidation(err);
    }
  }

  return (
    <form className="form-fields" onSubmit={submit}>
      <Input
        label={t("plans.name", "Plan name")}
        value={name}
        maxLength={80}
        required
        disabled={plan?.built_in || save.isPending}
        placeholder="Monthly 100 GiB"
        onChange={(e) => setName(e.target.value)}
      />
      <Textarea
        label={t("plans.description", "Description")}
        value={description}
        rows={2}
        maxLength={400}
        disabled={save.isPending}
        onChange={(e) => setDescription(e.target.value)}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-kumo-subtle">{t("quickPresets", "Presets:")}</span>
        {PLAN_TRANSFER_PRESETS.map((p) => (
          <Button
            key={p.label}
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => {
              if (p.unlimited) {
                setUnlimited(true);
              } else {
                setUnlimited(false);
                setValue(p.value!);
                setUnit(p.unit!);
              }
            }}
          >
            {p.unlimited ? t("unlimited", "Unlimited") : p.label}
          </Button>
        ))}
      </div>

      <Switch
        label={t("plans.unlimitedTransfer", "Unlimited transfer allowance")}
        checked={unlimited}
        disabled={save.isPending}
        onCheckedChange={setUnlimited}
      />

      {!unlimited && (
        <div className="quota-inputs">
          <Input
            label={t("transferLimit", "Transfer limit")}
            inputMode="decimal"
            value={value}
            required
            disabled={save.isPending}
            onChange={(e) => setValue(e.target.value)}
          />
          <Select
            label={t("transferUnit", "Transfer unit")}
            items={{ ...unitLabels, bytes: t("bytes", "Bytes") }}
            value={unit}
            disabled={save.isPending}
            onValueChange={(v: Unit | null) => {
              if (v) setUnit(v);
            }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-kumo-subtle">{t("durationPresets", "Duration:")}</span>
        {PLAN_DURATION_PRESETS.map((p) => (
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
          disabled={save.isPending}
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
              disabled={save.isPending}
              onChange={(e) => setDurationValue(e.target.value)}
            />
            <Select
              label={t("plans.resetMode", "Reset behavior")}
              value={resetMode}
              disabled={save.isPending}
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

      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Input
          label={t("deviceLimit", "Maximum subscription devices (optional)")}
          type="number"
          min={0}
          max={1000}
          value={maxDevices}
          placeholder={t("unlimited", "Unlimited")}
          disabled={save.isPending}
          onChange={(e) => setMaxDevices(e.target.value)}
        />
        <Input
          label={t("plans.priority", "Deduction priority")}
          type="number"
          value={priority}
          disabled={save.isPending}
          description={t("plans.priorityHint", "Higher priority packages are consumed first.")}
          onChange={(e) => setPriority(e.target.value)}
        />
      </div>

      <RoleLinkFields context="plan" value={limits} onChange={setLimits} disabled={save.isPending} />

      <Banner error={validation || save.error} />

      <FormActions
        onClose={onClose}
        pending={save.isPending}
        label={plan ? t("plans.save", "Save plan") : t("plans.create", "Create quota plan")}
      />
    </form>
  );
}
