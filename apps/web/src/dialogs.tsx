import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<ActiveDialog | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const confirm = useCallback((options: ConfirmOptions | string) => {
    const opts = typeof options === "string" ? { message: options } : options;
    return new Promise<boolean>((resolve) => setDialog({ kind: "confirm", options: opts, resolve }));
  }, []);

  const prompt = useCallback((options: PromptOptions | string) => {
    const opts = typeof options === "string" ? { message: options } : options;
    setPromptValue(opts.defaultValue ?? "");
    return new Promise<string | null>((resolve) => setDialog({ kind: "prompt", options: opts, resolve }));
  }, []);

  const closeConfirm = useCallback((value: boolean) => {
    setDialog((current) => { if (current?.kind === "confirm") current.resolve(value); return null; });
  }, []);
  const closePrompt = useCallback((value: string | null) => {
    setDialog((current) => { if (current?.kind === "prompt") current.resolve(value); return null; });
  }, []);

  // Focus the text field when a prompt opens.
  useEffect(() => {
    if (dialog?.kind === "prompt") inputRef.current?.focus();
  }, [dialog]);

  const api = useMemo<DialogApi>(() => ({ confirm, prompt }), [confirm, prompt]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {dialog?.kind === "confirm" ? (
        <div className="eq-modal-backdrop" role="presentation" onClick={() => closeConfirm(false)}>
          <div className="eq-modal confirm-modal" role="dialog" aria-modal="true" aria-label={dialog.options.title ?? "Confirm"} onClick={(event) => event.stopPropagation()}>
            {dialog.options.title ? <h2 className="eq-modal-title">{dialog.options.title}</h2> : null}
            <p className="confirm-modal-message">{dialog.options.message}</p>
            <div className="confirm-modal-actions">
              <button type="button" className="secondary" onClick={() => closeConfirm(false)}>{dialog.options.cancelLabel ?? "Cancel"}</button>
              <button type="button" onClick={() => closeConfirm(true)}>{dialog.options.confirmLabel ?? "Confirm"}</button>
            </div>
          </div>
        </div>
      ) : dialog?.kind === "prompt" ? (
        <div className="eq-modal-backdrop" role="presentation" onClick={() => closePrompt(null)}>
          <form
            className="eq-modal confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-label={dialog.options.title ?? "Enter a value"}
            onClick={(event) => event.stopPropagation()}
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
              onKeyDown={(event) => { if (event.key === "Escape") closePrompt(null); }}
            />
            <div className="confirm-modal-actions">
              <button type="button" className="secondary" onClick={() => closePrompt(null)}>Cancel</button>
              <button type="submit">{dialog.options.confirmLabel ?? "OK"}</button>
            </div>
          </form>
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
