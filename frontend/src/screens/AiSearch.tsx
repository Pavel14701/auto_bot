/**
 * Экран «AI-поиск» (01-ux-audit-ia.md §1.4, A1–A4; тексты — 03 §2.5):
 *  A1 — интро с примерами-промптами чипами + карточка «Понял так: …»
 *       после каждого ответа бота (criteria уже приходят из /ai/message);
 *  A2 — после финализации «Показать в ленте» (/?<критерии>) и «Открыть
 *       сигнал» (→ /filters), а не тупик «Поиск запущен!»;
 *  A3 — сброс ↺ с подтверждением в шапке чата, из композера убран;
 *  A4 — восстановление истории после F5 пока не делаем (P2, nice-to-have).
 * Ответы бота озвучиваются скрин-ридером (role="log" + aria-live).
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { aiFinalize, aiMessage, aiReset, type AiReply } from "../api/ai";
import { bodyLabel, driveLabel, fuelLabel, transmissionLabel } from "../lib/specs";
import { apiErrorView } from "./apiErrorText";

import "../screens-extra.css";

interface Bubble {
  role: "user" | "bot";
  text: string;
  options?: string[];
  finalize?: boolean;
  criteria?: Record<string, unknown>;
  /** Бабл-ошибка (маппинг 03 §3.2) — danger-тинт + возможный фолбэк-CTA. */
  error?: boolean;
  action?: { label: string; to: string };
}

/** Примеры-промпты в интро (03 §2.5 — тексты буквально). */
const PROMPT_EXAMPLES = [
  "Hyundai Palisade 2022–2024, дизель, до 45к $",
  "Гибрид до $20 000 для города",
  "Кроссовер 2021+, полный привод",
  "Минивэн для семьи, до 100 тыс. км",
];

const fmtNum = (v: unknown): string => Number(v).toLocaleString("ru-RU");

/** Критерии агента → человекочитаемая строка (A1):
 *  {make, model, year_from, year_to, price_max, fuel…} →
 *  «Palisade, 2022–2024, дизель, до $45 000». */
function criteriaToParts(c: Record<string, unknown>): string[] {
  const parts: string[] = [];
  if (c.make) parts.push(String(c.make));
  if (c.model) parts.push(String(c.model));
  const yFrom = c.year_from != null ? Number(c.year_from) : null;
  const yTo = c.year_to != null ? Number(c.year_to) : null;
  if (yFrom && yTo) parts.push(`${yFrom}–${yTo}`);
  else if (yFrom) parts.push(`с ${yFrom}`);
  else if (yTo) parts.push(`до ${yTo}`);
  if (c.price_min != null && c.price_max != null)
    parts.push(`$${fmtNum(c.price_min)}–$${fmtNum(c.price_max)}`);
  else if (c.price_max != null) parts.push(`до $${fmtNum(c.price_max)}`);
  else if (c.price_min != null) parts.push(`от $${fmtNum(c.price_min)}`);
  if (c.mileage_max != null) parts.push(`до ${fmtNum(c.mileage_max)} км`);
  if (c.fuel) parts.push(fuelLabel(String(c.fuel)) ?? String(c.fuel));
  if (c.transmission) parts.push(transmissionLabel(String(c.transmission)) ?? String(c.transmission));
  if (c.body_type) parts.push(bodyLabel(String(c.body_type)) ?? String(c.body_type));
  if (c.drive) parts.push(driveLabel(String(c.drive)) ?? String(c.drive));
  return parts;
}

/** Критерии → query ленты (A2): /?make=…&price_max=… — формат deep-link
 *  из Feed.deepLinkQuery, лента применит их сразу. */
function criteriaToQuery(c: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  const map: [string, string][] = [
    ["make", "make"],
    ["model", "model"],
    ["year_from", "year_from"],
    ["year_to", "year_to"],
    ["price_min", "price_min"],
    ["price_max", "price_max"],
    ["mileage_max", "mileage_max"],
  ];
  for (const [qk, ck] of map) {
    const v = c[ck];
    if (v != null && v !== "") sp.set(qk, String(v));
  }
  return sp.toString();
}

