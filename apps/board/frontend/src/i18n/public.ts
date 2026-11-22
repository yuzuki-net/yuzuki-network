import type { Catalog } from "./catalog";
import { installCatalogs } from "./load";

installCatalogs(import.meta.glob<Catalog>("./locales/*/{common,portal}.json", { import: "default", eager: true }));
