import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Meter } from "@cloudflare/kumo/components/meter";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../../assets/scripts/api";
import { SectionCard } from "../../components/console-ui";
import { english, useT } from "../../i18n";

function passwordScore(pw: string): number {
  if (!pw) return 0;
  let score = Math.min(40, pw.length * 3);
  if (/[a-z]/.test(pw)) score += 15;
  if (/[A-Z]/.test(pw)) score += 15;
  if (/[0-9]/.test(pw)) score += 15;
  if (/[^a-zA-Z0-9]/.test(pw)) score += 15;
  return Math.min(100, score);
}

export function PasswordSettings() {
  const t = useT("security");
  const toast = useKumoToastManager();
  const [nextPw, setNextPw] = useState("");
  const [invalid, setInvalid] = useState(false);
  const save = useMutation({
    mutationFn: (body: { current_password: string; new_password: string }) => api("/api/v1/me/password", "PUT", body),
    onSuccess: () => {
      toast.add({ variant: "success", title: t("password.saved", "Password updated") });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) return;
    const values = new FormData(event.currentTarget);
    const current = String(values.get("current") ?? "");
    const password = String(values.get("new") ?? "");
    if (password !== values.get("confirm")) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    save.mutate({ current_password: current, new_password: password });
  }

  const score = passwordScore(nextPw);

  return (
    <SectionCard
      title={t("password.title", "Change password")}
      description={t("password.description", "Changing your password signs you out of all sessions, including this one.")}
    >
      {save.isSuccess ? (
        <div className="flex flex-col gap-3">
          <KumoBanner size="sm" role="status" description={t("password.complete", "Your password changed and all sessions have ended.")} />
          <div className="actions">
            <LinkButton href="/login" variant="primary">
              {t("password.signin", "Sign in again")}
            </LinkButton>
          </div>
        </div>
      ) : (
        <form className="form-fields" onSubmit={submit}>
          <SensitiveInput
            label={t("password.current", "Current password")}
            name="current"
            autoComplete="current-password"
            maxLength={256}
            required
            disabled={save.isPending}
          />
          <div className="flex flex-col gap-2">
            <SensitiveInput
              label={t("password.new", "New password")}
              name="new"
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              required
              disabled={save.isPending}
              description={t("password.hint", "Use at least 12 characters.")}
              onValueChange={(val) => {
                setNextPw(val);
                setInvalid(false);
              }}
            />
            {nextPw.length > 0 && (
              <Meter
                label={t("password.strength", "Password strength")}
                value={score}
                customValue={
                  nextPw.length < 12
                    ? t("password.tooShort", "{count}/12 chars", { count: nextPw.length })
                    : score >= 80
                      ? t("password.strong", "Strong")
                      : t("password.fair", "Good")
                }
              />
            )}
          </div>
          <SensitiveInput
            label={t("password.confirm", "Confirm new password")}
            name="confirm"
            autoComplete="new-password"
            minLength={12}
            maxLength={256}
            required
            disabled={save.isPending}
            onChange={() => setInvalid(false)}
          />
          {invalid && (
            <KumoBanner variant="error" size="sm" role="alert" description={english("security", "password.mismatch", "Enter the same new password in both fields.")} />
          )}
          {save.isError && (
            <KumoBanner variant="error" size="sm" description={english("security", "password.error", "Could not change your password. Check the current password and try again.")} />
          )}
          <div className="actions">
            <Button type="submit" variant="primary" loading={save.isPending}>
              {t("password.title", "Change password")}
            </Button>
          </div>
        </form>
      )}
    </SectionCard>
  );
}
