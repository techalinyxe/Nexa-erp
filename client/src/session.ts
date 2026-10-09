import type { Session } from "./types";

const STORAGE_KEY = "nexa.session";

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function can(session: Session | null, permission: string): boolean {
  return session?.user.permissions.includes(permission) ?? false;
}