export function AiSearchScreen() {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastReply, setLastReply] = useState<AiReply | null>(null);
  const [launched, setLaunched] = useState<{ sources: string[] } | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const navigate = useNavigate();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [bubbles, launched]);

  /** Бабл с ошибкой по маппингу 03 §3.2 (сырой detail не показываем). */
  const pushError = (e: unknown) => {
    const view = apiErrorView(e);
    setBubbles((prev) => [
      ...prev,
      {
        role: "bot",
        text: `⚠️ ${view.text}`,
        error: true,
        action: view.action ? { label: view.action.label, to: view.action.to ?? "/filters" } : undefined,
      },
    ]);
  };

  const send = async (text: string) => {
    const clean = text.trim();
    if (!clean || busy) return;
    setBusy(true);
    setInput("");
    setBubbles((prev) => [...prev, { role: "user", text: clean }]);
    try {
      const reply = await aiMessage(clean);
      setLastReply(reply);
      setBubbles((prev) => [
        ...prev,
        {
          role: "bot",
          text: reply.text,
          options: reply.options,
          finalize: reply.finalize_ready,
          criteria: (reply.criteria as Record<string, unknown>) ?? undefined,
        },
      ]);
    } catch (e: unknown) {
      pushError(e);
    } finally {
      setBusy(false);
    }
  };

  const finalize = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await aiFinalize((lastReply?.criteria as Record<string, unknown>) ?? undefined);
      setLaunched({ sources: res.sources ?? [] });
    } catch (e: unknown) {
      pushError(e);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    await aiReset().catch(() => undefined);
    setBubbles([]);
    setLastReply(null);
    setLaunched(null);
    setResetConfirm(false);
  };

  const last = bubbles[bubbles.length - 1];
  const lastCriteria = last?.criteria;

  return (
    <div className="ai-chat">
      <div className="ai-chat__head">
        <div className="screen-title">AI-подбор</div>
        {bubbles.length > 0 && !resetConfirm && (
          <button
            type="button"
            className="ai-chat__reset"
            aria-label="Начать заново"
            onClick={() => setResetConfirm(true)}
          >
            ↺
          </button>
        )}
        {resetConfirm && (
          <span className="ai-chat__confirm">
            Начать заново?
            <button type="button" className="ai-chat__reset" onClick={() => void reset()}>
              Да, сбросить
            </button>
            <button type="button" className="ai-chat__reset" onClick={() => setResetConfirm(false)}>
              Отмена
            </button>
          </span>
        )}
      </div>

      {bubbles.length === 0 && !launched && (
        <div className="ai-chat__intro">
          <div className="ai-chat__intro-icon" aria-hidden="true">🤖</div>
          <div className="ai-chat__intro-title">AI-подбор автомобиля</div>
          <div className="ai-chat__intro-text">
            Опишите словами, что ищете — агент задаст уточняющие вопросы и
            запустит поиск по всем источникам.
          </div>
          <div className="ai-chat__prompts" role="group" aria-label="Примеры запросов">
            <span className="ai-chat__prompts-label">Попробуйте:</span>
            {PROMPT_EXAMPLES.map((p) => (
              <button
                key={p}
                type="button"
                className="ai-chat__prompt"
                onClick={() => void send(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Ответы бота озвучиваются (aria-live): пользователь слышит
          «печатает…» и результат без взгляда на экран */}
      <div className="ai-chat__history" role="log" aria-live="polite" aria-label="Диалог с AI-агентом">
        {bubbles.map((b, i) => (
          <div
            key={i}
            className={
              b.role === "user"
                ? "ai-msg ai-msg--user"
                : b.error
                  ? "ai-msg ai-msg--bot ai-msg--error"
                  : "ai-msg ai-msg--bot"
            }
          >
            <div className="ai-msg__text">{b.text}</div>
            {/* A1: карточка критериев после каждого ответа бота */}
            {b.role === "bot" && b.criteria && criteriaToParts(b.criteria).length > 0 && (
              <div className="ai-criteria">
                <span className="ai-criteria__label">Понял так:</span>
                <span className="ai-criteria__value">
                  {criteriaToParts(b.criteria).join(", ")}
                </span>
              </div>
            )}
            {b.action && (
              <button
                type="button"
                className="ai-msg__action"
                onClick={() => navigate(b.action!.to)}
              >
                {b.action.label}
              </button>
            )}
          </div>
        ))}
        {busy && (
          <div className="ai-msg ai-msg--bot">
            <div className="ai-msg__text ai-msg__text--typing" aria-label="Агент печатает">
              <span /><span /><span />
            </div>
          </div>
        )}
      </div>

      {launched && (
        <div className="ai-launched" role="status">
          <div className="ai-launched__text">
            {launched.sources.length > 0
              ? "🔎 Поиск запущен! Новые варианты пришлём в Telegram."
              : "🔎 Поиск запущен, но активных источников пока нет — проверьте подписки в разделе «Сигналы»."}
          </div>
          {launched.sources.length > 0 && (
            <div className="ai-launched__sources">
              {launched.sources.map((s) => (
                <span key={s} className="ai-launched__source">{s}</span>
              ))}
            </div>
          )}
          <div className="ai-launched__text">Сигнал сохранён — новые варианты придут в чат-бот.</div>
          <div className="ai-launched__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                const qs = lastCriteria ? criteriaToQuery(lastCriteria) : "";
                // BF-05: обещаем ленту — переключаем сегмент Главной до
                // навигации (меняется только query, pathname уже «/»).
                window.dispatchEvent(new CustomEvent("autobot:open-feed"));
                navigate(qs ? `/?${qs}` : "/");
              }}
            >
              Показать в ленте
            </button>
            <button type="button" className="btn" onClick={() => navigate("/filters")}>
              Открыть сигнал
            </button>
          </div>
        </div>
      )}

      {!launched && last?.options && last.options.length > 0 && (
        <div className="ai-chat__options">
          {last.options.map((o) => (
            <button key={o} className="chip" onClick={() => send(o)}>
              {o}
            </button>
          ))}
        </div>
      )}

      {!launched && last?.finalize && (
        <div className="ai-chat__finalize">
          <button className="btn btn--primary btn--block" disabled={busy} onClick={finalize}>
            {busy ? "Запускаю…" : "🔎 Запустить поиск"}
          </button>
        </div>
      )}

      <div ref={bottomRef} />

      {!launched && (
        <div className="ai-chat__composer">
          <textarea
            className="ai-chat__input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="Например: Kia Carnival, дизель, до 50к $"
            rows={2}
          />
          <div className="ai-chat__composer-actions">
            {/* A3: единственный primary — отправка; «Сброс» убран в шапку */}
            <button
              type="button"
              className="btn btn--primary"
              style={{ flex: 1 }}
              disabled={busy || !input.trim()}
              onClick={() => void send(input)}
            >
              {busy ? "Спрашиваю…" : "Отправить"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
