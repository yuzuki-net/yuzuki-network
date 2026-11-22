import { BubbleMap, type MapGeoJson } from "@cloudflare/kumo/components/chart";
import { MapChart, ScatterChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useState } from "react";
import world from "../../assets/maps/world.json";
import { useTheme } from "../theme";

echarts.use([MapChart, ScatterChart, TooltipComponent, CanvasRenderer]);

export default function MapPicker({
  marker,
  choose,
}: {
  marker?: { latitude: number; longitude: number };
  choose: (latitude: number, longitude: number) => void;
}) {
  const { resolved } = useTheme();
  const [chart, setChart] = useState<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!chart) return;
    const canvas = chart.getZr();
    const click = (event: { offsetX: number; offsetY: number }) => {
      const pixel = [event.offsetX, event.offsetY];
      if (!chart.containPixel({ geoIndex: 0 }, pixel)) return;
      const point = chart.convertFromPixel({ geoIndex: 0 }, pixel);
      if (!Array.isArray(point)) return;
      const [longitude, latitude] = point;
      if (latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
        choose(Math.round(latitude * 10_000) / 10_000, Math.round(longitude * 10_000) / 10_000);
      }
    };
    canvas.on("click", click);
    return () => {
      canvas.off("click", click);
    };
  }, [chart, choose]);

  return (
    <BubbleMap
      key={resolved}
      ref={setChart}
      echarts={echarts}
      geoJson={world as MapGeoJson}
      mapName="yuzuki-world-110m"
      data={marker ? [marker] : []}
      lng="longitude"
      lat="latitude"
      value={() => 1}
      minRadius={7}
      maxRadius={7}
      bubbleColor="#10b981"
      showTooltip={false}
      projection={null}
      zoom={1}
      height={220}
    />
  );
}
