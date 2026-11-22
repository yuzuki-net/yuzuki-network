import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { DotsThree, type Icon } from "@phosphor-icons/react";
import { useT } from "../../i18n";

type Action = { label: string; icon?: Icon; danger?: boolean; disabled?: boolean } & (
  { href: string; run?: never } | { run: () => void; href?: never }
);

export function RowActions({ item, actions }: { item: string; actions: Action[] }) {
  const t = useT("tables");
  if (actions.length === 0) return null;
  return <DropdownMenu>
    <DropdownMenu.Trigger render={<Button variant="ghost" shape="square" icon={DotsThree}
      aria-label={t("actionsFor", "Actions for {name}", { name: item })} />} />
    <DropdownMenu.Content align="end">
      {actions.map((action) => action.href ?
        <DropdownMenu.LinkItem key={action.label} href={action.href} icon={action.icon}>{action.label}</DropdownMenu.LinkItem> :
        <DropdownMenu.Item key={action.label} icon={action.icon} variant={action.danger ? "danger" : "default"}
          disabled={action.disabled} onClick={action.run}>{action.label}</DropdownMenu.Item>)}
    </DropdownMenu.Content>
  </DropdownMenu>;
}
