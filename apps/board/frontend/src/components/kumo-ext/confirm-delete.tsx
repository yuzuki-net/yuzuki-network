import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { Check, Copy, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useT } from "../../i18n";

/**
 * Localized adaptation of Kumo's official DeleteResource block
 * (node_modules/@cloudflare/kumo/dist/blocks-source/delete-resource).
 */
export function ConfirmDeleteDialog({
  open,
  onClose,
  resourceType,
  resourceName,
  description,
  confirmLabel,
  onConfirm,
  pending = false,
  requireName = false,
  error,
}: {
  open: boolean;
  onClose: () => void;
  resourceType: string;
  resourceName: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  pending?: boolean;
  requireName?: boolean;
  error?: string;
}) {
  const t = useT("common");
  const [typed, setTyped] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setTyped("");
      setCopied(false);
    }
  }, [open]);

  const ready = !requireName || typed.trim() === resourceName.trim();

  async function copyName() {
    try {
      await navigator.clipboard.writeText(resourceName);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <Dialog size="base" className="p-0 overflow-hidden" data-kumo-dialog={open ? "open" : undefined}>
        <div className="flex items-center justify-between gap-3 border-b border-kumo-line px-6 py-4">
          <Dialog.Title className="text-base font-semibold text-kumo-strong">
            {t("delete.title", "Delete {name}", { name: resourceName })}
          </Dialog.Title>
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="ghost" shape="square" size="sm" aria-label={t("close", "Close")} disabled={pending}>
                <X size={16} />
              </Button>
            )}
          />
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !pending) onConfirm();
          }}
        >
          <div className="flex flex-col gap-4 p-6">
            {error && <Banner size="sm" variant="error" icon={<WarningCircle />} description={error} />}
            <p className="text-sm leading-relaxed text-kumo-subtle">
              {description ?? t("delete.warning", "This action cannot be undone. This will permanently delete the {type} \"{name}\".", {
                type: resourceType,
                name: resourceName,
              })}
            </p>
            {requireName && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-1.5 text-sm text-kumo-default">
                  <span>{t("delete.typePrompt", "Type")}</span>
                  <button
                    type="button"
                    onClick={() => void copyName()}
                    className="inline-flex items-center gap-1 rounded-md bg-kumo-tint px-2 py-0.5 font-mono text-xs font-semibold text-kumo-strong hover:bg-kumo-recessed"
                  >
                    <span>{resourceName}</span>
                    {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
                  </button>
                  <span>{t("delete.typeSuffix", "to confirm:")}</span>
                </div>
                <Input
                  className="w-full"
                  aria-label={t("delete.typeLabel", "Confirm {name}", { name: resourceName })}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={resourceName}
                  disabled={pending}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-6 py-4">
            <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
              {t("cancel", "Cancel")}
            </Button>
            <Button type="submit" variant="destructive" loading={pending} disabled={!ready}>
              {confirmLabel ?? t("delete.confirm", "Delete")}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
