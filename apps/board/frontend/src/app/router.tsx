import { createContext, useCallback, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

type Router = { href: string; navigate: (href: string, replace?: boolean) => void };
const NavigationContext = createContext<Router | null>(null);
const eventName = "yuzuki:navigation";

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(eventName, listener);
  };
}

const snapshot = () => location.pathname + location.search + location.hash;
export const normalizePath = (path: string) => path.replace(/\/$/, "") || "/";

function changesMainView(current: URL, next: URL) {
  return normalizePath(current.pathname) !== normalizePath(next.pathname) ||
    ["user", "node", "server", "instance"].some((key) => current.searchParams.get(key) !== next.searchParams.get(key));
}

export function ConsoleRouter({ canNavigate, children }: { canNavigate: (path: string) => boolean; children: ReactNode }) {
  const href = useSyncExternalStore(subscribe, snapshot);
  const previous = useRef(href);
  useEffect(() => {
    const old = previous.current;
    previous.current = href;
    if (!changesMainView(new URL(old, location.origin), new URL(href, location.origin))) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement?.closest(".dialog-panel[data-open], .console-command-dialog[data-open]")) return;
      document.getElementById("main-content")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [href]);

  const navigate = useCallback((target: string, replace = false) => {
    const next = new URL(target, location.href);
    if (next.origin !== location.origin || !canNavigate(normalizePath(next.pathname))) {
      if (replace) location.replace(next.href);
      else location.assign(next.href);
      return;
    }
    const changedPage = changesMainView(new URL(location.href), next);
    const updated = next.pathname + next.search + next.hash;
    if (updated === snapshot()) return;
    if (replace) history.replaceState(null, "", updated);
    else history.pushState(null, "", updated);
    window.dispatchEvent(new Event(eventName));
    if (!next.hash && (!replace || changedPage)) window.scrollTo({ top: 0, behavior: "instant" });
  }, [canNavigate]);

  useEffect(() => {
    const activate = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
      const target = new URL(link.href, location.href);
      if (target.origin !== location.origin || !canNavigate(normalizePath(target.pathname))) return;
      if (target.hash && target.pathname === location.pathname && target.search === location.search) return;
      event.preventDefault();
      navigate(target.href);
    };
    document.addEventListener("click", activate);
    return () => document.removeEventListener("click", activate);
  }, [canNavigate, navigate]);

  return <NavigationContext.Provider value={{ href, navigate }}>{children}</NavigationContext.Provider>;
}

export function useConsoleLocation() {
  const router = useContext(NavigationContext);
  return router?.href ?? snapshot();
}

export function useConsoleNavigate() {
  const router = useContext(NavigationContext);
  return router?.navigate ?? ((href: string) => location.assign(href));
}
