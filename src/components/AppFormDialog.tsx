import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './app-form-dialog.css';

/** Native modal isolation, with return focus owned by the opening navigation/session. */
export default function AppFormDialog({ children, labelledBy, onDismiss, canRestoreFocus, opener, busy }: {
  children: ReactNode; labelledBy: string; onDismiss: () => void;
  canRestoreFocus: () => boolean; opener: HTMLElement | null; busy: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const restore = useRef(canRestoreFocus);
  restore.current = canRestoreFocus;
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    element.querySelector<HTMLElement>('[data-dialog-initial-focus]')?.focus();
    return () => {
      // Native close also restores focus. Suppress that when navigation owns focus now.
      const suppress = !restore.current();
      const wasInert = opener?.inert;
      if (suppress && opener) opener.inert = true;
      element.close();
      if (suppress && opener) opener.inert = wasInert ?? false;
      if (!suppress && opener?.isConnected && !opener.closest('[inert]')) opener.focus();
    };
  }, [opener]);
  return createPortal(<dialog ref={dialog} className="app-form-dialog" aria-modal="true" aria-labelledby={labelledBy}
    aria-busy={busy} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')).filter(node => node.getClientRects().length);
      const first = targets[0], last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} onCancel={event => { event.preventDefault(); onDismiss(); }}
    onMouseDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); onDismiss(); } }}>
    <section className="modal-card">{children}</section>
  </dialog>, document.body);
}
