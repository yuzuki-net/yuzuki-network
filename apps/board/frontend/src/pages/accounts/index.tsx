import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { CaretRight, CheckCircle, Key, LockKey, LockSimple, Prohibit, UserCircle, UserPlus, Wallet } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useConsoleLocation, useConsoleNavigate } from "../../app/router";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, Empty, FormActions, Modal, PageHeader } from "../../components/console-ui";
import { DataTable, RowActions, type Column, useTableSelection } from "../../components/data-table";
import { dateTime } from "../../components/format";
import { CreateUser } from "../../features/directory/create-user";
import { useDirectory } from "../../features/directory/query";
import { DirectorySearch } from "../../features/directory/search";
import { UserDetailPage } from "../../features/directory/user-detail";
import { QuotaEditor } from "../../features/quotas/editor";
import { useCan } from "../../features/session/context";
import { displayName, type Account } from "../../features/session/model";
import { useT } from "../../i18n";
import "./style.css";

function detailHref(id: string, tab?: string) {
  const params = new URLSearchParams(location.search);
  params.set("user", id);
  if (tab) params.set("tab", tab);
  else params.delete("tab");
  return `/admin/users?${params}`;
}

export default function Accounts() {
  const href = useConsoleLocation();
  const params = new URL(href, location.origin).searchParams;
  const id = params.get("user");
  return id ? <UserDetailPage key={id} id={id} /> : <UserDirectory />;
}

