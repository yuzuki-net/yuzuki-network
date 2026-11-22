import { Banner as KumoBanner } from "@cloudflare/kumo/components/banner";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { ArrowRight } from "@phosphor-icons/react";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api, message, signIn } from "../../assets/scripts/api";
import { BrandMark } from "../../components/kumo-ext";
import { english, useT } from "../../i18n";
import { PortalFrame } from "./frame";
import { defaultPanel, normalizePanel, usePortalOptions, useRefreshRestoredPortal } from "./options";
import "./auth-form.css";

export function AuthForm({ register = false }: { register?: boolean }) {
  const t = useT("portal");
  const options = usePortalOptions();
  const panel = normalizePanel(options.data?.panel ?? defaultPanel);
  const toast = useKumoToastManager();
  const [error, setError] = useState<unknown>();
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const signedIn = options.data?.signed_in ?? false;
  useRefreshRestoredPortal();
  useEffect(() => {
    if (options.data?.workspace) location.replace(options.data.workspace);
  }, [options.data?.workspace]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const email = String(values.get("email") ?? "");
      const password = String(values.get("password") ?? "");
      if (register) {
        await api("/auth/register", "POST", { email, password });
        setDone(true);
        toast.add({ title: t("auth.request_sent", "Registration submitted"), variant: "success" });
      } else {
        location.replace(await signIn(email, password));
      }
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  const title = register
    ? t("auth.register", "Create an account")
    : panel.portal.auth_title || t("auth.sign_in", "Sign in");
  const subtitle = register
    ? t("auth.register_desc", "An administrator will review your request before you can sign in.")
    : panel.portal.auth_subtitle || t("auth.login_desc", "Enter your email address and password to access your workspace.");
  const unavailable = register && options.data && !options.data.registration;
  const errorText =
    error instanceof ApiError && error.status === 401
      ? english("portal", "auth.invalid", "Check your email and password, then try again.")
      : error instanceof ApiError && error.status === 409
        ? english("portal", "auth.duplicate", "An account already uses this email address.")
        : error instanceof ApiError && error.status === 429
          ? english("portal", "auth.rate_limit", "Please wait a moment before trying again.")
          : error instanceof ApiError && error.code
            ? message(error)
            : error
              ? english("portal", "auth.error", "We could not finish this request. Check your details and try again.")
              : "";

  const maintenance = panel.workspace.maintenance_banner;

  return (
    <PortalFrame panel={panel}>
      <main className="portal-auth-content portal-width">
        <LayerCard className="portal-auth-card" render={<section aria-labelledby="auth-heading" />}>
          <div className="flex flex-col gap-3">
            <BrandMark
              iconPreset={panel.branding.icon_preset}
              logoUrl={panel.branding.logo_url}
              logoDarkUrl={panel.branding.logo_dark_url}
              alt={panel.name}
              size="lg"
            />
            <div className="portal-auth-heading">
              <h1 id="auth-heading" className="text-2xl font-semibold tracking-tight text-kumo-strong">
                {title}
              </h1>
              <p className="text-sm text-kumo-subtle">{subtitle}</p>
            </div>
          </div>

          {maintenance.enabled && (maintenance.title || maintenance.message) && (
            <KumoBanner
              size="sm"
              variant={maintenance.variant === "error" ? "error" : maintenance.variant === "warning" ? "alert" : "default"}
              title={maintenance.title || undefined}
              description={maintenance.message || undefined}
            />
          )}

          {panel.portal.auth_notice && (
            <KumoBanner size="sm" variant="secondary" description={panel.portal.auth_notice} />
          )}

          {options.isPending || signedIn ? (
            <div className="portal-auth-loader" role="status">
              <Loader size={22} />
              <span>
                {signedIn ? t("auth.opening", "Opening your workspace…") : t("auth.checking", "Checking your session…")}
              </span>
            </div>
          ) : unavailable ? (
            <div className="flex flex-col gap-3">
              <KumoBanner
                size="sm"
                variant="alert"
                description={t("auth.registration_off", "Registration is closed. Ask an administrator for access.")}
              />
              <LinkButton href="/login" variant="secondary">
                {t("auth.sign_in", "Sign in")}
              </LinkButton>
            </div>
          ) : done ? (
            <div className="portal-auth-complete">
              <KumoBanner
                size="sm"
                role="status"
                description={t("auth.submitted_desc", "Your request is ready for review. Return to sign in after approval.")}
              />
              <LinkButton href="/login" variant="primary">
                {t("auth.return", "Return to sign in")}
              </LinkButton>
            </div>
          ) : (
            <form className="form-fields portal-auth-form" onSubmit={submit}>
              <Input
                label={t("auth.email", "Email address")}
                name="email"
                type="email"
                autoComplete="username"
                required
                maxLength={254}
              />
              <SensitiveInput
                label={t("auth.password", "Password")}
                name="password"
                autoComplete={register ? "new-password" : "current-password"}
                minLength={register ? 12 : undefined}
                maxLength={256}
                required
                description={register ? t("auth.password_hint", "Use at least 12 characters.") : undefined}
              />
              {errorText && <KumoBanner variant="error" role="alert" size="sm" description={errorText} />}
              <Button variant="primary" type="submit" className="w-full" loading={pending} icon={ArrowRight}>
                {register ? t("auth.request", "Request access") : t("auth.sign_in", "Sign in")}
              </Button>
            </form>
          )}

          {(panel.portal.terms_url || panel.portal.privacy_url) && (
            <div className="flex flex-wrap items-center gap-3 border-t border-kumo-line pt-3 text-xs text-kumo-subtle">
              {panel.portal.terms_url && (
                <a className="text-link" href={panel.portal.terms_url} target="_blank" rel="noopener noreferrer">
                  {t("auth.terms", "Terms of Service")}
                </a>
              )}
              {panel.portal.privacy_url && (
                <a className="text-link" href={panel.portal.privacy_url} target="_blank" rel="noopener noreferrer">
                  {t("auth.privacy", "Privacy Policy")}
                </a>
              )}
            </div>
          )}

          {!options.isPending && !signedIn && !done && !unavailable && (
            <div className="flex items-center justify-center border-t border-kumo-line pt-3">
              {register ? (
                <LinkButton href="/login" variant="ghost" size="sm">
                  {t("auth.already", "Already have an account? Sign in")}
                </LinkButton>
              ) : (
                options.data?.registration && (
                  <LinkButton href="/register" variant="ghost" size="sm">
                    {t("auth.register", "Create an account")}
                  </LinkButton>
                )
              )}
            </div>
          )}
        </LayerCard>
      </main>
    </PortalFrame>
  );
}
