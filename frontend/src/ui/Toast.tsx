/** Тосты (UI/UX ТЗ §2.10): ToastProvider + useToast. */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface Toast {
  id: number;
  text: string;
  error: boolean;
}

interface ToastContextValue {
  show: (text: string, opts?: { error?: boolean; durationMs?: number }) => void;
}

const ToastContext = createContext<ToastContextValue>({ show: () => undefined });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  /** Когда последний раз показывали этот текст (дедуп подряд). */
  const shownAt = useRef(new Map<string, number>());

  const show = useCallback(
    (text: string, opts?: { error?: boolean; durationMs?: number }) => {
      // Дубль подряд (двойной тап по «В избранное» и т.п.) не дублируем:
      // обновляем окно подавления вместо второго такого же тоста.
      const key = `${opts?.error ? "!" : ""}${text}`;
      const now = Date.now();
      const prev = shownAt.current.get(key);
      shownAt.current.set(key, now);
      if (prev !== undefined && now - prev < 1200) return;

      const id = nextId.current++;
      setToasts((prev2) => [...prev2.slice(-2), { id, text, error: opts?.error ?? false }]);
      window.setTimeout(() => {
        setToasts((prev2) => prev2.filter((t) => t.id !== id));
      }, opts?.durationMs ?? 2500);
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={t.error ? "toast toast--error" : "toast"}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
