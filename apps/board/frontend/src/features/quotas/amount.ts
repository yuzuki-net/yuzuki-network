const units = { bytes: 1n, MiB: 1n << 20n, GiB: 1n << 30n, TiB: 1n << 40n } as const;
export type Unit = keyof typeof units;
export const unitLabels = { bytes: "Bytes", MiB: "MiB", GiB: "GiB", TiB: "TiB" } as const;
const maxQuota = (1n << 63n) - 1n;

export function decimalInput(value: string, locale: string) {
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find(({ type }) => type === "decimal")?.value ?? ".";
  return value.trim().replaceAll(decimal, ".").replace(/[٠-٩۰-۹]/g, (digit) => {
    const point = digit.charCodeAt(0);
    return String(point - (point >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

export function quotaAmount(value: string, unit: Unit) {
  const normalized = value.trim();
  if (normalized.length > 24 || !/^\d+(?:\.\d{1,3})?$/.test(normalized)) {
    throw Error("Enter a non-negative number with up to three decimal places.");
  }
  const [integer, fraction = ""] = normalized.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const amount = BigInt(integer + fraction) * units[unit];
  if (unit === "bytes" && amount % scale !== 0n) throw Error("Enter a whole number of bytes.");
  const rounded = (amount + scale / 2n) / scale;
  if (rounded > maxQuota) throw Error("The quota is larger than the supported limit.");
  return rounded;
}

export function existingAmount(bytes: string | null): { value: string; unit: Unit } {
  if (bytes === null) return { value: "", unit: "GiB" };
  const amount = BigInt(bytes);
  for (const unit of ["TiB", "GiB", "MiB"] as const) {
    if (amount < units[unit]) continue;
    const scaled = (amount * 1000n + units[unit] / 2n) / units[unit];
    const fraction = String(scaled % 1000n).padStart(3, "0").replace(/0+$/, "");
    const value = String(scaled / 1000n) + (fraction ? `.${fraction}` : "");
    if ((scaled * units[unit] + 500n) / 1000n === amount) return { value, unit };
  }
  return { value: bytes, unit: bytes === "0" ? "GiB" : "bytes" };
}
