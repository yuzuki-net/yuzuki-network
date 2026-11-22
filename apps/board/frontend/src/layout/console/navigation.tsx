import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { CaretUpDown, Check, ShieldCheck, UserCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { defaultBrand } from "../../assets/scripts/brand";
import type { Area, Route } from "../../app/routes";
import { BrandMark, type BrandIconPreset } from "../../components/kumo-ext";
import { useT, type Translator } from "../../i18n";

export const workspaces = {
  personal: { key: "personal", title: "Personal workspace", home: "/workspace", icon: UserCircle },
  admin: { key: "admin", title: "Administration", home: "/admin", icon: ShieldCheck },
} as const;

export function workspaceTitle(area: Area, t: Translator) {
  return t(workspaces[area].key, workspaces[area].title);
}

export type BrandAppearance = {
  name?: string;
  tagline?: string | null;
  iconPreset?: BrandIconPreset;
  logoUrl?: string | null;
  logoDarkUrl?: string | null;
};

function WorkspaceSwitcher({ area, canAdmin }: { area: Area; canAdmin: boolean }) {
  const current = workspaces[area];
  const AreaIcon = current.icon;
  const t = useT("navigation");
  const title = workspaceTitle(area, t);
  const { state, isMobile, setOpenMobile } = useSidebar();
  const [menuOpen, setMenuOpen] = useState(false);
  const collapsed = state === "collapsed" && !isMobile;
  const accessible = t("switch.current", "Switch workspace, current: {name}", { name: title });

  if (!canAdmin) {
    const labelEl = (
      <div
        className="flex h-9 w-full items-center gap-2.5 rounded-lg border border-kumo-line bg-kumo-recessed/60 px-2.5 text-sm font-medium text-kumo-default group-data-[state=collapsed]/sidebar:size-9 group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0"
      >
        <AreaIcon size={17} className="shrink-0 text-kumo-subtle" aria-hidden />
        <span className="truncate group-data-[state=collapsed]/sidebar:hidden">{title}</span>
      </div>
    );
    return collapsed ? <Tooltip side="right" content={title} render={labelEl} /> : labelEl;
  }

  const triggerBtn = collapsed ? (
    <Button
      variant="secondary"
      shape="square"
      icon={AreaIcon}
      className="size-9 shrink-0"
      aria-label={accessible}
    />
  ) : (
    <Button
      variant="secondary"
      className="h-9 w-full justify-between px-2.5 text-sm"
      aria-label={accessible}
    >
      <span className="flex min-w-0 items-center gap-2">
        <AreaIcon size={17} className="shrink-0" aria-hidden />
        <span className="truncate">{title}</span>
      </span>
      <CaretUpDown size={14} className="shrink-0 text-kumo-subtle" aria-hidden />
    </Button>
  );

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      {collapsed ? (
        <Tooltip
          side="right"
          content={accessible}
          render={<DropdownMenu.Trigger render={triggerBtn} />}
        />
      ) : (
        <DropdownMenu.Trigger render={triggerBtn} />
      )}
      <DropdownMenu.Content className="min-w-52" align="start" sideOffset={6}>
        <DropdownMenu.Group>
          <DropdownMenu.Label>{t("switch.title", "Switch workspace")}</DropdownMenu.Label>
          {(Object.keys(workspaces) as Area[]).map((key) => (
            <DropdownMenu.LinkItem
              key={key}
              href={workspaces[key].home}
              icon={workspaces[key].icon}
              aria-current={key === area ? "page" : undefined}
              onClick={() => {
                setMenuOpen(false);
                setOpenMobile(false);
              }}
            >
              <span>{workspaceTitle(key, t)}</span>
              {key === area && <Check className="ms-auto" style={{ color: "var(--brand-accent-strong)" }} size={16} aria-hidden />}
            </DropdownMenu.LinkItem>
          ))}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

export function Navigation({
  area,
  items,
  active,
  brand,
  canAdmin,
  badges,
  onMobileClose,
}: {
  area: Area;
  items: Route[];
  active: string;
  brand?: BrandAppearance;
  canAdmin: boolean;
  badges?: Partial<Record<string, number>>;
  onMobileClose: () => void;
}) {
  const workspace = workspaces[area];
  const t = useT("navigation");
  const title = workspaceTitle(area, t);
  const { isMobile, setOpenMobile, state } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;
  const groups = Array.from(new Set(items.map(({ group }) => group)));
  const NavigationGroups = isMobile ? "div" : "nav";
  const panelName = brand?.name || defaultBrand;

  const brandAnchor = (
    <a
      href={workspace.home}
      aria-label={panelName}
      onClick={() => setOpenMobile(false)}
      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1 no-underline outline-none transition-colors hover:opacity-90 focus-visible:ring-2 group-data-[state=collapsed]/sidebar:flex-none group-data-[state=collapsed]/sidebar:justify-center"
    >
      <BrandMark
        iconPreset={brand?.iconPreset}
        logoUrl={brand?.logoUrl}
        logoDarkUrl={brand?.logoDarkUrl}
        alt={panelName}
        size="md"
      />
      <div className="flex min-w-0 flex-1 flex-col group-data-[state=collapsed]/sidebar:hidden">
        <span className="truncate text-[0.9375rem] font-semibold leading-tight text-kumo-strong" dir="auto">
          {panelName}
        </span>
        {brand?.tagline && (
          <span className="truncate text-[11px] leading-tight text-kumo-subtle" dir="auto">
            {brand.tagline}
          </span>
        )}
      </div>
    </a>
  );

  return (
    <Sidebar className="console-sidebar" aria-label={isMobile ? title : undefined} id="console-navigation">
      {/* Directly align with Kumo's 58px top header; zero MenuButton nesting so collapsed Logo centers cleanly */}
      <Sidebar.Header className="console-side-header h-[58px] px-[11px] group-not-data-[state=collapsed]/sidebar:px-3.5 group-data-[state=collapsed]/sidebar:justify-center">
        {collapsed ? (
          <Tooltip side="right" content={panelName} render={brandAnchor} />
        ) : (
          brandAnchor
        )}
        {isMobile && <Sidebar.Close onClick={onMobileClose} aria-label={t("closeNav", "Close navigation")} />}
      </Sidebar.Header>

      <div className="border-b border-kumo-line px-[11px] py-2.5 group-not-data-[state=collapsed]/sidebar:px-3.5 group-data-[state=collapsed]/sidebar:flex group-data-[state=collapsed]/sidebar:justify-center">
        <WorkspaceSwitcher area={area} canAdmin={canAdmin} />
      </div>

      <Sidebar.Content>
        <NavigationGroups aria-label={!isMobile ? title : undefined}>
          {groups.map((group) => (
            <Sidebar.Group key={group}>
              <Sidebar.GroupLabel>{group}</Sidebar.GroupLabel>
              <Sidebar.Menu>
                {items
                  .filter((item) => item.group === group)
                  .map(({ path, label, icon, preload }) => {
                    const count = badges?.[path];
                    return (
                      <Sidebar.MenuItem key={path}>
                        <Sidebar.MenuButton
                          href={path}
                          icon={icon}
                          active={active === path}
                          tooltip={label}
                          aria-current={active === path ? "page" : undefined}
                          onFocus={() => { void preload().catch(() => {}); }}
                          onMouseEnter={() => { void preload().catch(() => {}); }}
                          onClick={() => setOpenMobile(false)}
                        >
                          <span className="truncate">{label}</span>
                          {count !== undefined && count > 0 && (
                            <Sidebar.MenuBadge className="ms-auto">
                              {count > 99 ? "99+" : count}
                            </Sidebar.MenuBadge>
                          )}
                        </Sidebar.MenuButton>
                      </Sidebar.MenuItem>
                    );
                  })}
              </Sidebar.Menu>
            </Sidebar.Group>
          ))}
        </NavigationGroups>
      </Sidebar.Content>
    </Sidebar>
  );
}
