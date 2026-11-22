import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../../assets/scripts/api";
import { Banner, FormActions, Modal } from "../../components/console-ui";
import { dateTime } from "../../components/format";
import { useT } from "../../i18n";
import type { Account } from "../session/model";
import type { UserDetail } from "./user-detail";

export function ProfilePanel({ user, path, edit, status }: { user: Account; path: string; edit: boolean; status: boolean }) {
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const t = useT("directory");
  const statusAction = user.active ? t("status.suspend", "Suspend account") : t("status.activate", "Activate account");
  const statusDescription = user.active ?
    t("status.suspendHelp", "Suspending this account ends its sessions and revokes its subscription links.") :
    t("status.activateHelp", "Activation allows this user to sign in and create subscription links.");
  const [activeDialog, setActiveDialog] = useState(false);
  const [email, setEmail] = useState(user.email);
  const [name, setName] = useState(user.display_name);
  const settings = useMutation({
    mutationFn: ({ route, body }: { route: "profile" | "status"; body: unknown }) => api<Account>(`${path}/${route}`, "PUT", body),
    onSuccess: (user, request) => {
      setActiveDialog(false);
      setEmail(user.email);
      setName(user.display_name);
      cache.setQueryData<UserDetail>([path], (prev) => prev && ({ ...prev, account: user }));
      void cache.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith("/api/v1/admin/directory") });
      void cache.invalidateQueries({ queryKey: ["/api/v1/me"] });
      toast.add({ title: request.route === "profile" ? t("profile.saved", "Profile saved") :
        user.active ? t("status.activated", "Account activated") : t("status.suspended", "Account suspended"), variant: "success" });
    },
  });
  const dirty = user.email !== email.trim() || user.display_name !== name.trim();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (edit && dirty) settings.mutate({ route: "profile", body: { email: email.trim(), display_name: name.trim() } });
  }
  return <>
    <div className={`grid items-start gap-4 ${status ? "lg:grid-cols-2" : ""}`}>
      <LayerCard render={<section />} className="profile-card">
        <h2>{t("profile.title", "Account profile")}</h2>
        <dl className="profile-attributes"><div><dt>{t("created", "Created")}</dt><dd>{dateTime(user.created_at)}</dd></div></dl>
        {edit ? <form className="form-fields profile-form" onSubmit={submit}>
          <Input label={t("profile.name", "Display name")} name="display_name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          <Input label={t("email", "Email address")} name="email" type="email" value={email} required onChange={(event) => setEmail(event.target.value)} />
          {!activeDialog && <Banner error={settings.error} />}
          <div><Button variant="primary" type="submit" disabled={!dirty} loading={settings.isPending}>{t("profile.save", "Save profile")}</Button></div>
        </form> : <dl className="profile-attributes"><div><dt>{t("profile.name", "Display name")}</dt><dd>{user.display_name || "—"}</dd></div>
          <div><dt>{t("email", "Email address")}</dt><dd><bdi>{user.email}</bdi></dd></div></dl>}
      </LayerCard>
      {status && <LayerCard render={<section />} className="profile-card">
        <h2>{t("status.access", "Account access")}</h2>
        <p className="muted">{statusDescription}</p>
        <div><Button variant="secondary" onClick={() => { settings.reset(); setActiveDialog(true); }}>
          {statusAction}
        </Button></div>
      </LayerCard>}
    </div>
    <Modal title={user.active ? t("status.suspendTitle", "Suspend account?") : t("status.activateTitle", "Activate account?")} description={user.email} open={activeDialog}
      onClose={() => setActiveDialog(false)} pending={settings.isPending}>
      <form className="form-fields" onSubmit={(event) => {
        event.preventDefault(); settings.mutate({ route: "status", body: { active: !user.active } });
      }}>
        <p>{statusDescription}</p>
        <Banner error={settings.error} />
        <FormActions pending={settings.isPending} onClose={() => setActiveDialog(false)} destructive={user.active}
          label={statusAction} />
      </form>
    </Modal>
  </>;
}

export function CredentialsPanel({ path }: { path: string }) {
  const toast = useKumoToastManager();
  const t = useT("directory");
  const [operation, setOperation] = useState<"password" | "sessions" | null>(null);
  const change = useMutation({
    mutationFn: (password: string | null) => password === null ? api(`${path}/sessions`, "DELETE") :
      api(`${path}/credentials`, "PUT", { password }),
    onSuccess: (_, password) => {
      setOperation(null);
      toast.add({ title: password === null ? t("credentials.sessionsEnded", "Sessions ended") : t("credentials.passwordReset", "Password reset"), variant: "success" });
    },
  });
  const request = (next: typeof operation) => { change.reset(); setOperation(next); };
  const sessions = operation === "sessions";
  return <>
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <LayerCard render={<section />} className="profile-card">
        <h2>{t("credentials.title", "Sign-in credentials")}</h2>
        <p className="muted">{t("credentials.help", "Resetting the password ends active browser sessions and revokes the user’s subscription links.")}</p>
        <div><Button variant="secondary" onClick={() => request("password")}>{t("credentials.reset", "Reset password")}</Button></div>
      </LayerCard>
      <LayerCard render={<section />} className="profile-card">
        <h2>{t("credentials.sessions", "Active sign-in sessions")}</h2>
        <p className="muted">{t("credentials.sessionsHelp", "Require the user to sign in again on all devices.")}</p>
        <div><Button variant="secondary" onClick={() => request("sessions")}>{t("credentials.endAll", "End all sign-in sessions")}</Button></div>
      </LayerCard>
    </div>
    <Modal open={operation !== null} title={sessions ? t("credentials.endTitle", "End all sign-in sessions?") : t("credentials.resetTitle", "Reset password?")}
      description={sessions ? t("credentials.endHelp", "The user will need to sign in again.") :
        t("credentials.resetHelp", "Existing sessions and subscription links will stop working.")}
      pending={change.isPending} onClose={() => setOperation(null)}>
      <form className="form-fields" onSubmit={(event) => {
        event.preventDefault();
        change.mutate(sessions ? null : String(new FormData(event.currentTarget).get("password")));
      }}>
        {!sessions && <SensitiveInput label={t("credentials.new", "New password")} name="password" autoComplete="new-password" minLength={12}
          maxLength={256} required description={t("credentials.requirement", "Use at least 12 characters.")} />}
        <Banner error={change.error} />
        <FormActions pending={change.isPending} onClose={() => setOperation(null)} destructive
          label={sessions ? t("credentials.end", "End sessions") : t("credentials.reset", "Reset password")} />
      </form>
    </Modal>
  </>;
}
