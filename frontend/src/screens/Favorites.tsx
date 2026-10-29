/**
 * Экран «Избранное» (01-ux-audit-ia.md §1.6; тексты — 03 §2.7):
 *  - пустое состояние с CTA «К ленте» (тексты буквально из 03);
 *  - бейдж «цена снизилась» семантикой --deal (данные first_price/price),
 *    «снято с продажи» — --danger (is_active);
 *  - старая цена — зачёркнутой вторичной строкой;
 *  - ошибки API различаются (401-сессия vs сеть), не всё «нужен вход».
 * В2 (подтверждение удаления с undo) — за скопом этого прохода: кнопка ✕
 * остаётся единственным деструктивом в строке, отдельно от тапа-перехода.
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client";
import { isGuest } from "../api/auth";
import { useLoginPrompt } from "../ui/LoginPrompt";
import { useToast } from "../ui/Toast";
import { SkeletonCard } from "../ui/Skeleton";
import { getRegion, priceChain } from "../lib/fx";
import type { Listing } from "../api/types";
import { apiErrorView } from "./apiErrorText";

export function FavoritesScreen() {
  const [items, setItems] = useState<Listing[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [guest, setGuest] = useState(() => isGuest());
  const loginPrompt = useLoginPrompt();
  const toast = useToast();
  const navigate = useNavigate();

  // BF-04: экран живёт в keep-alive и не перемонтируется — после апгрейда
  // гостя (автологин /login диспатчит autobot:auth) перечитываем гостя,
  // иначе сегмент навсегда остаётся гейтом «Нужен вход». При guest=false
  // эффект ниже сам догрузит список.
  useEffect(() => {
    const onAuth = () => setGuest(isGuest());
    window.addEventListener("autobot:auth", onAuth);
    return () => window.removeEventListener("autobot:auth", onAuth);
  }, []);

  // Гость: раздел персональный — сразу просим войти (модалка + гейт экрана)
  useEffect(() => {
    if (guest) {
      loginPrompt.show("Избранное доступно после входа — так машины сохраняются за вашим аккаунтом.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guest]);

  const load = useCallback(() => {
    setError(null);
    api<Listing[]>("/favorites")
      .then(setItems)
      .catch((e: unknown) => setError(e));
  }, []);

  useEffect(() => {
    if (!guest) load();
  }, [guest, load]);

  const unfavorite = async (id: number) => {
    try {
      await api(`/listings/${id}/favorite`, { method: "DELETE" });
      setItems((prev) => prev?.filter((x) => x.id !== id) ?? null);
    } catch {
      // удаление не прошло — машина остаётся в списке; молчать нельзя
      toast.show("Не удалось убрать из избранного — попробуйте ещё раз", {
        error: true,
      });
    }
  };

  if (guest) {
    return (
      <div className="state state--page">
        <div className="state__emoji">🔒</div>
        <div className="state__title">Нужен вход</div>
        <div className="state__text">
          Избранное доступно после входа через Telegram — так машины сохраняются
          за вашим аккаунтом.
        </div>
        <button className="btn btn--primary" style={{ marginTop: 12 }} onClick={() => navigate("/login")}>
          Войти
        </button>
      </div>
    );
  }

  if (error != null) {
    const view = apiErrorView(error);
    // 401 — сессия; прочее — типовая ошибка загрузки избранного (03 §2.7)
    const isAuth = (error as { status?: number }).status === 401;
    return (
      <div className="state state--page">
        <div className="state__emoji">⚠️</div>
        <div className="state__title">
          {isAuth ? "Нужна авторизация" : "Не удалось загрузить избранное"}
        </div>
        <div className="state__text">
          {isAuth
            ? view.text
            : "Откройте приложение из Telegram-бота и попробуйте снова."}
        </div>
        <button className="btn" style={{ marginTop: 12 }} onClick={load}>
          Повторить
        </button>
      </div>
    );
  }

  if (items === null) {
    return (
      <div className="screen">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="state state--page">
        <div className="state__emoji">🤍</div>
        <div className="state__title">Пока пусто</div>
        <div className="state__text">
          Нажмите ❤️ на любом объявлении — машина сохранится здесь.
        </div>
        <button className="btn btn--primary" style={{ marginTop: 12 }} onClick={() => navigate("/")}>
          К ленте
        </button>
      </div>
    );
  }

  return (
    <div className="screen">
      <section className="panel">
        <h3>Избранное: {items.length}</h3>
        <div className="fav-list">
          {items.map((l) => {
            // Бейджи отслеживания (§1.6): ⬇️ цена снизилась (--deal),
            // 🔴 снято с продажи (--danger) — данные first_price/is_active
            const dropped =
              l.first_price != null && l.price != null && l.price < l.first_price;
            const dropPct =
              dropped && l.first_price
                ? Math.round((1 - (l.price ?? 0) / l.first_price) * 100)
                : null;
            const gone = l.is_active === false;
            // Цены — в валюте региона (как в ленте), а не в валюте источника
            const toLocal = (p: number | null) =>
              priceChain(p, l.currency, getRegion(), { withOriginal: false });
            const priceNow = toLocal(l.price);
            const priceWas = dropped ? toLocal(l.first_price) : null;
            return (
              <div
                key={l.id}
                className="filter-item"
                role="button"
                tabIndex={0}
                aria-label={`${`${l.make ?? ""} ${l.model ?? ""}`.trim() || "Объявление"}, ${l.year ?? ""}`}
                onClick={() => navigate(`/listing/${l.id}`)}
                onKeyDown={(e) => {
                  // Enter и Space — доступность кликабельной строки (03 §5.2)
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate(`/listing/${l.id}`);
                  }
                }}
              >
                <div className="filter-item__body">
                  <div className="filter-item__name">
                    {`${l.make ?? ""} ${l.model ?? ""}`.trim() || "Объявление"}
                  </div>
                  <div className="filter-item__desc">
                    {`${l.year ?? "—"} · ${priceNow.local ?? priceNow.original ?? "—"} · ${l.mileage_km?.toLocaleString("ru") ?? "—"} км`}
                  </div>
                  {priceWas?.local && (
                    <div className="filter-item__desc">
                      было <span className="fav-price-was">{priceWas.local}</span>
                    </div>
                  )}
                  {dropped && (
                    <span className="fav-badge fav-badge--deal">
                      <span aria-hidden="true">⬇️</span> цена снизилась
                      {dropPct ? ` −${dropPct}%` : ""}
                    </span>
                  )}
                  {gone && (
                    <span className="fav-badge fav-badge--gone">
                      <span aria-hidden="true">🔴</span> снято с продажи
                    </span>
                  )}
                </div>
                <button
                  className="btn btn--danger"
                  aria-label="Убрать из избранного"
                  onClick={(e) => {
                    e.stopPropagation();
                    void unfavorite(l.id);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
