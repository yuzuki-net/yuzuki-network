import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ApiError, api } from "../../assets/scripts/api";
import { SectionCard } from "../../components/console-ui";
import { normalizePanel, usePortalOptions } from "../../features/portal/options";
import { useSession } from "../../features/session/context";
import type { Account, Session } from "../../features/session/model";
import { english, useT } from "../../i18n";

export function ProfileSettings() {
  const t = useT("security");
  const account = useSession();
  const options = usePortalOptions();
  const allowEdit = normalizePanel(options.data?.panel).workspace.allow_profile_edit;
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const [name, setName] = useState(account.display_name);
  const [email, setEmail] = useState(account.email);
  const [password, setPassword] = useState("");
  const emailChanged = account.email !== email.trim().toLowerCase();
  const changed = emailChanged || name.trim() !== account.display_name;
  const save = useMutation({
    mutationFn: () =>
      api<Account>("/api/v1/me/profile", "PUT", {
        email: email.trim(),
        display_name: name.trim(),
        current_password: emailChanged ? password : null,
      }),
    onSuccess: (updated) => {
      setName(updated.display_name);
      setEmail(updated.email);
      setPassword("");
      cache.setQueryData<Session>(["/api/v1/me"], (current) => current && { ...current, ...updated });
      void cache.invalidateQueries({ queryKey: ["/api/v1/me"] });
      toast.add({ variant: "success", title: t("profile.saved", "Profile saved") });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (allowEdit && changed && !save.isPending && (!emailChanged || password)) save.mutate();
  }

  return (
    <SectionCard
      title={t("profile.title", "Personal information")}
      description={t("profile.description", "Update your display name or sign-in email address.")}
    >
      {!allowEdit && (
        <div className="mb-4">
          <KumoBanner
            size="sm"
            variant="secondary"
            description={t("profile.locked", "Profile editing is disabled by your workspace administrator.")}
          />
        </div>
      )}
      <form className="form-fields" onSubmit={submit}>
        <Input
          label={t("profile.name", "Display name")}
          name="display_name"
          value={name}
          maxLength={100}
          autoComplete="name"
          onChange={(event) => setName(event.target.value)}
          disabled={!allowEdit || save.isPending}
        />
        <Input
          label={t("profile.email", "Email address")}
          name="email"
          type="email"
          value={email}
          maxLength={254}
          autoComplete="username"
          required
          onChange={(event) => {
            setEmail(event.target.value);
            setPassword("");
          }}
          disabled={!allowEdit || save.isPending}
        />
        {allowEdit && emailChanged && (
          <SensitiveInput
            label={t("password.current", "Current password")}
            name="current_password"
            value={password}
            maxLength={256}
            autoComplete="current-password"
            required
            disabled={save.isPending}
            onValueChange={setPassword}
            description={t("profile.verify_email", "Confirm your current password to change your email address.")}
          />
        )}
        {save.isError && (
          <KumoBanner
            variant="error"
            size="sm"
            description={
              save.error instanceof ApiError && save.error.status === 409
                ? english("security", "profile.conflict", "This email may already be in use or your profile changed. Review the details and try again.")
                : english("security", "profile.error", "Could not save your profile. Check your details and confirmation password.")
            }
          />
        )}
        {allowEdit && (
          <div className="actions">
            <Button variant="primary" type="submit" disabled={!changed} loading={save.isPending}>
              {t("profile.save", "Save profile")}
            </Button>
          </div>
        )}
      </form>
    </SectionCard>
  );
}
