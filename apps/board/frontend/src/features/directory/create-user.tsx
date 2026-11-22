import { Input } from "@cloudflare/kumo/components/input";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { api } from "../../assets/scripts/api";
import { Banner, FormActions, Modal } from "../../components/console-ui";
import { useT } from "../../i18n";
import type { Account } from "../session/model";

export const usersPath = "/api/v1/admin/users";

export function CreateUser({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const t = useT("directory");
  const create = useMutation({
    mutationFn: (form: FormData) => api<Account>(usersPath, "POST", { email: form.get("email"), password: form.get("password") }),
    onSuccess: (user) => {
      void cache.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith("/api/v1/admin/directory") });
      toast.add({ title: t("create.success", "User created"), variant: "success" });
      onCreated(user.id);
    },
  });
  const close = () => { create.reset(); onClose(); };
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!create.isPending) create.mutate(new FormData(event.currentTarget));
  }
  return <Modal open={open} title={t("create", "Create user")} description={t("create.detail", "Set the first sign-in credentials for this account.")} onClose={close} pending={create.isPending}>
    <form className="form-fields" onSubmit={submit}>
      <Input label={t("email", "Email address")} name="email" type="email" required autoComplete="off" maxLength={254} />
      <SensitiveInput label={t("create.password", "Initial password")} name="password" minLength={12} maxLength={256} required autoComplete="new-password"
        description={t("create.passwordHelp", "Use at least 12 characters. Share it with the user through a secure channel.")} />
      <Banner error={create.error} />
      <FormActions pending={create.isPending} onClose={close} label={t("create", "Create user")} />
    </form>
  </Modal>;
}
