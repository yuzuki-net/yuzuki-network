import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Calendar, Check, Megaphone, X } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../assets/scripts/api";
import { english, useLocale, useT } from "../../i18n";
import { INBOX, UNREAD, type Notice } from "./model";
import "./style.css";

const DISMISSED_KEY = "yuzuki.dismissed-fullscreen-notices";

function readDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    /* ignore storage errors */
  }
  return new Set();
}

function saveDismissed(ids: Set<string>) {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore storage errors */
  }
}

export function FullscreenAnnouncementOverlay({ notices }: { notices: Notice[] }) {
  const t = useT("announcements");
  const { locale } = useLocale();
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed());

  const pending = notices.filter((item) => !dismissed.has(item.id));
  const current = pending[0];

  const acknowledge = useMutation({
    mutationFn: (id: string) => api(`${INBOX}/read`, "PUT", { ids: [id] }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: [UNREAD] });
      void cache.invalidateQueries({ queryKey: [INBOX] });
    },
    onError: () => {
      toast.add({ variant: "error", title: english("announcements", "inbox.read_error", "Could not mark announcements as read") });
    },
  });

  function dismissForSession(id: string) {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    saveDismissed(next);
  }

  useEffect(() => {
    if (!current) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !acknowledge.isPending) {
        dismissForSession(current.id);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!current) return null;

  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div
      className="fullscreen-notice-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fullscreen-notice-title"
      data-kumo-dialog="open"
    >
      <div className="fullscreen-notice-shell">
        <div className="fullscreen-notice-accent" aria-hidden="true" />
        <header className="fullscreen-notice-header">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span
              className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-xl"
              style={{ background: "var(--brand-accent-soft)", color: "var(--brand-accent-strong)" }}
              aria-hidden
            >
              <Megaphone size={22} weight="duotone" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="primary">{t("mode.fullscreen", "Fullscreen notice")}</Badge>
                {pending.length > 1 && (
                  <Badge variant="secondary">
                    {t("fullscreen.queue", "1 of {count}", { count: pending.length })}
                  </Badge>
                )}
              </div>
              <h2
                id="fullscreen-notice-title"
                className="mt-2 text-xl font-semibold tracking-tight text-kumo-strong sm:text-2xl"
                dir="auto"
              >
                {current.title}
              </h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-kumo-subtle">
                <time dateTime={current.published_at}>
                  {t("fullscreen.publishedAt", "Published {date}", {
                    date: dateFmt.format(new Date(current.published_at)),
                  })}
                </time>
                {current.ends_at && (
                  <span className="inline-flex items-center gap-1">
                    <Calendar size={13} aria-hidden />
                    {t("schedule.until", "Visible until {date}", {
                      date: dateFmt.format(new Date(current.ends_at)),
                    })}
                  </span>
                )}
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label={t("fullscreen.dismiss", "Dismiss for now")}
            disabled={acknowledge.isPending}
            onClick={() => dismissForSession(current.id)}
          >
            <X size={18} />
          </Button>
        </header>

        <div className="fullscreen-notice-body">
          <p className="whitespace-pre-wrap text-sm leading-7 text-kumo-default sm:text-base" dir="auto">
            {current.body}
          </p>
        </div>

        <footer className="fullscreen-notice-footer">
          <Button
            variant="secondary"
            disabled={acknowledge.isPending}
            onClick={() => dismissForSession(current.id)}
          >
            {t("fullscreen.dismiss", "Dismiss for now")}
          </Button>
          <Button
            variant="primary"
            icon={Check}
            loading={acknowledge.isPending}
            onClick={() => acknowledge.mutate(current.id)}
          >
            {t("fullscreen.acknowledge", "I have read and understood")}
          </Button>
        </footer>
      </div>
    </div>
  );
}
