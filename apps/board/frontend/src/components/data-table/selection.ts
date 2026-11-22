import { useState } from "react";

export function useTableSelection(scope: string) {
  const [selection, setSelection] = useState<{ scope: string; ids: ReadonlySet<string> }>();
  return {
    ids: selection?.scope === scope ? selection.ids : new Set<string>(),
    change: (ids: ReadonlySet<string>) => setSelection({ scope, ids }),
    clear: () => setSelection({ scope, ids: new Set() }),
  };
}

export function toggleVisible(selection: ReadonlySet<string>, ids: Iterable<string>, checked: boolean) {
  const next = new Set(selection);
  for (const id of ids) {
    if (checked) next.add(id); else next.delete(id);
  }
  return next;
}
