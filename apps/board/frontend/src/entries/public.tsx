import { ToastProvider } from "@cloudflare/kumo/components/toast";
import { TooltipProvider } from "@cloudflare/kumo/components/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "../app/query";
import { initThemeEarly } from "../features/theme";
import { I18nProvider, startLocale } from "../i18n";
import "../i18n/public";
import "../assets/styles/kumo.css";
import "../assets/styles/base.css";

export function mountPublic(page: ReactNode) {
  initThemeEarly();
  void startLocale();
  createRoot(document.getElementById("app")!).render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delay={200}>
          <ToastProvider>{page}</ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