function UserDirectory() {
  const directory = useDirectory("/api/v1/admin/directory");
  const { result, page, setPage } = directory;
  const t = useT("directory");
  const canCreate = useCan("users.create");
  const canUpdate = useCan("users.update");
  const canRoles = useCan("roles.read");
  const canQuotas = useCan("quotas.read");
  const href = useConsoleLocation();
  const navigate = useConsoleNavigate();
  const toast = useKumoToastManager();
  const cache = useQueryClient();
  const create = new URL(href, location.origin).searchParams.get("create") === "1";
  const [pending, setPending] = useState<{ active: boolean; ids: string[] } | null>(null);
  const [quotaTarget, setQuotaTarget] = useState<Account>();
  const selection = useTableSelection(JSON.stringify([directory.query, directory.filter, page]));
  const filters = !!directory.query || directory.filter !== "all";
  const rows = result.data?.items ?? [];
  const maySelect = (row: Account) => row.status_editable === true && !directory.searching && !result.isPlaceholderData;
  const bulk = useMutation({
    mutationFn: (batch: { active: boolean; ids: string[] }) =>
      api<{ processed: number }>("/api/v1/admin/users/status", "POST", {
        account_ids: batch.ids,
        active: batch.active,
      }),
    onSuccess: (response, { active }) => {
      toast.add({
        title: active
          ? t("bulk.activated", "{count} accounts activated", { count: response.processed })
          : t("bulk.suspended", "{count} accounts suspended", { count: response.processed }),
        variant: "success",
      });
      selection.clear();
      setPending(null);
      void cache.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith("/api/v1/admin/") });
    },
  });
  function request(active: boolean) {
    const ids = rows.filter((row) => selection.ids.has(row.id) && row.active !== active && maySelect(row)).map((row) => row.id);
    if (ids.length) {
      bulk.reset();
      setPending({ active, ids });
    }
  }
  const canActivate = rows.some((row) => maySelect(row) && !row.active && selection.ids.has(row.id));
  const canPause = rows.some((row) => maySelect(row) && row.active && selection.ids.has(row.id));

  const columns: Column<Account>[] = [
    {
      key: "name",
      title: t("account", "Account"),
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <LinkButton
            variant="ghost"
            size="sm"
            className="user-name w-fit px-1.5"
            title={row.email}
            aria-label={t("open", "Open account {name}", { name: row.email })}
            href={detailHref(row.id)}
          >
            <span dir="auto">{row.display_name || row.email}</span>
            <CaretRight size={14} aria-hidden />
          </LinkButton>
          {row.display_name && (
            <p className="muted directory-email px-1.5 text-xs" title={row.email}>
              <bdi>{row.email}</bdi>
            </p>
          )}
        </div>
      ),
    },
    {
      key: "roles",
      title: t("roles", "Roles"),
      omitOnMobile: true,
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {(row.roles ?? []).length > 0 ? (
            (row.roles ?? []).map((role) => (
              <Chip key={role.id} tone={role.locked ? "blue" : "neutral"}>
                {role.locked ? (
                  <span className="inline-flex items-center gap-1">
                    <LockSimple size={11} aria-hidden />
                    {role.name}
                  </span>
                ) : (
                  role.name
                )}
              </Chip>
            ))
          ) : row.admin ? (
            <Chip tone="blue">
              <span className="inline-flex items-center gap-1">
                <LockSimple size={11} aria-hidden />
                {t("owner", "Administrator")}
              </span>
            </Chip>
          ) : (
            <span className="text-xs text-kumo-subtle">—</span>
          )}
        </div>
      ),
    },
    {
      key: "status",
      title: t("status", "Status"),
      width: "8rem",
      cell: (row) => (
        <Chip tone={row.active ? "green" : "amber"}>{row.active ? t("active", "Active") : t("inactive", "Inactive")}</Chip>
      ),
    },
    {
      key: "created",
      title: t("created", "Created"),
      omitOnMobile: true,
      width: "12rem",
      cell: (row) => dateTime(row.created_at),
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
            { label: t("detail.profile", "Profile"), icon: UserCircle, href: detailHref(row.id) },
            ...(canQuotas
              ? [{ label: t("detail.quota", "Transfer quota"), icon: Wallet, run: () => setQuotaTarget(row) }]
              : []),
            ...(canRoles
              ? [{ label: t("detail.permissions", "Permissions"), icon: LockKey, href: detailHref(row.id, "access") }]
              : []),
            { label: t("detail.credentials", "Credentials"), icon: Key, href: detailHref(row.id, "credentials") },
            ...(canUpdate && row.status_editable
              ? [
                  {
                    label: row.active ? t("row.suspend", "Suspend account") : t("row.activate", "Activate account"),
                    icon: row.active ? Prohibit : CheckCircle,
                    danger: row.active,
                    run: () => {
                      bulk.reset();
                      setPending({ active: !row.active, ids: [row.id] });
                    },
                  },
                ]
              : []),
          ]}
        />
      ),
    },
  ];

  function setCreate(value: boolean) {
    const url = new URL(href, location.origin);
    if (value) url.searchParams.set("create", "1");
    else url.searchParams.delete("create");
    navigate(url.pathname + url.search, true);
  }
  const createButton = canCreate && (
    <Button variant="primary" icon={UserPlus} onClick={() => setCreate(true)}>
      {t("create", "Create user")}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t("title", "Users")}
        description={t("description", "Find accounts and manage sign-in, permissions and quotas.")}
        action={createButton}
      />
      <Banner error={result.error} />
      <DataTable
        className="user-directory"
        label={t("table", "User directory")}
        toolbar={<DirectorySearch directory={directory} onRefresh={() => void result.refetch()} refreshing={result.isFetching} />}
        rows={rows}
        columns={columns}
        rowId={(row) => row.id}
        busy={result.isFetching}
        page={result.data && { index: page, size: result.data.page_size, count: result.data.total, change: setPage }}
        selection={
          canUpdate
            ? {
                ...selection,
                name: (row) => row.display_name || row.email,
                eligible: maySelect,
                disabled: result.isPlaceholderData || bulk.isPending,
                actions: (
                  <>
                    <Button variant="secondary" size="sm" disabled={!canActivate || bulk.isPending} onClick={() => request(true)}>
                      {t("bulk.activate", "Activate selected")}
                    </Button>
                    <Button variant="secondary" size="sm" disabled={!canPause || bulk.isPending} onClick={() => request(false)}>
                      {t("bulk.suspend", "Suspend selected")}
                    </Button>
                  </>
                ),
              }
            : undefined
        }
        empty={
          <Empty
            title={filters ? t("empty.filtered", "No matching users") : t("empty", "No users yet")}
            action={
              filters ? (
                <Button variant="secondary" onClick={directory.clear}>
                  {t("clear", "Clear filters")}
                </Button>
              ) : (
                createButton
              )
            }
          >
            {filters
              ? t("empty.try", "Try a different name, email address or account status.")
              : t("empty.create", "Create an account to let someone sign in.")}
          </Empty>
        }
      />
      <CreateUser
        open={canCreate && create}
        onClose={() => setCreate(false)}
        onCreated={(id) => {
          const params = new URL(href, location.origin).searchParams;
          params.delete("create");
          params.set("user", id);
          navigate("/admin/users?" + params, true);
        }}
      />
      <QuotaEditor user={quotaTarget} onClose={() => setQuotaTarget(undefined)} />
      <Modal
        open={!!pending}
        title={pending?.active ? t("bulk.activateTitle", "Activate accounts?") : t("bulk.suspendTitle", "Suspend accounts?")}
        description={
          pending?.active
            ? t("bulk.activateDescription", "Selected users will be able to sign in again.")
            : t("bulk.suspendDescription", "Selected users will be signed out and their subscription links will be revoked.")
        }
        onClose={() => setPending(null)}
        pending={bulk.isPending}
      >
        <form
          className="form-fields"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) bulk.mutate(pending);
          }}
        >
          <Banner error={bulk.error} />
          <FormActions
            onClose={() => setPending(null)}
            pending={bulk.isPending}
            destructive={!pending?.active}
            label={pending?.active ? t("bulk.activate", "Activate selected") : t("bulk.suspend", "Suspend selected")}
          />
        </form>
      </Modal>
    </>
  );
}
