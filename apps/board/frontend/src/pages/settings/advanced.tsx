import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { ArrowCounterClockwise, DownloadSimple, UploadSimple } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { SectionCard } from "../../components/console-ui";
import { CodePreview, ConfirmDeleteDialog } from "../../components/kumo-ext";
import { defaultPanel, normalizePanel, type Panel } from "../../features/portal/options";
import { english, useT } from "../../i18n";

export function AdvancedSettings({
  panel,
  disabled,
  onReplace,
}: {
  panel: Panel;
  disabled: boolean;
  onReplace: (next: Panel) => void;
}) {
  const t = useT("settings");
  const toast = useKumoToastManager();
  const fileInput = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const jsonSnapshot = JSON.stringify(panel, null, 2);

  function exportJson() {
    const blob = new Blob([jsonSnapshot], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(panel.name || "panel").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-settings.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setImportError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(english("settings", "advanced.invalidJson", "Select a valid exported settings JSON object."));
      }
      const normalized = normalizePanel(parsed as Partial<Panel>);
      onReplace(normalized);
      toast.add({
        variant: "success",
        title: t("advanced.imported", "Settings loaded into draft. Click Save settings to apply."),
      });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : english("settings", "advanced.invalidJson", "Invalid JSON file."));
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <SectionCard
        title={t("advanced.backupTitle", "Export & import configuration")}
        description={t("advanced.backupDesc", "Back up your customization or migrate branding and portal presets between environments.")}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <Button type="button" variant="secondary" icon={DownloadSimple} onClick={exportJson}>
              {t("advanced.export", "Export JSON")}
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
            <Button
              type="button"
              variant="secondary"
              icon={UploadSimple}
              disabled={disabled}
              onClick={() => fileInput.current?.click()}
            >
              {t("advanced.import", "Import JSON")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              icon={ArrowCounterClockwise}
              disabled={disabled}
              onClick={() => setConfirmReset(true)}
            >
              {t("advanced.reset", "Reset to defaults")}
            </Button>
          </div>
          {importError && <KumoBanner size="sm" variant="error" description={importError} />}
          <CodePreview title={t("advanced.snapshot", "Current settings snapshot (read-only)")} code={jsonSnapshot} lang="jsonc" />
        </div>
      </SectionCard>

      <ConfirmDeleteDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        resourceType={t("advanced.resetResource", "settings")}
        resourceName={panel.name}
        description={t(
          "advanced.resetConfirmDesc",
          "Restore all branding, appearance, homepage, subscription and workspace customization back to factory defaults. You can still review and click Save settings before publishing.",
        )}
        confirmLabel={t("advanced.reset", "Reset to defaults")}
        onConfirm={() => {
          onReplace({
            ...defaultPanel,
            features: { ...panel.features },
          });
          setConfirmReset(false);
          toast.add({
            variant: "info",
            title: t("advanced.resetDone", "Defaults loaded into draft. Click Save settings to apply."),
          });
        }}
      />
    </div>
  );
}
