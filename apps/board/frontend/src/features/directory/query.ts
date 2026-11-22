import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../assets/scripts/api";
import { useConsoleLocation, useConsoleNavigate } from "../../app/router";
import type { Account } from "../session/model";

export type Directory = { items: Account[]; total: number; page_size: number };

export function useDirectory(path: string) {
  const href = useConsoleLocation();
  const navigate = useConsoleNavigate();
  const { pathname, searchParams } = new URL(href, location.origin);
  const search = (searchParams.get("q") ?? "").slice(0, 120).trim();
  const active = searchParams.get("active");
  const filter = active === "true" || active === "false" ? active : "all";
  const index = Number(searchParams.get("page"));
  const page = Number.isInteger(index) && index >= 0 && index <= 10_000 ? index : 0;
  const [draft, setDraft] = useState<{ href: string; value: string }>();
  const query = draft?.href === href ? draft.value : search;
  const params = new URLSearchParams({ q: search, page: String(page) });
  if (filter !== "all") params.set("active", filter);
  const url = `${path}?${params}`;
  const result = useQuery({
    queryKey: [url], queryFn: ({ signal }) => api<Directory>(url, "GET", undefined, signal), placeholderData: keepPreviousData,
  });
  function update(term: string, value: string, index: number) {
    const next = new URLSearchParams();
    if (term) next.set("q", term);
    if (value !== "all") next.set("active", value);
    if (index) next.set("page", String(index));
    navigate(pathname + (next.size ? `?${next}` : ""), true);
  }
  useEffect(() => {
    if (query.trim() === search) return;
    const timer = window.setTimeout(() => update(query.trim(), filter, 0), 230);
    return () => window.clearTimeout(timer);
  }, [query, search, filter, pathname, navigate]);
  return {
    result, page, query, filter, searching: query.trim() !== search,
    setPage(index: number) { update(search, filter, index); },
    changeQuery(value: string) { setDraft({ href, value }); },
    changeFilter(value: string) { setDraft(undefined); update(query.trim(), value, 0); },
    clear() { setDraft(undefined); update("", "all", 0); },
  };
}
