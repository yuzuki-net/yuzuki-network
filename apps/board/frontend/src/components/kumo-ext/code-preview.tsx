import { Button } from "@cloudflare/kumo/components/button";
import { CodeBlock, type CodeLang } from "@cloudflare/kumo/components/code";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { Check, Copy } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { useT } from "../../i18n";

export function CodePreview({
  title,
  code,
  lang = "jsonc",
  actions,
}: {
  title?: string;
  code: string;
  lang?: CodeLang;
  actions?: ReactNode;
}) {
  const t = useT("common");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-kumo-line bg-kumo-base">
      <div className="flex items-center justify-between gap-2 border-b border-kumo-line bg-kumo-recessed/60 px-3.5 py-2">
        <span className="truncate text-xs font-medium text-kumo-subtle">{title ?? lang.toUpperCase()}</span>
        <div className="flex items-center gap-1.5">
          {actions}
          <Tooltip
            content={copied ? t("copied", "Copied") : t("copy", "Copy")}
            render={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                icon={copied ? Check : Copy}
                onClick={() => void copy()}
              >
                {copied ? t("copied", "Copied") : t("copy", "Copy")}
              </Button>
            }
          />
        </div>
      </div>
      <div className="max-h-80 overflow-auto p-3 text-xs [&>div]:border-0 [&>div]:bg-transparent [&>div]:p-0" dir="ltr">
        <CodeBlock code={code} lang={lang} />
      </div>
    </div>
  );
}
