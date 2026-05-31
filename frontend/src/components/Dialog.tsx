import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';

// Professional in-app confirm / prompt dialogs that replace the browser's native
// window.confirm / window.alert / window.prompt (the "<site> says" boxes). Async
// + promise-based so call sites read like the natives:
//   if (await confirm({ message: '…' })) { … }
//   const name = await promptText({ message: 'Name?' });

interface ConfirmOpts {
  title?: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;        // red primary button for destructive actions
}
interface PromptOpts {
  title?: string;
  message?: ReactNode;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
}

type State =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void }
  | null;

interface Ctx {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  promptText: (opts: PromptOpts) => Promise<string | null>;
}

const DialogCtx = createContext<Ctx>({
  confirm: async () => false,
  promptText: async () => null,
});

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const confirm = useCallback((opts: ConfirmOpts) =>
    new Promise<boolean>(resolve => setState({ kind: 'confirm', opts, resolve })), []);

  const promptText = useCallback((opts: PromptOpts) =>
    new Promise<string | null>(resolve => {
      setValue(opts.defaultValue ?? '');
      setState({ kind: 'prompt', opts, resolve });
    }), []);

  const settle = useCallback((result: boolean | string | null) => {
    setState(s => {
      if (s) (s.resolve as (v: unknown) => void)(result);
      return null;
    });
  }, []);

  const onCancel = useCallback(() => settle(state?.kind === 'prompt' ? null : false), [settle, state]);
  const onConfirm = useCallback(() => settle(state?.kind === 'prompt' ? value : true), [settle, state, value]);

  // Focus the input / primary action and wire Esc / Enter.
  useEffect(() => {
    if (!state) return;
    if (state.kind === 'prompt') setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter' && state.kind === 'confirm') { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onCancel, onConfirm]);

  const opts = state?.opts;
  const danger = state?.kind === 'confirm' && (state.opts as ConfirmOpts).danger;

  return (
    <DialogCtx.Provider value={{ confirm, promptText }}>
      {children}
      {state && (
        <div className="app-dialog-overlay" onMouseDown={onCancel}>
          <div className="app-dialog" role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
            <button className="app-dialog-x" aria-label="Close" onClick={onCancel}><X size={16} /></button>
            <div className="app-dialog-head">
              {danger && <span className="app-dialog-icon app-dialog-icon-danger"><AlertTriangle size={18} /></span>}
              <h3 className="app-dialog-title">
                {opts?.title ?? (state.kind === 'prompt' ? 'Enter a value' : 'Please confirm')}
              </h3>
            </div>
            {opts?.message && <div className="app-dialog-msg">{opts.message}</div>}
            {state.kind === 'prompt' && (
              <input
                ref={inputRef}
                className="app-dialog-input"
                value={value}
                placeholder={(state.opts as PromptOpts).placeholder ?? ''}
                onChange={e => setValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
                }}
              />
            )}
            <div className="app-dialog-actions">
              <button className="btn btn-secondary btn-sm" onClick={onCancel}>
                {opts?.cancelText ?? 'Cancel'}
              </button>
              <button
                className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={onConfirm}
                disabled={state.kind === 'prompt' && !value.trim()}
              >
                {opts?.confirmText ?? (state.kind === 'prompt' ? 'Save' : 'OK')}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogCtx.Provider>
  );
}

export const useDialog = () => useContext(DialogCtx);
