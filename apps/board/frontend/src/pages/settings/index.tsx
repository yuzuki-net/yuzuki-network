import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { ArrowCounterClockwise, Check } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useResource } from "../../app/query";
import { useConsoleLocation, useConsoleNavigate } from "../../app/router";
import { ApiError, api, message } from "../../assets/scripts/api";
import { Loading, PageHeader } from "../../components/console-ui";
import {
  normalizePanel,
  PANEL_SETTINGS,
  PORTAL_OPTIONS,
  type Panel,
  type PanelRecord,
} from "../../features/portal/options";
import { useCan } from "../../features/session/context";
import { english, useT } from "../../i18n";
import { AdvancedSettings } from "./advanced";
import { AppearanceSettings } from "./appearance";
import { BrandingSettings } from "./branding";
import { FeatureSettings } from "./features";
import { HomepageSettings } from "./homepage";
import { SubscriptionSettings } from "./subscription";
import "./style.css";

const TAB_KEYS = ["branding", "appearance", "homepage", "subscription", "features", "advanced"] as const;
type SettingsTab = (typeof TAB_KEYS)[number];

export default function SettingsPage() {
  const t = useT("settings");
  const settings = useResource<PanelRecord>(PANEL_SETTINGS);
  const writable = useCan("settings.manage");
  return (
    <>
      <PageHeader
        title={t("title", "System settings")}
        description={t(
          "description",
          "Customize branding, theme appearance, public portal, subscription guides, workspace behavior and maintenance notices.",
        )}
      />
      {settings.isPending && <Loading label={t("loading", "Loading system settings…")} />}
      {settings.isError && (
        <KumoBanner
          variant="error"
          size="sm"
          description={english("settings", "load_error", "System settings are temporarily unavailable.")}
          action={
            <Button variant="secondary" onClick={() => void settings.refetch()}>
              {t("retry", "Try again")}
            </Button>
          }
        />
      )}
      {settings.data && (
        <SettingsEditor
          record={{ revision: settings.data.revision, panel: normalizePanel(settings.data.panel) }}
          writable={writable}
          reload={settings.refetch}
        />
      )}
    </>
  );
}

