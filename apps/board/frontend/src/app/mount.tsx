import { ToastProvider } from "@cloudflare/kumo/components/toast";
import { TooltipProvider } from "@cloudflare/kumo/components/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { initThemeEarly } from "../features/theme";
import { I18nProvider, startLocale } from "../i18n";
import "../i18n/workspace";
import { queryClient } from "./query";
import { WorkspaceApp } from "./shell";
import "../assets/styles/kumo.css";
import "../assets/styles/base.css";

export function mount() {
  initThemeEarly();
  void startLocale();
  const notifications = document.createElement("div");
  notifications.className = "console-toast-host";
  document.body.append(notifications);
  createRoot(document.getElementById("app")!).render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delay={200}>
          <ToastProvider container={notifications}>
            <WorkspaceApp />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
