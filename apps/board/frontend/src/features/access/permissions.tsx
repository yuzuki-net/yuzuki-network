import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { InputGroup } from "@cloudflare/kumo/components/input-group";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useState } from "react";
import { Empty } from "../../components/console-ui";
import { useT } from "../../i18n";
import { groupPoints } from "./catalog";
import "./style.css";
import type { Permission, Point } from "../session/model";

export function PermissionGrid({
  points,
  value,
  onChange,
  allowed,
}: {
  points: Point[];
  value: Permission[];
  onChange: (value: Permission[]) => void;
  allowed: Permission[];
}) {
  const [query, setQuery] = useState("");
  const t = useT("access");
  const filter = query.trim().toLowerCase();
  const visible = points.filter((point) =>
    [
      t("group." + point.group.toLowerCase(), point.group),
      point.key,
      t("point." + point.key, point.label),
      point.label,
    ].some((item) => item.toLowerCase().includes(filter)),
  );
  const editable = allowed.length > 0;

  function setGroup(entries: Point[], enable: boolean) {
    const allowedKeys = entries.map((p) => p.key).filter((key) => allowed.includes(key));
    if (enable) {
      onChange(Array.from(new Set([...value, ...allowedKeys])));
    } else {
      const removeSet = new Set(allowedKeys);
      onChange(value.filter((key) => !removeSet.has(key)));
    }
  }

  function applyPreset(kind: "readonly" | "ops" | "clear") {
    if (kind === "clear") {
      onChange(value.filter((key) => !allowed.includes(key)));
      return;
    }
    const target =
      kind === "readonly"
        ? points.filter((p) => p.key.endsWith(".read") && allowed.includes(p.key)).map((p) => p.key)
        : points
            .filter(
              (p) =>
                (p.key.startsWith("nodes.") || p.key.startsWith("routing.") || p.key.startsWith("audit.")) &&
                allowed.includes(p.key),
            )
            .map((p) => p.key);
    onChange(Array.from(new Set([...value.filter((k) => !allowed.includes(k)), ...target])));
  }

  return (
    <div className="flow">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1 max-w-xs">
          <InputGroup>
            <InputGroup.Addon align="start">
              <MagnifyingGlass size={15} className="text-kumo-subtle" aria-hidden />
            </InputGroup.Addon>
            <InputGroup.Input
              type="search"
              aria-label={t("filter", "Filter permission points")}
              value={query}
              placeholder={t("filter.placeholder", "Filter by name or key…")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {editable && (
            <>
              <Button type="button" variant="secondary" size="xs" onClick={() => applyPreset("readonly")}>
                {t("preset.readOnly", "All read-only")}
              </Button>
              <Button type="button" variant="secondary" size="xs" onClick={() => applyPreset("ops")}>
                {t("preset.ops", "Infrastructure ops")}
              </Button>
              <Button type="button" variant="ghost" size="xs" onClick={() => applyPreset("clear")}>
                {t("preset.clear", "Clear all")}
              </Button>
            </>
          )}
          <span className="text-xs text-kumo-subtle" role="status">
            {t("filter.selected", "{count} selected", { count: value.length })}
          </span>
        </div>
      </div>

      {visible.length ? (
        <div className="permission-grid">
          {[...groupPoints(visible)].map(([group, entries]) => {
            const editableEntries = entries.filter((p) => allowed.includes(p.key));
            const allChecked =
              editableEntries.length > 0 && editableEntries.every((p) => value.includes(p.key));
            return (
              <fieldset key={group}>
                <legend className="flex items-center gap-2">
                  <span>{t("group." + group.toLowerCase(), group)}</span>
                </legend>
                {editableEntries.length > 1 && (
                  <div className="flex items-center justify-end gap-1 border-b border-kumo-line pb-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setGroup(entries, !allChecked)}
                    >
                      {allChecked ? t("group.clear", "Deselect group") : t("group.selectAll", "Select group")}
                    </Button>
                  </div>
                )}
                {entries.map((point) => (
                  <Checkbox
                    key={point.key}
                    label={
                      <span className="flex flex-col">
                        <span className="text-sm text-kumo-default">{t("point." + point.key, point.label)}</span>
                        <code className="text-[11px] text-kumo-subtle" dir="ltr">
                          {point.key}
                        </code>
                      </span>
                    }
                    checked={value.includes(point.key)}
                    disabled={!allowed.includes(point.key)}
                    onCheckedChange={(checked) =>
                      onChange(checked ? [...value, point.key] : value.filter((entry) => entry !== point.key))
                    }
                  />
                ))}
              </fieldset>
            );
          })}
        </div>
      ) : (
        <Empty title={t("filter.empty", "No matching permission points")}>
          {t("filter.emptyHelp", "Try a different name or key.")}
        </Empty>
      )}
    </div>
  );
}
