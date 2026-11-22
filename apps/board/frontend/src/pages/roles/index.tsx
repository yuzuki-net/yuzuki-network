import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Select } from "@cloudflare/kumo/components/select";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { LockSimple, PencilSimple, Plus } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useResource } from "../../app/query";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, Empty, FormActions, Loading, Modal, PageHeader } from "../../components/console-ui";
import { DataTable, DataToolbar, RowActions, type ActiveFilterChip, type Column } from "../../components/data-table";
import { bytes } from "../../components/format";
import { rolesPath, useCatalog } from "../../features/access/catalog";
import { PermissionGrid } from "../../features/access/permissions";
import {
  inheritedLinkLimits,
  quotaPlansPath,
  type QuotaPlan,
  type RoleLinkLimits,
} from "../../features/quotas/model";
import { RoleLinkFields } from "../../features/quotas/role-link-fields";
import { useCan, useSession } from "../../features/session/context";
import { can, type Permission, type Role } from "../../features/session/model";
import { useLocale, useT } from "../../i18n";
import "./style.css";

const sectionReads: Partial<Record<string, Permission>> = {
  users: "users.read",
  roles: "roles.read",
  quotas: "quotas.read",
  nodes: "nodes.read",
  routing: "routing.read",
  subscriptions: "subscriptions.read",
  settings: "settings.read",
  announcements: "announcements.read",
};

