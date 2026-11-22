import { BubbleMap, type MapGeoJson } from "@cloudflare/kumo/components/chart";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { MapChart, ScatterChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import world from "../../assets/maps/world.json";
import { useConsoleNavigate } from "../../app/router";
import { bytes } from "../../components/format";
import { useTheme } from "../theme";
import { useT } from "../../i18n";
import type { Marker } from "./model";

echarts.use([MapChart, ScatterChart, TooltipComponent, CanvasRenderer]);
const geometry = world as MapGeoJson;
const href = (id: string) => "/admin/servers?" + new URLSearchParams({ server: id });

function escape(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? "");
}

export default function NodeMap({ nodes }: { nodes: Marker[] }) {
  const navigate = useConsoleNavigate();
  const { resolved } = useTheme();
  const t = useT("dashboard");
  return (
    <>
      <BubbleMap
        key={resolved}
        echarts={echarts}
        geoJson={geometry}
        mapName="yuzuki-world-110m"
        data={nodes}
        lng="longitude"
        lat="latitude"
        name="name"
        minRadius={6}
        maxRadius={18}
        value={(node) => Number(node.uploaded) + Number(node.downloaded)}
        bubbleColor={(node) => (node.online ? "#10b981" : "#94a3b8")}
        bubbleBorderColor={resolved === "dark" ? "#171717" : "#ffffff"}
        bubbleBorderWidth={1.5}
        height={310}
        roam
        tooltipFormatter={(node) =>
          `<strong>${escape(node.name)}</strong><br>${escape(node.label)}<br>${escape(
            bytes(String(BigInt(node.uploaded) + BigInt(node.downloaded))),
          )}`
        }
        onBubbleClick={(node) => navigate(href(node.id))}
      />
      <ul className="dashboard-map-links" aria-label={t("map.configured", "Mapped nodes")}>
        {nodes.map((node) => (
          <li key={node.id}>
            <LinkButton variant="ghost" size="sm" href={href(node.id)}>
              <span
                className="size-2 rounded-full"
                style={{ background: node.online ? "#10b981" : "#94a3b8" }}
                aria-hidden
              />
              <span>
                {node.name} · {node.label}
              </span>
            </LinkButton>
          </li>
        ))}
      </ul>
    </>
  );
}
