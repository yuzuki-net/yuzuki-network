import type { CSSProperties, ReactNode } from "react";

export type Column<Row> = {
  key: string;
  title: ReactNode;
  cell: (row: Row) => ReactNode;
  width?: CSSProperties["width"];
  omitOnMobile?: boolean;
  end?: boolean;
  sticky?: boolean;
  sort?: (left: Row, right: Row) => number;
};

export type Selection<Row> = {
  ids: ReadonlySet<string>;
  change: (next: ReadonlySet<string>) => void;
  name: (row: Row) => string;
  eligible?: (row: Row) => boolean;
  disabled?: boolean;
  actions?: ReactNode;
};

export type Page = {
  index: number;
  size: number;
  count: number;
  change: (page: number) => void;
  changeSize?: (size: number) => void;
  pageSizeOptions?: number[];
};

export type QuickFilterOption = {
  value: string;
  label: string;
  count?: number;
};

export type ActiveFilterChip = {
  key: string;
  label: string;
  value: string;
  onRemove: () => void;
};

export type ClientPaginationConfig = {
  defaultPageSize?: number;
  pageSizeOptions?: number[];
  storageKey?: string;
};
