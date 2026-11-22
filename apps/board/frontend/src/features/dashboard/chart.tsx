import { TimeseriesChart } from "@cloudflare/kumo/components/chart";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { LineChart } from "echarts/charts";
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useState } from "react";
import { bytes } from "../../components/format";
import { useTheme } from "../theme";
import { useLocale, useT } from "../../i18n";
import type { TrafficPoint, TrafficRange } from "./model";
import { TrafficSamples } from "./samples";

echarts.use([LineChart, GridComponent, TooltipComponent, AriaComponent, CanvasRenderer]);

export default function TrafficChart({ rows, range }: { rows: TrafficPoint[]; range: TrafficRange }) {
  const t = useT("dashboard");
  const { locale } = useLocale();
  const { resolved } = useTheme();
  const [up, setUp] = useState(true);
  const [down, setDown] = useState(true);
  const [showValues, setShowValues] = useState(false);
  const fmt = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const series = [
    { key: "downloaded", visible: down, name: t("download", "Download"), color: resolved === "dark" ? "#34d399" : "#10b981" },
    { key: "uploaded", visible: up, name: t("upload", "Upload"), color: resolved === "dark" ? "#60a5fa" : "#2563eb" },
  ] as const;

  return (
    <>
      <div className="dashboard-series">
        <Checkbox
          label={
            <span className="inline-flex items-center gap-1.5 text-sm">
              <span className="size-2.5 rounded-full" style={{ background: series[0].color }} aria-hidden />
              {t("download", "Download")}
            </span>
          }
          checked={down}
          disabled={down && !up}
          onCheckedChange={setDown}
        />
        <Checkbox
          label={
            <span className="inline-flex items-center gap-1.5 text-sm">
              <span className="size-2.5 rounded-full" style={{ background: series[1].color }} aria-hidden />
              {t("upload", "Upload")}
            </span>
          }
          checked={up}
          disabled={up && !down}
          onCheckedChange={setUp}
        />
      </div>
      <div className="px-2 pb-2">
        <TimeseriesChart
          key={resolved}
          echarts={echarts}
          height={280}
          data={series
            .filter(({ visible }) => visible)
            .map(({ key, name, color }) => ({
              name,
              color,
              data: rows.map((row): [number, number] => [Date.parse(row.timestamp), Number(row[key])]),
            }))}
          xAxisTickFormat={(date) => fmt.format(date)}
          tooltipTimestampFormat={(date) => fmt.format(date)}
          yAxisTickFormat={(value) => bytes(String(value))}
          tooltipValueFormat={(value) => bytes(String(value))}
          tooltipFollowCursor="x"
          gradient
          ariaDescription={t("chart.description", "Time series of recorded upload and download traffic across all nodes.")}
        />
      </div>
      <Collapsible.Root className="dashboard-samples" open={showValues} onOpenChange={setShowValues}>
        <Collapsible.Trigger className="text-sm font-medium text-kumo-subtle hover:text-kumo-strong">
          {showValues ? t("chart.hideValues", "Hide values") : t("chart.showValues", "Show values")}
        </Collapsible.Trigger>
        <Collapsible.Panel className="pt-3">
          {showValues && <TrafficSamples key={range} rows={rows} timestamp={(date) => fmt.format(date)} />}
        </Collapsible.Panel>
      </Collapsible.Root>
    </>
  );
}
