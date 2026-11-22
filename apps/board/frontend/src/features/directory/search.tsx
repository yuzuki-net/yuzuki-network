import { DataToolbar, type ActiveFilterChip } from "../../components/data-table";
import { useT } from "../../i18n";
import type { useDirectory } from "./query";

export function DirectorySearch({
  directory,
  onRefresh,
  refreshing,
}: {
  directory: ReturnType<typeof useDirectory>;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const t = useT("directory");
  const hasFilters = !!directory.query || directory.filter !== "all";
  const statusLabels: Record<string, string> = {
    all: t("all", "All accounts"),
    true: t("active", "Active"),
    false: t("inactive", "Inactive"),
  };
  const activeFilters: ActiveFilterChip[] = [];
  if (directory.query.trim()) {
    activeFilters.push({
      key: "q",
      label: t("search", "Search accounts"),
      value: directory.query.trim(),
      onRemove: () => directory.changeQuery(""),
    });
  }
  if (directory.filter !== "all") {
    activeFilters.push({
      key: "status",
      label: t("status", "Status"),
      value: statusLabels[directory.filter] ?? directory.filter,
      onRemove: () => directory.changeFilter("all"),
    });
  }
  return (
    <DataToolbar
      quickFilters={{
        label: t("status", "Status"),
        value: directory.filter,
        onChange: directory.changeFilter,
        options: [
          { value: "all", label: statusLabels.all },
          { value: "true", label: statusLabels.true },
          { value: "false", label: statusLabels.false },
        ],
      }}
      search={{
        label: t("search", "Search accounts"),
        placeholder: t("searchPlaceholder", "Find by name or email"),
        value: directory.query,
        onChange: directory.changeQuery,
        resultCount: directory.result.data?.total,
      }}
      activeFilters={activeFilters}
      onClear={hasFilters ? directory.clear : undefined}
      onRefresh={onRefresh}
      refreshing={refreshing}
    />
  );
}
