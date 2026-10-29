/**
 * Онбординг в один экран (01-ux-audit-ia.md §3.6, O1): приветствие +
 * опциональный чипс роли + единственный primary «Показать машины».
 * Шаги «роль» и «страны» убраны: роль больше не блокирует кнопку
 * (раньше disabled={!role}), регионы покрыты «Регионом доставки»
 * в Профиле. Завершение = действие: POST /me/onboarded (App.tsx) → лента.
 */

import { useState } from "react";

import { tgUser } from "../api/auth";
import { Tooltip } from "../components/Tooltip";

const ROLES = [
  { key: "buyer", title: "Покупатель" },
  { key: "dealer", title: "Перекуп" },
  { key: "salon", title: "Салон-брокер" },
] as const;

/** Контракт завершения сохранён (App.tsx: finishOnboarding). */
export function OnboardingScreen({
  onDone,
}: {
  onDone: (data: { role: string; countries: string[] }) => void;
}) {
  const tg = tgUser();
  const name = tg?.first_name ?? "друг";
  /** Роль — опциональный чипс: клик по выбранному снимает выбор */
  const [role, setRole] = useState<string | null>(null);

  return (
    <div className="onboarding screen-enter">
      <div>
        <h2 style={{ margin: "0 0 8px" }}>🚗 Привет, {name}!</h2>
        <p style={{ color: "var(--text-secondary)", lineHeight: 1.5, margin: 0 }}>
          Авто из Кореи, Китая, ОАЭ, США и Казахстана: чеки осмотра, AI-разбор цены, доставка «под ключ».
          Сохраняйте, считайте доставку, ловите сигналы.
        </p>
      </div>

      <div>
        <div className="onboarding__roles-label">
          Кто вы?{" "}
          <Tooltip text="Роль помогает точнее подбирать машины и расчёты. Можно пропустить и выбрать позже в профиле.">
            <span className="onboarding__hint" tabIndex={0}>
              (необязательно ⓘ)
            </span>
          </Tooltip>
        </div>
        <div className="onboarding__chips" role="group" aria-label="Роль">
          {ROLES.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={role === r.key}
              className={role === r.key ? "chip chip--active" : "chip"}
              onClick={() => setRole(role === r.key ? null : r.key)}
            >
              {r.title}
            </button>
          ))}
        </div>
      </div>

      {/* Единственный primary: завершение = действие, ведущее в ленту */}
      <button
        className="btn btn--primary btn--block"
        onClick={() => onDone({ role: role ?? "buyer", countries: [] })}
      >
        Показать машины
      </button>
    </div>
  );
}
