import { Badge } from "@cloudflare/kumo/components/badge";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { ArrowLeft, ArrowRight, LockSimple } from "@phosphor-icons/react";
import { useState } from "react";
import { useResource } from "../../app/query";
import { useConsoleLocation, useConsoleNavigate } from "../../app/router";
import { Banner, Chip, Empty, Loading, PageHeader, SectionCard } from "../../components/console-ui";
import { bytes, dateTime, percent } from "../../components/format";
import { english, useT } from "../../i18n";
import { AssignmentForm } from "../access/assignment";
import { useCatalog } from "../access/catalog";
import { QuotaEditor } from "../quotas/editor";
import { useCan } from "../session/context";
import { displayName, type Access, type Account } from "../session/model";
import { usersPath } from "./create-user";
import { CredentialsPanel, ProfilePanel } from "./user-forms";

type AccountActions = { profile: boolean; status: boolean; credentials: boolean; access: boolean; quota: boolean };
export type UserDetail = { account: Account; actions: AccountActions };

function backHref(href: string) {
  const query = new URL(href, location.origin).searchParams;
  query.delete("user");
  query.delete("tab");
  return "/admin/users" + (query.size ? `?${query}` : "");
}

export function UserDetailPage({ id }: { id: string }) {
  const t = useT("directory");
  const href = useConsoleLocation();
  const navigate = useConsoleNavigate();
  const path = `${usersPath}/${id}`;
  const query = useResource<UserDetail>(path);
  const roleView = useCan("roles.read");
  const quotas = useCan("quotas.read");
  const [editQuota, setEditQuota] = useState(false);
  const selected = new URL(href, location.origin).searchParams.get("tab");
  const back = backHref(href);
  const user = query.data?.account;
  const actions = query.data?.actions;
  const tabs = [
    { value: "profile", label: t("detail.profile", "Profile") },
    ...(roleView ? [{ value: "access", label: t("detail.permissions", "Permissions") }] : []),
    ...(quotas ? [{ value: "quota", label: t("detail.quota", "Transfer quota") }] : []),
    ...(actions?.credentials ? [{ value: "credentials", label: t("detail.credentials", "Credentials") }] : []),
  ];
  const tab = selected && tabs.some(({ value }) => value === selected) ? selected : "profile";

  function select(value: string) {
    const params = new URL(href, location.origin).searchParams;
    if (value === "profile") params.delete("tab");
    else params.set("tab", value);
    navigate("/admin/users?" + params);
  }

  const usedBytes = user?.quota?.used_bytes ?? user?.used_bytes ?? "0";
  const quotaBytes = user ? (user.quota ? user.quota.quota_bytes : user.quota_bytes) : null;

  return (
    <>
      <div>
        <LinkButton href={back} variant="ghost" size="sm" icon={ArrowLeft}>
          {t("detail.back", "Back to users")}
        </LinkButton>
      </div>
      {query.isPending ? (
        <Loading label={t("detail.loading", "Loading account…")} />
      ) : !user || !actions ? (
        <>
          <Banner error={query.error} />
          <Empty
            title={english("directory", "detail.unavailable", "Account unavailable")}
            action={
              <LinkButton href={back} variant="secondary">
                {t("detail.open", "Open user directory")}
              </LinkButton>
            }
          />
        </>
      ) : (
        <>
          <PageHeader
            title={displayName(user)}
            description={user.display_name ? user.email : t("detail.account", "User account")}
            badge={
              <>
                <Chip tone={user.active ? "green" : "amber"}>{user.active ? t("active", "Active") : t("inactive", "Inactive")}</Chip>
                {(user.roles ?? []).map((role) => (
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
                ))}
                {user.admin && !(user.roles ?? []).some((r) => r.locked) && (
                  <Chip tone="blue">
                    <span className="inline-flex items-center gap-1">
                      <LockSimple size={11} aria-hidden />
                      {t("owner", "Administrator")}
                    </span>
                  </Chip>
                )}
              </>
            }
          />
          <div className="account-tabs">
            <Tabs variant="underline" tabs={tabs} value={tab} onValueChange={select} />
          </div>
          {tab === "profile" && <ProfilePanel user={user} path={path} edit={actions.profile} status={actions.status} />}
          {tab === "access" && <PermissionsPanel id={id} path={path} editable={actions.access} />}
          {tab === "credentials" && actions.credentials && <CredentialsPanel path={path} />}
          {tab === "quota" && quotas && (
            <SectionCard
              title={t("detail.quota", "Transfer quota")}
              action={
                actions.quota && (
                  <Button variant="primary" size="sm" onClick={() => setEditQuota(true)}>
                    {t("detail.quotaEdit", "Edit quota")}
                  </Button>
                )
              }
            >
              <div className="flex flex-col gap-4">
                <dl className="profile-attributes">
                  <div>
                    <dt>{t("detail.transfer", "Recorded transfer")}</dt>
                    <dd>{bytes(usedBytes)}</dd>
                  </div>
                  <div>
                    <dt>{t("detail.limit", "Account limit")}</dt>
                    <dd>{quotaBytes === null ? t("unlimited", "Unlimited") : bytes(quotaBytes)}</dd>
                  </div>
                </dl>
                {quotaBytes !== null && (
                  <Meter
                    label={t("detail.transfer", "Recorded transfer")}
                    value={percent(usedBytes, quotaBytes)}
                    customValue={`${bytes(usedBytes)} / ${bytes(quotaBytes)}`}
                  />
                )}
                {(user.quota?.grants ?? []).filter((g) => !g.revoked).length > 0 && (
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-semibold text-kumo-strong">
                      {t("detail.quotaPackages", "Quota packages")}
                    </span>
                    <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                      {(user.quota?.grants ?? [])
                        .filter((g) => !g.revoked)
                        .map((grant) => (
                          <div
                            key={grant.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-kumo-line bg-kumo-recessed/25 px-3 py-2 text-xs"
                          >
                            <div className="flex flex-wrap items-center gap-1.5">
                              <strong className="text-kumo-strong">{grant.name}</strong>
                              <Badge variant="secondary">
                                {grant.quota_bytes === null
                                  ? t("unlimited", "Unlimited")
                                  : `${bytes(grant.used_bytes)} / ${bytes(grant.quota_bytes)}`}
                              </Badge>
                            </div>
                            <span className="text-kumo-subtle">
                              {grant.cycle_ends_at
                                ? dateTime(grant.cycle_ends_at)
                                : grant.expires_at
                                  ? dateTime(grant.expires_at)
                                  : "—"}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
                <div className="actions">
                  <LinkButton
                    href={"/admin/quotas?" + new URLSearchParams({ q: user.email })}
                    variant="secondary"
                    size="sm"
                    icon={ArrowRight}
                  >
                    {t("detail.quotaOpen", "Open quota record")}
                  </LinkButton>
                </div>
              </div>
            </SectionCard>
          )}
          {actions.quota && (
            <QuotaEditor user={editQuota && tab === "quota" ? user : undefined} onClose={() => setEditQuota(false)} />
          )}
        </>
      )}
    </>
  );
}

function PermissionsPanel({ id, path, editable }: { id: string; path: string; editable: boolean }) {
  const t = useT("directory");
  const assignment = useResource<Access>(`${path}/access`);
  const { roles, points } = useCatalog();
  return (
    <SectionCard
      title={t("detail.permissionsTitle", "Roles and effective permissions")}
      description={t("detail.permissionsHelp", "Roles grant access. An account-level override takes priority over its roles.")}
    >
      {assignment.isPending || roles.isPending || points.isPending ? (
        <Loading />
      ) : assignment.data && roles.data && points.data ? (
        <AssignmentForm id={id} access={assignment.data} editable={editable} roles={roles.data} points={points.data} />
      ) : (
        <Banner error={assignment.error || roles.error || points.error} />
      )}
    </SectionCard>
  );
}
