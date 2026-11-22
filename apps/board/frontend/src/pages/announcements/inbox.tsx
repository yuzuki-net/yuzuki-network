import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Calendar, Check, Checks, CornersOut } from "@phosphor-icons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../assets/scripts/api";
import { Chip, Empty, Modal, PageHeader } from "../../components/console-ui";
import { DataTable, DataToolbar, useTableSelection, type ActiveFilterChip, type Column } from "../../components/data-table";
import { english, useLocale, useT } from "../../i18n";
import { INBOX, UNREAD, type Inbox, type Notice } from "./model";

export function AnnouncementInbox() {
  const t = useT("announcements");
  const { locale } = useLocale();
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const [index, setIndex] = useState(0);
  const [readFilter, setReadFilter] = useState<"all" | "unread">("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Notice | null>(null);
  const selection = useTableSelection(String(index));
  const query = useQuery({
    queryKey: [INBOX, index],
    queryFn: ({ signal }) => api<Inbox>(`${INBOX}?page=${index}`, "GET", undefined, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const page = query.data;
  const rows = page?.items ?? [];
  const visibleRows = rows.filter(
    (row) =>
      (readFilter === "all" || !row.read) &&
      row.title.toLocaleLowerCase(locale).includes(search.trim().toLocaleLowerCase(locale)),
  );
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  useEffect(() => {
    if (!page || query.isPlaceholderData) return;
    setIndex((pageIndex) => Math.min(pageIndex, Math.max(0, Math.ceil(page.total / page.page_size) - 1)));
  }, [page, query.isPlaceholderData]);
  const mark = useMutation({
    mutationFn: (ids: string[] | null) => api(`${INBOX}/read`, "PUT", { ids }),
    onSuccess: (_, ids) => {
      toast.add({ variant: "success", title: t("toast.read", "Announcements marked as read") });
      if (open && (!ids || ids.includes(open.id))) setOpen({ ...open, read: true });
      selection.clear();
      void cache.invalidateQueries({ queryKey: [INBOX] });
      void cache.invalidateQueries({ queryKey: [UNREAD] });
    },
    onError: () => toast.add({ variant: "error", title: english("announcements", "inbox.read_error", "Could not mark announcements as read") }),
  });

  const activeFilters: ActiveFilterChip[] = [];
  if (search.trim()) {
    activeFilters.push({
      key: "q",
      label: t("filter.search", "Search announcement titles"),
      value: search.trim(),
      onRemove: () => setSearch(""),
    });
  }
  if (readFilter === "unread") {
    activeFilters.push({
      key: "read",
      label: t("column.status", "Status"),
      value: t("inbox.unread", "Unread"),
      onRemove: () => setReadFilter("all"),
    });
  }

  const columns: Column<Notice>[] = [
    {
      key: "title",
      title: t("column.title", "Title"),
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" className="announcement-title-button" onClick={() => setOpen(row)}>
            <span dir="auto">{row.title}</span>
          </Button>
          {row.display_mode === "fullscreen" && (
            <Badge variant="primary">
              <CornersOut size={11} className="me-1 inline" aria-hidden />
              {t("mode.fullscreenShort", "Fullscreen")}
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "status",
      title: t("column.status", "Status"),
      cell: (row) => (
        <Chip tone={row.read ? "neutral" : "blue"}>
          {row.read ? t("inbox.read", "Read") : t("inbox.unread", "Unread")}
        </Chip>
      ),
    },
    {
      key: "published",
      title: t("column.published", "Published"),
      omitOnMobile: true,
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <time dateTime={row.published_at}>{date.format(new Date(row.published_at))}</time>
          {row.ends_at && (
            <span className="text-[11px] text-kumo-subtle">
              {t("schedule.until", "Visible until {date}", { date: date.format(new Date(row.ends_at)) })}
            </span>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t("inbox.title", "Announcements")}
        description={t("inbox.description", "Read updates from your workspace administrators.")}
        action={
          (page?.unread ?? 0) > 0 ? (
            <Button variant="secondary" icon={Checks} onClick={() => mark.mutate(null)} loading={mark.isPending}>
              {t("action.read_all", "Mark all as read")}
            </Button>
          ) : undefined
        }
      />
      {query.isError && (
        <KumoBanner
          variant="error"
          size="sm"
          description={english("announcements", "load_error", "Announcements are temporarily unavailable.")}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {t("action.reload", "Reload")}
            </Button>
          }
        />
      )}
      <DataTable
        label={t("inbox.table", "Announcement inbox")}
        rows={visibleRows}
        columns={columns}
        rowId={(row) => row.id}
        layout="auto"
        busy={query.isFetching}
        page={page && { index, size: page.page_size, count: page.total, change: setIndex }}
        toolbar={
          <DataToolbar
            quickFilters={{
              label: t("column.status", "Status"),
              value: readFilter,
              onChange: (next) => setReadFilter(next as "all" | "unread"),
              options: [
                { value: "all", label: t("inbox.all", "All"), count: page?.total },
                { value: "unread", label: t("inbox.unread", "Unread"), count: page?.unread ?? 0 },
              ],
            }}
            search={{
              label: t("filter.search", "Search announcement titles"),
              value: search,
              onChange: setSearch,
              resultCount: visibleRows.length,
            }}
            activeFilters={activeFilters}
            onClear={
              search || readFilter !== "all"
                ? () => {
                    setSearch("");
                    setReadFilter("all");
                  }
                : undefined
            }
            onRefresh={() => void query.refetch()}
            refreshing={query.isFetching}
          />
        }
        selection={
          (page?.unread ?? 0) > 0
            ? {
                ...selection,
                eligible: (row) => !row.read,
                name: (row) => row.title,
                disabled: query.isPlaceholderData || mark.isPending,
                actions: (
                  <Button variant="secondary" size="sm" icon={Check} onClick={() => mark.mutate([...selection.ids])}>
                    {t("action.read_selected", "Mark selected as read")}
                  </Button>
                ),
              }
            : undefined
        }
        empty={
          <Empty
            title={
              search || readFilter !== "all"
                ? t("admin.no_matches", "No matching announcements")
                : t("inbox.empty", "You’re up to date")
            }
          >
            {t("inbox.empty_hint", "Published announcements will appear here.")}
          </Empty>
        }
      />
      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        title={open?.title ?? t("inbox.title", "Announcements")}
        large
      >
        {open && (
          <div className="announcement-preview">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <time dateTime={open.published_at}>{date.format(new Date(open.published_at))}</time>
              {open.display_mode === "fullscreen" && (
                <Badge variant="primary">{t("mode.fullscreenShort", "Fullscreen")}</Badge>
              )}
              {open.ends_at && (
                <Badge variant="secondary">
                  <Calendar size={12} className="me-1 inline" aria-hidden />
                  {t("schedule.until", "Visible until {date}", { date: date.format(new Date(open.ends_at)) })}
                </Badge>
              )}
            </div>
            <p className="text-sm leading-relaxed text-kumo-default" dir="auto">{open.body}</p>
            <div className="dialog-actions">
              {!open.read && (
                <Button variant="primary" icon={Check} loading={mark.isPending} onClick={() => mark.mutate([open.id])}>
                  {t("action.read", "Mark as read")}
                </Button>
              )}
              <Button variant="secondary" onClick={() => setOpen(null)}>
                {t("action.close", "Close")}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
