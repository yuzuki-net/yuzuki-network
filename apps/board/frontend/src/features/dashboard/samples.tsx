import { useState } from "react";
import { DataTable, type Column } from "../../components/data-table";
import { bytes } from "../../components/format";
import { useT, type Translator } from "../../i18n";
import type { TrafficPoint } from "./model";

function TransferValue({ value, t }: { value: string; t: Translator }) {
  const exact = t("chart.exactBytes", "{count} bytes", { count: BigInt(value) });
  return <data value={value} title={exact}>
    <span aria-hidden>{bytes(value)}</span><span className="sr-only">{exact}</span>
  </data>;
}

export function TrafficSamples({ rows, timestamp }: { rows: TrafficPoint[]; timestamp: (date: Date) => string }) {
  const t = useT("dashboard");
  const [page, setPage] = useState(0);
  const size = 15;
  const lastPage = Math.max(0, Math.ceil(rows.length / size) - 1);
  const index = Math.min(page, lastPage);
  const visible = rows.slice(Math.max(0, rows.length - (index + 1) * size), rows.length - index * size).reverse();
  const columns: Column<TrafficPoint>[] = [
    { key: "time", title: t("chart.sampleTime", "Interval start"), cell: (row) =>
      <time dateTime={row.timestamp}>{timestamp(new Date(row.timestamp))}</time> },
    { key: "download", title: t("download", "Download"), end: true, cell: (row) => <TransferValue value={row.downloaded} t={t} /> },
    { key: "upload", title: t("upload", "Upload"), end: true, cell: (row) => <TransferValue value={row.uploaded} t={t} /> },
  ];
  return <DataTable label={t("chart.table", "Transfer values")} rows={visible} columns={columns}
    rowId={(row) => row.timestamp} page={{ index, size, count: rows.length, change: setPage }} />;
}
