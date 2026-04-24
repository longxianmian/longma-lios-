export interface AuthState {
  tenant_id: string;
  company_name: string;
  token: string;
}

const AUTH_KEY = 'liosAuth';
const ADMIN_KEY = 'liosAdmin';

export function getAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthState;
  } catch {
    return null;
  }
}

export function setAuth(auth: AuthState): void {
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
}

export function clearAuth(): void {
  localStorage.removeItem(AUTH_KEY);
}

export function isAdminVerified(): boolean {
  return sessionStorage.getItem(ADMIN_KEY) === 'true';
}

export function setAdminVerified(): void {
  sessionStorage.setItem(ADMIN_KEY, 'true');
}
