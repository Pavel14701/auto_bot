/**
 * Панель «Мои объявления» (NAV-V2: вынесена из Профиля в таб «Авто»).
 *
 * Лоты рынка пользователя со статус-пилюлями жизненного цикла (06 §6 +
 * 10-listing-lifecycle §5): Черновик/На проверке/Одобрено—оплата/
 * Опубликовано/Отклонено/Правки на проверке/Снято/Истёк поверх placement;
 * CTA — «Продолжить»/«Исправить» (/sell?edit), «Оплатить размещение»,
 * «Восстановить» (submit заново); live-обновление по событию listing_status
 * личного канала (useListingStatus → тост + refresh).
 *
 * 12-ai-trust §2 (F12): «Качество: N/100» с пороговым цветом (≥80 deal /
 * ≥50 warn / ниже danger) + первый совет как подсказка.
 *
 * Гость — рынок закрыт (403): панель не рендерится и данных не просит.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { haptic, isGuest } from "../api/auth";
import { openInvoice, type InvoiceStatus } from "../lib/invoice";
import { countryFlag, countryName } from "../lib/geo";
import { qualityTone } from "../lib/listingQuality";
import { listingStatusToast, useListingStatus } from "../lib/chatStore";
import { useToast } from "../ui/Toast";
import { apiErrorText } from "./apiErrorText";
import "../market.css";
import type { LotSubmitResult, MyLot, PlacementInvoice } from "../api/types";

/** Подписи правил авто-модерации (10 §2) для списка нарушений. */
const VIOLATION_LABEL: Record<string, string> = {
  contacts_in_text: "Контакты в описании",
  forbidden_words: "Запрещённые слова",
  price_outlier: "Подозрительная цена",
  short_description: "Короткое описание",
  new_user: "Первое объявление — ручная проверка",
  duplicate: "Похоже на дубликат",
};

/** Placement мёртв (ждёт оплаты или deadline в прошлом) — «Одобрено—оплата». */
function placementDead(lot: MyLot): boolean {
  if (lot.placement_status === "needs_payment" || lot.placement_status === "expired") {
    return true;
  }
  if (!lot.placement_deadline) return false;
  const t = Date.parse(lot.placement_deadline);
  return Number.isFinite(t) && t < Date.now();
}

/** Placement-подпись опубликованного лота — вторая строка под пилюлей. */
function placementDetail(lot: MyLot): string | null {
  const fmt = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleDateString("ru") : null;
  switch (lot.placement_status) {
    case "included":
      return "включён в подписку (Pro)";
    case "free":
      return `бесплатно до ${fmt(lot.placement_free_until) ?? "—"}`;
    case "paid":
      return `оплачено до ${fmt(lot.placement_paid_until) ?? "—"}`;
    default:
      return null;
  }
}

/** Подпись статуса моего лота (06 §3 + 10 §5): пилюля в «Мои объявления».
 *  Статусы жизненного цикла (10 §1) — поверх placement; лоты без status
 *  (внешние/партнёрские, старый контракт) — прежняя placement-логика. */
export function lotStatusLabel(lot: MyLot): { text: string; tone: string } {
  switch (lot.status) {
    case "draft":
      return { text: "Черновик", tone: "muted" };
    case "moderation":
      return { text: "На проверке ⏳", tone: "warn" };
    case "rejected":
      return { text: "Отклонено", tone: "danger" };
    case "expired":
      return { text: "Срок истёк", tone: "muted" };
    case "archived":
      return { text: "Снято", tone: "muted" };
    case "accepted":
      if (!lot.is_active) return { text: "Снято", tone: "muted" };
      if (placementDead(lot)) return { text: "Одобрено — оплата", tone: "warn" };
      return { text: "Опубликовано", tone: "ok" };
    default:
      break;
  }
  // Лоты без status (до миграции 0030 / партнёрские) — placement-пилюли.
  if (!lot.is_active) {
    return { text: "Снято", tone: "muted" };
  }
  const fmt = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleDateString("ru") : null;
  switch (lot.placement_status) {
    case "included":
      return { text: "Включён (Pro)", tone: "ok" };
    case "free":
      return { text: `Бесплатно до ${fmt(lot.placement_free_until) ?? "—"}`, tone: "ok" };
    case "paid":
      return { text: `Оплачено до ${fmt(lot.placement_paid_until) ?? "—"}`, tone: "ok" };
    case "needs_payment":
      return { text: "Требует оплаты", tone: "warn" };
    case "expired":
      return { text: "Срок истёк", tone: "warn" };
    case "slot":
      return { text: "Размещено", tone: "ok" };
    default:
      return { text: lot.placement_status, tone: "muted" };
  }
}

