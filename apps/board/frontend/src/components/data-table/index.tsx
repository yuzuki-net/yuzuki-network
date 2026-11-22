import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Pagination } from "@cloudflare/kumo/components/pagination";
import { Table } from "@cloudflare/kumo/components/table";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { CaretDown, CaretUp, CaretUpDown, Rows } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { useLocale, useT } from "../../i18n";
import { Empty } from "../console-ui";
import { toggleVisible } from "./selection";
import { readOrder, storeOrder, type Order } from "./sort";
import type { ClientPaginationConfig, Column, Page, Selection } from "./types";
import "./style.css";

export type { ActiveFilterChip, ClientPaginationConfig, Column, Page, QuickFilterOption, Selection } from "./types";
export { useTableSelection } from "./selection";
export { DataToolbar } from "./toolbar";
export { RowActions } from "./actions";

const DEFAULT_PAGE_SIZES = [10, 20, 50, 100];
const SIZE_PREFIX = "yuzuki:table:size:";
const DENSITY_KEY = "yuzuki:table:density";

function readPageSize(key: string | undefined, fallback: number, options: number[]): number {
  if (!key) return fallback;
  try {
    const raw = Number(sessionStorage.getItem(SIZE_PREFIX + key));
    if (options.includes(raw)) return raw;
  } catch {
    /* ignore storage errors */
  }
  return fallback;
}

function storePageSize(key: string | undefined, value: number) {
  if (!key) return;
  try {
    sessionStorage.setItem(SIZE_PREFIX + key, String(value));
  } catch {
    /* ignore storage errors */
  }
}

function readDensity(): "comfortable" | "compact" {
  try {
    return sessionStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

function useCompactViewport() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 640px)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const listener = (event: MediaQueryListEvent) => setNarrow(event.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);
  return narrow;
}

