import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { Check, Translate } from "@phosphor-icons/react";
import { localeNames, useLocale, useT, type Locale } from "./index";

export function LanguagePicker({ enabledLocales }: { enabledLocales?: readonly Locale[] }) {
  const { locale, changeLocale, loading } = useLocale();
  const t = useT("common");
  const allEntries = Object.entries(localeNames) as [Locale, string][];
  const entries = enabledLocales?.length
    ? allEntries.filter(([key]) => enabledLocales.includes(key) || key === locale)
    : allEntries;
  if (entries.length <= 1) return null;
  const label = t("language", "Language");

  return (
    <DropdownMenu>
      <Tooltip
        content={label}
        render={
          <DropdownMenu.Trigger
            render={
              <Button
                variant="ghost"
                shape="square"
                icon={Translate}
                aria-label={label}
                aria-busy={loading}
              />
            }
          />
        }
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Group>
          <DropdownMenu.Label>{label}</DropdownMenu.Label>
          {entries.map(([key, name]) => (
            <DropdownMenu.Item key={key} selected={key === locale} onClick={() => changeLocale(key)}>
              <span lang={key} dir={key === "fa" ? "rtl" : "ltr"}>
                {name}
              </span>
              {key === locale && <Check className="ms-auto" aria-hidden size={15} />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
