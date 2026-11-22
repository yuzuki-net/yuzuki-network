import { QueryClient, useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../assets/scripts/api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status < 500), staleTime: 10_000 },
    mutations: { retry: false },
  },
});

export function useResource<T>(url: string, enabled = true, refetchInterval?: number) {
  return useQuery({ queryKey: [url], queryFn: ({ signal }) => api<T>(url, "GET", undefined, signal), enabled, refetchInterval });
}