export function DataTable<Row>({
  label,
  rows,
  columns,
  rowId,
  toolbar,
  selection,
  page,
  pagination,
  footer,
  sortPreference,
  busy = false,
  empty,
  className = "",
  layout,
}: {
  label: string;
  rows: readonly Row[];
  columns: Column<Row>[];
  rowId: (row: Row) => string;
  toolbar?: ReactNode;
  selection?: Selection<Row>;
  page?: Page;
  pagination?: false | ClientPaginationConfig;
  footer?: ReactNode;
  sortPreference?: string;
  busy?: boolean;
  empty?: ReactNode;
  className?: string;
  layout?: "auto" | "fixed";
}) {
  const t = useT("tables");
  const { direction } = useLocale();
  const isNarrow = useCompactViewport();
  const [order, setOrder] = useState(() => readOrder(sortPreference));
  const [density, setDensity] = useState<"comfortable" | "compact">(readDensity);

  const clientConfig = pagination === false ? null : pagination;
  const pageSizeOptions = page?.pageSizeOptions ?? clientConfig?.pageSizeOptions ?? DEFAULT_PAGE_SIZES;
  const defaultSize = clientConfig?.defaultPageSize ?? pageSizeOptions[0] ?? 10;
  const sizeKey = clientConfig?.storageKey ?? sortPreference ?? label;

  const [clientPage, setClientPage] = useState(0);
  const [clientSize, setClientSize] = useState(() => readPageSize(sizeKey, defaultSize, pageSizeOptions));

  function sortBy(next: Order | undefined) {
    storeOrder(sortPreference, next);
    setOrder(next);
    setClientPage(0);
  }

  function toggleDensity() {
    const next = density === "comfortable" ? "compact" : "comfortable";
    setDensity(next);
    try {
      sessionStorage.setItem(DENSITY_KEY, next);
    } catch {
      /* ignore storage errors */
    }
  }

  const compare = columns.find(({ key }) => key === order?.key)?.sort;
  const ordered = compare
    ? [...rows].sort((left, right) => (order?.direction === "descending" ? -1 : 1) * compare(left, right))
    : rows;

  const useClientPagination = !page && pagination !== false;
  const maxClientPage = Math.max(0, Math.ceil(ordered.length / clientSize) - 1);
  const safeClientPage = Math.min(clientPage, maxClientPage);

  useEffect(() => {
    if (useClientPagination && clientPage > maxClientPage) {
      setClientPage(maxClientPage);
    }
  }, [useClientPagination, clientPage, maxClientPage]);

  const visibleRows = useClientPagination
    ? ordered.slice(safeClientPage * clientSize, (safeClientPage + 1) * clientSize)
    : ordered;

  const activePage: Page | undefined = page
    ? page
    : useClientPagination && ordered.length > 0
      ? {
          index: safeClientPage,
          size: clientSize,
          count: ordered.length,
          change: setClientPage,
          changeSize: (nextSize: number) => {
            storePageSize(sizeKey, nextSize);
            setClientSize(nextSize);
            setClientPage(0);
          },
          pageSizeOptions,
        }
      : undefined;

  const selectable = selection
    ? visibleRows.filter((row) => !selection.eligible || selection.eligible(row)).map(rowId)
    : [];
  const checked = selectable.filter((id) => selection?.ids.has(id)).length;
  const all = selectable.length !== 0 && checked === selectable.length;
  const tail = direction === "rtl" ? "left" : "right";
  const fixed = layout ? layout === "fixed" : columns.some(({ width }) => width !== undefined);

  const showSkeleton = busy && !rows.length;

  return (
    <LayerCard render={<section />} className={`data-panel ${className}`} aria-label={label} data-density={density}>
      {toolbar}
      {selection && selection.ids.size > 0 && (
        <div className="data-selection">
          <span role="status">{t("selected", "{count} selected", { count: selection.ids.size })}</span>
          <div className="actions">
            {selection.actions}
            <Button variant="ghost" size="sm" disabled={selection.disabled} onClick={() => selection.change(new Set())}>
              {t("clearSelection", "Clear selection")}
            </Button>
          </div>
        </div>
      )}
      {showSkeleton || visibleRows.length > 0 ? (
        <div className="data-table-region" role="region" aria-label={label} tabIndex={0} aria-busy={busy}>
          <Table aria-label={label} layout={fixed ? "fixed" : "auto"}>
            {fixed && (
              <colgroup>
                {selection && <col className="data-select-column" />}
                {columns.map((column) => (
                  <col
                    key={column.key}
                    data-column={column.key}
                    style={{ width: column.width }}
                    data-mobile-hidden={column.omitOnMobile || undefined}
                  />
                ))}
              </colgroup>
            )}
            <Table.Header variant="compact" sticky>
              <Table.Row>
                {selection && (
                  <Table.CheckHead
                    className="data-select-column"
                    label={t("selectPage", "Select rows on this page")}
                    disabled={showSkeleton || selection.disabled || !selectable.length}
                    checked={all}
                    indeterminate={checked > 0 && !all}
                    onCheckedChange={(value) => selection.change(toggleVisible(selection.ids, selectable, value))}
                  />
                )}
                {columns.map((column) => {
                  const sort = order?.key === column.key ? order.direction : undefined;
                  const Arrow = sort === "ascending" ? CaretUp : sort === "descending" ? CaretDown : CaretUpDown;
                  const sortTip =
                    sort === "ascending"
                      ? t("sortDesc", "Sorted ascending · click for descending")
                      : sort === "descending"
                        ? t("sortClear", "Sorted descending · click to clear")
                        : t("sortAsc", "Click to sort ascending");
                  return (
                    <Table.Head
                      key={column.key}
                      data-mobile-hidden={column.omitOnMobile || undefined}
                      aria-sort={sort}
                      sticky={column.sticky ? tail : undefined}
                      className={column.end ? "data-align-end" : undefined}
                    >
                      {column.sort ? (
                        <Tooltip
                          content={sortTip}
                          render={
                            <Button
                              variant="ghost"
                              size="xs"
                              className={`data-table-sort ${sort ? "is-sorted" : ""}`}
                              aria-label={
                                typeof column.title === "string"
                                  ? t("sort", "Sort by {column}", { column: column.title })
                                  : undefined
                              }
                              onClick={() =>
                                sortBy(
                                  sort === "descending"
                                    ? undefined
                                    : {
                                        key: column.key,
                                        direction: sort === "ascending" ? "descending" : "ascending",
                                      },
                                )
                              }
                            >
                              {column.title}
                              <Arrow size={13} aria-hidden />
                            </Button>
                          }
                        />
                      ) : (
                        column.title
                      )}
                    </Table.Head>
                  );
                })}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {showSkeleton
                ? Array.from({ length: 5 }, (_, idx) => (
                    <Table.Row key={`skeleton-${idx}`} variant="default" aria-hidden>
                      {selection && (
                        <Table.Cell className="data-select-column">
                          <span className="data-skeleton-box" />
                        </Table.Cell>
                      )}
                      {columns.map((column, colIdx) => (
                        <Table.Cell
                          key={column.key}
                          data-mobile-hidden={column.omitOnMobile || undefined}
                          className={column.end ? "data-align-end" : undefined}
                        >
                          <span
                            className="data-skeleton-bar"
                            style={{ width: colIdx === 0 ? `${55 + ((idx * 13) % 30)}%` : "60%" }}
                          />
                        </Table.Cell>
                      ))}
                    </Table.Row>
                  ))
                : visibleRows.map((row) => {
                    const id = rowId(row);
                    const selected = selection?.ids.has(id);
                    return (
                      <Table.Row
                        key={id}
                        variant={selected ? "selected" : "default"}
                        aria-selected={selection ? !!selected : undefined}
                      >
                        {selection && (
                          <Table.CheckCell
                            className="data-select-column"
                            checked={!!selected}
                            disabled={selection.disabled || selection.eligible?.(row) === false}
                            label={t("selectRow", "Select {name}", { name: selection.name(row) })}
                            onCheckedChange={(value) => selection.change(toggleVisible(selection.ids, [id], value))}
                          />
                        )}
                        {columns.map((column) => (
                          <Table.Cell
                            key={column.key}
                            data-mobile-hidden={column.omitOnMobile || undefined}
                            sticky={column.sticky ? tail : undefined}
                            className={column.end ? "data-align-end" : undefined}
                          >
                            {column.cell(row)}
                          </Table.Cell>
                        ))}
                      </Table.Row>
                    );
                  })}
            </Table.Body>
          </Table>
        </div>
      ) : (
        empty ?? <Empty title={t("empty", "No results")} />
      )}
      {activePage && activePage.count > 0 && (
        <div className="data-pagination-wrap">
          <div className="data-pagination-meta">
            <Tooltip
              content={
                density === "compact"
                  ? t("densityComfortable", "Switch to comfortable rows")
                  : t("densityCompact", "Switch to compact rows")
              }
              render={
                <Button
                  type="button"
                  variant="ghost"
                  shape="square"
                  size="xs"
                  icon={Rows}
                  aria-pressed={density === "compact"}
                  aria-label={t("densityToggle", "Toggle row density")}
                  onClick={toggleDensity}
                />
              }
            />
            {busy && <Loader size={14} aria-label={t("updating", "Updating results")} />}
          </div>
          <Pagination
            className="data-pagination"
            page={activePage.index + 1}
            perPage={activePage.size}
            totalCount={activePage.count}
            setPage={(nextPage) => activePage.change(nextPage - 1)}
            labels={{
              navigation: t("pagination", "Pagination"),
              firstPage: t("firstPage", "First page"),
              previousPage: t("previous", "Previous page"),
              nextPage: t("next", "Next page"),
              lastPage: t("lastPage", "Last page"),
              pageNumber: t("pageNumber", "Page number"),
              pageSize: t("pageSize", "Rows per page"),
            }}
          >
            <Pagination.Info>
              {() =>
                t("pageRange", "{from}–{to} of {total}", {
                  from: activePage.index * activePage.size + 1,
                  to: Math.min((activePage.index + 1) * activePage.size, activePage.count),
                  total: activePage.count,
                })
              }
            </Pagination.Info>
            {activePage.changeSize && (
              <>
                <Pagination.Separator />
                <Pagination.PageSize
                  value={activePage.size}
                  onChange={activePage.changeSize}
                  options={activePage.pageSizeOptions ?? DEFAULT_PAGE_SIZES}
                  label={t("perPage", "Per page:")}
                />
              </>
            )}
            <Pagination.Controls controls={isNarrow ? "simple" : "full"} />
          </Pagination>
        </div>
      )}
      {footer && <div className="data-footer">{footer}</div>}
    </LayerCard>
  );
}
