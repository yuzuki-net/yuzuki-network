import { BrandMark, type BrandIconPreset } from "../../components/kumo-ext";
import { defaultBrand } from "../../assets/scripts/brand";
import { useT } from "../../i18n";

export function PortalBrand({
  name = defaultBrand,
  tagline,
  iconPreset,
  logoUrl,
  logoDarkUrl,
}: {
  name?: string;
  tagline?: string | null;
  iconPreset?: BrandIconPreset;
  logoUrl?: string | null;
  logoDarkUrl?: string | null;
}) {
  const t = useT("portal");
  return (
    <a
      className="inline-flex min-w-0 items-center gap-2.5 no-underline transition-opacity hover:opacity-90"
      href="/"
      aria-label={t("home.brand", "{name} home", { name })}
    >
      <BrandMark
        iconPreset={iconPreset}
        logoUrl={logoUrl}
        logoDarkUrl={logoDarkUrl}
        alt={name}
        size="md"
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-semibold text-kumo-strong" dir="auto" title={name}>
          {name}
        </span>
        {tagline && (
          <span className="hidden truncate text-[11px] text-kumo-subtle sm:block" dir="auto">
            {tagline}
          </span>
        )}
      </span>
    </a>
  );
}