export default function Roles() {
  const t = useT("roles");
  const qt = useT("quotas");
  const { locale } = useLocale();
  const { roles, points } = useCatalog();
  const { access } = useSession();
  const canManage = useCan("roles.manage");
  const canUsers = useCan("users.read");
  const canReadQuotas = useCan("quotas.read");
  const plans = useResource<QuotaPlan[]>(quotaPlansPath, canReadQuotas);
  const cache = useQueryClient();
  const toast = useKumoToastManager();

  const [dialog, setDialog] = useState<"view" | "create" | "delete" | null>(null);
  const [role, setRole] = useState<Role>();
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState("all");
  const [selected, setSelected] = useState<Permission[]>([]);
  const [limits, setLimits] = useState<RoleLinkLimits>(inheritedLinkLimits);
  const [defaultPlanId, setDefaultPlanId] = useState<string>("");

  const mayEdit = (entry?: Role) =>
    canManage && (!entry || (!entry.locked && can(access, ...entry.permissions)));
  const editable = mayEdit(role);
  const canDelete = editable && !!role && !role.built_in && !role.locked;

  const missingReads = Array.from(
    new Set(
      selected.flatMap((key) => {
        const read = sectionReads[key.split(".")[0]];
        return read && !selected.includes(read) && access.permissions.includes(read) ? [read] : [];
      }),
    ),
  );

  const filtered =
    roles.data?.filter(
      (entry) =>
        (kind === "all" || entry.built_in === (kind === "built-in")) &&
        [entry.name, entry.description].some((value) =>
          value.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
        ),
    ) ?? [];

  const change = useMutation({
    mutationFn: ({ method, body }: { method: string; body?: unknown }) =>
      api(role ? `${rolesPath}/${role.id}` : rolesPath, method, body),
    onSuccess: (_, request) => {
      setDialog(null);
      toast.add({
        title:
          request.method === "DELETE"
            ? t("toast.deleted", "Role deleted")
            : request.method === "POST"
              ? t("toast.created", "Role created")
              : t("toast.saved", "Role saved"),
        variant: "success",
      });
      void cache.invalidateQueries({ queryKey: [rolesPath] });
      void cache.invalidateQueries({ queryKey: ["/api/v1/me"] });
      void cache.invalidateQueries({ queryKey: ["/api/v1/admin/quotas"] });
    },
  });

  function open(value?: Role) {
    change.reset();
    setRole(value);
    setSelected(value?.permissions ?? []);
    setLimits(value?.link_limits ?? inheritedLinkLimits);
    setDefaultPlanId(value?.default_quota_plan_id ?? "");
    setDialog(value ? "view" : "create");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || change.isPending) return;
    if (dialog === "delete") {
      change.mutate({ method: "DELETE" });
      return;
    }

    const formData = Object.fromEntries(new FormData(event.currentTarget));
    const payloadName = role?.built_in ? role.name : String(formData.name ?? "");
    const payloadDesc = String(formData.description ?? role?.description ?? "");

    change.mutate({
      method: role ? "PUT" : "POST",
      body: {
        name: payloadName,
        description: payloadDesc,
        permissions: selected,
        default_quota_plan_id: defaultPlanId || null,
        link_limits: limits,
      },
    });
  }

  const columns: Column<Role>[] = [
    {
      key: "role",
      title: t("table.role", "Role"),
      sort: (left, right) => left.name.localeCompare(right.name, locale),
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <Button variant="ghost" size="sm" className="table-name w-fit" onClick={() => open(row)}>
            {row.locked && <LockSimple size={14} aria-hidden />}
            <span>{row.name}</span>
          </Button>
          {row.description && <p className="muted px-1.5 text-xs">{row.description}</p>}
        </div>
      ),
    },
    {
      key: "quota",
      title: t("table.quota", "Default quota plan"),
      omitOnMobile: true,
      cell: (row) => (
        <span className="text-xs text-kumo-default">
          {row.locked
            ? qt("unlimited", "Unlimited")
            : row.default_quota_plan_name ?? t("quota.notSet", "None")}
        </span>
      ),
    },
    {
      key: "members",
      title: t("table.members", "Members"),
      width: "6.5rem",
      omitOnMobile: true,
      sort: (left, right) => (left.member_count ?? 0) - (right.member_count ?? 0),
      cell: (row) => <span className="tabular-nums">{row.member_count ?? 0}</span>,
    },
    {
      key: "points",
      title: t("table.points", "Permission points"),
      width: "9rem",
      omitOnMobile: true,
      sort: (left, right) => left.permissions.length - right.permissions.length,
      cell: (row) => (
        <span className="tabular-nums">
          {row.locked ? t("type.allPermissions", "All") : row.permissions.length}
        </span>
      ),
    },
    {
      key: "type",
      title: t("table.type", "Type"),
      width: "9.5rem",
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          <Chip tone={row.locked ? "blue" : row.built_in ? "green" : "neutral"}>
            {row.locked
              ? t("type.locked", "Built-in · Locked")
              : row.built_in
                ? t("type.builtIn", "Built-in")
                : t("type.custom", "Custom")}
          </Chip>
        </div>
      ),
    },
    {
      key: "actions",
      title: <span className="sr-only">{t("table.actions", "Actions")}</span>,
      width: "4rem",
      end: true,
      sticky: true,
      cell: (row) => (
        <RowActions
          item={row.name}
          actions={[
            { label: mayEdit(row) ? t("edit", "Edit role") : t("view", "View role"), icon: PencilSimple, run: () => open(row) },
          ]}
        />
      ),
    },
  ];

  const planItems: Record<string, string> = {
    "": t("quota.noPlan", "No default plan"),
    ...Object.fromEntries(
      (plans.data ?? []).map((p) => [
        p.id,
        `${p.name} (${p.quota_bytes === null ? qt("unlimited", "Unlimited") : bytes(p.quota_bytes)})`,
      ]),
    ),
  };

  return (
    <>
      <PageHeader
        title={t("title", "Roles and permissions")}
        description={t("description", "Create reusable roles that grant specific actions, default new-user quota plans, and subscription limits.")}
        action={
          canManage && (
            <Button variant="primary" icon={Plus} onClick={() => open()}>
              {t("create", "Create role")}
            </Button>
          )
        }
      />
      <Banner error={roles.error || points.error} />
      <LayerCard render={<section />} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-kumo-strong">{t("assign", "Assign roles to accounts")}</h2>
          <p className="text-xs text-kumo-subtle">
            {t("assign.help", "Open an account’s Permissions tab to set roles or override individual points.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canReadQuotas && (
            <LinkButton variant="secondary" size="sm" href="/admin/quotas?tab=plans">
              {t("quota.managePlans", "Manage quota plans")}
            </LinkButton>
          )}
          {canUsers && (
            <LinkButton variant="secondary" size="sm" href="/admin/users">
              {t("assign.open", "Open user directory")}
            </LinkButton>
          )}
        </div>
      </LayerCard>
      <DataTable
        label={t("table.title", "Roles")}
        rows={filtered}
        columns={columns}
        rowId={(row) => row.id}
        layout="auto"
        pagination={{ defaultPageSize: 10, storageKey: "roles" }}
        busy={roles.isPending}
        toolbar={
          <DataToolbar
            quickFilters={{
              label: t("table.type", "Type"),
              value: kind,
              onChange: setKind,
              options: [
                { value: "all", label: t("type.all", "All types"), count: roles.data?.length ?? 0 },
                {
                  value: "built-in",
                  label: t("type.builtIn", "Built-in"),
                  count: roles.data?.filter((entry) => entry.built_in).length ?? 0,
                },
                {
                  value: "custom",
                  label: t("type.custom", "Custom"),
                  count: roles.data?.filter((entry) => !entry.built_in).length ?? 0,
                },
              ],
            }}
            search={{
              label: t("search", "Find roles"),
              value: filter,
              onChange: setFilter,
              resultCount: filtered.length,
            }}
            activeFilters={[
              ...(filter.trim()
                ? [
                    {
                      key: "q",
                      label: t("search", "Find roles"),
                      value: filter.trim(),
                      onRemove: () => setFilter(""),
                    } satisfies ActiveFilterChip,
                  ]
                : []),
              ...(kind !== "all"
                ? [
                    {
                      key: "kind",
                      label: t("table.type", "Type"),
                      value: kind === "built-in" ? t("type.builtIn", "Built-in") : t("type.custom", "Custom"),
                      onRemove: () => setKind("all"),
                    } satisfies ActiveFilterChip,
                  ]
                : []),
            ]}
            onClear={
              filter || kind !== "all"
                ? () => {
                    setFilter("");
                    setKind("all");
                  }
                : undefined
            }
          />
        }
        empty={<Empty title={filter || kind !== "all" ? t("empty.filtered", "No matching roles") : t("empty", "No roles available")} />}
      />
      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        pending={change.isPending}
        large
        title={dialog === "delete" ? t("delete.title", "Delete role?") : role?.name ?? t("create", "Create role")}
        description={
          dialog === "delete"
            ? t("delete.help", "Remove the role from every account before deleting it.")
            : role?.locked
              ? t("locked.help", "Administrator is a locked built-in role managed through the Board CLI and cannot be edited or deleted.")
              : role?.built_in
                ? t("builtIn.help", "Board manages this built-in role. You can configure its default quota plan and permissions.")
                : t("editor.help", "Choose the permission points, default quota plan, and limits the role grants.")
        }
      >
        <form className="form-fields role-form" key={role?.id ?? "new"} onSubmit={submit}>
          {dialog !== "delete" && (
            <>
              {role?.locked && (
                <KumoBanner
                  size="sm"
                  variant="default"
                  title={t("locked.bannerTitle", "Read-only built-in role")}
                  description={t(
                    "locked.bannerDesc",
                    "All workspace administrators ({count} account(s)) hold this role with full permissions and unrestricted access to all nodes.",
                    { count: role.member_count ?? 0 },
                  )}
                />
              )}
              {editable ? (
                <>
                  <Input
                    label={t("editor.name", "Role name")}
                    name="name"
                    defaultValue={role?.name ?? ""}
                    maxLength={72}
                    required
                    disabled={change.isPending || role?.built_in}
                    description={role?.built_in ? t("builtIn.nameFixed", "Built-in role names cannot be changed.") : undefined}
                  />
                  <Textarea
                    label={t("editor.description", "Description")}
                    name="description"
                    defaultValue={role?.description ?? ""}
                    rows={2}
                    maxLength={400}
                    disabled={change.isPending}
                  />
                </>
              ) : (
                role?.description && <p className="muted text-sm">{role.description}</p>
              )}

              {!role?.locked && (
                <div className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-4">
                  <span className="text-sm font-semibold text-kumo-strong">
                    {t("quota.title", "Default new-user quota plan")}
                  </span>
                  <p className="text-xs text-kumo-subtle">
                    {t(
                      "quota.planHelp",
                      "Issued automatically as an independent quota grant when a new account is created with this role. Existing accounts keep their own stacked quota packages.",
                    )}
                  </p>
                  <Select
                    label={t("quota.defaultPlan", "Quota plan template")}
                    value={defaultPlanId}
                    disabled={!editable || change.isPending}
                    items={planItems}
                    onValueChange={(next: string | null) => setDefaultPlanId(next ?? "")}
                  />
                </div>
              )}

              {!role?.locked && (
                <RoleLinkFields value={limits} onChange={setLimits} disabled={!editable || change.isPending} />
              )}

              {points.isPending ? (
                <Loading label={t("points.loading", "Loading permission points…")} />
              ) : (
                <PermissionGrid
                  points={points.data ?? []}
                  value={role?.locked ? (points.data ?? []).map((p) => p.key) : selected}
                  onChange={setSelected}
                  allowed={editable && !change.isPending ? access.permissions : []}
                />
              )}

              {editable && missingReads.length > 0 && (
                <KumoBanner
                  size="sm"
                  variant="alert"
                  title={t("review", "Review section access")}
                  description={t(
                    "review.detail",
                    "These read points may be needed to show the role’s actions in the console: {points}.",
                    { points: missingReads.join(", ") },
                  )}
                  action={
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setSelected(Array.from(new Set([...selected, ...missingReads])))}
                    >
                      {t("review.addAll", "Add missing read points")}
                    </Button>
                  }
                />
              )}
              {canDelete && (
                <div>
                  <Button
                    variant="destructive"
                    size="sm"
                    type="button"
                    onClick={() => {
                      change.reset();
                      setDialog("delete");
                    }}
                    disabled={change.isPending}
                  >
                    {t("delete", "Delete role")}
                  </Button>
                </div>
              )}
            </>
          )}
          <Banner error={change.error || points.error} />
          {editable ? (
            <FormActions
              onClose={() => setDialog(null)}
              pending={change.isPending}
              destructive={dialog === "delete"}
              label={dialog === "delete" ? t("delete", "Delete role") : role ? t("save", "Save role") : t("create", "Create role")}
            />
          ) : (
            <div className="dialog-actions">
              <Button variant="secondary" type="button" onClick={() => setDialog(null)}>
                {t("close", "Close")}
              </Button>
            </div>
          )}
        </form>
      </Modal>
    </>
  );
}
