import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Key, Lock, ShieldCheck } from "@phosphor-icons/react";
import { useConsoleLocation, useConsoleNavigate } from "../../app/router";
import { PageHeader, SectionCard } from "../../components/console-ui";
import { useT } from "../../i18n";
import { TrafficHeatmap } from "./heatmap";
import { PasswordSettings } from "./password";
import { PreferencesSettings } from "./preferences";
import { ProfileSettings } from "./profile";
import { ProfileHero } from "./profile-hero";
import { SessionSettings } from "./sessions";
import "./style.css";

function SecurityTipsCard() {
  const t = useT("security");
  const items = [
    {
      icon: Key,
      title: t("tips.strongTitle", "Use a unique, long password"),
      body: t("tips.strongBody", "Combine at least 12 characters with letters, numbers and symbols that you do not reuse on other services."),
    },
    {
      icon: Lock,
      title: t("tips.sessionsTitle", "All sessions end on password change"),
      body: t("tips.sessionsBody", "Updating your password immediately signs out all active browsers so compromised sessions cannot persist."),
    },
    {
      icon: ShieldCheck,
      title: t("tips.reviewTitle", "Audit active browsers regularly"),
      body: t("tips.reviewBody", "Visit the Sessions tab whenever you sign in from a shared computer and revoke any unfamiliar devices."),
    },
  ];
  return (
    <SectionCard
      title={t("tips.title", "Security recommendations")}
      description={t("tips.description", "Best practices to keep your account and subscription links protected.")}
    >
      <ul className="flex flex-col gap-3.5">
        {items.map(({ icon: Icon, title, body }) => (
          <li key={title} className="flex items-start gap-3 rounded-lg border border-kumo-line bg-kumo-recessed/25 p-3.5">
            <span
              className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "var(--brand-accent-soft)", color: "var(--brand-accent-strong)" }}
              aria-hidden
            >
              <Icon size={16} />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-kumo-strong">{title}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-kumo-subtle">{body}</p>
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

export default function Security() {
  const t = useT("security");
  const href = useConsoleLocation();
  const navigate = useConsoleNavigate();
  const requested = new URL(href, location.origin).searchParams.get("tab");
  const section = requested === "password" || requested === "sessions" ? requested : "profile";
  const tabs = [
    { value: "profile", label: t("tabs.profile", "Profile & preferences") },
    { value: "password", label: t("tabs.password", "Password") },
    { value: "sessions", label: t("tabs.sessions", "Sessions") },
  ];
  return (
    <>
      <PageHeader
        title={t("title", "Account settings")}
        description={t("description", "Manage your profile, preferences, sign-in credentials and sessions.")}
      />

      <ProfileHero />
      <TrafficHeatmap />

      <div className="border-b border-kumo-line" aria-label={t("tabs.label", "Account settings sections")} role="group">
        <Tabs
          variant="underline"
          tabs={tabs}
          value={section}
          onValueChange={(value) => {
            const next = new URL(href, location.origin);
            if (value === "profile") next.searchParams.delete("tab");
            else next.searchParams.set("tab", value);
            navigate(next.pathname + next.search + next.hash);
          }}
        />
      </div>

      <div className="account-section">
        {section === "profile" && (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <ProfileSettings />
            <PreferencesSettings />
          </div>
        )}
        {section === "password" && (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <PasswordSettings />
            <SecurityTipsCard />
          </div>
        )}
        {section === "sessions" && <SessionSettings />}
      </div>
    </>
  );
}
