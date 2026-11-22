import { Input } from "@cloudflare/kumo/components/input";
import { useT } from "../../i18n";
import { inheritedLinkLimits, type CountTuple, type RoleLinkLimits } from "./model";
import "./style.css";

export type { RoleLinkLimits } from "./model";

const fields = [
  ["universal", "Universal (URI)"],
  ["mihomo", "mihomo"],
  ["sing_box", "sing-box"],
  ["xray", "xray-core"],
] as const;

const formatIndices: Record<(typeof fields)[number][0], number> = {
  xray: 0,
  sing_box: 1,
  mihomo: 2,
  universal: 3,
};

export function RoleLinkFields({
  value = inheritedLinkLimits,
  inherited,
  onChange,
  disabled,
  context = "role",
}: {
  value?: RoleLinkLimits;
  inherited?: CountTuple;
  onChange: (value: RoleLinkLimits) => void;
  disabled?: boolean;
  context?: "role" | "account" | "plan";
}) {
  const t = useT("quotas");
  const hint =
    context === "role"
      ? t("roleLimitHint", "Leave a format blank to inherit the default of one link. Across roles, the highest explicit allowance is used.")
      : context === "plan"
        ? t("planLimitHint", "Optional format link limits associated with this quota plan template.")
        : t("accountLimitHint", "Leave a format blank to use its role allowance. A lower limit pauses newer links.");
  return (
    <fieldset className="quota-link-fields">
      <legend>{t("linkLimits", "Subscription link limits")}</legend>
      <p className="muted text-xs">{hint}</p>
      <div className="quota-link-grid">
        {fields.map(([key, label]) => (
          <Input
            key={key}
            label={label}
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            disabled={disabled}
            value={value[key] ?? ""}
            placeholder={
              inherited
                ? t("inheritedValue", "Inherited: {count}", { count: inherited[formatIndices[key]] })
                : t("inherited", "Inherited")
            }
            onChange={(event) =>
              onChange({
                ...value,
                [key]: event.currentTarget.value === "" ? null : event.currentTarget.valueAsNumber,
              })
            }
          />
        ))}
      </div>
    </fieldset>
  );
}
