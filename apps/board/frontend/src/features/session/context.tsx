import { createContext, useContext } from "react";
import { can, type Session, type Permission } from "./model";

export const SessionContext = createContext<Session | null>(null);
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Session provider is missing.");
  return session;
}

export function useCan(...permissions: Permission[]) {
  return can(useSession().access, ...permissions);
}
