import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { SignOut } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useResource } from "../../app/query";
import { api } from "../../assets/scripts/api";
import { Chip, Empty, FormActions, Modal } from "../../components/console-ui";
import { DataTable, DataToolbar, RowActions, type Column } from "../../components/data-table";
import { english, useLocale, useT } from "../../i18n";

type Session = {
  id: string; current: boolean; user_agent: string; created_at: string; last_seen_at: string; expires_at: string;
};
type Revoke = { kind: "one"; row: Session } | { kind: "others" };

const SESSIONS = "/api/v1/me/sessions";

export function SessionSettings() {
  const t = useT("security");
  const { locale } = useLocale();
  const records = useResource<Session[]>(SESSIONS);
  const toast = useKumoToastManager();
  const cache = useQueryClient();
  const [confirm, setConfirm] = useState<Revoke | null>(null);
  const [search, setSearch] = useState("");
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const exact = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });
  const revoke = useMutation({
    mutationFn: (target: Revoke) => api(target.kind === "one" ? `${SESSIONS}/${target.row.id}` : SESSIONS, "DELETE"),
    onSuccess: () => {
      setConfirm(null);
      void cache.invalidateQueries({ queryKey: [SESSIONS] });
      toast.add({ variant: "success", title: t("sessions.revoked", "Sessions ended") });
    },
  });
  function open(target: Revoke) {
    revoke.reset();
    setConfirm(target);
  }
  const identify = (row: Session) => t("sessions.one_target", "{client} · signed in {date}", {
    client: clientName(row.user_agent, t("sessions.unknown", "Unknown browser")), date: exact.format(new Date(row.created_at)),
  });
  const rows = records.data ?? [];
  const visibleRows = rows.filter((row) =>
    clientName(row.user_agent, t("sessions.unknown", "Unknown browser"))
      .toLocaleLowerCase(locale)
      .includes(search.trim().toLocaleLowerCase(locale)),
  );
  const columns: Column<Session>[] = [
    { key: "client", title: t("sessions.client", "Browser and device"), cell: (row) =>
      <div className="session-card-name">
        <div><strong>{clientName(row.user_agent, t("sessions.unknown", "Unknown browser"))}</strong>
          {row.current && <Chip tone="green">{t("sessions.current", "Current session")}</Chip>}</div>
        <time className="session-card-date" dateTime={row.created_at}>
          {t("sessions.started", "Signed in {date}", { date: date.format(new Date(row.created_at)) })}
        </time>
      </div> },
    { key: "active", title: t("sessions.active", "Last active"), omitOnMobile: true, cell: (row) =>
      <time dateTime={row.last_seen_at}>{date.format(new Date(row.last_seen_at))}</time> },
    { key: "expires", title: t("sessions.expires", "Expires"), omitOnMobile: true, cell: (row) =>
      <time dateTime={row.expires_at}>{date.format(new Date(row.expires_at))}</time> },
    { key: "action", title: "", width: "3.75rem", sticky: true, end: true, cell: (row) => row.current ? null :
      <RowActions item={identify(row)} actions={[
        { label: t("sessions.end", "End session"), icon: SignOut, danger: true, run: () => open({ kind: "one", row }) },
      ]} /> },
  ];

  return <>
    {records.isError && <KumoBanner variant="error" size="sm" description={english("security", "sessions.load_error", "Could not load sign-in sessions.")}
      action={<Button variant="secondary" onClick={() => void records.refetch()}>{t("sessions.retry", "Try again")}</Button>} />}
    <DataTable
      label={t("sessions.title", "Sign-in sessions")}
      rows={visibleRows}
      columns={columns}
      rowId={(row) => row.id}
      layout="auto"
      busy={records.isFetching}
      sortPreference="security-sessions"
      pagination={{ defaultPageSize: 10, storageKey: "security-sessions" }}
      toolbar={
        <>
          <header className="panel-header">
            <div>
              <h2>{t("sessions.title", "Sign-in sessions")}</h2>
              <p className="muted">
                {t("sessions.description", "Review where you’re signed in and end any session you no longer use.")}
              </p>
            </div>
            {rows.some((row) => !row.current) && (
              <Button variant="secondary" icon={SignOut} onClick={() => open({ kind: "others" })}>
                {t("sessions.end_others", "End other sessions")}
              </Button>
            )}
          </header>
          {rows.length > 1 && (
            <DataToolbar
              search={{
                label: t("sessions.search", "Search sessions"),
                placeholder: t("sessions.searchHint", "Browser or operating system"),
                value: search,
                onChange: setSearch,
                resultCount: visibleRows.length,
              }}
              onClear={search ? () => setSearch("") : undefined}
              onRefresh={() => void records.refetch()}
              refreshing={records.isFetching}
            />
          )}
        </>
      }
      empty={<Empty title={search ? t("sessions.noMatches", "No matching sessions") : t("sessions.empty", "No active sessions")} />}
    />
    <Modal open={!!confirm} onClose={() => setConfirm(null)} pending={revoke.isPending}
      description={confirm?.kind === "one" ? identify(confirm.row) : undefined}
      title={confirm?.kind === "others" ? t("sessions.confirm_others", "End other sessions?") : t("sessions.confirm_one", "End this session?")}>
      {confirm && <form className="form-fields" onSubmit={(event) => { event.preventDefault(); revoke.mutate(confirm); }}>
        <p>{confirm.kind === "others" ? t("sessions.others_description", "Your other browsers will need to sign in again.")
          : t("sessions.one_description", "This browser will need to sign in again.")}</p>
        {revoke.isError && <KumoBanner variant="error" size="sm" description={english("security", "sessions.revoke_error", "Could not end the selected sessions. Reload the list and try again.")} />}
        <FormActions onClose={() => setConfirm(null)} label={confirm.kind === "others" ? t("sessions.end_others", "End other sessions")
          : t("sessions.end", "End session")} pending={revoke.isPending} destructive />
      </form>}
    </Modal>
  </>;
}

function clientName(userAgent: string, fallback: string) {
  const browser = /Edg(?:e|A|iOS)?\//.test(userAgent) ? "Microsoft Edge"
    : /(?:Firefox|FxiOS)\//.test(userAgent) ? "Firefox"
    : /(?:Chrome|CriOS)\//.test(userAgent) ? "Chrome"
    : /Safari\//.test(userAgent) ? "Safari" : fallback;
  const platform = /Android/.test(userAgent) ? "Android"
    : /(?:iPhone|iPad|iPod)/.test(userAgent) ? "iOS"
    : /Windows/.test(userAgent) ? "Windows"
    : /Macintosh/.test(userAgent) ? "macOS"
    : /Linux/.test(userAgent) ? "Linux" : "";
  return platform ? `${browser} · ${platform}` : browser;
}
