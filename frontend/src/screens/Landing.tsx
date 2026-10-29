/**
 * Лендинг-вход (NAV-V2 §1): главная страница выбора приложения — для
 * пользователей (Mini App) и для партнёров (ЛК).
 *
 * В браузере на корне «/» показывается ВСЕГДА (даже при выбранной
 * поверхности): вход — один клик по карточке. Последний выбор НЕ
 * запирает лендинг — лишь ставит карточку первой с меткой «● последний
 * вход». В Telegram и по deep-link с query (/?make=…) сразу открывается
 * приложение — лишний экран не встаёт на пути сценария. Вернуться на
 * лендинг: Профиль → «Сменить поверхность» (resetSurface + «/»).
 */

import { Car, Building2, ArrowRight } from "lucide-react";

const SURFACE_KEY = "autobot.surface";

export function getChosenSurface(): string | null {
  try {
    return localStorage.getItem(SURFACE_KEY);
  } catch {
    return null;
  }
}

/** Запомнить последний вход (только сортировка карточек + метка). */
export function chooseSurface(surface: "user" | "partner"): void {
  try {
    localStorage.setItem(SURFACE_KEY, surface);
  } catch {
    /* гости с заблокированным storage всё равно попадут в приложение */
  }
  window.dispatchEvent(new CustomEvent("autobot:surface"));
}

/** «Сменить поверхность» (Профиль): сброс выбора + полная загрузка «/»
 *  — лендинг открывается снова. */
export function resetSurface(): void {
  try {
    localStorage.removeItem(SURFACE_KEY);
  } catch {
    /* storage недоступен — просто перезагрузим корень */
  }
}

export function Landing({
  onChooseUser,
}: {
  onChooseUser: () => void;
}) {
  // Последний вход — первым; «user» и «partner» равноправны.
  const last = getChosenSurface();
  const userFirst = last !== "partner";

  const userCard = (
    <button
      type="button"
      className={
        userFirst
          ? "landing__card landing__card--primary landing__card--last"
          : "landing__card landing__card--primary"
      }
      onClick={onChooseUser}
    >
      <span className="landing__card-icon">
        <Car size={26} aria-hidden="true" />
      </span>
      <span className="landing__card-body">
        <span className="landing__card-title">
          Приложение для пользователей
          {last === "user" && <span className="landing__card-last">● последний вход</span>}
        </span>
        <span className="landing__card-text">
          Лента объявлений, AI-подбор, избранное, разборы цен
        </span>
      </span>
      <ArrowRight size={18} className="landing__card-arrow" aria-hidden="true" />
    </button>
  );

  const partnerCard = (
    <a
      className={!userFirst ? "landing__card landing__card--last" : "landing__card"}
      href="/partner"
      data-testid="landing-partner"
      onClick={() => chooseSurface("partner")}
    >
      <span className="landing__card-icon">
        <Building2 size={26} aria-hidden="true" />
      </span>
      <span className="landing__card-body">
        <span className="landing__card-title">
          Кабинет партнёра
          {last === "partner" && <span className="landing__card-last">● последний вход</span>}
        </span>
        <span className="landing__card-text">
          Для салонов и маклеров: лиды, рынок, биллинг
        </span>
      </span>
      <ArrowRight size={18} className="landing__card-arrow" aria-hidden="true" />
    </a>
  );

  return (
    <div className="landing" data-testid="landing">
      <div className="landing__hero">
        <div className="landing__logo" aria-hidden="true">🚗</div>
        <h1 className="landing__title">Auto Selection</h1>
        <p className="landing__sub">
          Подбор автомобилей из Кореи, Китая, ОАЭ, США и Казахстана:
          агрегатор объявлений, AI-анализ цены и чеки осмотра.
        </p>
      </div>

      <div className="landing__cards">
        {userFirst ? [userCard, partnerCard] : [partnerCard, userCard]}
      </div>

      <p className="landing__hint">
        В Telegram приложение открывается сразу из бота — без выбора.
      </p>
    </div>
  );
}
