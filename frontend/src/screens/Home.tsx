/**
 * Главная (NAV-V2 §2): лента объявлений и AI-поиск — один таб, сегмент
 * сверху («Лента | AI-поиск»). Обе панели живут в keep-alive: смена
 * сегмента прячет неактивную классом .keepalive-hidden (display:none),
 * состояние фильтров ленты и чат AI не теряются.
 *
 * Лента — viewport-scroll экран (вся прокрутка внутри .feed-scroll,
 * body.feed-locked): пока активен её сегмент, Home занимает высоту
 * контента (flex-цепочка .home-screen → .home-screen__panel → лента).
 * AI-сегмент — обычный page-scroll: FeedScreen получает inactive и сам
 * снимает feed-locked (см. Feed.tsx).
 *
 * FAB «+ Продать» (06 §6) живёт на Главной — его рендерит App (SellFab
 * виден только на пути «/»), сюда ничего не добавляем.
 */

import { useEffect, useState } from "react";

import { FeedScreen } from "./Feed";
import { AiSearchScreen } from "./AiSearch";

type Segment = "feed" | "ai";

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: "feed", label: "Лента" },
  { key: "ai", label: "AI-поиск" },
];

export function HomeScreen() {
  const [segment, setSegment] = useState<Segment>("feed");
  /** Ленивый монтаж панелей: AI не грузится, пока его не открывали. */
  const [visited, setVisited] = useState<ReadonlySet<Segment>>(new Set(["feed"]));

  useEffect(() => {
    setVisited((prev) => (prev.has(segment) ? prev : new Set(prev).add(segment)));
  }, [segment]);

  // BF-05: «Показать в ленте» (AI-поиск) меняет только query — сегмент
  // оставался на AI, критерии применялись в скрытую ленту. Навигация
  // диспатчит событие — Главная переключается на ленту.
  useEffect(() => {
    const onOpenFeed = () => setSegment("feed");
    window.addEventListener("autobot:open-feed", onOpenFeed);
    return () => window.removeEventListener("autobot:open-feed", onOpenFeed);
  }, []);

  return (
    <div className="home-screen" data-testid="home-screen">
      <div className="hist-seg home-screen__seg" role="tablist" aria-label="Разделы главной">
        {SEGMENTS.map((it) => (
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
            onClick={() => setSegment(it.key)}
          >
            {it.label}
          </button>
        ))}
      </div>

      <div className={segment === "feed" ? "home-screen__panel" : "keepalive-hidden"}>
        {visited.has("feed") && <FeedScreen inactive={segment !== "feed"} />}
      </div>
      <div className={segment === "ai" ? "home-screen__panel" : "keepalive-hidden"}>
        {visited.has("ai") && <AiSearchScreen />}
      </div>
    </div>
  );
}
