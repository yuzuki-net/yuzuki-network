import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../../assets/scripts/api";
import { Banner, FormActions, Modal } from "../../components/console-ui";
import { useT } from "../../i18n";
import { nodesPath, serversPath, type Server, type ServerInput } from "./model";

export function ServerFormModal({
  open,
  server,
  onClose,
  onSaved,
}: {
  open: boolean;
  server?: Server;
  onClose: () => void;
  onSaved?: (saved: Server) => void;
}) {
  const t = useT("nodes");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={server ? t("servers.editTitle", "Edit server") : t("servers.addTitle", "Add server")}
      description={
        server
          ? t("servers.editDesc", "Update server display name, default public host, or remarks.")
          : t("servers.addDesc", "Register a host to connect its yuzuki-node agent and deploy proxy nodes.")
      }
    >
      {open && (
        <ServerForm
          key={server?.id ?? "new"}
          server={server}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Modal>
  );
}

function ServerForm({
  server,
  onClose,
  onSaved,
}: {
  server?: Server;
  onClose: () => void;
  onSaved?: (saved: Server) => void;
}) {
  const t = useT("nodes");
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const [name, setName] = useState(server?.name ?? "");
  const [defaultHost, setDefaultHost] = useState(server?.default_host ?? "");
  const [remark, setRemark] = useState(server?.remark ?? "");

  const save = useMutation({
    mutationFn: (body: ServerInput) =>
      api<Server>(server ? `${serversPath}/${server.id}` : serversPath, server ? "PUT" : "POST", body),
    onSuccess: (saved) => {
      toast.add({
        title: server ? t("servers.saved", "Server updated") : t("servers.created", "Server added"),
        variant: "success",
      });
      void cache.invalidateQueries({ queryKey: [serversPath] });
      void cache.invalidateQueries({ queryKey: [nodesPath] });
      onSaved?.(saved);
      onClose();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (save.isPending) return;
    save.mutate({
      name: name.trim(),
      default_host: defaultHost.trim() || null,
      remark: remark.trim(),
    });
  }

  return (
    <form className="form-fields" onSubmit={submit}>
      <Input
        label={t("servers.name", "Server name")}
        value={name}
        maxLength={80}
        required
        placeholder="Tokyo-01"
        disabled={save.isPending}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        label={t("servers.defaultHost", "Default public host (IP or domain)")}
        value={defaultHost}
        dir="ltr"
        maxLength={255}
        placeholder="jp1.example.com"
        description={t(
          "servers.defaultHostHelp",
          "Optional. Automatically pre-fills the connection address when creating managed nodes on this server.",
        )}
        disabled={save.isPending}
        onChange={(e) => setDefaultHost(e.target.value)}
      />
      <Textarea
        label={t("servers.remark", "Remark (optional)")}
        value={remark}
        rows={2}
        maxLength={400}
        placeholder={t("servers.remarkPlaceholder", "Provider, billing cycle, or network notes")}
        disabled={save.isPending}
        onChange={(e) => setRemark(e.target.value)}
      />
      <Banner error={save.error} />
      <FormActions
        onClose={onClose}
        pending={save.isPending}
        label={server ? t("servers.save", "Save server") : t("servers.add", "Add server")}
      />
    </form>
  );
}
