import { Button } from "@cloudflare/kumo/components/button";
import { CommandPalette } from "@cloudflare/kumo/components/command-palette";
import { Dialog } from "@cloudflare/kumo/primitives/dialog";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { Devices, GlobeHemisphereEast, HardDrives, LinkSimple, MagnifyingGlass, Signpost, UserPlus, type Icon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConsoleNavigate } from "../../app/router";
import type { Route } from "../../app/routes";
import { useSession } from "../../features/session/context";
import { can, type Permission } from "../../features/session/model";
import { useLocale, useT } from "../../i18n";

type Command = Pick<Route, "area" | "label" | "group" | "icon"> & { path: string };

const actions: { route: string; query: string; label: string; key: string; icon: Icon; permission?: Permission }[] = [
  { route: "/admin/users", query: "create=1", key: "user", label: "Create user", icon: UserPlus, permission: "users.create" },
  { route: "/admin/servers", query: "create=1", key: "server", label: "Add server", icon: HardDrives, permission: "nodes.manage" },
  { route: "/admin/nodes", query: "create=1", key: "node", label: "Add proxy node", icon: GlobeHemisphereEast, permission: "nodes.manage" },
  { route: "/admin/routing", query: "tab=preview", key: "routing", label: "Test a routing rule", icon: Signpost },
  { route: "/workspace/security", query: "tab=sessions", key: "sessions", label: "Manage sign-in sessions", icon: Devices },
  { route: "/workspace/subscriptions", query: "create=1", key: "subscription", label: "Create a subscription link", icon: LinkSimple, permission: "subscriptions.manage" },
];

export function ConsoleCommands({ items }: { items: Route[] }) {
  const t = useT("navigation");
  const { locale } = useLocale();
  const { access } = useSession();
  const navigate = useConsoleNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(true);

  const changeOpen = useCallback((next: boolean, restore = true) => {
    restoreFocus.current = restore;
    setOpen(next);
    if (next) {
      previousFocus.current =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : trigger.current;
    } else {
      setQuery("");
    }
  }, []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !event.isComposing && !event.repeat) {
        event.preventDefault();
        changeOpen(!open);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, changeOpen]);

  function select(item: Command, newTab: boolean) {
    changeOpen(false, newTab);
    if (newTab) window.open(item.path, "_blank", "noopener,noreferrer");
    else navigate(item.path);
  }

  const shortcuts = actions.flatMap(({ route, query: qs, label, key, icon, permission }) => {
    const page = items.find(({ path }) => path === route);
    if (!page || (permission && !can(access, permission))) return [];
    return [{ area: page.area, path: route + "?" + qs, label: t("command.action." + key, label), group: page.group, icon }];
  });
  const term = query.trim().toLocaleLowerCase(locale);
  const filtered: Command[] = [...items, ...shortcuts].filter(({ label, group, path }) =>
    `${label} ${group} ${path}`.toLocaleLowerCase(locale).includes(term),
  );
  const title = t("command", "Search pages and actions");

  return (
    <Dialog.Root open={open} onOpenChange={(next) => changeOpen(next)}>
      <Tooltip
        content={t("commandHint", "Find a page or action · Ctrl / ⌘ + K")}
        render={
          <Dialog.Trigger
            ref={trigger}
            render={
              <Button
                variant="secondary"
                size="sm"
                className="console-command-pill h-8 gap-2 px-2.5 text-kumo-subtle"
                aria-label={title}
                aria-keyshortcuts="Control+K Meta+K"
              >
                <MagnifyingGlass size={15} aria-hidden />
                <span className="hidden text-xs sm:inline">{t("commandShort", "Quick jump…")}</span>
                <kbd className="hidden rounded border border-kumo-line bg-kumo-recessed px-1.5 py-0.5 font-sans text-[10px] font-medium text-kumo-subtle md:inline">
                  ⌘K
                </kbd>
              </Button>
            }
          />
        }
      />
      <Dialog.Portal>
        <Dialog.Backdrop className="console-command-backdrop" />
        <Dialog.Popup
          className="console-command-dialog"
          finalFocus={() =>
            restoreFocus.current &&
            (previousFocus.current?.isConnected ? previousFocus.current : trigger.current)
          }
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <CommandPalette.Panel
            items={filtered}
            open={open}
            value={query}
            onValueChange={setQuery}
            itemToStringValue={(item) => item.label}
            getSelectableItems={(list) => list}
            onSelect={(item, { newTab }) => select(item, newTab)}
          >
            <CommandPalette.Input
              placeholder={t("commandPlaceholder", "Search pages and actions…")}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                event.stopPropagation();
                changeOpen(false);
              }}
            />
            <CommandPalette.List>
              <CommandPalette.Results>
                {(item) => (
                  <CommandPalette.Item
                    key={item.path}
                    value={item}
                    onClick={(event) => select(item, event.ctrlKey || event.metaKey)}
                  >
                    <span className="console-command-result">
                      <item.icon size={17} aria-hidden />
                      <span className="truncate">{item.label}</span>
                      <span className="text-xs text-kumo-subtle">
                        {item.area === "admin" ? t("admin", "Administration") : t("personal", "Personal workspace")}
                      </span>
                    </span>
                  </CommandPalette.Item>
                )}
              </CommandPalette.Results>
              <CommandPalette.Empty>{t("commandNone", "No matching pages")}</CommandPalette.Empty>
            </CommandPalette.List>
            <CommandPalette.Footer>
              <span><kbd>↑↓</kbd> {t("commandNavigate", "Navigate")}</span>
              <span><kbd>↵</kbd> {t("commandSelect", "Open")}</span>
              <span><kbd>Esc</kbd> {t("commandClose", "Close")}</span>
            </CommandPalette.Footer>
          </CommandPalette.Panel>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
