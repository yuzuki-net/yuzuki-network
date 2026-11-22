export type Order = { key: string; direction: "ascending" | "descending" };

const prefix = "yuzuki:table:sort:";

export function readOrder(table?: string): Order | undefined {
  if (!table) return undefined;
  try {
    const order = JSON.parse(sessionStorage.getItem(prefix + table) ?? "null");
    if (typeof order?.key === "string" && (order.direction === "ascending" || order.direction === "descending")) return order;
  } catch { /* Table sorting also works when browser storage is unavailable. */ }
}

export function storeOrder(table: string | undefined, order: Order | undefined) {
  if (!table) return;
  try {
    if (order) sessionStorage.setItem(prefix + table, JSON.stringify(order));
    else sessionStorage.removeItem(prefix + table);
  } catch { /* Keep the active sort in memory. */ }
}
