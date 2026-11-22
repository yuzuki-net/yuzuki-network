import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import {
  Archive,
  Bell,
  Calendar,
  CornersOut,
  Eye,
  Megaphone,
  PaperPlaneTilt,
  PencilSimple,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api } from "../../assets/scripts/api";
import { Chip, Empty, FormActions, Modal, PageHeader } from "../../components/console-ui";
import {
  DataTable,
  DataToolbar,
  RowActions,
  useTableSelection,
  type ActiveFilterChip,
  type Column,
} from "../../components/data-table";
import { usePortalOptions } from "../../features/portal/options";
import { useCan } from "../../features/session/context";
import { english, useLocale, useT } from "../../i18n";
import {
  ADMIN_ANNOUNCEMENTS,
  INBOX,
  UNREAD,
  scheduleState,
  type AdminNotice,
  type DisplayMode,
  type Page,
  type Status,
} from "./model";

type Filter = Status | "all";
type Confirmation =
  | { action: "publish" | "archive" | "delete"; row: AdminNotice }
  | { action: "archive" | "delete"; ids: string[] };
type Editor = { row?: AdminNotice };

function canArchive(row: AdminNotice) {
  return row.status === "published" || row.status === "queued";
}
function canDelete(row: AdminNotice) {
  return row.status === "draft" || row.status === "archived";
}

function toLocalDateTimeInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDateTimeInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function AdminAnnouncements() {
  const t = useT("announcements");
  const { locale } = useLocale();
  const changeAllowed = useCan("announcements.manage");
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const options = usePortalOptions();
  const publishing = options.data?.panel.features.announcements ?? true;
  const [filter, setFilter] = useState<Filter>("all");
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preview, setPreview] = useState<AdminNotice | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const request = new URLSearchParams({ page: String(index) });
  if (query) request.set("q", query);
  if (filter !== "all") request.set("status", filter);
  const scope = request.toString();
  const selection = useTableSelection(scope);
  const records = useQuery({
    queryKey: [ADMIN_ANNOUNCEMENTS, scope],
    queryFn: ({ signal }) => api<Page<AdminNotice>>(`${ADMIN_ANNOUNCEMENTS}?${scope}`, "GET", undefined, signal),
    placeholderData: keepPreviousData,
    refetchInterval: ({ state }) =>
      state.data?.items.some((row) => row.status === "queued" && !row.failed) ? 1_500 : false,
  });
  const page = records.data;
  const rows = page?.items ?? [];
  const selected = rows.filter((row) => selection.ids.has(row.id));
  const archiveSelected = selected.length > 0 && selected.every(canArchive);
  const deleteSelected = selected.length > 0 && selected.every(canDelete);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const statuses = {
    all: t("filter.all", "All statuses"),
    draft: t("status.draft", "Draft"),
    queued: t("status.queued", "Queued"),
    published: t("status.published", "Published"),
    archived: t("status.archived", "Archived"),
  };

  useEffect(() => {
    if (!page || records.isPlaceholderData) return;
    setIndex((pageIndex) => Math.min(pageIndex, Math.max(0, Math.ceil(page.total / page.page_size) - 1)));
  }, [page, records.isPlaceholderData]);

  function refresh() {
    void cache.invalidateQueries({ queryKey: [ADMIN_ANNOUNCEMENTS] });
    void cache.invalidateQueries({ queryKey: [INBOX] });
    void cache.invalidateQueries({ queryKey: [UNREAD] });
  }

  const mutate = useMutation({
    mutationFn: (change: Confirmation) =>
      "ids" in change
        ? api(`${ADMIN_ANNOUNCEMENTS}/bulk`, "POST", change)
        : change.action === "delete"
          ? api(`${ADMIN_ANNOUNCEMENTS}/${change.row.id}`, "DELETE")
          : api(`${ADMIN_ANNOUNCEMENTS}/${change.row.id}/${change.action}`, "POST"),
    onSuccess: (_, change) => {
      toast.add({
        variant: "success",
        title:
          change.action === "publish"
            ? t("toast.queued", "Publication queued")
            : change.action === "archive"
              ? t("toast.archived", "Announcements archived")
              : t("toast.deleted", "Announcements deleted"),
      });
      setConfirmation(null);
      selection.clear();
      refresh();
    },
  });

  function confirm(next: Confirmation) {
    mutate.reset();
    setConfirmation(next);
  }

  function renderScheduleCell(row: AdminNotice) {
    const state = scheduleState(row.starts_at, row.ends_at);
    if (state === "always") {
      return <span className="text-xs text-kumo-subtle">{t("schedule.always", "Always visible")}</span>;
    }
    const tone = state === "expired" ? "neutral" : state === "scheduled" ? "blue" : "green";
    const label =
      state === "expired"
        ? t("schedule.expired", "Expired")
        : state === "scheduled"
          ? t("schedule.scheduled", "Scheduled")
          : t("schedule.active", "In window");
    return (
      <div className="flex flex-col gap-1">
        <div>
          <Chip tone={tone}>{label}</Chip>
        </div>
        <span className="text-[11px] text-kumo-subtle">
          {row.starts_at ? date.format(new Date(row.starts_at)) : t("schedule.immediate", "Now")}
          {" → "}
          {row.ends_at ? date.format(new Date(row.ends_at)) : t("schedule.noEnd", "No end")}
        </span>
      </div>
    );
  }

  const columns: Column<AdminNotice>[] = [
    {
      key: "title",
      title: t("column.title", "Title"),
      cell: (row) => (
        <Button variant="ghost" size="sm" className="announcement-title-button px-1.5" onClick={() => setPreview(row)}>
          <span dir="auto">{row.title}</span>
        </Button>
      ),
    },
    {
      key: "display_mode",
      title: t("column.displayMode", "Display mode"),
      omitOnMobile: true,
      cell: (row) =>
        row.display_mode === "fullscreen" ? (
          <Chip tone="blue">
            <span className="inline-flex items-center gap-1">
              <CornersOut size={12} aria-hidden />
              {t("mode.fullscreenShort", "Fullscreen")}
            </span>
          </Chip>
        ) : (
          <Chip tone="neutral">
            <span className="inline-flex items-center gap-1">
              <Bell size={12} aria-hidden />
              {t("mode.normalShort", "Inbox")}
            </span>
          </Chip>
        ),
    },
    {
      key: "schedule",
      title: t("column.schedule", "Display period"),
      omitOnMobile: true,
      cell: renderScheduleCell,
    },
    {
      key: "status",
      title: t("column.status", "Status"),
      cell: (row) => (
        <Chip
          tone={
            row.failed
              ? "red"
              : row.status === "published"
                ? "green"
                : row.status === "queued"
                  ? "amber"
                  : "neutral"
          }
        >
          {row.failed ? english("announcements", "status.failed", "Delivery failed") : statuses[row.status]}
        </Chip>
      ),
    },
    {
      key: "date",
      title: t("column.updated", "Last updated"),
      omitOnMobile: true,
      cell: (row) => <time dateTime={row.updated_at}>{date.format(new Date(row.updated_at))}</time>,
    },
    ...(changeAllowed
      ? [
          {
            key: "actions",
            title: "",
            end: true,
            sticky: true,
            width: "3.75rem",
            cell: (row: AdminNotice) => (
              <RowActions
                item={row.title}
                actions={[
                  { label: t("action.preview", "Preview"), icon: Eye, run: () => setPreview(row) },
                  ...(row.status === "draft"
                    ? [{ label: t("action.edit", "Edit draft"), icon: PencilSimple, run: () => setEditor({ row }) }]
                    : []),
                  ...(row.status === "draft" || row.failed
                    ? [
                        {
                          label: row.failed ? t("action.retry", "Retry delivery") : t("action.publish", "Publish"),
                          icon: PaperPlaneTilt,
                          disabled: !publishing,
                          run: () => confirm({ action: "publish", row }),
                        },
                      ]
                    : []),
                  ...(canArchive(row)
                    ? [
                        {
                          label: t("action.archive", "Archive"),
                          icon: Archive,
                          run: () => confirm({ action: "archive", row }),
                        },
                      ]
                    : []),
                  ...(canDelete(row)
                    ? [
                        {
                          label: t("action.delete", "Delete"),
                          icon: Trash,
                          danger: true,
                          run: () => confirm({ action: "delete", row }),
                        },
                      ]
                    : []),
                ]}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={t("admin.title", "Announcements")}
        description={t("admin.description", "Write, publish and manage messages for personal workspaces.")}
        action={
          changeAllowed ? (
            <Button variant="primary" icon={Plus} onClick={() => setEditor({})}>
              {t("action.new", "New announcement")}
            </Button>
          ) : undefined
        }
      />
      {!publishing && (
        <KumoBanner
          size="sm"
          description={t("admin.feature_off", "Enable announcements in System settings to publish updates.")}
        />
      )}
      {records.isError && (
        <KumoBanner
          size="sm"
          variant="error"
          description={english("announcements", "load_error", "Announcements are temporarily unavailable.")}
          action={
            <Button variant="secondary" onClick={() => void records.refetch()}>
              {t("action.reload", "Reload")}
            </Button>
          }
        />
      )}
      <DataTable
        label={t("admin.table", "Announcement records")}
        rows={rows}
        columns={columns}
        rowId={(row) => row.id}
        layout="auto"
        busy={records.isFetching}
        page={page && { index, size: page.page_size, count: page.total, change: setIndex }}
        toolbar={
          <DataToolbar
            quickFilters={{
              label: t("column.status", "Status"),
              value: filter,
              onChange: (next) => {
                setFilter(next as Filter);
                setIndex(0);
              },
              options: [
                { value: "all", label: statuses.all },
                { value: "draft", label: statuses.draft },
                { value: "queued", label: statuses.queued },
                { value: "published", label: statuses.published },
                { value: "archived", label: statuses.archived },
              ],
            }}
            search={{
              label: t("filter.search", "Search announcement titles"),
              value,
              onChange: (next) => {
                setValue(next);
                if (!next && query) {
                  setQuery("");
                  setIndex(0);
                }
              },
              resultCount: page?.total,
            }}
            activeFilters={[
              ...(query
                ? [
                    {
                      key: "q",
                      label: t("filter.search", "Search announcement titles"),
                      value: query,
                      onRemove: () => {
                        setValue("");
                        setQuery("");
                        setIndex(0);
                      },
                    } satisfies ActiveFilterChip,
                  ]
                : []),
              ...(filter !== "all"
                ? [
                    {
                      key: "status",
                      label: t("column.status", "Status"),
                      value: statuses[filter],
                      onRemove: () => {
                        setFilter("all");
                        setIndex(0);
                      },
                    } satisfies ActiveFilterChip,
                  ]
                : []),
            ]}
            onSubmit={() => {
              setQuery(value.trim());
              setIndex(0);
            }}
            onClear={
              query || filter !== "all" || value
                ? () => {
                    setValue("");
                    setQuery("");
                    setFilter("all");
                    setIndex(0);
                  }
                : undefined
            }
            onRefresh={() => void records.refetch()}
            refreshing={records.isFetching}
          />
        }
        selection={
          changeAllowed
            ? {
                ...selection,
                name: (row) => row.title,
                disabled: records.isPlaceholderData || mutate.isPending,
                actions: (
                  <>
                    {archiveSelected && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={Archive}
                        onClick={() => confirm({ action: "archive", ids: selected.map((row) => row.id) })}
                      >
                        {t("action.archive_selected", "Archive selected")}
                      </Button>
                    )}
                    {deleteSelected && (
                      <Button
                        variant="destructive"
                        size="sm"
                        icon={Trash}
                        onClick={() => confirm({ action: "delete", ids: selected.map((row) => row.id) })}
                      >
                        {t("action.delete_selected", "Delete selected")}
                      </Button>
                    )}
                    {selected.length > 0 && !archiveSelected && !deleteSelected && (
                      <span className="muted text-xs">
                        {t(
                          "selection.mixed",
                          "Select drafts or archived announcements to delete. Select queued or published announcements to archive.",
                        )}
                      </span>
                    )}
                  </>
                ),
              }
            : undefined
        }
        empty={
          <Empty
            title={
              query || filter !== "all"
                ? t("admin.no_matches", "No matching announcements")
                : t("admin.empty", "No announcements yet")
            }
          >
            {t("admin.empty_hint", "Drafts and published announcements appear here.")}
          </Empty>
        }
      />
      <AnnouncementEditor editor={editor} publishing={publishing} close={() => setEditor(null)} refresh={refresh} />
      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={preview?.title ?? t("action.preview", "Preview")}
        large
      >
        {preview && (
          <div className="announcement-preview">
            <div className="flex flex-wrap items-center gap-2">
              <Chip>{statuses[preview.status]}</Chip>
              <Chip tone={preview.display_mode === "fullscreen" ? "blue" : "neutral"}>
                {preview.display_mode === "fullscreen"
                  ? t("mode.fullscreen", "Fullscreen notice")
                  : t("mode.normal", "Standard inbox notice")}
              </Chip>
              {(preview.starts_at || preview.ends_at) && (
                <Badge variant="secondary">
                  <Calendar size={12} className="me-1 inline" aria-hidden />
                  {preview.starts_at ? date.format(new Date(preview.starts_at)) : t("schedule.immediate", "Now")}
                  {" → "}
                  {preview.ends_at ? date.format(new Date(preview.ends_at)) : t("schedule.noEnd", "No end")}
                </Badge>
              )}
            </div>
            <p className="text-sm leading-relaxed text-kumo-default" dir="auto">
              {preview.body}
            </p>
            <div className="dialog-actions">
              <Button variant="secondary" onClick={() => setPreview(null)}>
                {t("action.close", "Close")}
              </Button>
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={!!confirmation}
        onClose={() => setConfirmation(null)}
        pending={mutate.isPending}
        title={
          confirmation?.action === "publish"
            ? t("confirm.publish", "Publish announcement?")
            : confirmation?.action === "archive"
              ? t("confirm.archive", "Archive announcements?")
              : t("confirm.delete", "Delete announcements?")
        }
      >
        {confirmation && (
          <form
            className="form-fields"
            onSubmit={(event) => {
              event.preventDefault();
              mutate.mutate(confirmation);
            }}
          >
            <p className="text-sm text-kumo-subtle">
              {confirmation.action === "publish"
                ? t("confirm.publish_desc", "The announcement will be queued for delivery to personal workspaces.")
                : confirmation.action === "archive"
                  ? t("confirm.archive_desc", "Archived announcements are removed from personal inboxes.")
                  : t("confirm.delete_desc", "The selected announcements will be permanently deleted.")}
            </p>
            {mutate.isError && (
              <KumoBanner
                variant="error"
                size="sm"
                description={english("announcements", "change_error", "The update failed. Reload and review the announcement status.")}
              />
            )}
            <FormActions
              onClose={() => setConfirmation(null)}
              pending={mutate.isPending}
              destructive={confirmation.action === "delete"}
              label={
                confirmation.action === "publish"
                  ? t("action.publish", "Publish")
                  : confirmation.action === "archive"
                    ? t("action.archive", "Archive")
                    : t("action.delete", "Delete")
              }
            />
          </form>
        )}
      </Modal>
    </>
  );
}

const SCHEDULE_PRESETS: { key: string; hours: number | null; fallback: string }[] = [
  { key: "schedule.presetPermanent", hours: null, fallback: "Permanent" },
  { key: "schedule.preset24h", hours: 24, fallback: "24 hours" },
  { key: "schedule.preset3d", hours: 72, fallback: "3 days" },
  { key: "schedule.preset7d", hours: 24 * 7, fallback: "7 days" },
  { key: "schedule.preset30d", hours: 24 * 30, fallback: "30 days" },
];

function AnnouncementEditor({
  editor,
  publishing,
  close,
  refresh,
}: {
  editor: Editor | null;
  publishing: boolean;
  close: () => void;
  refresh: () => void;
}) {
  const t = useT("announcements");
  const { locale } = useLocale();
  const toast = useKumoToastManager();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("normal");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");

  const save = useMutation({
    mutationFn: async (input: {
      title: string;
      body: string;
      display_mode: DisplayMode;
      starts_at: string | null;
      ends_at: string | null;
      publishNow: boolean;
    }) => {
      let targetId: string | undefined;
      if (editor?.row) {
        await api(`${ADMIN_ANNOUNCEMENTS}/${editor.row.id}`, "PUT", {
          title: input.title,
          body: input.body,
          display_mode: input.display_mode,
          starts_at: input.starts_at,
          ends_at: input.ends_at,
          revision: editor.row.revision,
        });
        targetId = editor.row.id;
      } else {
        const created = await api<{ id: string }>(ADMIN_ANNOUNCEMENTS, "POST", {
          title: input.title,
          body: input.body,
          display_mode: input.display_mode,
          starts_at: input.starts_at,
          ends_at: input.ends_at,
        });
        targetId = created?.id;
      }
      if (input.publishNow && targetId) {
        await api(`${ADMIN_ANNOUNCEMENTS}/${targetId}/publish`, "POST");
      }
      return input.publishNow;
    },
    onSuccess: (published) => {
      toast.add({
        variant: "success",
        title: published ? t("toast.queued", "Publication queued") : t("toast.saved", "Draft saved"),
      });
      refresh();
      close();
    },
  });

  useEffect(() => {
    setTitle(editor?.row?.title ?? "");
    setBody(editor?.row?.body ?? "");
    setDisplayMode(editor?.row?.display_mode ?? "normal");
    setStartsAt(toLocalDateTimeInput(editor?.row?.starts_at));
    setEndsAt(toLocalDateTimeInput(editor?.row?.ends_at));
    setScheduleError(null);
    setMode("edit");
  }, [editor]);

  function cancel() {
    save.reset();
    close();
  }

  function applyPreset(hours: number | null) {
    setScheduleError(null);
    if (hours === null) {
      setStartsAt("");
      setEndsAt("");
      return;
    }
    const base = startsAt ? new Date(startsAt) : new Date();
    const validBase = Number.isNaN(base.getTime()) ? new Date() : base;
    if (!startsAt) setStartsAt(toLocalDateTimeInput(validBase.toISOString()));
    const end = new Date(validBase.getTime() + hours * 3_600_000);
    setEndsAt(toLocalDateTimeInput(end.toISOString()));
  }

  function triggerSave(publishNow: boolean) {
    if (save.isPending || !title.trim() || !body.trim()) return;
    const startIso = fromLocalDateTimeInput(startsAt);
    const endIso = fromLocalDateTimeInput(endsAt);
    if (startIso && endIso && Date.parse(endIso) <= Date.parse(startIso)) {
      setScheduleError(english("announcements", "schedule.invalidRange", "End time must be later than start time."));
      return;
    }
    setScheduleError(null);
    save.mutate({
      title,
      body,
      display_mode: displayMode,
      starts_at: startIso,
      ends_at: endIso,
      publishNow,
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    triggerSave(false);
  }

  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const startIso = fromLocalDateTimeInput(startsAt);
  const endIso = fromLocalDateTimeInput(endsAt);

  return (
    <Modal
      open={!!editor}
      onClose={cancel}
      pending={save.isPending}
      large
      title={editor?.row ? t("action.edit", "Edit draft") : t("action.new", "New announcement")}
      description={t(
        "editor.description",
        "Compose your update, choose display mode and active period, then save or publish.",
      )}
    >
      <form className="form-fields" onSubmit={submit}>
        <Tabs
          variant="segmented"
          className="w-fit max-w-full"
          value={mode}
          onValueChange={(val) => setMode(val as "edit" | "preview")}
          tabs={[
            { value: "edit", label: t("editor.writeTab", "Write") },
            { value: "preview", label: t("action.preview", "Preview") },
          ]}
        />

        {mode === "edit" ? (
          <>
            <Input
              label={t("editor.title", "Title")}
              name="announcement-title"
              value={title}
              autoComplete="off"
              required
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              disabled={save.isPending}
            />

            {/* Display mode selector */}
            <div role="group" aria-labelledby="announcement-display-mode-label" className="flex flex-col gap-2.5">
              <span id="announcement-display-mode-label" className="text-sm font-medium text-kumo-default">
                {t("editor.displayMode", "Display mode")}
              </span>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={save.isPending}
                  onClick={() => setDisplayMode("normal")}
                  className={`announcement-mode-card ${displayMode === "normal" ? "is-selected" : ""}`}
                  aria-pressed={displayMode === "normal"}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-kumo-strong">
                    <Bell size={16} aria-hidden />
                    <span>{t("mode.normal", "Standard inbox notice")}</span>
                  </div>
                  <p className="text-xs leading-relaxed text-kumo-subtle">
                    {t("mode.normalDesc", "Shown in the user’s Announcements inbox with an unread badge.")}
                  </p>
                </button>
                <button
                  type="button"
                  disabled={save.isPending}
                  onClick={() => setDisplayMode("fullscreen")}
                  className={`announcement-mode-card ${displayMode === "fullscreen" ? "is-selected" : ""}`}
                  aria-pressed={displayMode === "fullscreen"}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-kumo-strong">
                    <CornersOut size={16} aria-hidden />
                    <span>{t("mode.fullscreen", "Fullscreen notice")}</span>
                  </div>
                  <p className="text-xs leading-relaxed text-kumo-subtle">
                    {t(
                      "mode.fullscreenDesc",
                      "Pops up as a prominent fullscreen modal when signed-in users open the console until acknowledged.",
                    )}
                  </p>
                </button>
              </div>
            </div>

            {/* Display period / schedule */}
            <div
              role="group"
              aria-labelledby="announcement-schedule-label"
              className="flex flex-col gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  id="announcement-schedule-label"
                  className="flex items-center gap-1.5 text-sm font-medium text-kumo-strong"
                >
                  <Calendar size={15} style={{ color: "var(--brand-accent)" }} aria-hidden />
                  <span>{t("schedule.title", "Display period (optional)")}</span>
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {SCHEDULE_PRESETS.map((preset) => (
                    <Button
                      key={preset.key}
                      type="button"
                      variant="secondary"
                      size="xs"
                      disabled={save.isPending}
                      onClick={() => applyPreset(preset.hours)}
                    >
                      {t(preset.key, preset.fallback)}
                    </Button>
                  ))}
                </div>
              </div>
              <p className="text-xs leading-relaxed text-kumo-subtle">
                {t(
                  "schedule.help",
                  "Leave both blank to display indefinitely once published, or set a window when subscribers should see it.",
                )}
              </p>
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <Input
                  label={t("schedule.startsAt", "Visible from")}
                  type="datetime-local"
                  value={startsAt}
                  disabled={save.isPending}
                  description={t("schedule.startsAtHint", "Leave blank to start immediately on publish.")}
                  onChange={(event) => {
                    setStartsAt(event.target.value);
                    setScheduleError(null);
                  }}
                />
                <Input
                  label={t("schedule.endsAt", "Visible until")}
                  type="datetime-local"
                  value={endsAt}
                  disabled={save.isPending}
                  description={t("schedule.endsAtHint", "Leave blank to keep visible until archived.")}
                  onChange={(event) => {
                    setEndsAt(event.target.value);
                    setScheduleError(null);
                  }}
                />
              </div>
            </div>

            <Textarea
              label={t("editor.message", "Message")}
              name="announcement-body"
              value={body}
              rows={8}
              required
              maxLength={10_000}
              onChange={(event) => setBody(event.target.value)}
              disabled={save.isPending}
            />
          </>
        ) : (
          <div
            className={`flex flex-col gap-3 rounded-xl border border-kumo-line p-5 ${
              displayMode === "fullscreen"
                ? "bg-kumo-base shadow-md"
                : "bg-kumo-recessed/40"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              {displayMode === "fullscreen" && (
                <span
                  className="inline-flex size-8 items-center justify-center rounded-lg"
                  style={{ background: "var(--brand-accent-soft)", color: "var(--brand-accent-strong)" }}
                  aria-hidden
                >
                  <Megaphone size={17} weight="duotone" />
                </span>
              )}
              <Badge variant={displayMode === "fullscreen" ? "primary" : "secondary"}>
                {displayMode === "fullscreen"
                  ? t("mode.fullscreen", "Fullscreen notice")
                  : t("mode.normal", "Standard inbox notice")}
              </Badge>
              {(startIso || endIso) && (
                <Badge variant="outline">
                  {startIso ? dateFmt.format(new Date(startIso)) : t("schedule.immediate", "Now")}
                  {" → "}
                  {endIso ? dateFmt.format(new Date(endIso)) : t("schedule.noEnd", "No end")}
                </Badge>
              )}
            </div>
            <h3 className="text-lg font-semibold text-kumo-strong" dir="auto">
              {title || t("editor.untitled", "Untitled announcement")}
            </h3>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-kumo-default" dir="auto">
              {body || t("editor.emptyBody", "No message body yet.")}
            </p>
          </div>
        )}

        {scheduleError && <KumoBanner variant="error" size="sm" description={scheduleError} />}

        {save.isError && (
          <KumoBanner
            variant="error"
            size="sm"
            description={
              save.error instanceof ApiError && save.error.status === 409
                ? english("announcements", "editor.conflict", "This draft changed. Close the editor and reload announcements.")
                : english("announcements", "editor.error", "The draft could not be saved. Check the title, message and schedule.")
            }
          />
        )}

        <div className="dialog-actions">
          <Button variant="secondary" type="button" disabled={save.isPending} onClick={cancel}>
            {t("action.close", "Cancel")}
          </Button>
          <Button
            variant="secondary"
            type="submit"
            loading={save.isPending}
            disabled={!title.trim() || !body.trim()}
          >
            {t("action.save", "Save draft")}
          </Button>
          {publishing && (
            <Button
              variant="primary"
              type="button"
              icon={PaperPlaneTilt}
              loading={save.isPending}
              disabled={!title.trim() || !body.trim()}
              onClick={() => triggerSave(true)}
            >
              {t("action.saveAndPublish", "Save & publish")}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
