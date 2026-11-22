import { useT } from "../../i18n";
import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { CaretDown, GearSix, SignOut } from "@phosphor-icons/react";
import { useState } from "react";
import { displayName, type Session } from "../../features/session/model";

export function AccountMenu({
  session,
  signOut,
  pending,
}: {
  session: Session;
  signOut: () => void;
  pending: boolean;
}) {
  const name = displayName(session);
  const t = useT("navigation");
  const [open, setOpen] = useState(false);
  const initials = name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toLocaleUpperCase();

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip
        content={t("accountMenu", "Account menu")}
        render={
          <DropdownMenu.Trigger
            render={
              <Button
                variant="ghost"
                className="console-account gap-2 px-2"
                aria-label={t("accountMenu", "Account menu")}
              />
            }
          >
            <span className="console-avatar" aria-hidden>
              {initials || "U"}
            </span>
            <span className="console-account-name text-sm font-medium">{name}</span>
            <CaretDown size={13} className="text-kumo-subtle" aria-hidden />
          </DropdownMenu.Trigger>
        }
      />
      <DropdownMenu.Content align="end" className="console-account-menu">
        <DropdownMenu.Group>
          <DropdownMenu.Label className="console-account-detail">
            <strong>{name}</strong>
            {name !== session.email && <span className="text-xs text-kumo-subtle">{session.email}</span>}
          </DropdownMenu.Label>
          <DropdownMenu.Separator />
          <DropdownMenu.LinkItem href="/workspace/security" icon={GearSix} onClick={() => setOpen(false)}>
            {t("security", "Account settings")}
          </DropdownMenu.LinkItem>
          <DropdownMenu.Item
            onClick={() => {
              setOpen(false);
              signOut();
            }}
            disabled={pending}
            icon={SignOut}
          >
            {pending ? t("signingOut", "Signing out…") : t("signOut", "Sign out")}
          </DropdownMenu.Item>
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
