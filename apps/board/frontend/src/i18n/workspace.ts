import type { Catalog } from "./catalog";
import { installCatalogs } from "./load";

installCatalogs(
  import.meta.glob<Catalog>("./locales/en/*.json", { import: "default", eager: true }),
  import.meta.glob<Catalog>(["./locales/*/*.json", "!./locales/en/*.json"], { import: "default" }),
);
