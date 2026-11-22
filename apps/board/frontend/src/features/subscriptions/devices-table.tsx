import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Devices, Trash } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useResource } from "../../app/query";
import { api } from "../../assets/scripts/api";
import { Banner, Chip, Empty, FormActions, Modal } from "../../components/console-ui";
import { DataTable, DataToolbar, RowActions, type Column } from "../../components/data-table";
import { HelpTip } from "../../components/kumo-ext";
import { personalQuotaPath } from "../quotas/model";
import { useLocale, useT } from "../../i18n";
import { detectClientBadge } from "./clients";
import { subscriptionDevicesUrl, type SubscriptionDevice, type SubscriptionDevices } from "./links";

export function DevicesTable({ canManage, maximum }: { canManage: boolean; maximum: number | null }) {
  const t = useT("subscriptions");
  const { locale } = useLocale();
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const data = useResource<SubscriptionDevices>(subscriptionDevicesUrl);
  const [removing, setRemoving] = useState<SubscriptionDevice>();
  const [search, setSearch] = useState("");
  const query = useQueryClient();
  const toast = useKumoToastManager();
  const close = () => setRemoving(undefined);
  const del = useMutation({
    mutationFn: (id: string) => api(`${subscriptionDevicesUrl}/${id}`, "DELETE"),
    onSuccess: () => {
      toast.add({ title: t("deviceReleased", "Device slot released"), variant: "success" });
      void query.invalidateQueries({ queryKey: [subscriptionDevicesUrl] });
      void query.invalidateQueries({ queryKey: [personalQuotaPath] });
      close();
    },
  });
  const deviceName = (row: SubscriptionDevice) => row.client_name || t("deviceFallback", "Subscription client");
  const columns: Column<SubscriptionDevice>[] = [
    {
      key: "client",
      title: t("device", "Client"),
      cell: (row) => {
        const family = detectClientBadge(row.client_name);
        return (
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-kumo-strong">{deviceName(row)}</strong>
            {family && <Chip tone="blue">{family}</Chip>}
          </div>
        );
      },
    },
    {
      key: "first",
      title: t("firstSeen", "First bound"),
      width: "12rem",
      omitOnMobile: true,
      cell: (row) => <time dateTime={row.first_seen_at}>{date.format(new Date(row.first_seen_at))}</time>,
    },
    {
      key: "last",
      title: t("lastUsed", "Last refreshed"),
      width: "12rem",
      cell: (row) => <time dateTime={row.last_seen_at}>{date.format(new Date(row.last_seen_at))}</time>,
    },
    ...(canManage
      ? [
          {
            key: "actions",
            title: "",
            width: "4rem",
            end: true,
            sticky: true,
            cell: (row: SubscriptionDevice) => (
              <RowActions
                item={deviceName(row)}
                actions={[
                  {
                    label: t("releaseSlot", "Release slot"),
                    icon: Trash,
                    danger: true,
                    run: () => {
                      del.reset();
                      setRemoving(row);
                    },
                  },
                ]}
              />
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <Banner error={data.error} />
      {data.data && (
        <LayerCard className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <span
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "var(--brand-accent-soft)", color: "var(--brand-accent-strong)" }}
              aria-hidden
            >
              <Devices size={18} />
            </span>
            <div>
              <div className="flex items-center gap-1.5 text-sm font-semibold text-kumo-strong">
                <span>
                  {maximum === null
                    ? t("unlimitedSlots", "{count} bound · Unlimited slots", { count: data.data.items.length })
                    : t("countSlots", "{count} of {limit} device slots in use", {
                        count: data.data.items.length,
                        limit: maximum,
                      })}
                </span>
                <HelpTip
                  content={t(
                    "deviceIdentity",
                    "The slot uses the device ID when the client shares one. Otherwise it uses the connection address and client identifier.",
                  )}
                />
              </div>
              <p className="text-xs text-kumo-subtle">
                {t("slotExplanation", "A client occupies a slot for {days} days after its latest configuration refresh.", {
                  days: data.data.active_for_days,
                })}
              </p>
            </div>
          </div>
        </LayerCard>
      )}
      <DataTable
        label={t("devices", "Subscription devices")}
        rows={(data.data?.items ?? []).filter((row) =>
          deviceName(row).toLocaleLowerCase(locale).includes(search.trim().toLocaleLowerCase(locale)),
        )}
        columns={columns}
        rowId={(row) => row.id}
        busy={data.isFetching}
        sortPreference="subscription-devices"
        pagination={{ defaultPageSize: 10, storageKey: "subscription-devices" }}
        toolbar={
          (data.data?.items.length ?? 0) > 0 && (
            <DataToolbar
              search={{
                label: t("searchDevices", "Search clients"),
                placeholder: t("searchDevicesHint", "Filter by client name"),
                value: search,
                onChange: setSearch,
                resultCount: (data.data?.items ?? []).filter((row) =>
                  deviceName(row).toLocaleLowerCase(locale).includes(search.trim().toLocaleLowerCase(locale)),
                ).length,
              }}
              onClear={search ? () => setSearch("") : undefined}
              onRefresh={() => void data.refetch()}
              refreshing={data.isFetching}
            />
          )
        }
        empty={
          <Empty title={search ? t("noMatchingDevices", "No matching devices") : t("emptyDevices", "No subscription devices yet")}>
            {search
              ? t("changeFilters", "Clear the filters to see more links.")
              : t("emptyDevicesHint", "Refresh a subscription from a client to register its first device.")}
          </Empty>
        }
      />
      <Modal
        title={t("releaseSlot", "Release slot")}
        description={removing && deviceName(removing)}
        open={!!removing}
        onClose={close}
        pending={del.isPending}
      >
        <form
          className="form-fields"
          onSubmit={(event) => {
            event.preventDefault();
            if (removing && !del.isPending) del.mutate(removing.id);
          }}
        >
          <p className="text-sm text-kumo-subtle">
            {t("releaseHint", "This frees the slot. A later refresh can register the client again if a slot is available.")}
          </p>
          <Banner error={del.error} />
          <FormActions onClose={close} pending={del.isPending} label={t("releaseSlot", "Release slot")} destructive />
        </form>
      </Modal>
    </>
  );
}
