import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Select } from "@cloudflare/kumo/components/select";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { LockSimple } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../../assets/scripts/api";
import { Banner, Chip } from "../../components/console-ui";
import { useT } from "../../i18n";
import { useSession } from "../session/context";
import { can, type Access, type Permission, type Point, type Role } from "../session/model";
import { groupPoints } from "./catalog";
import "./style.css";

export function AssignmentForm({
  id,
  access,
  editable,
  roles,
  points,
}: {
  id: string;
  access: Access;
  editable: boolean;
  roles: Role[];
  points: Point[];
}) {
  const { access: actor } = useSession();
  const cache = useQueryClient();
  const toast = useKumoToastManager();
  const t = useT("access");
  const overridesOptions = {
    inherit: t("override.inherit", "Use roles"),
    allow: t("override.allow", "Allow"),
    deny: t("override.deny", "Deny"),
  };
  const path = `/api/v1/admin/users/${id}/access`;
  const [selected, setSelected] = useState(access.roles.map((role) => role.id));
  const [overrides, setOverrides] = useState(access.overrides);
  const change = useMutation({
    mutationFn: () =>
      api<Access>(path, "PUT", {
        roles: selected.filter((roleId) => !roles.find((r) => r.id === roleId)?.locked),
        overrides,
      }),
    onSuccess: (value) => {
      cache.setQueryData([path], value);
      void cache.invalidateQueries({ queryKey: [`/api/v1/admin/users/${id}`] });
      void cache.invalidateQueries({ queryKey: ["/api/v1/admin/directory"] });
      toast.add({ title: t("saved", "User access updated"), variant: "success" });
    },
  });

  const rolePoints = new Set(roles.filter((role) => selected.includes(role.id)).flatMap((role) => role.permissions));
  const roleIds = new Set(access.roles.map(({ id }) => id));
  const roleChanged = selected.length !== roleIds.size || selected.some((role) => !roleIds.has(role));
  const overrideChanged = points.some(({ key }) => access.overrides[key] !== overrides[key]);
  const isAllowed = (key: Permission) => access.owner || (overrides[key] ?? rolePoints.has(key));
  const allowed = points.filter(({ key }) => isAllowed(key)).length;
  const shownRoles = editable && !access.owner ? roles : access.roles;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (editable && !access.owner && !change.isPending && (roleChanged || overrideChanged)) change.mutate();
  }

  function setPoint(key: Permission, value: string | null) {
    const next = { ...overrides };
    if (!value || value === "inherit") delete next[key];
    else next[key] = value === "allow";
    setOverrides(next);
  }

  return (
    <form className="form-fields permissions-form" onSubmit={submit}>
      {access.owner && <Banner>{t("owner", "Administrator role membership is locked and managed through the Board CLI.")}</Banner>}

      <fieldset className="role-assignment">
        <legend>{t("roles", "Assigned roles")}</legend>
        {!shownRoles.length && <p className="muted">{t("roles.empty", "No roles assigned.")}</p>}
        <div className="role-options">
          {shownRoles.map((role) => {
            const isLocked = role.locked;
            const label = (
              <span className="role-option-label">
                <strong className="inline-flex items-center gap-1.5">
                  {isLocked && <LockSimple size={13} aria-hidden />}
                  <span>{role.name}</span>
                  {isLocked && <Chip tone="blue">{t("lockedRole", "Locked")}</Chip>}
                </strong>
                {role.description && <span className="muted">{role.description}</span>}
              </span>
            );
            return editable && !access.owner ? (
              <div className="role-option" key={role.id}>
                <Checkbox
                  label={label}
                  checked={selected.includes(role.id)}
                  disabled={isLocked || change.isPending || !can(actor, ...role.permissions)}
                  onCheckedChange={(checked) =>
                    setSelected(checked ? [...selected, role.id] : selected.filter((entry) => entry !== role.id))
                  }
                />
              </div>
            ) : (
              <div className="role-option" key={role.id}>
                <Checkbox label={label} checked={selected.includes(role.id) || (access.owner && isLocked)} disabled />
              </div>
            );
          })}
        </div>
      </fieldset>

      <Collapsible.Root defaultOpen={!editable || access.owner}>
        <Collapsible.Trigger className="permission-disclosure">
          {t("effective", "Effective permissions and overrides")}
        </Collapsible.Trigger>
        <Collapsible.Panel className="permission-disclosure-body">
          <p className="muted">
            {t("grants", "{allowed} of {total} permission points granted", { allowed, total: points.length })}
            {editable && !access.owner && <> · {t("override.help", "Overrides take priority over role permissions.")}</>}
          </p>
          <div className="permission-grid">
            {[...groupPoints(points)].map(([group, entries]) => (
              <fieldset key={group}>
                <legend>{t("group." + group.toLowerCase(), group)}</legend>
                {entries.map((point) => {
                  const pointValue = overrides[point.key];
                  const effective = isAllowed(point.key);
                  const label = t("point." + point.key, point.label);
                  return (
                    <div className="permission-edit" key={point.key}>
                      <div>
                        <strong>{label}</strong>
                        <br />
                        <code dir="ltr">{point.key}</code>
                      </div>
                      <div className="permission-state">
                        <Chip tone={effective ? "green" : pointValue === false ? "red" : "neutral"}>
                          {effective ? t("granted", "Granted") : t("denied", "Denied")}
                        </Chip>
                        {editable && !access.owner && (
                          <Select
                            aria-label={t("override.label", "Override {label}", { label })}
                            className="permission-select"
                            items={overridesOptions}
                            value={pointValue === undefined ? "inherit" : pointValue ? "allow" : "deny"}
                            disabled={change.isPending || !can(actor, point.key)}
                            onValueChange={(value: string | null) => setPoint(point.key, value)}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </fieldset>
            ))}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>

      <Banner error={change.error} />
      {editable && !access.owner && (
        <div>
          <Button variant="primary" type="submit" loading={change.isPending} disabled={!roleChanged && !overrideChanged}>
            {t("save", "Save access")}
          </Button>
        </div>
      )}
    </form>
  );
}