export function MyLotsPanel() {
  const toast = useToast();
  /** «Мои объявления» (06 §6): лоты рынка пользователя с placement-статусом. */
  const [myLots, setMyLots] = useState<MyLot[] | null>(null);
  /** Ид лота с раскрытым выбором срока продления (1/4 нед). */
  const [extendingId, setExtendingId] = useState<number | null>(null);
  /** Лот в полёте (extend/DELETE) — блокируем его кнопки. */
  const [lotBusy, setLotBusy] = useState<number | null>(null);

  const reloadLots = useCallback(() => {
    if (isGuest()) return;
    api<MyLot[]>("/market/my-lots")
      .then((r) => setMyLots(Array.isArray(r) ? r : []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    reloadLots();
  }, [reloadLots]);

  /** Live-статусы объявлений (10 §3): событие личного канала → тост +
   *  свежие my-lots (панель keep-alive — подписка живёт, пока открыт апп). */
  useListingStatus((ev) => {
    const t = listingStatusToast(ev);
    toast.show(t.text, { error: t.error });
    reloadLots();
  });

  /** «Продлить» лот рынка (06 §2): Stars-инвойс размещения (20★/нед,
   *  4 нед = 60★) через tg.openInvoice. */
  const extendLot = async (lotId: number, weeks: 1 | 4) => {
    if (lotBusy != null) return;
    setLotBusy(lotId);
    let invoiceUrl: string | null = null;
    try {
      const inv = await api<PlacementInvoice>(`/market/lots/${lotId}/extend`, {
        method: "POST",
        body: JSON.stringify({ weeks }),
      });
      invoiceUrl = inv.invoice_url;
      haptic();
    } catch (e) {
      setLotBusy(null);
      const status = (e as { status?: number }).status;
      toast.show(
        status === 503
          ? "🛠 Платежи временно недоступны — попробуйте через пару минут"
          : apiErrorText(e), // 03 §3.2: сырой detail наружу не показываем
        { error: true },
      );
      return;
    }

    const inTg = openInvoice(invoiceUrl, (status: InvoiceStatus) => {
      setLotBusy(null);
      if (status === "paid") {
        toast.show("✅ Размещение продлено");
        reloadLots(); // перечитать placement-статусы
      } else if (status === "failed") {
        toast.show("❌ Оплата не прошла. Проверьте баланс ★ Stars и попробуйте ещё раз", { error: true });
      } else if (status === "cancelled") {
        toast.show("Оплата отменена — лот можно продлить в любой момент");
      } else {
        toast.show("⏳ Платёж в обработке — размещение продлится в течение пары минут");
      }
    });
    if (!inTg) {
      setLotBusy(null);
      toast.show(
        "💳 Счёт открыт в новой вкладке, но оплата ★ Stars работает только в Telegram",
      );
    }
  };

  /** «Снять с продажи»: подтверждение → DELETE /market/lots/{id} (06 §2). */
  const removeLot = async (lotId: number) => {
    if (lotBusy != null) return;
    if (!window.confirm("Снять объявление с продажи?")) return;
    setLotBusy(lotId);
    try {
      await api(`/market/lots/${lotId}`, { method: "DELETE" });
      toast.show("Объявление снято с продажи");
      reloadLots();
    } catch {
      toast.show("Не удалось снять объявление — попробуйте ещё раз", { error: true });
    } finally {
      setLotBusy(null);
    }
  };

  /** «Восстановить» истёкший лот (10 §4): POST /market/lots/{id}/submit —
   *  заново через модерацию (синхронный вердикт), placement — как раньше. */
  const restoreLot = async (lotId: number) => {
    if (lotBusy != null) return;
    setLotBusy(lotId);
    try {
      const r = await api<LotSubmitResult>(`/market/lots/${lotId}/submit`, {
        method: "POST",
      });
      if (r.status === "moderation") {
        toast.show("Отправлено на проверку — результат придёт здесь");
      } else if (r.status === "rejected") {
        toast.show(
          `Объявление отклонено: ${r.rejected_reason ?? "нарушение правил размещения"}`,
          { error: true },
        );
      } else {
        toast.show("Объявление восстановлено");
      }
      reloadLots();
    } catch {
      toast.show("Не удалось восстановить объявление — попробуйте ещё раз", { error: true });
    } finally {
      setLotBusy(null);
    }
  };

  // Гость: рынок закрыт (403) — панель не рисуем вовсе.
  if (isGuest()) return null;

  return (
    <section className="panel profile-card" aria-label="Мои объявления">
      <h3>Мои объявления</h3>
      <p className="profile-card__text">
        Продайте свою машину: объявление попадёт в ленту рынка, а покупатели
        напишут вам в чат. Первое объявление — 7 дней бесплатно.
      </p>
      {myLots === null ? (
        <div className="state"><span className="skeleton" style={{ width: 160, height: 16 }} /></div>
      ) : myLots.length === 0 ? (
        <p className="info-row info-row--muted">
          Объявлений пока нет — разместите первое, это займёт пару минут.
        </p>
      ) : (
        <div className="mylots">
          {myLots.map((lot) => {
            const status = lotStatusLabel(lot);
            const name = `${lot.make ?? ""} ${lot.model ?? ""}`.trim() || `Лот #${lot.listing_id}`;
            const busy = lotBusy === lot.listing_id;
            // Статусы жизненного цикла (10 §1); undefined — старый контракт
            const st = lot.status;
            const dead = st === "accepted" && placementDead(lot);
            // published: принят и жив (placement оплачен/бесплатный идёт)
            const published = st == null
              ? lot.is_active
              : st === "accepted" && lot.is_active && !dead;
            // Одобрено модерацией, но скрыто до оплаты размещения (10 §5)
            const needPay = st === "accepted" && lot.is_active && dead;
            const extendable = published && lot.placement_status !== "included";
            const removable = published || needPay;
            const editHref = `/sell?edit=${lot.listing_id}`;
            const patchReject = lot.pending_patch?.patch_reject_reason ?? null;
            return (
              <article key={lot.listing_id} className="mylot">
                {lot.images?.[0] ? (
                  <img className="mylot__img" src={lot.images[0]} alt="" loading="lazy" />
                ) : (
                  <span className="mylot__img mylot__img--empty" aria-hidden="true">🚗</span>
                )}
                <div className="mylot__main">
                  <span className="mylot__name">
                    {name}
                    {lot.year ? `, ${lot.year}` : ""}
                  </span>
                  <span className="mylot__price tabular">
                    {lot.price?.toLocaleString("ru-RU")} {lot.currency}
                  </span>
                  {/* Гео owner-лота (GEO-V1 §3): «🇷🇺 Москва»; без города —
                      флаг + имя страны; старый ответ без country — строки нет */}
                  {(lot.country || lot.city) && (
                    <span className="mylot__placement">
                      📍{" "}
                      {lot.country
                        ? `${countryFlag(lot.country)} ${lot.city ?? countryName(lot.country)}`
                        : lot.city}
                    </span>
                  )}
                  <span className={`mylot__pill mylot__pill--${status.tone}`}>{status.text}</span>
                  {/* Качество объявления (12 §2): score с бэка, цвет по
                      порогам ≥80 deal / ≥50 warn / ниже danger */}
                  {lot.quality && (
                    <span
                      className={`mylot__quality mylot__quality--${qualityTone(lot.quality.score)}`}
                    >
                      Качество: {lot.quality.score}/100
                    </span>
                  )}
                  {/* Первый совет качества — подсказкой под score-пилюлей */}
                  {lot.quality?.tips?.[0] && (
                    <span className="mylot__quality-tip">
                      💡 {lot.quality.tips[0]}
                    </span>
                  )}
                  {published && placementDetail(lot) && (
                    <span className="mylot__placement">{placementDetail(lot)}</span>
                  )}
                  {/* Отклонено модерацией: причина + сработавшие правила (10 §2) */}
                  {st === "rejected" && (
                    <div className="mylot__reject">
                      {lot.rejected_reason && (
                        <span className="mylot__reject__reason">{lot.rejected_reason}</span>
                      )}
                      {(lot.violations?.length ?? 0) > 0 && (
                        <ul className="mylot__violations">
                          {lot.violations?.map((v) => (
                            <li key={`${v.rule}|${v.detail}`}>
                              {VIOLATION_LABEL[v.rule] ?? v.rule}: {v.detail}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {/* Версия на проверке (10 §1): старая продолжает показываться */}
                  {lot.pending_patch && st === "accepted" && (
                    <div className="mylot__patch" role="note">
                      Правки на проверке — в ленте продолжает показываться старая
                      версия объявления
                      {patchReject && (
                        <span className="mylot__patch__reason">
                          Предыдущие правки отклонены: {patchReject}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="mylot__actions">
                  {st === "draft" && (
                    <Link className="btn" to={editHref}>
                      Продолжить
                    </Link>
                  )}
                  {(st === "rejected" || patchReject) && (
                    <Link className="btn" to={editHref}>
                      Исправить
                    </Link>
                  )}
                  {published && (
                    <Link className="btn" to={editHref}>
                      Редактировать
                    </Link>
                  )}
                  {/* Истёк (10 §1): submit заново — через модерацию */}
                  {st === "expired" && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void restoreLot(lot.listing_id)}
                    >
                      Восстановить
                    </button>
                  )}
                  {/* Одобрено, но ждёт оплаты: тот же контур, что продление */}
                  {needPay && (
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busy}
                      onClick={() =>
                        setExtendingId(extendingId === lot.listing_id ? null : lot.listing_id)
                      }
                    >
                      Оплатить размещение
                    </button>
                  )}
                  {extendable && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        setExtendingId(extendingId === lot.listing_id ? null : lot.listing_id)
                      }
                    >
                      Продлить
                    </button>
                  )}
                  {removable && (
                    <button
                      type="button"
                      className="btn btn--danger mylot__remove"
                      disabled={busy}
                      onClick={() => void removeLot(lot.listing_id)}
                    >
                      Снять
                    </button>
                  )}
                </div>
                {/* Выбор срока размещения/продления: 1 нед = 20★, 4 нед = 60★ (§2) */}
                {extendingId === lot.listing_id && (extendable || needPay) && (
                  <div className="mylot__extend" role="group" aria-label="Срок размещения">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void extendLot(lot.listing_id, 1)}
                    >
                      1 неделя · 20★
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void extendLot(lot.listing_id, 4)}
                    >
                      4 недели · 60★
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      <Link to="/sell" className="btn btn--primary btn--block mylots__add">
        ＋ Продать авто
      </Link>
    </section>
  );
}
