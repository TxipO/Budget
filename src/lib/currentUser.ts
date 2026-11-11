// The household member entering transactions on THIS device. localStorage
// 'currentUser' (a name) is the single source of truth; the sidebar switcher,
// the transaction form and the login-identity default all go through here.
export const CURRENT_USER_EVENT = 'currentUserChange';

export function getCurrentUser(): string {
  // Storage can be blocked (private mode, site data off); nothing is remembered then.
  try { return localStorage.getItem('currentUser') ?? ''; } catch { return ''; }
}

export function setCurrentUser(name: string) {
  try { localStorage.setItem('currentUser', name); } catch {}
  window.dispatchEvent(new Event(CURRENT_USER_EVENT));
}
