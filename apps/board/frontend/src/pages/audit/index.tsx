import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { ButtonGroup } from "@cloudflare/kumo/components/button-group";
import { InlineCopyText } from "@cloudflare/kumo/components/inline-copy-text";
import { ArrowClockwise, CaretRight } from "@phosphor-icons/react";
import { useState } from "react";
import { useResource } from "../../app/query";
import { useConsoleLocation, useConsoleNavigate } from "../../app/router";
import { dateTime } from "../../components/format";
import { Banner, Chip, Empty, PageHeader } from "../../components/console-ui";
import { DataTable, DataToolbar, type ActiveFilterChip, type Column } from "../../components/data-table";
import { useCan } from "../../features/session/context";
import { useT } from "../../i18n";
import "./style.css";

type Event = { id: number; actor: string; action: string; target: string; target_label?: string; occurred_at: string };
const actions: Record<string, string> = {
  "account.created": "Created user",
  "account.profile_updated": "Updated profile",
  "account.status_updated": "Updated account status",
  "account.quota_updated": "Updated quota",
  "account.sessions_revoked": "Ended sign-in sessions",
  "account.password_reset": "Reset password",
  "account.own_password_changed": "Changed own password",
  "account.access_updated": "Updated account access",
  "role.created": "Created role",
  "role.updated": "Updated role",
  "role.deleted": "Deleted role",
  "account.own_profile_updated": "Updated own profile",
  "session.revoked": "Ended a session",
  "session.others_revoked": "Ended other sessions",
  "announcement.created": "Created announcement",
  "announcement.updated": "Updated announcement",
  "announcement.queued": "Queued announcement",
  "announcement.archived": "Archived announcement",
  "announcement.deleted": "Deleted announcement",
  "panel.settings_updated": "Updated system settings",
};
const kinds = ["accounts", "permissions", "quotas", "sessions", "portal"] as const;

function actionTone(action: string): "green" | "blue" | "amber" | "red" | "neutral" {
  if (action.endsWith(".created") || action.endsWith(".queued")) return "green";
  if (action.endsWith(".deleted") || action.includes("revoked") || action.includes("reset")) return "amber";
  if (action.includes("settings") || action.includes("access") || action.includes("quota")) return "blue";
  return "neutral";
}

