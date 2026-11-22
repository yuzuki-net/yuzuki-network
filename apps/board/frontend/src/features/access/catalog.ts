import { useResource } from "../../app/query";
import type { Point, Role } from "../session/model";

export const rolesPath = "/api/v1/admin/roles";

export function useCatalog(enabled = true) {
  const roles = useResource<Role[]>(rolesPath, enabled);
  const points = useResource<Point[]>("/api/v1/admin/permissions", enabled);
  return { roles, points };
}

export function groupPoints(points: Point[]) {
  const groups = new Map<string, Point[]>();
  for (const point of points) {
    const entries = groups.get(point.group) ?? [];
    entries.push(point);
    groups.set(point.group, entries);
  }
  return groups;
}
