/**
 * Авто (NAV-V2 §2): избранное, история просмотров/разборов и «Мои
 * объявления» — один таб с сегментом сверху. Панели живут в keep-alive
 * (смена сегмента прячет неактивную .keepalive-hidden — избранное,
 * история и лоты рынка не перезагружаются).
 *
 * Активный сегмент синхронизирован с query (?tab=favorites|history|mine):
 * deep-link'ы /auto?tab=history (редирект со старого /analyses, «Найти
 * похожие» из PDP — ?similar сохраняется) открывают нужную панель.
 * Гостю рынок закрыт — сегмента «Мои объявления» нет.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { isGuest } from "../api/auth";
import { FavoritesScreen } from "./Favorites";
import { AnalysesScreen } from "./Analyses";
import { MyLotsPanel } from "./MyLotsPanel";

type Segment = "favorites" | "history" | "mine";

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: "favorites", label: "Избранное" },
  { key: "history", label: "История" },
  { key: "mine", label: "Мои объявления" },
];

const VALID: readonly Segment[] = ["favorites", "history", "mine"];

export function AutoScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const guest = isGuest();

  const param = searchParams.get("tab") as Segment | null;
  const allowed = (s: Segment) => VALID.includes(s) && (s !== "mine" || !guest);
  const segment: Segment = param && allowed(param) ? param : "favorites";

  /** Ленивый монтаж панелей: неактивные не грузятся до первого захода. */
  const [visited, setVisited] = useState<ReadonlySet<Segment>>(new Set(["favorites"]));
  useEffect(() => {
    setVisited((prev) => (prev.has(segment) ? prev : new Set(prev).add(segment)));
  }, [segment]);

  const open = (key: Segment) => {
    // Сегмент в query: deep-link'и работают, переходы между сегментами
    // живут в истории — «Назад» возвращает предыдущий сегмент (BF-11:
    // replace вычищал историю, вопреки обещанию «back/forward работают»).
    setSearchParams(key === "favorites" ? {} : { tab: key });
  };

  return (
    <div className="screen auto-screen" data-testid="auto-screen">
      <div className="hist-seg" role="tablist" aria-label="Разделы авто">
        {SEGMENTS.filter((it) => allowed(it.key)).map((it) => (
          <button
            key={it.key}
            role="tab"
            type="button"
            aria-selected={segment === it.key}
            className={
              segment === it.key
                ? "hist-seg__btn hist-seg__btn--active"
                : "hist-seg__btn"
            }
            onClick={() => open(it.key)}
          >
            {it.label}
          </button>
        ))}
      </div>

      <div className={segment === "favorites" ? "screen-enter" : "keepalive-hidden"}>
        {visited.has("favorites") && <FavoritesScreen />}
      </div>
      <div className={segment === "history" ? "screen-enter" : "keepalive-hidden"}>
        {visited.has("history") && <AnalysesScreen />}
      </div>
      <div className={segment === "mine" ? "screen-enter" : "keepalive-hidden"}>
        {visited.has("mine") && <MyLotsPanel />}
      </div>
    </div>
  );
}
