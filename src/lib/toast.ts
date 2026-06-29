export type ToastType = 'success' | 'error' | 'info';
export interface ToastAction { label: string; onClick: () => void }

export function toast(message: string, type: ToastType = 'success', action?: ToastAction, duration?: number) {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: { message, type, action, duration } }));
}
