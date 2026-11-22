import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { LinkSimple, Plus, Sparkle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useResource } from "../../app/query";
import { useConsoleLocation, useConsoleNavigate } from "../../app/router";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, FormActions, Modal, PageHeader } from "../../components/console-ui";
import { useTableSelection } from "../../components/data-table";
import { ActionTooltip, KpiStatCard } from "../../components/kumo-ext";
import { normalizePanel, usePortalOptions } from "../../features/portal/options";
import { personalQuotaPath } from "../../features/quotas/model";
import { useCan } from "../../features/session/context";
import { DevicesTable } from "../../features/subscriptions/devices-table";
import { LinkAddress, LinksTable } from "../../features/subscriptions/links-table";
import { SubscriberNodesTable } from "../../features/subscriptions/nodes-card";
import {
  countLinks,
  formats,
  provisionSubscriptionsUrl,
  subscriptionsUrl,
  type FormatCode,
  type SubscriptionLink,
  type SubscriptionSnapshot,
} from "../../features/subscriptions/links";
import { useT } from "../../i18n";
import "./style.css";

type DialogState =
  | { view: "new" }
  | { view: "address"; link: SubscriptionLink }
  | { view: "rename"; link: SubscriptionLink }
  | { view: "remove"; ids: string[]; links: SubscriptionLink[] };

