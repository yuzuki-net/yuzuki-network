import { Button } from "@cloudflare/kumo/components/button";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { DownloadSimple, LinkSimple, PencilSimple, QrCode, Trash } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Chip, Empty } from "../../components/console-ui";
import { DataTable, DataToolbar, RowActions, useTableSelection, type ActiveFilterChip, type Column } from "../../components/data-table";
import { QrCodeModal } from "../../components/kumo-ext";
import type { ClientPreset } from "../portal/options";
import { useLocale, useT } from "../../i18n";
import { buildClientImports } from "./clients";
import { absoluteLink, formats, type FormatCode, type SubscriptionLink } from "./links";

export function LinkAddress({ path, baseUrl }: { path: string; baseUrl?: string | null }) {
  const t = useT("subscriptions");
  const address = absoluteLink(path, baseUrl);
  return (
    <div title={address} className="subscription-address">
      <ClipboardText
        text={address}
        size="sm"
        labels={{ copyAction: t("copy", "Copy subscription address") }}
        tooltip={{ text: t("copyAction", "Copy address"), copiedText: t("copied", "Address copied") }}
      />
    </div>
  );
}

export function LinksTable({
  rows,
  canManage,
  busy,
  quotaPaused,
  selected,
  initialFormat,
  baseUrl,
  showQr = true,
  enabledClients,
  toolbarAction,
  onView,
  onRename,
  onRemove,
}: {
  rows: readonly SubscriptionLink[];
  canManage: boolean;
  busy: boolean;
  quotaPaused: boolean;
  selected: ReturnType<typeof useTableSelection>;
  initialFormat?: FormatCode;
  baseUrl?: string | null;
  showQr?: boolean;
  enabledClients?: readonly ClientPreset[];
  toolbarAction?: ReactNode;
  onView: (link: SubscriptionLink) => void;
  onRename: (link: SubscriptionLink) => void;
  onRemove: (ids: string[]) => void;
}) {
  const t = useT("subscriptions");
  const { locale } = useLocale();
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState<FormatCode | "all">(initialFormat ?? "all");
  const [qrLink, setQrLink] = useState<SubscriptionLink | null>(null);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const filtering = !!query || format !== "all";
  const visible = rows.filter(
    (row) =>
      (format === "all" || row.format === format) &&
      row.name.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale)),
  );
  function clearFilters() {
    setQuery("");
    setFormat("all");
    selected.clear();
  }

  const columns: Column<SubscriptionLink>[] = [
    {
      key: "name",
      title: t("name", "Name"),
      sort: (left, right) => left.name.localeCompare(right.name, locale),
      cell: (row) => (
        <div className="subscription-name">
          <strong className="text-kumo-strong">{row.name}</strong>
          <span className="muted subscription-mobile-core text-xs">{formats[row.format].name}</span>
          {quotaPaused ? (
            <Chip tone="amber">{t("quotaPaused", "Paused by quota")}</Chip>
          ) : (
            !row.within_limit && <Chip tone="amber">{t("limitPaused", "Paused by link limit")}</Chip>
          )}
        </div>
      ),
    },
    {
      key: "format",
      title: t("format", "Format"),
      width: "8rem",
      omitOnMobile: true,
      cell: (row) => <Chip tone="blue">{formats[row.format].name}</Chip>,
    },
    {
      key: "address",
      title: t("address", "Subscription address"),
      omitOnMobile: true,
      cell: (row) => <LinkAddress path={row.path} baseUrl={baseUrl} />,
    },
    {
      key: "used",
      title: t("lastUsed", "Last refreshed"),
      width: "11rem",
      omitOnMobile: true,
      sort: (left, right) => (left.last_used_at ?? "").localeCompare(right.last_used_at ?? ""),
      cell: (row) =>
        row.last_used_at ? (
          <time dateTime={row.last_used_at}>{date.format(new Date(row.last_used_at))}</time>
        ) : (
          <span className="muted">{t("never", "Never")}</span>
        ),
    },
    {
      key: "actions",
      title: "",
      width: "8.5rem",
      end: true,
      sticky: true,
      cell: (row) => {
        const url = absoluteLink(row.path, baseUrl);
        const imports = buildClientImports(row.format, url, row.name, enabledClients);
        return (
          <div className="inline-flex items-center justify-end gap-1">
            {imports.length > 0 && (
              <DropdownMenu>
                <Tooltip
                  content={t("importClient", "One-click import")}
                  render={
                    <DropdownMenu.Trigger
                      render={
                        <Button
                          variant="ghost"
                          shape="square"
                          size="sm"
                          icon={DownloadSimple}
                          aria-label={t("importClient", "One-click import")}
                        />
                      }
                    />
                  }
                />
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Group>
                    <DropdownMenu.Label>{formats[row.format].name}</DropdownMenu.Label>
                    {imports.map((c) => (
                      <DropdownMenu.LinkItem key={c.id} href={c.href}>
                        {c.name}
                      </DropdownMenu.LinkItem>
                    ))}
                  </DropdownMenu.Group>
                </DropdownMenu.Content>
              </DropdownMenu>
            )}
            {showQr && (
              <Tooltip
                content={t("showQr", "Show QR code")}
                render={
                  <Button
                    variant="ghost"
                    shape="square"
                    size="sm"
                    icon={QrCode}
                    aria-label={t("showQr", "Show QR code")}
                    onClick={() => setQrLink(row)}
                  />
                }
              />
            )}
            <RowActions
              item={row.name}
              actions={[
                { label: t("viewAddress", "View address"), icon: LinkSimple, run: () => onView(row) },
                ...(canManage
                  ? [
                      { label: t("rename", "Rename link"), icon: PencilSimple, run: () => onRename(row) },
                      { label: t("remove", "Delete link"), icon: Trash, danger: true, run: () => onRemove([row.id]) },
                    ]
                  : []),
              ]}
            />
          </div>
        );
      },
    },
  ];

  return (
    <>
      <DataTable
        label={t("table", "Subscription links")}
        rows={visible}
        rowId={(row) => row.id}
        columns={columns}
        sortPreference="subscription-links"
        pagination={{ defaultPageSize: 10, storageKey: "subscription-links" }}
        busy={busy}
        toolbar={
          <DataToolbar
            quickFilters={{
              label: t("format", "Format"),
              value: format === "all" ? "all" : String(format),
              onChange: (value) => {
                setFormat(value !== "all" ? (Number(value) as FormatCode) : "all");
                selected.clear();
              },
              options: [
                { value: "all", label: t("allFormats", "All formats"), count: rows.length },
                { value: "3", label: "Universal", count: rows.filter((r) => r.format === 3).length },
                { value: "2", label: "mihomo", count: rows.filter((r) => r.format === 2).length },
                { value: "1", label: "sing-box", count: rows.filter((r) => r.format === 1).length },
                { value: "0", label: "xray-core", count: rows.filter((r) => r.format === 0).length },
              ],
            }}
            search={{
              label: t("search", "Search links"),
              value: query,
              onChange: (value) => {
                setQuery(value);
                selected.clear();
              },
              resultCount: visible.length,
            }}
            activeFilters={[
              ...(query.trim()
                ? [
                    {
                      key: "q",
                      label: t("search", "Search links"),
                      value: query.trim(),
                      onRemove: () => {
                        setQuery("");
                        selected.clear();
                      },
                    } satisfies ActiveFilterChip,
                  ]
                : []),
              ...(format !== "all"
                ? [
                    {
                      key: "format",
                      label: t("format", "Format"),
                      value: formats[format].name,
                      onRemove: () => {
                        setFormat("all");
                        selected.clear();
                      },
                    } satisfies ActiveFilterChip,
                  ]
                : []),
            ]}
            actions={toolbarAction}
            onClear={filtering ? clearFilters : undefined}
          />
        }
        selection={
          canManage
            ? {
                ids: selected.ids,
                change: selected.change,
                name: (row) => row.name,
                actions: (
                  <Button variant="destructive" size="sm" icon={Trash} onClick={() => onRemove([...selected.ids])}>
                    {t("removeSelected", "Delete selected")}
                  </Button>
                ),
              }
            : undefined
        }
        empty={
          <Empty title={filtering ? t("noMatches", "No matching links") : t("emptyLinks", "No subscription links yet")}>
            {filtering
              ? t("changeFilters", "Clear the filters to see more links.")
              : t("emptyHint", "Create an address for your client’s format and import it as a remote profile.")}
          </Empty>
        }
      />
      {qrLink && (
        <QrCodeModal
          open={!!qrLink}
          onClose={() => setQrLink(null)}
          title={qrLink.name}
          subtitle={formats[qrLink.format].name}
          value={absoluteLink(qrLink.path, baseUrl)}
        />
      )}
    </>
  );
}
