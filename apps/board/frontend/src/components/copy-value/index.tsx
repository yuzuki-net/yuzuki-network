import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { useT } from "../../i18n";
import "./style.css";

export function CopyValue({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const t = useT("common");
  return <div className="copy-value" role="group" aria-label={label}>
    <span>{label}</span>
    <ClipboardText key={value} size="base" text={value} masked={secret} labels={{
      copyAction: t("copyNamed", "Copy {label}", { label }), revealAction: t("showNamed", "Show {label}", { label }),
      hideAction: t("hideNamed", "Hide {label}", { label }),
    }} tooltip={{ text: t("copy", "Copy"), copiedText: t("copied", "Copied") }} />
  </div>;
}