export default function Subscriptions() {
  const t = useT("subscriptions");
  const allowed = useCan("subscriptions.manage");
  const options = usePortalOptions();
  const panel = normalizePanel(options.data?.panel);
  const data = useResource<SubscriptionSnapshot>(subscriptionsUrl);
  const href = useConsoleLocation();
  const navigate = useConsoleNavigate();
  const params = new URL(href, location.origin).searchParams;
  const viewParam = params.get("view");
  const section = viewParam === "devices" ? "devices" : viewParam === "nodes" ? "nodes" : "links";
  const requestedFormat = formats.find(({ code }) => String(code) === params.get("format"))?.code;
  const requestCreate = section === "links" && params.get("create") === "1";
  const handledRequest = useRef<string | undefined>(undefined);
  const selected = useTableSelection(`${section}/${requestedFormat ?? "all"}`);
  const [dialog, setDialog] = useState<DialogState>();
  const [name, setName] = useState("");
  const [format, setFormat] = useState<FormatCode>(0);
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const close = () => setDialog(undefined);

  function refresh() {
    void cache.invalidateQueries({ queryKey: [subscriptionsUrl] });
    void cache.invalidateQueries({ queryKey: [personalQuotaPath] });
  }

  const create = useMutation({
    mutationFn: () => api<SubscriptionLink>(subscriptionsUrl, "POST", { name, format }),
    onSuccess: (link) => {
      refresh();
      toast.add({ title: t("created", "Subscription link created"), variant: "success" });
      setDialog({ view: "address", link });
    },
  });
  const remove = useMutation({
    mutationFn: (ids: string[]) =>
      ids.length === 1
        ? api(`${subscriptionsUrl}/${ids[0]}`, "DELETE")
        : api(`${subscriptionsUrl}/remove`, "POST", { ids }),
    onSuccess: () => {
      selected.clear();
      refresh();
      toast.add({ title: t("removed", "Subscription links deleted"), variant: "success" });
      close();
    },
  });
  const rename = useMutation({
    mutationFn: ({ id, name: nextName }: { id: string; name: string }) =>
      api(`${subscriptionsUrl}/${id}`, "PATCH", { name: nextName }),
    onSuccess: (_, { id, name: nextName }) => {
      cache.setQueryData<SubscriptionSnapshot>(
        [subscriptionsUrl],
        (current) =>
          current && {
            ...current,
            links: current.links.map((row) => (row.id === id ? { ...row, name: nextName } : row)),
          },
      );
      void cache.invalidateQueries({ queryKey: [subscriptionsUrl] });
      toast.add({ title: t("renamed", "Subscription link renamed"), variant: "success" });
      close();
    },
  });

  const provision = useMutation({
    mutationFn: () => api<SubscriptionLink[]>(provisionSubscriptionsUrl, "POST"),
    onSuccess: (created) => {
      refresh();
      toast.add({
        title:
          created.length > 0
            ? t("provisionCreated", "Created {count} default subscription link(s)", { count: created.length })
            : t("provisionReady", "Default subscription links are already ready"),
        variant: "success",
      });
    },
  });

  const snapshot = data.data;
  const counts = snapshot && countLinks(snapshot);
  const missingDefaults =
    snapshot && counts
      ? formats.filter(({ code }) => snapshot.effective_link_limits[code] > 0 && counts[code] === 0)
      : [];
  const slots =
    snapshot && counts ? formats.filter(({ code }) => counts[code] < snapshot.effective_link_limits[code]) : [];
  const defaultFormat =
    requestedFormat !== undefined && slots.some(({ code }) => code === requestedFormat)
      ? requestedFormat
      : slots[0]?.code;
  const resetCreate = create.reset;

  useEffect(() => {
    if (!requestCreate) {
      handledRequest.current = undefined;
      return;
    }
    if (!snapshot || handledRequest.current === href) return;
    handledRequest.current = href;
    const remaining = new URL(href, location.origin);
    remaining.searchParams.delete("create");
    navigate(remaining.pathname + remaining.search, true);
    if (!allowed || defaultFormat === undefined || (requestedFormat !== undefined && requestedFormat !== defaultFormat)) {
      return;
    }
    resetCreate();
    setName("");
    setFormat(defaultFormat);
    setDialog({ view: "new" });
  }, [allowed, defaultFormat, href, navigate, requestCreate, requestedFormat, resetCreate, snapshot]);

  const openCreate = () => {
    if (defaultFormat === undefined) return;
    create.reset();
    setName("");
    setFormat(defaultFormat);
    setDialog({ view: "new" });
  };
  const openRemove = (ids: string[]) => {
    remove.reset();
    setDialog({ view: "remove", ids, links: snapshot?.links.filter(({ id }) => ids.includes(id)) ?? [] });
  };

  const newLinkBtn = allowed && (
    <div className="flex flex-wrap items-center gap-2">
      {missingDefaults.length > 0 && (
        <Button variant="secondary" icon={Sparkle} loading={provision.isPending} onClick={() => provision.mutate()}>
          {t("generateDefaults", "Generate default links")}
        </Button>
      )}
      <ActionTooltip
        disabled={!slots.length}
        content={
          !slots.length
            ? t("limits.full", "All format limits are in use. Delete a link or ask an administrator for more slots.")
            : undefined
        }
      >
        <Button variant="primary" icon={Plus} disabled={!slots.length} onClick={openCreate}>
          {t("newLink", "New link")}
        </Button>
      </ActionTooltip>
    </div>
  );

  return (
    <>
      <PageHeader
        title={t("title", "Subscriptions")}
        description={t(
          "description",
          "Create an address for the format supported by your client, then import it as a remote profile.",
        )}
        action={section === "links" ? newLinkBtn : undefined}
      />

      <div className="border-b border-kumo-line">
        <Tabs
          variant="underline"
          tabs={[
            { value: "links", label: t("table", "Subscription links") },
            { value: "nodes", label: t("nodes.tab", "Available nodes") },
            { value: "devices", label: t("devices", "Subscription devices") },
          ]}
          value={section}
          onValueChange={(value) => {
            if (value === "links" || value === "devices" || value === "nodes") {
              navigate(
                value === "links" ? "/workspace/subscriptions" : `/workspace/subscriptions?view=${value}`,
              );
            }
          }}
        />
      </div>

      <Banner error={data.error} />

      {section === "links" ? (
        <>
          {snapshot && !snapshot.quota.eligible && (
            <KumoBanner
              size="sm"
              variant="alert"
              title={t("accessPaused", "Subscription access is paused")}
              description={
                snapshot.quota.state === "scheduled"
                  ? t("quotaScheduled", "The configuration becomes available when your quota period starts.")
                  : t("quotaBlocked", "Review your quota from the workspace overview.")
              }
            />
          )}
          {snapshot?.requires_proxy && !snapshot.endpoints.some(Boolean) && (
            <KumoBanner
              size="sm"
              variant="secondary"
              title={t("waiting", "Waiting for published endpoints")}
              description={t(
                "waitingHint",
                "You can create links now. A client can refresh once its format has a published endpoint.",
              )}
            />
          )}

          {snapshot && counts && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={t("capacity", "Links used and allowed by format")}>
              {formats.map(({ code, name: core, type }) => {
                const epCount = snapshot.endpoints[code];
                return (
                  <KpiStatCard
                    key={core}
                    icon={LinkSimple}
                    title={`${core} · ${type}`}
                    value={t("slotCount", "{used} / {total}", {
                      used: counts[code],
                      total: snapshot.effective_link_limits[code],
                    })}
                    badge={
                      epCount > 0 ? (
                        <Chip tone="green">{t("endpointsReady", "{count} endpoints", { count: epCount })}</Chip>
                      ) : (
                        <Chip tone="amber">{t("endpointsNone", "No endpoints")}</Chip>
                      )
                    }
                    subtitle={t("slotSub", "Active links / allowance")}
                  />
                );
              })}
            </div>
          )}

          <LinksTable
            key={requestedFormat ?? "all"}
            initialFormat={requestedFormat}
            rows={snapshot?.links ?? []}
            canManage={allowed}
            busy={data.isFetching}
            quotaPaused={snapshot?.quota.eligible === false}
            selected={selected}
            baseUrl={panel.subscription.base_url}
            showQr={panel.subscription.show_qr_code}
            enabledClients={panel.subscription.enabled_clients}
            onView={(link) => setDialog({ view: "address", link })}
            onRemove={openRemove}
            onRename={(link) => {
              rename.reset();
              setName(link.name);
              setDialog({ view: "rename", link });
            }}
            toolbarAction={newLinkBtn}
          />
        </>
      ) : section === "nodes" ? (
        <SubscriberNodesTable />
      ) : (
        <DevicesTable canManage={allowed} maximum={snapshot?.quota.max_devices ?? null} />
      )}

      <Modal title={t("newLink", "New link")} open={dialog?.view === "new"} onClose={close} pending={create.isPending}>
        <form
          className="form-fields"
          onSubmit={(event) => {
            event.preventDefault();
            if (!create.isPending) create.mutate();
          }}
        >
          <Input
            label={t("name", "Name")}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder={t("nameHint", "e.g. Desktop client")}
            required
            maxLength={80}
          />
          <Select
            label={t("format", "Format")}
            value={String(format)}
            items={slots.map(({ code, name: core, type }) => ({ value: String(code), label: `${core} (${type})` }))}
            onValueChange={(value: string | null) => {
              if (value !== null) setFormat(Number(value) as FormatCode);
            }}
          />
          {snapshot?.requires_proxy && snapshot.endpoints[format] === 0 && (
            <KumoBanner
              size="sm"
              variant="secondary"
              description={t("formatWaiting", "This format can refresh once a compatible endpoint is published.")}
            />
          )}
          <Banner error={create.error} />
          <FormActions
            onClose={close}
            pending={create.isPending}
            disabled={!name.trim() || !slots.some(({ code }) => code === format)}
            label={t("create", "Create link")}
          />
        </form>
      </Modal>

      <Modal
        title={t("rename", "Rename link")}
        description={t("renameHelp", "The existing address stays valid.")}
        open={dialog?.view === "rename"}
        onClose={close}
        pending={rename.isPending}
      >
        {dialog?.view === "rename" && (
          <form
            className="form-fields"
            onSubmit={(event) => {
              event.preventDefault();
              if (!rename.isPending && name.trim() && name.trim() !== dialog.link.name) {
                rename.mutate({ id: dialog.link.id, name: name.trim() });
              }
            }}
          >
            <Input
              label={t("name", "Name")}
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Banner error={rename.error} />
            <FormActions
              onClose={close}
              pending={rename.isPending}
              disabled={!name.trim() || name.trim() === dialog.link.name}
            />
          </form>
        )}
      </Modal>

      <Modal
        title={t("address", "Subscription address")}
        description={dialog?.view === "address" ? dialog.link.name : undefined}
        open={dialog?.view === "address"}
        onClose={close}
      >
        {dialog?.view === "address" && (
          <div className="form-fields">
            <p className="text-sm text-kumo-subtle">
              {t("copyHint", "Copy the address into your client as a remote profile, then refresh the profile.")}
            </p>
            <LinkAddress path={dialog.link.path} baseUrl={panel.subscription.base_url} />
            <div className="dialog-actions">
              <Button variant="primary" onClick={close}>
                {t("done", "Done")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        title={t("confirmTitle", "Delete subscription links")}
        open={dialog?.view === "remove"}
        onClose={close}
        pending={remove.isPending}
      >
        <form
          className="form-fields"
          onSubmit={(event) => {
            event.preventDefault();
            if (remove.isPending) return;
            if (dialog?.view === "remove") remove.mutate(dialog.ids);
          }}
        >
          <p className="text-sm text-kumo-subtle">
            {t("confirmRemove", "The selected addresses will stop working. Clients using them will need another subscription link.")}
          </p>
          {dialog?.view === "remove" && dialog.links.length > 0 && (
            <ul className="subscription-removal-list">
              {dialog.links.slice(0, 5).map((link) => (
                <li key={link.id}>
                  <bdi className="font-medium text-kumo-strong">{link.name}</bdi>
                  <Chip tone="neutral">{formats[link.format].name}</Chip>
                </li>
              ))}
              {dialog.ids.length > 5 && (
                <li className="muted text-xs">{t("confirmMore", "And {count} more", { count: dialog.ids.length - 5 })}</li>
              )}
            </ul>
          )}
          <Banner error={remove.error} />
          <FormActions onClose={close} pending={remove.isPending} destructive label={t("delete", "Delete")} />
        </form>
      </Modal>
    </>
  );
}
