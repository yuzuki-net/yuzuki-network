import { messages } from "../i18n";

export function bytes(value: string | null) {
  if (value === null) return messages.get("common", "unlimited", "Unlimited");
  const number = Number(value);
  const labels = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  let unit = 0;
  let scaled = number;
  while (scaled >= 1024 && unit < labels.length - 1) { scaled /= 1024; unit++; }
  const formatter = new Intl.NumberFormat(messages.snapshot().locale, { maximumFractionDigits: 1 });
  return `${formatter.format(scaled)} ${labels[unit]}`;
}

export function dateTime(value: string) {
  return new Intl.DateTimeFormat(messages.snapshot().locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function percent(used: string, limit: string | null) {
  if (limit === null) return 0;
  return Number(limit) === 0 ? 100 : Math.min(Math.round(Number(used) * 100 / Number(limit)), 100);
}
