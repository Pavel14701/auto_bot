/**
 * Профиль (01-ux-audit-ia.md §1.8, R1–R5; тексты — 03 §2.9):
 *  - R1: порядок панелей — Подписка/Тарифы сразу после шапки, настройки
 *    оформления (тема/регион) ниже, «Профиль» между ними;
 *  - R2: иерархия кнопок покупки сохранена (free → Pro/Business,
 *    business — максимум), primary один;
 *  - R3: «Выйти» — danger-ghost внизу с подтверждением, не primary-плита
 *    среди покупок;
 *  - статус «бессрочная (партнёрская)» для business без даты (policies);
 *  - сравнение тарифов — на токены (styles in screens-extra.css).
 *
 * «Мои объявления» (NAV-V2) переехали в таб «Авто» (screens/MyLotsPanel).
 * «Сменить поверхность» (NAV-V2 §1): выход на лендинг-вход с выбором
 * приложения (пользователи/партнёры) — лендинг всегда открывается на «/».
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { haptic, isGuest, logout, tgUser } from "../api/auth";
import {
  getRegion,
  setRegion,
  REGION_CURRENCY,
  REGION_LABEL,
  type Region,
} from "../lib/fx";
import { getTheme, setTheme, type Theme } from "../lib/theme";
import { openInvoice } from "../lib/invoice";
import { resetSurface } from "./Landing";
import type { StarsInvoice, Subscription, User } from "../api/types";

const TIER_LABEL: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
};

/** Иерархия тарифов: free < pro < business (app/domain/subscription/policies).
 *  Предлагаем к покупке только тарифы СТРОГО выше текущего. */
const TIER_RANK: Record<string, number> = { free: 0, pro: 1, business: 2 };

/** Каденс дайджеста из /api/subscription — человеко-читаемо. */
const DIGEST_LABEL: Record<string, string> = {
  weekly: "дайджест раз в неделю",
  daily: "дайджест ежедневно",
  instant: "мгновенные уведомления",
};

/** Окно лимита анализов: 1 день / неделя / N дней. */
function windowLabel(days: number): string {
  if (days === 1) return "день";
  if (days === 7) return "нед";
  return `${days} дн`;
}

/** Сравнение тарифов (новая экономика): строка фичи → значение по тарифам. */
const TIER_FEATURES: { label: string; value: Record<string, string | boolean> }[] = [
  {
    label: "AI-анализы цены",
    value: { free: "1/нед", pro: "30/день", business: "безлимит" },
  },
  {
    label: "Дайджест",
    value: { free: "раз в неделю", pro: "ежедневно", business: "instant" },
  },
  { label: "Чеки осмотра", value: { free: false, pro: true, business: true } },
  {
    label: "Мгновенные уведомления при публикации",
    value: { free: false, pro: false, business: true },
  },
  { label: "Агент на сделку", value: { free: false, pro: false, business: true } },
];

/** Переключатель темы: три сегмента (lib/theme). */
const THEME_OPTIONS: { key: Theme; label: string }[] = [
  { key: "system", label: "Системная" },
  { key: "light", label: "Светлая" },
  { key: "dark", label: "Тёмная" },
];

