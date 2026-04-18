/**
 * ConfirmDialog - React-based confirmation dialog
 *
 * Replaces window.confirm() / window.alert() to avoid triggering Windows DWM
 * re-composition that can re-activate ghost BrowserView HWNDs.
 *
 * On Windows, Electron's window.confirm() creates a native modal dialog that
 * hijacks the window message loop. When the dialog closes, Windows re-evaluates
 * hit-testing for all child HWNDs, which can resurrect BrowserView HWNDs that
 * were previously removed by removeBrowserView() but whose native HWND persisted.
 *
 * This React-based dialog is rendered entirely within the BrowserWindow's DOM,
 * so it does NOT create any native Windows window, avoiding the DWM interaction entirely.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** If true, hide the cancel button (for alert-style usage) */
  hideCancel?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  hideCancel = false,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Auto-focus confirm button when opened
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        confirmRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Handle Escape key
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="relative w-full max-w-md mx-4 bg-background border border-border rounded-xl shadow-xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h3 className="text-sm font-semibold mb-2">{title}</h3>}
        <p className="text-sm text-muted-foreground whitespace-pre-wrap mb-6">{message}</p>
        <div className="flex justify-end gap-2">
          {!hideCancel && (
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-secondary transition-colors"
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface DialogState {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  hideCancel: boolean;
}

/**
 * Hook for using confirm/alert dialogs as a Promise-based API.
 *
 * Usage:
 *   const { confirm, alert, ConfirmDialogElement } = useConfirm()
 *   // In JSX render: {ConfirmDialogElement}
 *
 *   // Confirm:
 *   const ok = await confirm('Are you sure?')
 *   if (!ok) return
 *
 *   // Alert:
 *   await alert('Operation completed!')
 *
 * This replaces window.confirm()/window.alert() with React dialogs that avoid
 * creating native Windows windows that can trigger DWM/BrowserView HWND issues.
 */
export function useConfirm() {
  const resolverRef = useRef<((value: boolean) => void) | null>(null);
  const [state, setState] = useState<DialogState>({
    open: false,
    title: '',
    message: '',
    confirmLabel: 'OK',
    cancelLabel: 'Cancel',
    hideCancel: false,
  });

  const confirm = useCallback(
    (
      message: string,
      options?: {
        title?: string;
        confirmLabel?: string;
        cancelLabel?: string;
      },
    ): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
        setState({
          open: true,
          title: options?.title || '',
          message,
          confirmLabel: options?.confirmLabel || 'OK',
          cancelLabel: options?.cancelLabel || 'Cancel',
          hideCancel: false,
        });
      });
    },
    [],
  );

  const alert = useCallback(
    (
      message: string,
      options?: {
        title?: string;
        confirmLabel?: string;
      },
    ): Promise<void> => {
      return new Promise<void>((resolve) => {
        resolverRef.current = () => resolve();
        setState({
          open: true,
          title: options?.title || '',
          message,
          confirmLabel: options?.confirmLabel || 'OK',
          cancelLabel: 'Cancel',
          hideCancel: true,
        });
      });
    },
    [],
  );

  const handleConfirm = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }));
    resolverRef.current?.(true);
    resolverRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }));
    resolverRef.current?.(false);
    resolverRef.current = null;
  }, []);

  const ConfirmDialogElement = (
    <ConfirmDialog
      open={state.open}
      title={state.title || undefined}
      message={state.message}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      hideCancel={state.hideCancel}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );

  return { confirm, alert, ConfirmDialogElement };
}