function SettingsEditor({
  record,
  writable,
  reload,
}: {
  record: PanelRecord;
  writable: boolean;
  reload: () => Promise<{ data?: PanelRecord }>;
}) {
  const t = useT("settings");
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const href = useConsoleLocation();
  const navigate = useConsoleNavigate();
  const requested = new URL(href, location.origin).searchParams.get("tab") as SettingsTab | null;
  const group: SettingsTab = requested && TAB_KEYS.includes(requested) ? requested : "branding";
  const [base, setBase] = useState(record);
  const [draft, setDraft] = useState<Panel>(record.panel);
  const changed = JSON.stringify(draft) !== JSON.stringify(base.panel);
  const conflict = record.revision !== base.revision;

  const save = useMutation({
    mutationFn: () => api<PanelRecord>(PANEL_SETTINGS, "PUT", { revision: base.revision, panel: draft }),
    onSuccess: (next) => {
      const normalized = { revision: next.revision, panel: normalizePanel(next.panel) };
      setBase(normalized);
      setDraft(normalized.panel);
      cache.setQueryData([PANEL_SETTINGS], normalized);
      void cache.invalidateQueries({ queryKey: [PORTAL_OPTIONS] });
      void cache.invalidateQueries({ queryKey: ["/api/v1/me/announcements/unread"] });
      toast.add({ variant: "success", title: t("saved", "Settings saved") });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void cache.invalidateQueries({ queryKey: [PANEL_SETTINGS] });
      }
    },
  });

  useEffect(() => {
    if (conflict && !changed) {
      setBase(record);
      setDraft(record.panel);
    }
  }, [changed, conflict, record]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writable && changed && !save.isPending && !conflict) save.mutate();
  }

  async function reloadLatest() {
    const { data } = await reload();
    if (!data) return;
    const normalized = { revision: data.revision, panel: normalizePanel(data.panel) };
    setBase(normalized);
    setDraft(normalized.panel);
    save.reset();
  }

  function setGroup(value: string) {
    const next = new URL(href, location.origin);
    if (value === "branding") next.searchParams.delete("tab");
    else next.searchParams.set("tab", value);
    navigate(next.pathname + next.search + next.hash);
  }

  const disabled = !writable || save.isPending;
  const tabItems: { value: SettingsTab; label: string }[] = [
    { value: "branding", label: t("branding.title", "Branding") },
    { value: "appearance", label: t("appearance.title", "Appearance") },
    { value: "homepage", label: t("homepage.title", "Public homepage") },
    { value: "subscription", label: t("subscription.title", "Subscriptions") },
    { value: "features", label: t("features.title", "Workspace & Features") },
    { value: "advanced", label: t("advanced.title", "Import / Export") },
  ];

  return (
    <form className="flex min-w-0 flex-col gap-5" onSubmit={submit}>
      <div className="border-b border-kumo-line" role="group" aria-label={t("tabs", "Settings sections")}>
        <Tabs variant="underline" tabs={tabItems} value={group} onValueChange={setGroup} />
      </div>

      {writable && changed && (
        <div className="sticky top-[66px] z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-kumo-line bg-kumo-base/95 px-4 py-2.5 shadow-sm backdrop-blur">
          <div className="flex items-center gap-2 text-sm font-medium text-kumo-strong">
            <span className="size-2 rounded-full" style={{ background: "var(--brand-accent)" }} aria-hidden />
            <span>{t("unsaved", "You have unsaved changes")}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={ArrowCounterClockwise}
              disabled={save.isPending}
              onClick={() => {
                setDraft(base.panel);
                save.reset();
              }}
            >
              {t("discard", "Discard changes")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon={Check}
              disabled={conflict}
              loading={save.isPending}
            >
              {t("save", "Save settings")}
            </Button>
          </div>
        </div>
      )}

      {group === "branding" && (
        <BrandingSettings
          value={draft}
          disabled={disabled}
          onChange={(changes) => setDraft((current) => ({ ...current, ...changes }))}
          onChangeExtra={(changes) =>
            setDraft((current) => ({ ...current, branding: { ...current.branding, ...changes } }))
          }
        />
      )}

      {group === "appearance" && (
        <AppearanceSettings
          accent={draft.landing.accent}
          appearance={draft.appearance}
          brandName={draft.name}
          disabled={disabled}
          onChangeAccent={(accent) =>
            setDraft((current) => ({ ...current, landing: { ...current.landing, accent } }))
          }
          onChange={(changes) =>
            setDraft((current) => ({ ...current, appearance: { ...current.appearance, ...changes } }))
          }
        />
      )}

      {group === "homepage" && (
        <HomepageSettings
          landing={draft.landing}
          portal={draft.portal}
          disabled={disabled}
          onChangeLanding={(changes) =>
            setDraft((current) => ({ ...current, landing: { ...current.landing, ...changes } }))
          }
          onChangePortal={(changes) =>
            setDraft((current) => ({ ...current, portal: { ...current.portal, ...changes } }))
          }
        />
      )}

      {group === "subscription" && (
        <SubscriptionSettings
          value={draft.subscription}
          panelName={draft.name}
          panelUrl={draft.url}
          disabled={disabled}
          onChange={(changes) =>
            setDraft((current) => ({
              ...current,
              subscription: { ...current.subscription, ...changes },
            }))
          }
        />
      )}

      {group === "features" && (
        <FeatureSettings
          features={draft.features}
          workspace={draft.workspace}
          disabled={disabled}
          onChangeFeatures={(changes) =>
            setDraft((current) => ({ ...current, features: { ...current.features, ...changes } }))
          }
          onChangeWorkspace={(changes) =>
            setDraft((current) => ({ ...current, workspace: { ...current.workspace, ...changes } }))
          }
        />
      )}

      {group === "advanced" && (
        <AdvancedSettings
          panel={draft}
          disabled={disabled}
          onReplace={(next) => {
            setDraft(next);
            save.reset();
          }}
        />
      )}

      {(save.isError || conflict) && (
        <KumoBanner
          variant="error"
          size="sm"
          role="alert"
          description={
            conflict || (save.error instanceof ApiError && save.error.status === 409)
              ? english("settings", "conflict", "Another administrator saved these settings. Load the latest version to continue.")
              : save.error instanceof ApiError && save.error.code
                ? message(save.error)
                : english("settings", "save_error", "Settings could not be saved. Check the entered values and try again.")
          }
          action={
            conflict ? (
              <Button type="button" variant="secondary" onClick={() => void reloadLatest()}>
                {t("reload", "Load latest settings")}
              </Button>
            ) : undefined
          }
        />
      )}

      {writable && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-kumo-line pt-4">
          {changed && (
            <Button
              type="button"
              variant="secondary"
              disabled={save.isPending}
              onClick={() => {
                setDraft(base.panel);
                save.reset();
              }}
            >
              {t("discard", "Discard changes")}
            </Button>
          )}
          <Button type="submit" variant="primary" icon={Check} disabled={!changed || conflict} loading={save.isPending}>
            {t("save", "Save settings")}
          </Button>
        </div>
      )}
    </form>
  );
}