export function ProfileScreen() {
  const [user, setUser] = useState<User | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegionState] = useState<Region>(() => getRegion());
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  /** R3: подтверждение выхода — случайный тап не разлогинивает. */
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  /** Меню v3: превью сигналов (сигналы ушли из таб-бара в Профиль). */
  const [signals, setSignals] = useState<
    { id: number; name?: string | null; criteria: Record<string, unknown>; notify_mode: string }[] | null
  >(null);

  const load = useCallback(() => {
    api<User>("/me")
      .then(setUser)
      .catch((e: Error) => setError(e.message));
    api<Subscription>("/subscription")
      .then(setSub)
      .catch(() => undefined); // вне Telegram статуса нет — read-only
    // GET /api/filters отвечает массивом (list[FilterOut], см. Filters.tsx)
    api<NonNullable<typeof signals>>("/filters")
      .then((r) => setSignals(Array.isArray(r) ? r : []))
      .catch(() => setSignals([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const buy = async (tier: "pro" | "business", period: "month" | "year") => {
    // RACE-01 (аудит 2026-10-29): один инвойс за раз — блокируем ВСЕ кнопки
    // покупки, не только нажатую (два открытых счёта Stars = два списания).
    if (buying !== null) return;
    const key = `${tier}_${period}`;
    setBuying(key);
    setMessage(null);
    let invoiceUrl: string | null = null;
    try {
      const invoice = await api<StarsInvoice>("/payments/stars", {
        method: "POST",
        body: JSON.stringify({ tier, period }),
      });
      invoiceUrl = invoice.invoice_url;
      haptic();
    } catch (e) {
      setBuying(null);
      const status = (e as { status?: number }).status;
      if (status === 503) {
        setMessage("🛠 Платежи временно недоступны — попробуйте через пару минут.");
      } else if (status === 401 || status === 403) {
        setMessage("🔒 Сессия истекла. Закройте мини-апп и откройте заново из Telegram-бота.");
      } else {
        setMessage(`Не удалось создать счёт: ${(e as Error).message}`);
      }
      return;
    }

    const inTg = openInvoice(invoiceUrl, (status) => {
      setBuying(null);
      if (status === "paid") {
        setMessage("✅ Оплата прошла — подписка активирована");
        load();
      } else if (status === "failed") {
        setMessage(
          "❌ Оплата не прошла. Проверьте баланс ★ Stars (Настройки → Stars) и попробуйте ещё раз.",
        );
      } else if (status === "cancelled") {
        setMessage("Оплата отменена — счёт можно открыть снова в любой момент.");
      } else {
        setMessage("⏳ Платёж в обработке — подписка активируется в течение пары минут.");
      }
    });
    if (!inTg) {
      setBuying(null);
      setMessage(
        "💳 Счёт открыт в новой вкладке, но оплата ★ Stars работает только в Telegram. Откройте мини-апп из бота и повторите оформление.",
      );
    }
  };

  const tg = tgUser();

  if (error) {
    return (
      <div className="screen">
        <div className="state">
          <div className="state__emoji">🔒</div>
          <div className="state__title">Нужна авторизация</div>
          <div className="state__text">Откройте приложение из Telegram-бота</div>
        </div>
      </div>
    );
  }
  if (!user) {
    return (
      <div className="screen">
        <div className="state"><span className="skeleton" style={{ width: 140, height: 16 }} /></div>
      </div>
    );
  }

  const tier = sub?.tier ?? user.subscription_tier;
  const rank = TIER_RANK[tier] ?? 0;
  const until = sub?.subscription_until
    ? new Date(sub.subscription_until).toLocaleDateString("ru")
    : null;
  // business без даты окончания — бессрочный партнёрский тариф (policies.py)
  const tierStatus =
    tier === "business"
      ? until
        ? `активна до ${until}`
        : "бессрочная (партнёрская)"
      : until
        ? `активна до ${until}`
        : tier === "free"
          ? "бесплатный тариф"
          : "активна";

  // Подпись лимитов — из /api/subscription (digest, inspection, agent, analyses_limit)
  const limits: string[] = [];
  if (sub) {
    limits.push(
      sub.analyses_limit == null
        ? "безлимит анализов"
        : `${sub.analyses_limit} анализов/${windowLabel(sub.analyses_window_days)}`,
    );
    limits.push(DIGEST_LABEL[sub.digest] ?? "дайджест");
    if (sub.inspection) limits.push("чеки осмотра");
    if (sub.instant) limits.push("instant при публикации");
    if (sub.agent) limits.push("агент на сделку");
    limits.push(`${sub.max_filters ?? "∞"} уведомлений`);
  }

  // Цены кнопок — из /api/subscription (prices), с фолбэками как раньше
  const price = (key: string, fallback: number) => sub?.prices?.[key] ?? fallback;

  const guest = isGuest();

  return (
    <div className="screen">
      {guest && (
        <section className="panel profile-card">
          <h3>Гостевой режим</h3>
          <p className="profile-card__text">
            Вы смотрите как гость: лента, калькулятор и избранное доступны.
            AI-анализ цены, сохранённые машины и уведомления в Telegram —
            после входа.
          </p>
          <Link to="/login" className="btn btn--primary btn--block profile-card__cta">
            Войти / Регистрация
          </Link>
        </section>
      )}

      {/* R1: монетизация сразу после шапки — подписка и тарифы */}
      <section className="panel profile-card">
        <h3>Подписка</h3>
        <div className="sub-tier">
          <div className="sub-tier__name">{TIER_LABEL[tier]}</div>
          <div className="sub-tier__until">{tierStatus}</div>
        </div>
        {sub && <div className="sub-limits">{limits.join(" · ")}</div>}
        <div className="sub-actions">
          {/* Кнопки по иерархии: free → Pro и Business; pro → Business;
              business — уже максимум, покупок нет */}
          {rank < TIER_RANK.pro && (
            <>
              <button className="btn btn--primary" disabled={buying !== null} onClick={() => buy("pro", "month")}>
                {buying === "pro_month" ? "Оформляем…" : `⭐ Pro — ${price("pro_month", 500)}★/мес`}
              </button>
              <button className="btn" disabled={buying !== null} onClick={() => buy("pro", "year")}>
                {buying === "pro_year" ? "Оформляем…" : `⭐ Pro — ${price("pro_year", 4800)}★/год (−20%)`}
              </button>
            </>
          )}
          {rank < TIER_RANK.business && (
            <button className="btn" disabled={buying !== null} onClick={() => buy("business", "month")}>
              {buying === "business_month" ? "Оформляем…" : `⭐ Business — ${price("business_month", 2500)}★/мес`}
            </button>
          )}
          {rank >= TIER_RANK.business && (
            <div className="sub-limits">
              Это максимальный тариф — все возможности уже открыты
            </div>
          )}
        </div>
        {message && (
          <div className={
            message.startsWith("✅") || message.startsWith("⏳")
              ? "profile-msg profile-msg--ok"
              : "profile-msg profile-msg--err"
          }>
            {message}
          </div>
        )}
      </section>

      {/* Сравнение тарифов: три колонки с фичами (новая экономика) */}
      <section className="panel profile-card">
        <h3>Тарифы</h3>
        <div className="tier-grid">
          {(["free", "pro", "business"] as const).map((t) => (
            <div
              key={t}
              className={t === tier ? "tier-card tier-card--current" : "tier-card"}
            >
              <div className="tier-card__name">
                {TIER_LABEL[t]}
                {t === tier && <span className="badge badge--claimed">текущий</span>}
              </div>
              <div className="tier-card__price">
                {t === "free"
                  ? "бесплатно"
                  : t === "pro"
                    ? `${price("pro_month", 500)} ★/мес`
                    : `${price("business_month", 2500)} ★/мес`}
              </div>
              {TIER_FEATURES.map((f) => {
                const v = f.value[t];
                return typeof v === "string" ? (
                  <div className="tier-card__feature" key={f.label}>
                    <span aria-hidden>✓</span>
                    {f.label}: <b>{v}</b>
                  </div>
                ) : v ? (
                  <div className="tier-card__feature" key={f.label}>
                    <span aria-hidden>✓</span>
                    {f.label}
                  </div>
                ) : (
                  <div className="tier-card__feature tier-card__feature--off" key={f.label}>
                    <span aria-hidden>—</span>
                    {f.label}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="panel profile-card">
        <h3>Мои сигналы</h3>
        <p className="profile-card__text">
          Подписки на новые машины: подходящие объявления приходят в чат-бот.
        </p>
        {signals === null ? (
          <div className="state"><span className="skeleton" style={{ width: 160, height: 16 }} /></div>
        ) : signals.length === 0 ? (
          <p className="info-row info-row--muted">Сигналов пока нет — создайте первый в разделе «Сигналы».</p>
        ) : (
          <div className="sig-preview">
            {signals.slice(0, 3).map((s) => (
              <div className="info-row" key={s.id}>
                <span className="info-row__label">
                  {s.notify_mode === "instant" ? "⚡" : "🔔"} {s.name || `Сигнал #${s.id}`}
                </span>
                <span className="info-row__value info-row__muted">
                  {s.notify_mode === "instant"
                    ? "сразу при публикации"
                    : "дайджест по тарифу"}
                </span>
              </div>
            ))}
            {signals.length > 3 && (
              <div className="info-row info-row--muted">…и ещё {signals.length - 3}</div>
            )}
          </div>
        )}
        <Link to="/filters" className="btn btn--block sig-preview__all">
          Все сигналы ({signals?.length ?? 0})
        </Link>
      </section>

      {/* «Мои объявления» (NAV-V2) — в табе «Авто» (screens/MyLotsPanel) */}

      <section className="panel profile-card">
        <h3>Профиль</h3>
        <div className="info-row">
          <span className="info-row__label">Имя</span>
          <span className="info-row__value">
            {user.first_name} {user.last_name ?? ""}
            {user.username ? <span className="info-row__muted"> · @{user.username}</span> : null}
          </span>
          <span className="badge badge--claimed">{TIER_LABEL[user.subscription_tier]}</span>
        </div>
        <div className="info-row">
          <span className="info-row__label">Роль</span>
          <span className="info-row__value">{user.role}</span>
        </div>
        <div className="info-row">
          <span className="info-row__label">С нами с</span>
          <span className="info-row__value">{new Date(user.created_at).toLocaleDateString("ru")}</span>
        </div>
      </section>

      {/* R1: настройки оформления — ниже монетизации */}
      <section className="panel profile-card">
        <h3>Тема оформления</h3>
        <div className="theme-row">
          {THEME_OPTIONS.map((o) => (
            <button
              key={o.key}
              className={theme === o.key ? "chip chip--active" : "chip"}
              aria-pressed={theme === o.key}
              onClick={() => {
                haptic("light");
                setTheme(o.key); // применяет и оповещает MiniApp (AppRoot)
                setThemeState(o.key);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="region-hint">
          Системная повторяет тему Telegram (вне Telegram — настройки устройства).
          Светлая и тёмная применяются всегда, независимо от системы.
        </div>
      </section>

      <section className="panel profile-card">
        <h3>Регион доставки</h3>
        <div className="region-row">
          {(["ru", "by"] as const).map((r) => (
            <button
              key={r}
              aria-pressed={region === r}
              className={region === r ? "chip chip--active" : "chip"}
              onClick={() => {
                haptic("light");
                setRegion(r);
                setRegionState(r);
              }}
            >
              {REGION_LABEL[r]} · {REGION_CURRENCY[r]}
            </button>
          ))}
        </div>
        <div className="region-hint">
          В ленте цены — в валюте региона; $ и цена источника остаются в карточке
          объявления. Таможенные платежи ЕАЭС одинаковы для РФ и РБ; нюансы
          постановки на учёт уточнит менеджер.
        </div>
      </section>

      {/* R3: выход — текстовая danger-ghost внизу, с подтверждением */}
      {logoutConfirm ? (
        <div className="pr-logout__confirm" role="alertdialog" aria-label="Подтверждение выхода">
          <span>Точно выйти? Сессия сбросится.</span>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => {
              logout();
              // keep-alive экраны («История» и др.) перечитывают данные:
              // просмотры предыдущего пользователя не должны показываться дальше
              window.dispatchEvent(new CustomEvent("autobot:auth"));
            }}
          >
            Выйти
          </button>
          <button type="button" className="btn" onClick={() => setLogoutConfirm(false)}>
            Остаться
          </button>
        </div>
      ) : (
        <button type="button" className="pr-logout" onClick={() => setLogoutConfirm(true)}>
          Выйти (сбросить сессию)
        </button>
      )}

      {/* NAV-V2 §1: быстрый выход на лендинг-вход (выбор поверхности).
          Лендинг открывается на «/» при полной загрузке — ведём туда. */}
      <button
        type="button"
        className="btn btn--block"
        onClick={() => {
          resetSurface();
          window.location.assign("/");
        }}
      >
        Сменить поверхность (пользователи / партнёры)
      </button>

      {tg && (
        <div className="info-row info-row--muted">
          <span className="info-row__label">Контекст Mini App активен</span>
          <span className="info-row__value">Telegram ID: {tg.id}</span>
        </div>
      )}
    </div>
  );
}
