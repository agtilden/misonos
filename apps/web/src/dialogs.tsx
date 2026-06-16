import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface PromptOptions {
  message: string;
  title?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}

interface DialogApi {
  /** In-app replacement for window.confirm — resolves true/false. */
  confirm: (options: ConfirmOptions | string) => Promise<boolean>;
  /** In-app replacement for window.prompt — resolves the entered string, or null if cancelled. */
  prompt: (options: PromptOptions | string) => Promise<string | null>;
}

type ActiveDialog =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };

const DialogContext = createContext<DialogApi | null>(null);

function cancelDialog(dialog: ActiveDialog | null): void {
  if (dialog?.kind === "confirm") dialog.resolve(false);
  else if (dialog?.kind === "prompt") dialog.resolve(null);
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<ActiveDialog | null>(null);
  // Mirror of `dialog` so we can settle the *previous* promise synchronously when a
  // new dialog opens, without a side effect inside a setState updater.
  const dialogRef = useRef<ActiveDialog | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const containerRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  const settle = useCallback((next: ActiveDialog | null) => {
    dialogRef.current = next;
    setDialog(next);
  }, []);

  // Open a dialog, cancelling any currently-open one first so its awaiting caller
  // doesn't hang (e.g. a slider emitting several change events in a row).
  const confirm = useCallback((options: ConfirmOptions | string) => {
    const opts = typeof options === "string" ? { message: options } : options;
    return new Promise<boolean>((resolve) => {
      cancelDialog(dialogRef.current);
      settle({ kind: "confirm", options: opts, resolve });
    });
  }, [settle]);

  const prompt = useCallback((options: PromptOptions | string) => {
    const opts = typeof options === "string" ? { message: options } : options;
    setPromptValue(opts.defaultValue ?? "");
    return new Promise<string | null>((resolve) => {
      cancelDialog(dialogRef.current);
      settle({ kind: "prompt", options: opts, resolve });
    });
  }, [settle]);

  const closeConfirm = useCallback((value: boolean) => {
    const current = dialogRef.current;
    settle(null);
    if (current?.kind === "confirm") current.resolve(value);
  }, [settle]);

  const closePrompt = useCallback((value: string | null) => {
    const current = dialogRef.current;
    settle(null);
    if (current?.kind === "prompt") current.resolve(value);
  }, [settle]);

  const cancel = useCallback(() => {
    const current = dialogRef.current;
    if (current?.kind === "confirm") closeConfirm(false);
    else if (current?.kind === "prompt") closePrompt(null);
  }, [closeConfirm, closePrompt]);

  // Move focus into the dialog when it opens.
  useEffect(() => {
    if (dialog?.kind === "prompt") inputRef.current?.focus();
    else if (dialog?.kind === "confirm") confirmButtonRef.current?.focus();
  }, [dialog]);

  // Escape cancels; Tab is trapped within the dialog so focus can't fall back to the
  // underlying control (which could re-trigger the original action).
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); cancel(); return; }
    if (event.key !== "Tab" || !containerRef.current) return;
    const focusable = containerRef.current.querySelectorAll<HTMLElement>('button, input, [href], [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
    else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
  };

  const api = useMemo<DialogApi>(() => ({ confirm, prompt }), [confirm, prompt]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {dialog ? (
        <div className="eq-modal-backdrop" role="presentation" onClick={cancel}>
          {dialog.kind === "confirm" ? (
            <div
              ref={(element) => { containerRef.current = element; }}
              className="eq-modal confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-label={dialog.options.title ?? "Confirm"}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={onKeyDown}
            >
              {dialog.options.title ? <h2 className="eq-modal-title">{dialog.options.title}</h2> : null}
              <p className="confirm-modal-message">{dialog.options.message}</p>
              <div className="confirm-modal-actions">
                <button type="button" className="secondary" onClick={() => closeConfirm(false)}>{dialog.options.cancelLabel ?? "Cancel"}</button>
                <button ref={confirmButtonRef} type="button" onClick={() => closeConfirm(true)}>{dialog.options.confirmLabel ?? "Confirm"}</button>
              </div>
            </div>
          ) : (
            <form
              ref={(element) => { containerRef.current = element; }}
              className="eq-modal confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-label={dialog.options.title ?? "Enter a value"}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={onKeyDown}
              onSubmit={(event) => { event.preventDefault(); closePrompt(promptValue); }}
            >
              {dialog.options.title ? <h2 className="eq-modal-title">{dialog.options.title}</h2> : null}
              <p className="confirm-modal-message">{dialog.options.message}</p>
              <input
                ref={inputRef}
                className="confirm-modal-input"
                value={promptValue}
                placeholder={dialog.options.placeholder}
                onChange={(event) => setPromptValue(event.target.value)}
              />
              <div className="confirm-modal-actions">
                <button type="button" className="secondary" onClick={() => closePrompt(null)}>Cancel</button>
                <button type="submit">{dialog.options.confirmLabel ?? "OK"}</button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </DialogContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useDialogs(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialogs must be used within a DialogProvider");
  return ctx;
}
