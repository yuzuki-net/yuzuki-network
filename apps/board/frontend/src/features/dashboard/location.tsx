import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { MapPin } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useState, type FormEvent } from "react";
import { useResource } from "../../app/query";
import { api } from "../../assets/scripts/api";
import { Banner, FormActions, Loading, Modal } from "../../components/console-ui";
import { useT } from "../../i18n";
import { dashboardUrl, type NodeLocation } from "./model";

const Picker = lazy(() => import("./map-picker"));

export function NodeLocationPanel({ id, manage }: { id: string; manage: boolean }) {
  const t = useT("nodes");
  const path = `/api/v1/admin/servers/${id}/location`;
  const data = useResource<NodeLocation | null>(path);
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const [open, setOpen] = useState(false);
  const set = useMutation({
    mutationFn: (value: NodeLocation | null) => api(path, value ? "PUT" : "DELETE", value ?? undefined),
    onSuccess: (_, value) => {
      cache.setQueryData([path], value);
      void cache.invalidateQueries({ queryKey: [dashboardUrl] });
      toast.add({ variant: "success", title: value ? t("location.saved", "Location saved") : t("location.removed", "Location removed") });
      setOpen(false);
    },
  });

  return <>
    <LayerCard render={<section />} className="node-step-card">
      <header><MapPin aria-hidden size={20} /><h2>{t("location.title", "Map location")}</h2></header>
      <Banner error={data.error} />
      <p className="muted">{data.isPending ? t("location.loading", "Loading location…") :
        data.data?.label ?? t("location.none", "Add a location to show this server on the dashboard map.")}</p>
      {manage && <Button variant="secondary" disabled={data.isPending} onClick={() => { set.reset(); setOpen(true); }}>
        {data.data ? t("location.edit", "Edit location") : t("location.add", "Add location")}
      </Button>}
    </LayerCard>
    <Modal open={open} title={t("location.editor", "Server location")} onClose={() => setOpen(false)} pending={set.isPending} large>
      {open && <LocationForm initial={data.data} error={set.error} pending={set.isPending} close={() => setOpen(false)} save={set.mutate} />}
    </Modal>
  </>;
}

function LocationForm({ initial, error, pending, close, save }: {
  initial?: NodeLocation | null; error: unknown; pending: boolean; close: () => void; save: (value: NodeLocation | null) => void;
}) {
  const t = useT("nodes");
  const [latitude, setLatitude] = useState(initial?.latitude.toString() ?? "");
  const [longitude, setLongitude] = useState(initial?.longitude.toString() ?? "");
  const [map, setMap] = useState(false);
  const choose = useCallback((latitude: number, longitude: number) => {
    setLatitude(String(latitude));
    setLongitude(String(longitude));
  }, []);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save({ label: String(new FormData(event.currentTarget).get("label")), latitude: Number(latitude), longitude: Number(longitude) });
  }
  return <form className="form-fields" onSubmit={submit}>
    <Input name="label" label={t("location.name", "Location name")} maxLength={100} required defaultValue={initial?.label} />
    <Collapsible.Root open={map} onOpenChange={setMap}>
      <Collapsible.Trigger>{t("location.map", "Choose on a map")}</Collapsible.Trigger>
      <Collapsible.Panel>{map && <Suspense fallback={<Loading label={t("location.mapLoading", "Loading map…")} />}>
        <Picker marker={latitude && longitude ? { latitude: Number(latitude), longitude: Number(longitude) } : undefined} choose={choose} />
      </Suspense>}</Collapsible.Panel>
    </Collapsible.Root>
    <div className="edit-grid">
      <Input label={t("location.latitude", "Latitude")} type="number" min={-90} max={90} step="any" value={latitude}
        onChange={(event) => setLatitude(event.target.value)} required />
      <Input label={t("location.longitude", "Longitude")} type="number" min={-180} max={180} step="any" value={longitude}
        onChange={(event) => setLongitude(event.target.value)} required />
    </div>
    <Banner error={error} />
    {initial && <div><Button variant="ghost" type="button" disabled={pending} onClick={() => save(null)}>{t("location.remove", "Remove from map")}</Button></div>}
    <FormActions onClose={close} pending={pending} label={t("location.save", "Save location")} />
  </form>;
}
