import { createContext, createElement, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type ValidationResult = { ok: boolean; error?: string };
type AdminAccess = {
  adminKey: string | null;
  unlock: (key: string) => Promise<ValidationResult>;
  lock: () => void;
};

const AdminAccessContext = createContext<AdminAccess | null>(null);

export function AdminAccessProvider({ children }: { children: ReactNode }) {
  const [adminKey, setAdminKey] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const lock = useCallback(() => {
    requestVersion.current += 1;
    setAdminKey(null);
  }, []);

  const unlock = useCallback(async (key: string): Promise<ValidationResult> => {
    const version = ++requestVersion.current;
    try {
      const response = await fetch("/api/admin/validate", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (response.status === 401) return { ok: false, error: "Invalid admin key" };
      if (!response.ok) return { ok: false, error: "Could not validate admin key" };
      if (version !== requestVersion.current) return { ok: false, error: "Admin unlock was cancelled" };
      setAdminKey(key);
      return { ok: true };
    } catch {
      return { ok: false, error: "Network error while validating admin key" };
    }
  }, []);

  return createElement(AdminAccessContext.Provider, { value: { adminKey, unlock, lock } }, children);
}

export function useAdminAccess(): AdminAccess {
  const access = useContext(AdminAccessContext);
  if (!access) throw new Error("useAdminAccess must be used within AdminAccessProvider");
  return access;
}