export default function Audit() {
  const t = useT("audit");
  const href = useConsoleLocation();
  const navigate = useConsoleNavigate();
  const canUsers = useCan("users.read");
  const canAnnouncements = useCan("announcements.read");
  const { searchParams } = new URL(href, location.origin);
  const search = (searchParams.get("q") ?? "").trim().slice(0, 120);
  const type = searchParams.get("kind");
  const kind = kinds.find((item) => item === type) ?? "all";
  const [stack, setStack] = useState<number[]>([]);
  const [draft, setDraft] = useState<{ href: string; query: string }>();
  const query = draft?.href === href ? draft.query : search;
  const cursor = stack.at(-1);
  const params = new URLSearchParams();
  if (cursor) params.set("before", String(cursor));
  if (search) params.set("q", search);
  if (kind !== "all") params.set("kind", kind);
  const audit = useResource<Event[]>("/api/v1/admin/audit" + (params.size ? `?${params}` : ""));

  function update(term: string, value: string) {
    setDraft(undefined);
    setStack([]);
    const next = new URLSearchParams();
    if (term) next.set("q", term);
    if (value !== "all") next.set("kind", value);
    navigate("/admin/audit" + (next.size ? `?${next}` : ""), true);
  }

  const kindLabels: Record<string, string> = {
    all: t("kind.all", "All activity"),
    accounts: t("kind.accounts", "Accounts and credentials"),
    permissions: t("kind.permissions", "Permissions and roles"),
    quotas: t("kind.quotas", "Transfer quotas"),
    sessions: t("kind.sessions", "Sign-in sessions"),
    portal: t("kind.portal", "Announcements and settings"),
  };

  const activeFilters: ActiveFilterChip[] = [];
  if (search) {
    activeFilters.push({
      key: "q",
      label: t("search", "Search audit log"),
      value: search,
      onRemove: () => update("", kind),
    });
  }
  if (kind !== "all") {
    activeFilters.push({
      key: "kind",
      label: t("kind", "Activity type"),
      value: kindLabels[kind] ?? kind,
      onRemove: () => update(query.trim(), "all"),
    });
  }

  const columns: Column<Event>[] = [
    {
      key: "action",
      title: t("columns.activity", "Activity"),
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={actionTone(row.action)}>
              {t(`event.${row.action}`, actions[row.action] ?? row.action)}
            </Chip>
          </div>
          <p className="muted text-xs">
            <bdi>{row.actor}</bdi>
          </p>
        </div>
      ),
    },
    {
      key: "when",
      title: t("columns.when", "When"),
      width: "12rem",
      omitOnMobile: true,
      cell: (row) => dateTime(row.occurred_at),
    },
    {
      key: "target",
      title: t("columns.target", "Target"),
      width: "12rem",
      end: true,
      cell: (row) => (
        <div className="audit-target">
          {row.target_label && (
            <strong className="audit-target-title text-kumo-strong" title={row.target_label}>
              <bdi>{row.target_label}</bdi>
            </strong>
          )}
          <InlineCopyText value={row.target} labels={{ copyAction: t("copy", "Copy target ID") }}>
            {row.target.slice(0, 8)}…
          </InlineCopyText>
          {canUsers && row.action.startsWith("account.") && (
            <LinkButton
              href={"/admin/users?" + new URLSearchParams({ user: row.target })}
              variant="ghost"
              size="xs"
              className="audit-open"
              aria-label={t("open", "View account")}
            >
              <span className="audit-open-label">{t("open", "View account")}</span>
              <CaretRight className="audit-open-icon" size={16} aria-hidden />
            </LinkButton>
          )}
        </div>
      ),
    },
  ];

  const rows = audit.data ?? [];
  const showCursorNav = stack.length > 0 || rows.length === 50;

  return (
    <>
      <PageHeader
        title={t("title", "Audit log")}
        description={t("description", "Find changes to accounts, credentials, roles and transfer quotas.")}
        action={
          <Button variant="secondary" icon={ArrowClockwise} loading={audit.isFetching} onClick={() => audit.refetch()}>
            {t("refresh", "Refresh")}
          </Button>
        }
      />
      <Banner error={audit.error} />
      <DataTable
        className="audit-table"
        label={t("table", "Audit events")}
        rows={rows}
        columns={columns}
        rowId={(row) => String(row.id)}
        layout="auto"
        busy={audit.isPending}
        pagination={false}
        toolbar={
          <DataToolbar
            quickFilters={{
              label: t("kind", "Activity type"),
              value: kind,
              onChange: (value) => update(query.trim(), value),
              options: [
                { value: "all", label: kindLabels.all },
                { value: "accounts", label: kindLabels.accounts },
                { value: "permissions", label: kindLabels.permissions },
                { value: "quotas", label: kindLabels.quotas },
                { value: "sessions", label: kindLabels.sessions },
                { value: "portal", label: kindLabels.portal },
              ],
            }}
            search={{
              label: t("search", "Search audit log"),
              placeholder: canAnnouncements
                ? t("search.targets", "Actor, target ID or announcement title")
                : t("search.placeholder", "Actor email or target ID"),
              value: query,
              onChange: (nextQuery) => {
                setDraft({ href, query: nextQuery });
                if (!nextQuery && search) update("", kind);
              },
              resultCount: rows.length,
            }}
            activeFilters={activeFilters}
            onSubmit={() => update(query.trim(), kind)}
            onClear={query || kind !== "all" ? () => update("", "all") : undefined}
          />
        }
        footer={
          showCursorNav && (
            <>
              <span className="text-xs text-kumo-subtle tabular-nums">
                {t("pageIndicator", "Page {page} · {count} events", { page: stack.length + 1, count: rows.length })}
              </span>
              <ButtonGroup aria-label={t("pagination", "Navigate audit pages")}>
                <Button variant="secondary" size="sm" disabled={!stack.length || audit.isPending} onClick={() => setStack(stack.slice(0, -1))}>
                  {t("newer", "Newer")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={rows.length !== 50 || audit.isPending}
                  onClick={() => {
                    const last = rows.at(-1);
                    if (last) setStack([...stack, last.id]);
                  }}
                >
                  {t("older", "Older")}
                </Button>
              </ButtonGroup>
            </>
          )
        }
        empty={
          <Empty title={cursor ? t("empty.older", "No older activity") : t("empty", "No matching activity")}>
            {cursor
              ? t("empty.newer", "Choose Newer to return to the previous results.")
              : t("empty.help", "Activity appears here as accounts, permissions and quotas change.")}
          </Empty>
        }
      />
    </>
  );
}
