import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { ChartLineUp, Fire } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useResource } from "../../app/query";
import { bytes } from "../../components/format";
import { useSession } from "../../features/session/context";
import { english, useLocale, useT } from "../../i18n";

type HeatmapDay = {
  date: string;
  uploaded: string;
  downloaded: string;
  billed_bytes: string;
};

type HeatmapResponse = {
  window_days: number;
  days: HeatmapDay[];
  total_uploaded: string;
  total_downloaded: string;
  total_billed: string;
  active_days: number;
  peak_day: { date: string; billed_bytes: string } | null;
};

type GridCell = {
  key: string;
  date: Date;
  visible: boolean;
  uploaded: number;
  downloaded: number;
  billed: number;
  level: 0 | 1 | 2 | 3 | 4;
};

const YEAR_DAYS = 365;
const MS_PER_DAY = 86_400_000;

function toUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoUtcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addUtcDays(d: Date, delta: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + delta));
}

function intensityLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  const ratio = Math.log1p(value) / Math.log1p(max);
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.78) return 3;
  return 4;
}

export function TrafficHeatmap() {
  const t = useT("security");
  const { locale } = useLocale();
  const session = useSession();
  const query = useResource<HeatmapResponse>(`/api/v1/me/usage/heatmap?days=${YEAR_DAYS}`);

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }),
    [locale],
  );
  const monthFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }),
    [locale],
  );
  const weekdayFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }),
    [locale],
  );

  const weekdayLabels = useMemo(() => {
    // 2024-01-07 is a Sunday in UTC
    return [0, 1, 2, 3, 4, 5, 6].map((offset) => weekdayFmt.format(new Date(Date.UTC(2024, 0, 7 + offset))));
  }, [weekdayFmt]);

  const { weeks, monthLabels, spanStart, elapsedDays } = useMemo(() => {
    const byDate = new Map<string, HeatmapDay>();
    let maxBilled = 0;
    let earliestDataDay: Date | null = null;
    for (const entry of query.data?.days ?? []) {
      byDate.set(entry.date, entry);
      const val = Number(entry.billed_bytes) || 0;
      if (val > maxBilled) maxBilled = val;
      const parsed = new Date(`${entry.date}T00:00:00Z`);
      if (!Number.isNaN(parsed.getTime()) && (!earliestDataDay || parsed < earliestDataDay)) {
        earliestDataDay = parsed;
      }
    }

    const todayUtc = toUtcDay(new Date());
    const rollingYearStart = addUtcDays(todayUtc, -(YEAR_DAYS - 1));

    // Anchor the 1-year span at account creation (or earliest usage if earlier),
    // clamped so the span never begins more than 365 days before today.
    const createdRaw = new Date(session.created_at);
    const createdUtc = Number.isNaN(createdRaw.getTime()) ? rollingYearStart : toUtcDay(createdRaw);
    let anchor = earliestDataDay && earliestDataDay < createdUtc ? earliestDataDay : createdUtc;
    if (anchor < rollingYearStart) anchor = rollingYearStart;
    if (anchor > todayUtc) anchor = todayUtc;

    // The calendar always reserves 1 full year (365 days) from anchor,
    // rendering square cells from anchor up through today and leaving future dates blank.
    const spanEnd = addUtcDays(anchor, YEAR_DAYS - 1);
    const gridStart = addUtcDays(anchor, -anchor.getUTCDay());
    const gridEnd = addUtcDays(spanEnd, 6 - spanEnd.getUTCDay());

    const builtWeeks: GridCell[][] = [];
    let cursor = gridStart;
    while (cursor <= gridEnd) {
      const week: GridCell[] = [];
      for (let dow = 0; dow < 7; dow++) {
        const key = isoUtcDate(cursor);
        const visible = cursor >= anchor && cursor <= todayUtc;
        const hit = visible ? byDate.get(key) : undefined;
        const uploaded = hit ? Number(hit.uploaded) || 0 : 0;
        const downloaded = hit ? Number(hit.downloaded) || 0 : 0;
        const billed = hit ? Number(hit.billed_bytes) || 0 : 0;
        week.push({
          key,
          date: cursor,
          visible,
          uploaded,
          downloaded,
          billed,
          level: visible ? intensityLevel(billed, maxBilled) : 0,
        });
        cursor = addUtcDays(cursor, 1);
      }
      builtWeeks.push(week);
    }

    const labels: { col: number; label: string }[] = [];
    let lastMonthKey = "";
    builtWeeks.forEach((week, idx) => {
      const visibleDay = week.find((cell) => cell.visible);
      if (!visibleDay) return;
      const monthKey = `${visibleDay.date.getUTCFullYear()}-${visibleDay.date.getUTCMonth()}`;
      if (monthKey !== lastMonthKey) {
        if (labels.length === 0 || idx - labels[labels.length - 1].col >= 3) {
          labels.push({ col: idx, label: monthFmt.format(visibleDay.date) });
        }
        lastMonthKey = monthKey;
      }
    });

    const elapsed = Math.max(1, Math.min(YEAR_DAYS, Math.floor((todayUtc.getTime() - anchor.getTime()) / MS_PER_DAY) + 1));

    return {
      weeks: builtWeeks,
      monthLabels: labels,
      spanStart: anchor,
      elapsedDays: elapsed,
    };
  }, [query.data, session.created_at, monthFmt]);

  const data = query.data;
  const avgDaily =
    data && data.active_days > 0
      ? Math.round(Number(data.total_billed) / data.active_days).toString()
      : "0";

  return (
    <LayerCard render={<section aria-labelledby="traffic-heatmap-heading" />} className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg"
            style={{ background: "var(--brand-accent-soft)", color: "var(--brand-accent-strong)" }}
            aria-hidden
          >
            <ChartLineUp size={17} weight="bold" />
          </span>
          <div>
            <h2 id="traffic-heatmap-heading" className="text-sm font-semibold text-kumo-strong">
              {t("heatmap.title", "Daily traffic activity")}
            </h2>
            <p className="text-xs text-kumo-subtle">
              {t("heatmap.description", "Recorded daily transfer volume over a 1-year calendar window up to today.")}
            </p>
          </div>
        </div>

        <Badge variant="secondary">
          {t("heatmap.spanBadge", "{start} – Today (1 year)", {
            start: dateFmt.format(spanStart),
          })}
        </Badge>
      </div>

      <div className="flex flex-col gap-4 p-5">
        {query.isError && (
          <KumoBanner
            variant="error"
            size="sm"
            description={english("security", "heatmap.error", "Could not load daily traffic history.")}
            action={
              <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
                {t("sessions.retry", "Try again")}
              </Button>
            }
          />
        )}

        {/* Summary metrics */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-kumo-line bg-kumo-recessed/30 px-3.5 py-2.5">
            <div className="text-xs text-kumo-subtle">{t("heatmap.periodTotal", "Period billed total")}</div>
            <div className="mt-0.5 text-base font-semibold text-kumo-strong tabular-nums">
              {data ? bytes(data.total_billed) : "—"}
            </div>
            <div className="text-[11px] text-kumo-subtle tabular-nums">
              {data
                ? t("heatmap.upDown", "↑ {up} · ↓ {down}", {
                    up: bytes(data.total_uploaded),
                    down: bytes(data.total_downloaded),
                  })
                : "—"}
            </div>
          </div>

          <div className="rounded-lg border border-kumo-line bg-kumo-recessed/30 px-3.5 py-2.5">
            <div className="text-xs text-kumo-subtle">{t("heatmap.activeDays", "Active days")}</div>
            <div className="mt-0.5 text-base font-semibold text-kumo-strong tabular-nums">
              {data
                ? t("heatmap.activeDaysValue", "{active} / {total}", {
                    active: data.active_days,
                    total: elapsedDays,
                  })
                : "—"}
            </div>
            <div className="text-[11px] text-kumo-subtle">
              {t("heatmap.activeDaysHint", "Days with recorded transfer")}
            </div>
          </div>

          <div className="rounded-lg border border-kumo-line bg-kumo-recessed/30 px-3.5 py-2.5">
            <div className="text-xs text-kumo-subtle">{t("heatmap.dailyAvg", "Active-day average")}</div>
            <div className="mt-0.5 text-base font-semibold text-kumo-strong tabular-nums">
              {data ? bytes(avgDaily) : "—"}
            </div>
            <div className="text-[11px] text-kumo-subtle">
              {t("heatmap.dailyAvgHint", "Mean transfer on active days")}
            </div>
          </div>

          <div className="rounded-lg border border-kumo-line bg-kumo-recessed/30 px-3.5 py-2.5">
            <div className="flex items-center gap-1 text-xs text-kumo-subtle">
              <Fire size={13} style={{ color: "var(--brand-accent)" }} aria-hidden />
              <span>{t("heatmap.peakDay", "Peak day")}</span>
            </div>
            <div className="mt-0.5 text-base font-semibold text-kumo-strong tabular-nums">
              {data?.peak_day ? bytes(data.peak_day.billed_bytes) : t("heatmap.noTraffic", "No traffic yet")}
            </div>
            <div className="text-[11px] text-kumo-subtle">
              {data?.peak_day ? dateFmt.format(new Date(`${data.peak_day.date}T00:00:00Z`)) : "—"}
            </div>
          </div>
        </div>

        {/* Left-aligned 1-year Calendar Heatmap Grid with guaranteed square cells */}
        {query.isPending ? (
          <div className="flex flex-col gap-2 py-4">
            <SkeletonLine className="h-28 w-full rounded-lg" />
          </div>
        ) : (
          <div className="heatmap-scroll">
            <div className="heatmap-shell" style={{ ["--heatmap-weeks" as string]: weeks.length }}>
              <div className="heatmap-months" aria-hidden="true">
                <div className="heatmap-axis-spacer" />
                <div className="heatmap-month-track">
                  {monthLabels.map((m) => (
                    <span
                      key={`${m.col}-${m.label}`}
                      className="heatmap-month-label"
                      style={{ gridColumnStart: m.col + 1 }}
                    >
                      {m.label}
                    </span>
                  ))}
                </div>
              </div>

              <div className="heatmap-body">
                <div className="heatmap-weekdays" aria-hidden="true">
                  <span></span>
                  <span>{weekdayLabels[1]}</span>
                  <span></span>
                  <span>{weekdayLabels[3]}</span>
                  <span></span>
                  <span>{weekdayLabels[5]}</span>
                  <span></span>
                </div>

                <div
                  className="heatmap-grid"
                  role="grid"
                  aria-label={t("heatmap.gridLabel", "Daily traffic heatmap")}
                >
                  {weeks.map((week, colIdx) => (
                    <div key={colIdx} className="heatmap-week" role="row">
                      {week.map((cell) => {
                        if (!cell.visible) {
                          return (
                            <span
                              key={cell.key}
                              className="heatmap-cell heatmap-cell-blank"
                              aria-hidden="true"
                            />
                          );
                        }
                        const labelDate = dateFmt.format(cell.date);
                        const tipContent =
                          cell.billed > 0 || cell.uploaded > 0 || cell.downloaded > 0
                            ? `${labelDate} · ${bytes(String(cell.billed))} (↑ ${bytes(String(cell.uploaded))} / ↓ ${bytes(String(cell.downloaded))})`
                            : `${labelDate} · ${t("heatmap.zeroDay", "No traffic recorded")}`;
                        return (
                          <Tooltip
                            key={cell.key}
                            content={tipContent}
                            render={
                              <button
                                type="button"
                                className="heatmap-cell"
                                data-level={cell.level}
                                aria-label={tipContent}
                              />
                            }
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer legend */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-kumo-subtle">
          <span>{t("heatmap.timezoneNote", "Daily buckets are aggregated in UTC.")}</span>
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <span>{t("heatmap.less", "Less")}</span>
            <span className="heatmap-legend-swatch" data-level="0" />
            <span className="heatmap-legend-swatch" data-level="1" />
            <span className="heatmap-legend-swatch" data-level="2" />
            <span className="heatmap-legend-swatch" data-level="3" />
            <span className="heatmap-legend-swatch" data-level="4" />
            <span>{t("heatmap.more", "More")}</span>
          </div>
        </div>
      </div>
    </LayerCard>
  );
}
