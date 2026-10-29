/** Экран «Сайт: вход/регистрация» (вне Telegram). Поиск — только после регистрации. */

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";

import {
  createTelegramLoginLink,
  pollTelegramLogin,
  webLogin,
  webRegister,
} from "../api/auth";
import { apiErrorText } from "./apiErrorText";

interface Props {
  onAuthed: () => void;
}

const TG_POLL_INTERVAL_MS = 2500;
const TG_POLL_MAX_TRIES = 360; // ~15 минут (= TTL логин-кода на бэке)

export function LoginScreen({ onAuthed }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Вход через Telegram: ссылка на бота + состояние ожидания подтверждения
  const [tgUrl, setTgUrl] = useState<string | null>(null);
  const tgTimer = useRef<number | null>(null);

  const stopTelegramLogin = (message?: string) => {
    if (tgTimer.current !== null) {
      window.clearInterval(tgTimer.current);
      tgTimer.current = null;
    }
    setTgUrl(null);
    if (message) setError(message);
  };

  useEffect(() => () => stopTelegramLogin(), []);

  const startTelegramLogin = async () => {
    setError(null);
    setBusy(true);
    try {
      const link = await createTelegramLoginLink();
      window.open(link.url, "_blank", "noopener");
      setTgUrl(link.url);
      let tries = 0;
      tgTimer.current = window.setInterval(() => {
        tries += 1;
        if (tries > TG_POLL_MAX_TRIES) {
          stopTelegramLogin("Время ожидания вышло — попробуйте войти ещё раз.");
          return;
        }
        void pollTelegramLogin(link.code)
          .then((r) => {
            if ("access_token" in r) {
              stopTelegramLogin();
              onAuthed();
            } else if (r.status === "expired") {
              stopTelegramLogin("Ссылка входа устарела — попробуйте ещё раз.");
            }
          })
          .catch(() => {
            /* сетевая осечка — повторим на следующем тике */
          });
      }, TG_POLL_INTERVAL_MS);
    } catch (e: unknown) {
      setError(
        e instanceof Error && e.message.includes("503")
          ? "Вход через Telegram сейчас недоступен — используйте email."
          : apiErrorText(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (mode === "register") {
        await webRegister(email, password, firstName || undefined);
      } else {
        await webLogin(email, password);
      }
      onAuthed();
    } catch (e: unknown) {
      // 401 Invalid credentials / 409 Email already registered / сеть —
      // по маппингу 03 §3.2 (сырой detail наружу не показываем)
      setError(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen auth">
      <div className="auth__hero">
        <div className="auth__hero-icon">🔐</div>
        <h1 className="auth__title">{mode === "login" ? "Вход" : "Регистрация"}</h1>
        <p className="auth__sub">
          Поиск по объявлениям, уведомления и AI-подбор доступны после входа.
          Уведомления приходят только в Telegram.
        </p>
      </div>

      <div className="auth__tabs" role="tablist">
        <button
          role="tab"
          aria-selected={mode === "login"}
          className={mode === "login" ? "auth__tab auth__tab--active" : "auth__tab"}
          onClick={() => setMode("login")}
        >
          Вход
        </button>
        <button
          role="tab"
          aria-selected={mode === "register"}
          className={mode === "register" ? "auth__tab auth__tab--active" : "auth__tab"}
          onClick={() => setMode("register")}
        >
          Регистрация
        </button>
      </div>

      <form
        className="panel auth__form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {mode === "register" && (
          <label className="calc-field">
            <span>Имя (необязательно)</span>
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Иван" />
          </label>
        )}
        <label className="calc-field">
          <span>Email</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@mail.com"
            type="email"
            autoComplete="email"
          />
        </label>
        <label className="calc-field">
          <span>Пароль</span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "register" ? "Минимум 8 символов" : "Пароль"}
            type="password"
            autoComplete={mode === "register" ? "new-password" : "current-password"}
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button
          className="btn btn--primary btn--block"
          disabled={busy || !email || password.length < (mode === "register" ? 8 : 1)}
        >
          {busy ? (mode === "register" ? "Регистрируем…" : "Входим…") : mode === "register" ? "Зарегистрироваться" : "Войти"}
        </button>

        <div className="auth__divider"><span>или</span></div>

        {tgUrl ? (
          <div className="tg-login">
            <div className="tg-login__title">📨 Подтвердите вход в Telegram</div>
            <div className="tg-login__text">
              Мы открыли бота — нажмите <b>Start</b>, и вы сразу войдёте на сайт.
              Окно обновится само.
            </div>
            <a className="btn btn--block" href={tgUrl} target="_blank" rel="noreferrer">
              Открыть бота снова
            </a>
            <button
              className="btn btn--block"
              type="button"
              onClick={() => stopTelegramLogin()}
            >
              Отменить
            </button>
          </div>
        ) : (
          <button
            className="btn btn--block"
            type="button"
            disabled={busy}
            onClick={() => void startTelegramLogin()}
          >
            <Send size={18} />
            Войти через Telegram
          </button>
        )}

        <p className="auth__hint">
          Уведомления о новых вариантах отправляются только в Telegram — при входе
          через бота он привязывается автоматически.
        </p>
      </form>
    </div>
  );
}
