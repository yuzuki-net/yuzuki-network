import { Button } from "@cloudflare/kumo/components/button";
import { InputGroup } from "@cloudflare/kumo/components/input-group";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { ArrowClockwise, MagnifyingGlass, X } from "@phosphor-icons/react";
import type { FormEvent, ReactNode } from "react";
import { useT } from "../../i18n";
import type { ActiveFilterChip, QuickFilterOption } from "./types";

export function DataToolbar({
  search,
  quickFilters,
  options,
  actions,
  activeFilters,
  onSubmit,
  onClear,
  onRefresh,
  refreshing,
}: {
  search?: {
    label: string;
    placeholder?: string;
    value: string;
    onChange: (value: string) => void;
    resultCount?: number;
  };
  quickFilters?: {
    label: string;
    value: string;
    options: readonly QuickFilterOption[];
    onChange: (value: string) => void;
  };
  options?: ReactNode;
  actions?: ReactNode;
  activeFilters?: readonly ActiveFilterChip[];
  onSubmit?: () => void;
  onClear?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const t = useT("tables");
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit?.();
  }
  const hasChips = !!activeFilters && activeFilters.length > 0;
  return (
    <div className="data-toolbar-wrap">
      {quickFilters && quickFilters.options.length > 0 && (
        <div className="data-quick-filters" role="tablist" aria-label={quickFilters.label}>
          {quickFilters.options.map((option) => {
            const active = quickFilters.value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={active}
                className={`data-quick-pill ${active ? "is-active" : ""}`}
                onClick={() => quickFilters.onChange(option.value)}
              >
                <span>{option.label}</span>
                {typeof option.count === "number" && (
                  <span className="data-quick-pill-count tabular-nums">{option.count}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <form className="data-toolbar" onSubmit={submit}>
        <div className="data-toolbar-controls" role="group" aria-label={t("toolbar", "Table controls")}>
          {search && (
            <div className="data-search">
              <InputGroup>
                <InputGroup.Addon align="start">
                  <MagnifyingGlass size={15} className="text-kumo-subtle" aria-hidden />
                </InputGroup.Addon>
                <InputGroup.Input
                  type="text"
                  aria-label={search.label}
                  placeholder={search.placeholder ?? search.label}
                  value={search.value}
                  maxLength={120}
                  onChange={(event) => search.onChange(event.target.value)}
                />
                {search.value && (
                  <InputGroup.Addon align="end">
                    <button
                      type="button"
                      className="data-search-clear"
                      aria-label={t("clearSearch", "Clear search")}
                      onClick={() => search.onChange("")}
                    >
                      <X size={13} aria-hidden />
                    </button>
                  </InputGroup.Addon>
                )}
              </InputGroup>
            </div>
          )}
          {options && <div className="data-toolbar-options">{options}</div>}
          {onSubmit && (
            <Button type="submit" variant="secondary" size="sm">
              {t("search", "Search")}
            </Button>
          )}
          {onClear && !hasChips && (
            <Tooltip
              content={t("clear", "Clear filters")}
              render={
                <Button type="button" variant="ghost" size="sm" icon={X} onClick={onClear}>
                  {t("clear", "Clear filters")}
                </Button>
              }
            />
          )}
        </div>
        {(actions || onRefresh || typeof search?.resultCount === "number") && (
          <div className="data-toolbar-actions">
            {typeof search?.resultCount === "number" && (
              <span className="data-result-count tabular-nums">
                {t("matches", "{count} results", { count: search.resultCount })}
              </span>
            )}
            {actions}
            {onRefresh && (
              <Tooltip
                content={t("refresh", "Refresh")}
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    shape="square"
                    size="sm"
                    icon={ArrowClockwise}
                    loading={refreshing}
                    aria-label={t("refresh", "Refresh")}
                    onClick={onRefresh}
                  />
                }
              />
            )}
          </div>
        )}
      </form>
      {hasChips && (
        <div className="data-active-filters" role="region" aria-label={t("activeFilters", "Active filters")}>
          {activeFilters.map((chip) => (
            <span key={chip.key} className="data-filter-chip">
              <span className="data-filter-chip-label">{chip.label}:</span>
              <span className="data-filter-chip-value">{chip.value}</span>
              <button
                type="button"
                className="data-filter-chip-remove"
                aria-label={t("removeFilter", "Remove {label} filter", { label: chip.label })}
                onClick={chip.onRemove}
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
          {onClear && (
            <Button type="button" variant="ghost" size="xs" onClick={onClear}>
              {t("resetAll", "Reset all")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
