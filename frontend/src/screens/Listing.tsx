/**
 * Карточка объявления / PDP (UI/UX ТЗ §2.3) — по аудиту редизайна
 * (01-ux-audit-ia.md §1.3, wireframe §3.2):
 *
 * - P1: CTA-блок = один primary + вторичные [В избранное][Поделиться]
 *   [Агент(business)] + «Доставка и растаможка» текстовой ссылкой.
 *   Кнопка «Назад» удалена (системный Back + ‹ в шапке).
 * - P2: primary на экране один; апселлы (тарифы/квота) — ghost,
 *   «Анализировать» — вторичная кнопка внутри секции AI.
 * - P3: hint-строки под характеристиками убраны; пояснения — только у
 *   неочевидного (VIN, статус, оригинал/перевод) и через Tooltip.
 * - P4: статус продажи — бейдж под ценой (снятое — красным); дубли внизу
 *   страницы нет; даты отслеживания свернуты в «Детали ▾».
 * - P5: «Найти похожие» — инлайн-секция: POST /listings/{id}/similar прямо
 *   в карточке, без перехода на вкладку «Анализы».
 * - P6: история цен — график (PriceChart) + «Все изменения ▾».
 * - P7: тост о блокировке источника убран; одна hint-строка под кнопкой
 *   источника.
 * - P8: осмотр свернут до сводки «оценка · замечания · ⚠️», раскрытие —
 *   по кнопке (Inspection.tsx не меняем, сворачиваем обёрткой).
 * - P9: перевод заголовка — мелкой строкой.
 *
 * V2 (жалоба владельца: «вынеси анализ вправо, как до рефакторинга»):
 * - двухколоночный PDP на desktop ≥768px: слева контент (галерея,
 *   заголовок/цены, характеристики, отслеживание, комплектация, осмотр,
 *   история цен, похожие), справа sticky-колонка ~340–380px с
 *   AI-анализом цены и CTA-карточкой (цена+статус+кнопки);
 * - мобайл <768px — одна колонка в DOM-порядке: галерея/заголовок →
 *   анализ → CTA-кнопки → остальное (анализ остаётся сразу после цены);
 * - «Связаться с менеджером» (primary в CTA): монетизация/сведение с
 *   партнёрами, доступна всем авторизованным — POST /listings/{id}/contact,
 *   инлайн-форма с опциональным комментарием (не модалка), состояние
 *   «отправлено» живёт в localStorage autobot.contact.{listingId},
 *   409 — дубль заявки за сутки.
 *
 * 12-ai-trust §1 (F12): панель «🤖 Отчёт истории» под осмотром — кнопка
 * «Собрать отчёт истории» → GET /listings/{id}/history-report → факты
 * списком + LLM-вывод; 404 no_history_data — компактная строка; гость
 * (403) панели не видит.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Heart,
  ExternalLink,
  Layers,
  Truck,
  Share2,
  UserCheck,
  MessageCircle,
  MessagesSquare,
} from "lucide-react";

import { api } from "../api/client";
import { haptic, isGuest } from "../api/auth";
import { openExternal, shareListingCard, SOURCE_BLOCKED_HINT } from "../lib/external";
import { persistentGet, persistentSet } from "../lib/persistentState";
import { useToast } from "../ui/Toast";
import { useLoginPrompt } from "../ui/LoginPrompt";
import { SkeletonCard } from "../ui/Skeleton";
import { ErrorState } from "../ui/States";
import type {
  Listing,
  SimilarResponse,
  Subscription,
  ContactResponse,
  HistoryReportView,
} from "../api/types";
import { getRegion, priceChain, toUsd } from "../lib/fx";
import { countryLabel } from "../lib/geo";
import { createSellerChat } from "../lib/chatApi";
import { VERDICT_LABEL, deltaPct, fairPosition, type AnalysisData } from "../lib/analysis";
import { PriceChart } from "../ui/PriceChart";
import { Tooltip } from "../components/Tooltip";
import { InspectionSection } from "../components/Inspection";
import type { InspectionReport } from "../lib/inspection";
import { GRADE_LABEL } from "../lib/inspection";
import "../market.css";

/** SR-текст вердикта (03-content-a11y §5.5): цвет + слово, не только цвет. */
const VERDICT_SR: Record<AnalysisData["verdict"], string> = {
  deal: "Вердикт: выгодная цена",
  fair: "Вердикт: справедливая цена",
  overpriced: "Вердикт: выше рынка",
};

/** localStorage-ключ «заявка менеджеру по этому лоту уже отправлена». */
const contactKey = (listingId: string | undefined) => `autobot.contact.${listingId ?? ""}`;

/** Подписи фактов отчёта истории (12 §1): ключи бэка → русский label.
 *  mileage_confirmed — «Пробег подтверждён», значение да/нет. */
const HIST_FACT_LABEL: Record<string, string> = {
  accidents_count: "ДТП по страховой базе",
  last_accident: "Последнее ДТП",
  owners: "Владельцев",
  mileage_confirmed: "Пробег подтверждён",
  usage: "Использование",
  report_grade: "Оценка состояния",
  report_date: "Дата отчёта",
};

/** Значение факта для строки: mileage_confirmed → да/нет, report_date —
 *  ISO-дата в русский формат, остальное как есть (строки бэка уже русские). */
function histFactValue(key: string, value: string | number): string {
  if (key === "mileage_confirmed") {
    const raw = String(value).trim().toLowerCase();
    const no = raw === "" || raw === "0" || raw === "no" || raw === "false" || raw === "нет";
    return no ? "нет" : "да";
  }
  if (key === "report_date") {
    const t = Date.parse(String(value));
    return Number.isFinite(t) ? new Date(t).toLocaleDateString("ru") : String(value);
  }
  return String(value);
}

/** prefers-reduced-motion (§6.2.5): плавный скролл галереи отключаем. */
const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Точки-индикаторы галереи рендерим при ≤10 фото; длиннее остаётся
 *  счётчик «N / M» (простой выбор: точки-слайдер не заводим). */
const GALLERY_MAX_DOTS = 10;

export function ListingScreen() {
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [favorited, setFavorited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [quotaHit, setQuotaHit] = useState(false);
  const [inspection, setInspection] = useState<InspectionReport | null>(null);
  /** 403 на /inspection: чеки закрыты на free — показываем пейволл Pro. */
  const [inspectionLocked, setInspectionLocked] = useState(false);
  /** 404 на /inspection: чеков у источника нет (kcar) или чек лота не найден
   *  (encar) — вместо молчаливой пустоты показываем компактное пояснение. */
  const [inspectionMissing, setInspectionMissing] = useState(false);
  /** P8: осмотр по умолчанию свернут у лотов без замечаний (marks пуст),
   *  раскрыт — с замечаниями; null = пользователь ещё не переключал. */
  const [inspOpen, setInspOpen] = useState<boolean | null>(null);
  /** P4: даты отслеживания — в раскрытии «Детали ▾». */
  const [datesOpen, setDatesOpen] = useState(false);
  /** P6: полный список истории цен — в раскрытии «Все изменения ▾». */
  const [histOpen, setHistOpen] = useState(false);
  /** P5: похожие машины — инлайн, POST /listings/{id}/similar. */
  const [similar, setSimilar] = useState<SimilarResponse | null>(null);
  const [similarBusy, setSimilarBusy] = useState(false);
  /** Агент на сделку — кнопка только на тарифе с agent=true (business). */
  const [agentAvailable, setAgentAvailable] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  /** «Связаться с менеджером»: раскрытие инлайн-формы под primary. */
  const [contactOpen, setContactOpen] = useState(false);
  const [contactBusy, setContactBusy] = useState(false);
  /** «Заявка отправлена ✓» — из localStorage, переживает переоткрытие. */
  const [contactSent, setContactSent] = useState(false);
  const [contactComment, setContactComment] = useState("");
  /** «Спросить продавца» (чаты, ТЗ §7): seller-тред по лоту. */
  const [sellerBusy, setSellerBusy] = useState(false);
  /** Отчёт истории (12 §1): факты + LLM-вывод; кнопка «Собрать» в PDP. */
  const [histReport, setHistReport] = useState<HistoryReportView | null>(null);
  const [histBusy, setHistBusy] = useState(false);
  /** 404 no_history_data — компактная строка «Данных по истории нет». */
  const [histMissing, setHistMissing] = useState(false);
  /** 403 от /history-report (гость/сессия умерла) — панель скрываем. */
  const [histForbidden, setHistForbidden] = useState(false);
  const contactFormId = useId();
  const navigate = useNavigate();
  const toast = useToast();
  const loginPrompt = useLoginPrompt();

  // Фото осмотра добавляются в конец общей галереи (карточка ТЗ §2.3)
  const galleryImages = useMemo(
    () => [...(listing?.images ?? []), ...(inspection?.images ?? [])],
    [listing, inspection],
  );

  useEffect(() => {
    api<Listing>(`/listings/${id}`)
      .then((l) => {
        setListing(l);
        // История просмотров (меню v3): экран «История» слушает событие.
        window.dispatchEvent(
          new CustomEvent("listing:view", {
            detail: {
              listing_id: l.id,
              make: l.make,
              model: l.model,
              year: l.year,
              price: l.price,
              currency: l.currency,
              image: (l.images ?? [])[0] ?? null,
            },
          }),
        );
      })
      .catch((e: Error) => setError(e.message));
    api<{ favorited: boolean }>(`/favorites/${id}`)
      .then((r) => setFavorited(r.favorited))
      .catch(() => undefined); // вне Telegram — без избранного
    // Осмотр (0018): 200 — секция с картой; 403 — пейволл Pro (free);
    // 404 — чеков нет у источника (kcar) или лота (encar) — строка-пояснение;
    // 401 (гость) — секции тихо нет вообще
    api<InspectionReport>(`/listings/${id}/inspection`)
      .then(setInspection)
      .catch((e) => {
        const status = (e as { status?: number }).status;
        if (status === 403) setInspectionLocked(true);
        if (status === 404) setInspectionMissing(true);
      });
    // Кэш последнего разбора (без LLM): если есть — сразу график.
    // Гостю аналитика недоступна — не запрашиваем вовсе.
    if (!isGuest()) {
      api<AnalysisData | null>(`/listings/${id}/analysis`)
        .then((a) => a && setAnalysis(a))
        .catch(() => undefined);
    }
  }, [id]);

  // Тариф: нужна только фича agent (кнопка «Агент на сделку», business)
  useEffect(() => {
    if (isGuest()) return; // гостю агент недоступен — и кнопки не будет
    api<Subscription>("/subscription")
      .then((s) => setAgentAvailable(Boolean(s.agent)))
      .catch(() => undefined);
  }, []);

  // Заявка менеджеру уже отправлена (localStorage): переоткрытие карточки
  // не должно снова предлагать отправить заявку — сервер 409 всё равно
  // поймает дубль, но UI честнее сразу показать «отправлено»
  useEffect(() => {
    setContactSent(persistentGet(contactKey(id)) === "1");
    setContactOpen(false);
    setContactComment("");
  }, [id]);

  const runAnalysis = async () => {
    if (analyzing) return;
    if (isGuest()) {
      // Аналитика — только для авторизированных (ТЗ: гость = демо без LLM)
      loginPrompt.show(
        "AI-анализ цены доступен после входа — войдите или зарегистрируйтесь.",
      );
      return;
    }
    setAnalyzing(true);
    haptic("medium");
    try {
      const a = await api<AnalysisData>(`/listings/${id}/analysis`, {
        method: "POST",
      });
      setAnalysis(a);
      haptic("heavy");
    } catch (e) {
      if ((e as { status?: number }).status === 403) {
        setQuotaHit(true);
      } else {
        toast.show("Анализ недоступен, попробуйте позже", { error: true });
      }
    } finally {
      setAnalyzing(false);
    }
  };

  /** P5: похожие машины — инлайн в PDP (раньше уводили на вкладку «Анализы»).
   *  POST /listings/{id}/similar (LLM-реранк) уже существует. */
  const findSimilar = async () => {
    if (similarBusy) return;
    if (isGuest()) {
      loginPrompt.show("Поиск похожих доступен после входа — войдите или зарегистрируйтесь.");
      return;
    }
    setSimilarBusy(true);
    haptic("medium");
    try {
      const res = await api<SimilarResponse>(`/listings/${id}/similar`, {
        method: "POST",
      });
      setSimilar(res);
    } catch {
      toast.show("Похожие машины сейчас недоступны — попробуйте позже", { error: true });
    } finally {
      setSimilarBusy(false);
    }
  };

  /** «Отправить агента на сделку» (business): идемпотентный POST,
   *  lead создаётся на стороне партнёрского контура. Бэк расширил контракт
   *  (05 §5): {lead_id, status, thread_id} — заявка живёт в чатах,
   *  ведём юзера в созданный deal-тред сразу. */
  const sendAgent = async () => {
    if (agentBusy) return;
    setAgentBusy(true);
    haptic("medium");
    try {
      const r = await api<{ lead_id: number; status: string; thread_id: string | null }>(
        `/listings/${id}/agent`,
        {
          method: "POST",
          body: JSON.stringify({ comment: "Хочу осмотр и оформление сделки" }),
        },
      );
      toast.show("Агент свяжется с вами");
      if (r?.thread_id) navigate(`/chats/${r.thread_id}`);
    } catch {
      toast.show("Не удалось отправить агента — попробуйте ещё раз", { error: true });
    } finally {
      setAgentBusy(false);
    }
  };

  /** Раскрытие мини-формы заявки «Связаться с менеджером» (не модалка —
   *  инлайн под кнопкой в правой колонке). Гостю — логин-промпт:
   *  механика доступна всем авторизованным (403-контур на сервере). */
  const toggleContactForm = () => {
    if (isGuest()) {
      loginPrompt.show(
        "Связь с менеджером доступна после входа — войдите или зарегистрируйтесь.",
      );
      return;
    }
    haptic("medium");
    setContactOpen((v) => !v);
  };

  /** POST /listings/{id}/contact {comment|null} → {lead_id, status}: лид
   *  партнёру (монетизация/сведение). 201 — тост + «Заявка отправлена ✓»
   *  (disabled, localStorage); 409 — дубль за сутки; 403 — гостевой гейт.
   *  Пустая textarea → comment:null: дефолтную формулировку подставляет
   *  бэкенд (RequestContact) — не дублируем её на клиенте. */
  const sendContact = async () => {
    if (contactBusy || contactSent) return;
    setContactBusy(true);
    haptic("medium");
    try {
      await api<ContactResponse>(`/listings/${id}/contact`, {
        method: "POST",
        body: JSON.stringify({ comment: contactComment.trim() || null }),
      });
      persistentSet(contactKey(id), "1");
      setContactSent(true);
      setContactOpen(false);
      toast.show("✅ Менеджер свяжется с вами");
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403) {
        // сессия умерла между рендером и кликом — тот же гостевой гейт
        loginPrompt.show(
          "Связь с менеджером доступна после входа — войдите или зарегистрируйтесь.",
        );
      } else if (status === 409) {
        setContactOpen(false);
        toast.show("Вы уже оставляли заявку по этой машине сегодня");
      } else {
        toast.show("Не удалось отправить заявку — попробуйте позже", { error: true });
      }
    } finally {
      setContactBusy(false);
    }
  };

  /** «Спросить продавца» (чаты, 05-chats-marketplace §7): создать/reuse
   *  seller-тред (POST /api/chats/seller/{id}) и открыть экран чата.
   *  Гостю — логин-промпт: переписка должна жить под аккаунтом. */
  const askSeller = async () => {
    if (sellerBusy) return;
    if (isGuest()) {
      loginPrompt.show("Чат с продавцом доступен после входа — войдите или зарегистрируйтесь.");
      return;
    }
    setSellerBusy(true);
    haptic("medium");
    try {
      const threadId = await createSellerChat(id!);
      navigate(`/chats/${threadId}`);
    } catch {
      toast.show("Не удалось открыть чат с продавцом — попробуйте позже", { error: true });
    } finally {
      setSellerBusy(false);
    }
  };

  const toggleFavorite = async () => {
    haptic("medium");
    try {
      const r = await api<{ favorited: boolean }>(`/listings/${id}/favorite`, {
        method: "POST",
      });
      setFavorited(r.favorited);
      toast.show(r.favorited ? "❤️ Добавлено в избранное" : "Убрано из избранного");
    } catch {
      toast.show("Не удалось изменить избранное", { error: true });
    }
  };

  /** «🤖 Отчёт истории» (12 §1): GET /listings/{id}/history-report —
   *  факты списком + LLM-вывод; 404 no_history_data — компактная строка;
   *  403 (гость) — панель пропадает совсем. */
  const runHistoryReport = async () => {
    if (histBusy) return;
    setHistBusy(true);
    haptic("medium");
    try {
      const r = await api<HistoryReportView>(`/listings/${id}/history-report`);
      setHistReport(r);
      setHistMissing(false);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) {
        setHistMissing(true);
      } else if (status === 403) {
        setHistForbidden(true);
      } else {
        toast.show("Отчёт истории сейчас недоступен — попробуйте позже", { error: true });
      }
    } finally {
      setHistBusy(false);
    }
  };

  /** P7: клик по «Открыть у источника» — без тоста-предупреждения на каждый
   *  клик; единственное место с подсказкой — hint-строка под кнопкой. */
  const openSource = () => {
    haptic();
    openExternal(listing?.url ?? "");
  };

  if (error) {
    return <ErrorState description={error} onRetry={() => navigate(-1)} />;
  }
  if (!listing) {
    return (
      <div style={{ padding: 12 }}>
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  const title = `${listing.make ?? ""} ${listing.model ?? ""}`.trim();
  // KRW/EUR → USD по фикс-курсу MVP (как в боте), иначе в калькулятор уйдут воны
  const usd = toUsd(listing.price, listing.currency);
  const chain = priceChain(listing.price, listing.currency, getRegion());

  /** «Поделиться»: нативный диалог Telegram (t.me/share/url) или шторка
   *  браузера; фолбэк — копирование ссылки + тост «Ссылка скопировано»
   *  (lib/external: inline mode у бота выключен, switchInlineQuery не годится). */
  const shareCurrent = () => {
    haptic();
    void shareListingCard({
      id: listing.id,
      make: listing.make,
      model: listing.model,
      year: listing.year,
      price: listing.price,
      currency: listing.currency,
    }).then((shared) => {
      // true — нативный диалог открыт, тост не нужен; false — скопировали в буфер
      if (!shared) toast.show("✅ Ссылка скопирована");
    });
  };

  // Характеристики: только заполненные (P3 — без hint-строк в потоке,
  // пояснение через Tooltip осталось только у VIN)
  const specs: { label: string; value: string }[] = [
    listing.body_type && { label: "Кузов", value: listing.body_type },
    listing.year && { label: "Год выпуска", value: String(listing.year) },
    // Гео лота (GEO-V1 §3): «🇦🇪 ОАЭ» / «🇷🇺 Россия, Москва»
    listing.country && {
      label: "Страна",
      value: listing.city
        ? `${countryLabel(listing.country)}, ${listing.city}`
        : countryLabel(listing.country),
    },
    listing.engine_volume != null && {
      label: "Двигатель",
      value: `${listing.engine_volume} л`,
    },
    listing.fuel && { label: "Топливо", value: listing.fuel },
    listing.transmission && { label: "КПП", value: listing.transmission },
    listing.drive && { label: "Привод", value: listing.drive },
    listing.mileage_km != null && {
      label: "Пробег",
      value: `${listing.mileage_km.toLocaleString("ru")} км`,
    },
    listing.color && { label: "Цвет", value: listing.color },
  ].filter((s): s is { label: string; value: string } => Boolean(s));

  const fmtDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString("ru") : null;
  const seenFirst = fmtDate(listing.first_seen_at);
  const seenLast = fmtDate(listing.last_seen_at);
  const updatedAt = fmtDate(listing.updated_at);
  const priceChanged = fmtDate(listing.price_changed_at);

  // P8: сводка осмотра для заголовка секции — «оценка · N замечаний · M ⚠️»
  const inspWarnCount = inspection
    ? inspection.items.filter((i) => i.status === "warn" || i.status === "defect").length
    : 0;
  const inspOpenEffective = inspOpen ?? (inspection ? inspection.marks.length > 0 : false);
  const inspInspected = inspection?.inspected_at
    ? new Date(inspection.inspected_at).toLocaleDateString("ru")
    : null;

  const active = listing.is_active !== false;

  return (
    <div className="listing-page">
      {/* Назад — всегда под рукой, поверх галереи (не только внизу страницы) */}
      <button className="listing-back" aria-label="Назад" onClick={() => navigate(-1)}>
        ‹
      </button>

      {/* ЛЕВАЯ колонка (≥768px), начало: галерея + «что это и почём».
          На мобиле — первые экраны, дальше сразу анализ и кнопки (side). */}
      <div className="listing-page__main">
        {/* Галерея: свайп + счётчик + фуллскрин по клику (ТЗ §2.3).
            Фото осмотра (чек) — в конце галереи, отдельный блок не нужен */}
        {galleryImages.length > 0 ? (
          <Gallery images={galleryImages} alt={title} />
        ) : (
          <div className="state">
            <div className="state__emoji">📷</div>
            <div className="state__text">Фото не загружены</div>
          </div>
        )}

        {/* Заголовок + цена + статус: первый экран отвечает «что это и почём» */}
        <section className="panel spec-card">
          <h3>{title || "Объявление"}</h3>
          {/* P9: перевод — мелкой строкой под заголовком, а не отдельной
              секцией; пояснение про авто-перевод — в Tooltip */}
          {listing.title_ru && listing.title_raw &&
            listing.title_ru !== listing.title_raw && (
            <div className="pdp-orig">
              <span lang={listing.source_language ?? "ko"}>{listing.title_raw}</span>
              <span className="pdp-orig__note">
                {" оригинал · "}
                <Tooltip text="авто-перевод (NLLB), язык источника">
                  <span className="pdp-qmark" aria-hidden="true">
                    ?
                  </span>
                </Tooltip>
              </span>
            </div>
          )}
          <div className="spec-card__price">
            {chain.usd
              ? `${chain.usd}${chain.local ? ` · ${chain.local}` : ""}`
              : chain.original ?? "—"}
          </div>
          {chain.original && (
            <div className="info-row">
              <span className="info-row__label">Цена у источника</span>
              <span className="info-row__value">{chain.original}</span>
            </div>
          )}
          {usd != null && (listing.currency ?? "").toUpperCase() !== "USD" && (
            <div className="info-row">
              <span className="info-row__label">По курсу (оценка)</span>
              <span className="info-row__value">≈ {usd.toLocaleString("ru")} $</span>
            </div>
          )}
          {/* P4: единственный бейдж статуса — сразу под ценой */}
          <div className={active ? "pdp-status pdp-status--active" : "pdp-status pdp-status--gone"}>
            {active ? "В продаже" : "Снято с продажи"}
            <Tooltip text="проверяем источник по расписанию">
              <span className="pdp-qmark" aria-hidden="true">
                ?
              </span>
            </Tooltip>
          </div>
          {/* Рынок владельцев (06 §4): бейдж продавца под статусом —
              внешний лот (encar/kcar) владельца не имеет */}
          {listing.owner_type && (
            <div className="pdp-owner-type">
              {listing.owner_type === "partner" ? "🏪 Салон" : "👤 Частник"}
            </div>
          )}
        </section>

        {/* «От владельца» (06 §6): описание продавца — панель сразу после
            цены/статуса; рисуем только если владелец его заполнил */}
        {listing.owner_description && (
          <section className="panel pdp-owner-note" aria-label="От владельца">
            <h3>
              От владельца
              {listing.owner_type === "partner" ? " (салон)" : listing.owner_type === "user" ? " (частник)" : ""}
            </h3>
            <p className="pdp-owner-note__text">{listing.owner_description}</p>
          </section>
        )}

        {/* История машины (07 §3): партнёрский таймлайн «как в Корее» —
            события [{date, title, note?}] свежие первыми; блок только
            когда события есть (пустые не рисуем) */}
        {(listing.owner_history?.length ?? 0) > 0 && (
          <section className="panel pdp-owner-history" aria-label="История машины">
            <h3>История машины</h3>
            <ol className="pdp-owner-history__list">
              {listing.owner_history!.map((event, i) => (
                <li key={`${event.date}-${i}`} className="pdp-owner-history__item">
                  <span className="pdp-owner-history__date">{event.date}</span>
                  <span className="pdp-owner-history__title">{event.title}</span>
                  {event.note && (
                    <span className="pdp-owner-history__note">{event.note}</span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      {/* ПРАВАЯ колонка (≥768px, sticky): AI-анализ цены + CTA-карточка.
          На мобиле (<768px) — одна колонка: этот блок встаёт сразу под
          заголовок/цену (анализ → кнопки → остальное), как до рефакторинга */}
      <aside className="listing-page__side">
        {/* AI-разбор цены — вердикт, главный дифференциатор продукта */}
        <section className="panel pdp-side-analysis">
          <h3>
            <span aria-hidden="true">🤖</span> AI-анализ цены
          </h3>
          {analyzing ? (
            <div className="analysis">
              <div className="analysis__loading">
                <span className="analysis__spinner" />
                Сравниваю с рынком…
                <div className="analysis__loading-sub">
                  сопоставимые объявления, история цены, вердикт — до минуты
                </div>
              </div>
              <div className="skeleton" style={{ height: 64, borderRadius: 12 }} />
              <div className="skeleton" style={{ height: 96, borderRadius: 12 }} />
            </div>
          ) : analysis ? (
            <div className="analysis">
              <div className="analysis__head">
                {/* Верликт-бейдж по токенам --deal/--warn/--danger (§2.3) */}
                <div
                  className={`pdp-verdict pdp-verdict--${analysis.verdict}`}
                  aria-label={VERDICT_SR[analysis.verdict]}
                >
                  <span aria-hidden="true">{VERDICT_LABEL[analysis.verdict].emoji}</span>{" "}
                  {VERDICT_LABEL[analysis.verdict].text}
                </div>
                {deltaPct(analysis) != null && (
                  <span
                    className={`analysis__pill analysis__pill--${
                      deltaPct(analysis)! <= 0 ? "good" : "bad"
                    }`}
                  >
                    {deltaPct(analysis)! > 0 ? "▲" : "▼"} {deltaPct(analysis)}%
                  </span>
                )}
              </div>
              {analysis.fair_min != null && analysis.fair_max != null && (
                <div className="analysis__range">
                  <div className="analysis__range-label">
                    Справедливый диапазон:{" "}
                    <b>
                      {Math.round(analysis.fair_min).toLocaleString("ru-RU")}–
                      {Math.round(analysis.fair_max).toLocaleString("ru-RU")}{" "}
                      {analysis.currency}
                    </b>
                  </div>
                  {fairPosition(analysis) != null && (
                    <div className="analysis__bar">
                      <div
                        className="analysis__bar-marker"
                        style={{ left: `${fairPosition(analysis)}%` }}
                      />
                    </div>
                  )}
                </div>
              )}
              {analysis.history.length > 1 ? (
                <PriceChart history={analysis.history} comps={analysis.comps} />
              ) : (
                <div className="analysis__hint">
                  📈 Истории цены пока мало — график появится, когда начнём
                  отслеживать объявление.
                </div>
              )}
              {analysis.summary && (
                <div className="analysis__summary">💬 {analysis.summary}</div>
              )}
              {analysis.factors.length > 0 && (
                <ul className="analysis__factors">
                  {analysis.factors.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
              {analysis.comps && (
                <div className="analysis__market">
                  Рынок: {analysis.comps.count} сопоставимых · медиана{" "}
                  {analysis.comps.median.toLocaleString("ru-RU")} {analysis.currency}
                </div>
              )}
              <div className="analysis__meta">
                {analysis.created_at &&
                  `разбор от ${new Date(analysis.created_at).toLocaleDateString("ru")}`}
                {" · "}
                {analysis.source === "ai" ? "нейросеть" : "статистика рынка"}
                <button className="analysis__retry" onClick={() => void runAnalysis()}>
                  🔄 Пересчитать
                </button>
              </div>
            </div>
          ) : quotaHit ? (
            <div className="analysis analysis--locked">
              🔒 Бесплатный разбор этой недели уже использован — новый доступен
              через несколько дней.
              {/* P2: апселл — не primary, тихая кнопка с замочком */}
              <button
                className="btn btn--block"
                style={{ marginTop: 10 }}
                onClick={() => {
                  haptic();
                  navigate("/profile");
                }}
              >
                ⚡ Безлимит в Pro
              </button>
            </div>
          ) : (
            <div className="analysis">
              <div className="analysis__hint">
                {isGuest()
                  ? "🔒 Нейросеть сравнит цену с рынком: сопоставимые объявления, история цены, вердикт. Доступно после входа."
                  : "Нейросеть сравнит цену с рынком: сопоставимые объявления, история цены, вердикт и факторы."}
              </div>
              {/* P2: акцентная secondary внутри секции AI, не primary */}
              <button
                className="btn btn--block"
                style={{ marginTop: 10 }}
                onClick={() => void runAnalysis()}
              >
                {isGuest()
                  ? "🤖 Анализировать — по входу"
                  : "🤖 Анализировать (1 бесплатно в неделю)"}
              </button>
            </div>
          )}
        </section>

        {/* CTA-карточка: цена + статус + действия. Primary — «Связаться
            с менеджером» (доступен всем авторизованным), «Открыть у
            источника» — secondary + hint про гео-блок (P1/P7). Дублей CTA
            в левой колонке нет: одни кнопки — одно место. */}
        <section className="panel pdp-cta">
          <div className="pdp-cta__price">{chain.usd ?? chain.original ?? "—"}</div>
          <div className={active ? "pdp-status pdp-status--active" : "pdp-status pdp-status--gone"}>
            {active ? "В продаже" : "Снято с продажи"}
            <Tooltip text="проверяем источник по расписанию">
              <span className="pdp-qmark" aria-hidden="true">
                ?
              </span>
            </Tooltip>
          </div>

          {contactSent ? (
            /* 201 уже был: кнопка-статус, disabled, состояние из localStorage */
            <button className="btn btn--primary btn--block" disabled>
              Заявка отправлена ✓
            </button>
          ) : (
            <>
              <button
                className="btn btn--primary btn--block"
                aria-expanded={contactOpen}
                aria-controls={contactFormId}
                onClick={toggleContactForm}
              >
                <MessageCircle size={18} aria-hidden="true" />
                Связаться с менеджером
              </button>
              {/* Мини-форма заявки (не модалка): опциональный комментарий
                  + «Отправить заявку», инлайн под кнопкой в правой колонке */}
              {contactOpen && (
                <div className="pdp-contact" id={contactFormId}>
                  <textarea
                    className="pdp-contact__input"
                    aria-label="Комментарий менеджеру (необязательно)"
                    placeholder="Комментарий (необязательно): вопросы, сроки, обмен…"
                    rows={2}
                    maxLength={500}
                    value={contactComment}
                    onChange={(e) => setContactComment(e.target.value)}
                  />
                  <button
                    className="btn btn--primary btn--block"
                    disabled={contactBusy}
                    onClick={() => void sendContact()}
                  >
                    {contactBusy ? "Отправляем…" : "Отправить заявку"}
                  </button>
                  <div className="pdp-contact__hint">
                    Менеджер партнёра проверит авто и свяжется с вами
                  </div>
                </div>
              )}
            </>
          )}

          {/* Спросить продавца (чаты, 05 §7 + 06 §4): ТОЛЬКО лоты рынка
              (owner_type) — по внешним лотам продавца нет, кнопки не будет;
              салон — «Спросить продавца», частник — «Спросить владельца» */}
          {listing.owner_type && (
            <button
              className="btn btn--block"
              disabled={sellerBusy}
              onClick={() => void askSeller()}
            >
              <MessagesSquare size={18} aria-hidden="true" />
              {sellerBusy
                ? "Открываем чат…"
                : listing.owner_type === "user"
                  ? "Спросить владельца"
                  : "Спросить продавца"}
            </button>
          )}

          <button className="btn btn--block" onClick={openSource}>
            <ExternalLink size={18} aria-hidden="true" />
            Открыть у источника
          </button>
          {/* P7: единственная подсказка о гео-блоке — до клика, не тостом */}
          <div className="cta-hint">{SOURCE_BLOCKED_HINT}</div>
          <div className="pdp-cta__row">
            <button
              className="btn pdp-cta__btn"
              onClick={() => void toggleFavorite()}
              aria-pressed={favorited}
            >
              <Heart
                size={18}
                fill={favorited ? "var(--accent)" : "none"}
                color={favorited ? "var(--accent)" : undefined}
                aria-hidden="true"
              />
              {favorited ? "В избранном" : "В избранное"}
            </button>
            <button className="btn pdp-cta__btn" onClick={shareCurrent}>
              <Share2 size={18} aria-hidden="true" />
              Поделиться
            </button>
          </div>
          {/* Агент на сделку — только бизнес-тариф (sub.agent) */}
          {agentAvailable && (
            <button
              className="btn btn--block"
              disabled={agentBusy}
              onClick={() => void sendAgent()}
            >
              <UserCheck size={18} aria-hidden="true" />
              {agentBusy ? "Отправляем…" : "Агент на сделку"}
            </button>
          )}
          {/* Калькулятор доставки — обычная ссылка-строка, не кнопка (P1);
              прокидываем страну лота (UX-003, UIUX-GEO §4/§7): калькулятор
              подставит её в сегмент и посчитает доставку именно от неё */}
          <button
            className="pdp-cta__link"
            onClick={() => {
              haptic();
              navigate(
                `/calc?${usd != null ? `price=${usd}&` : ""}year=${listing.year ?? ""}&cur=${encodeURIComponent(listing.currency ?? "")}&country=${encodeURIComponent(listing.country ?? "")}`,
              );
            }}
          >
            <Truck size={16} aria-hidden="true" />
            Доставка и растаможка →
          </button>
        </section>
      </aside>

      {/* ЛЕВАЯ колонка, продолжение: характеристики → отслеживание →
          комплектация → осмотр → история цен → похожие (DOM-порядок =
          порядок мобайла; на десктопе всё это — под галереей/заголовком) */}
      <div className="listing-page__rest">
        {/* Характеристики: без hint-строк (P3), пояснение — Tooltip у VIN */}
        {specs.length > 0 && (
          <section className="panel">
            <h3>Характеристики</h3>
            {specs.map((s) => (
              /* mobile ux: info-row--spec — на узких экранах подпись
                 сверху, значение ниже (блок Mobile UX в index.css) */
              <div className="info-row info-row--spec" key={s.label}>
                <span className="info-row__label">{s.label}</span>
                <span className="info-row__value">{s.value}</span>
              </div>
            ))}
            {listing.vin && (
              <div className="info-row">
                <span className="info-row__label">
                  VIN{" "}
                  <Tooltip text="идентификационный номер — по нему проверяют историю">
                    <span className="pdp-qmark" aria-hidden="true">
                      ?
                    </span>
                  </Tooltip>
                </span>
                <span className="info-row__value pdp-mono">{listing.vin}</span>
              </div>
            )}
          </section>
        )}

        {/* Данные объявления: источник всегда на виду; даты — «Детали ▾» (P4) */}
        <section className="panel">
          <h3>Данные объявления</h3>
          <div className="info-row">
            <span className="info-row__label">Источник</span>
            <span className="info-row__value">
              {listing.source} · ID {listing.source_id}
            </span>
          </div>
          <button
            className="pdp-disc"
            aria-expanded={datesOpen}
            onClick={() => setDatesOpen((v) => !v)}
          >
            Детали отслеживания {datesOpen ? "▴" : "▾"}
          </button>
          {datesOpen && (
            <div>
              {seenFirst && (
                <div className="info-row">
                  <span className="info-row__label">В базе с</span>
                  <span className="info-row__value">{seenFirst}</span>
                </div>
              )}
              {updatedAt && updatedAt !== seenFirst && (
                <div className="info-row">
                  <span className="info-row__label">Обновлено источником</span>
                  <span className="info-row__value">{updatedAt}</span>
                </div>
              )}
              {priceChanged && (
                <div className="info-row">
                  <span className="info-row__label">Цена менялась</span>
                  <span className="info-row__value">{priceChanged}</span>
                </div>
              )}
              {seenLast && (
                <div className="info-row">
                  <span className="info-row__label">Последняя проверка</span>
                  <span className="info-row__value">{seenLast}</span>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Комплектация (миграция 0023) */}
        {listing.options && listing.options.length > 0 && (
          <section className="panel">
            <h3>
              <span aria-hidden="true">🧰</span> Комплектация
            </h3>
            <div className="options-chips">
              {listing.options.map((o) => (
                <span className="options-chips__item" key={o}>
                  {o}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Осмотр (0018/0022): P8 — сводка в заголовке + раскрытие.
            Inspection.tsx не трогаем — сворачиваем обёрткой в Listing. */}
        {inspection && (
          <section className="panel">
            <div className="pdp-insp-head">
              <h3>
                <span aria-hidden="true">🔍</span> Осмотр
                <span className="pdp-insp-summary">
                  {inspection.grade && GRADE_LABEL[inspection.grade]}
                  {` · ${inspection.marks.length} замечаний`}
                  {inspWarnCount > 0 && ` · ${inspWarnCount} ⚠️`}
                  {inspInspected && ` · осмотр ${inspInspected}`}
                  {` · данные ${inspection.source}`}
                </span>
              </h3>
              <button
                className="pdp-disc"
                aria-expanded={inspOpenEffective}
                onClick={() => setInspOpen(!inspOpenEffective)}
              >
                {inspOpenEffective ? "Скрыть" : "Раскрыть"}
              </button>
            </div>
            {inspOpenEffective && <InspectionSection report={inspection} />}
          </section>
        )}

        {/* Чеки осмотра закрыты на free (403 от /inspection): пейволл Pro.
            Гостю (401) секции нет вообще — пейволл не показываем */}
        {!inspection && inspectionLocked && (
          <section className="panel">
            <h3>
              <span aria-hidden="true">🔍</span> Осмотр
            </h3>
            <div className="state">
              <div className="state__emoji">🔒</div>
              <div className="state__title">Чеки осмотра — на Pro</div>
              <div className="state__text">
                Карта повреждений кузова, чек-лист агрегатов и фото с осмотра
                доступны на тарифах Pro и Business.
              </div>
              {/* P2: апселл — ghost-кнопка, primary на экране один */}
              <button
                className="btn"
                onClick={() => {
                  haptic();
                  navigate("/profile");
                }}
              >
                Смотреть тарифы
              </button>
            </div>
          </section>
        )}

        {/* 404 от /inspection: пользователь должен понимать, почему карты нет,
            а не видеть пустоту. kcar чеков не выдаёт вовсе; у части лотов encar
            чек просто не найден */}
        {!inspection && !inspectionLocked && inspectionMissing && (
          <div className="insp-missing">
            🧾 Чек осмотра:{" "}
            {listing.source === "encar"
              ? "чек для этого лота не найден"
              : `у этого источника (${listing.source}) чеков нет`}
          </div>
        )}

        {/* 🤖 Отчёт истории (12-ai-trust §1): панель сразу после осмотра.
            Гостю (403 на сервере / гостевой режим) панели нет вовсе. */}
        {!isGuest() && !histForbidden && (
          <section className="panel hist-report" aria-label="Отчёт истории">
            <h3>
              <span aria-hidden="true">🤖</span> Отчёт истории
            </h3>
            {histBusy ? (
              <div className="hist-report__loading">
                <span className="analysis__spinner" aria-hidden="true" />
                Собираем факты: страховые базы, владельцы, пробег…
              </div>
            ) : histReport ? (
              <>
                <ul className="hist-report__facts">
                  {Object.entries(histReport.facts).map(([key, value]) => (
                    <li className="hist-report__fact" key={key}>
                      <span className="hist-report__fact-label">
                        {HIST_FACT_LABEL[key] ?? key.replace(/_/g, " ")}
                      </span>
                      <span className="hist-report__fact-value">
                        {histFactValue(key, value)}
                      </span>
                    </li>
                  ))}
                </ul>
                {histReport.llm_summary && (
                  <div className="hist-report__summary">
                    <div className="hist-report__summary-title">Вывод</div>
                    <p className="hist-report__summary-text">{histReport.llm_summary}</p>
                  </div>
                )}
                <div className="hist-report__meta">
                  {histReport.generated_at &&
                    `отчёт от ${new Date(histReport.generated_at).toLocaleDateString("ru")}`}
                  <button
                    className="hist-report__retry"
                    onClick={() => void runHistoryReport()}
                  >
                    🔄 Обновить
                  </button>
                </div>
              </>
            ) : histMissing ? (
              <div className="hist-report__missing">Данных по истории нет</div>
            ) : (
              <>
                <div className="hist-report__hint">
                  ДТП по страховой базе, число владельцев, подтверждение пробега —
                  соберём в один отчёт и добавим вывод, стоит ли смотреть машину.
                </div>
                <button
                  className="btn btn--block"
                  disabled={histBusy}
                  onClick={() => void runHistoryReport()}
                >
                  Собрать отчёт истории
                </button>
              </>
            )}
          </section>
        )}

        {/* История цен (фаза 4): P6 — график (PriceChart) как основная форма,
            полный список точек — в раскрытии «Все изменения ▾» */}
        {listing.price_history && listing.price_history.length > 1 && (
          <section className="panel">
            <h3>История цен</h3>
            <PriceChart history={listing.price_history} comps={null} />
            <button
              className="pdp-disc"
              aria-expanded={histOpen}
              onClick={() => setHistOpen((v) => !v)}
            >
              Все изменения {histOpen ? "▴" : "▾"}
            </button>
            {histOpen &&
              [...listing.price_history].reverse().map((p, i) => (
                <div className="info-row" key={`${p.recorded_at}-${i}`}>
                  <span className="info-row__label">
                    {new Date(p.recorded_at).toLocaleDateString("ru")}
                    {i === 0 ? " · текущая" : ""}
                  </span>
                  <span className="info-row__value">
                    <b>
                      {p.price.toLocaleString("ru")} {p.currency ?? ""}
                    </b>
                  </span>
                </div>
              ))}
          </section>
        )}

        {/* P5: похожие машины — инлайн-секция в ЛЕВОЙ (контентной) колонке,
            без перехода в «Анализы»; результаты реранка — те же, что были
            внутри AI-блока до выноса анализа в правую колонку */}
        <section className="panel">
          <h3>
            Похожие машины
            {similar && (
              <span className="pdp-similar__src similar-source">
                {similar.source === "ai" ? "🤖 нейросеть" : "📊 статистика"}
              </span>
            )}
          </h3>
          {similar ? (
            <>
              {similar.items.length === 0 ? (
                <div className="pdp-similar__empty">
                  Похожих машин не нашлось — база пополняется каждый день,
                  попробуйте позже.
                </div>
              ) : (
                <div className="similar-list">
                  {similar.items.map((s) => {
                    const sp = priceChain(s.price, s.currency, getRegion());
                    return (
                      <article
                        key={s.id}
                        className="similar-item"
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(`/listing/${s.id}`)}
                        onKeyDown={(e) => e.key === "Enter" && navigate(`/listing/${s.id}`)}
                      >
                        {s.image ? (
                          <img className="similar-item__img" src={s.image} alt="" loading="lazy" />
                        ) : (
                          <div className="similar-item__img similar-item__img--empty">🚗</div>
                        )}
                        <div className="similar-item__body">
                          <div className="similar-item__title">
                            {`${s.make ?? ""} ${s.model ?? ""}`.trim() || "Объявление"}
                            {s.year ? `, ${s.year}` : ""}
                          </div>
                          <div className="similar-item__meta">
                            {sp.usd ?? sp.original ?? "—"}
                            {s.mileage_km != null &&
                              ` · ${s.mileage_km.toLocaleString("ru")} км`}
                          </div>
                          {s.reason && (
                            <div className="similar-item__reason">💬 {s.reason}</div>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              <button className="btn" onClick={() => setSimilar(null)}>
                Скрыть результаты
              </button>
            </>
          ) : (
            <button
              className="btn btn--block"
              disabled={similarBusy}
              onClick={() => void findSimilar()}
            >
              <Layers size={18} aria-hidden="true" />
              {similarBusy ? "Ищем…" : "Найти похожие"}
            </button>
          )}
        </section>
      </div>

      {/* Sticky-CTA на мобиле (UX-004): primary — то же действие экрана,
          что в CTA-карточке («Связаться» / статус «Отправлено ✓» после
          заявки); «Открыть у источника» — secondary-текстовая ссылка второй
          строкой (один primary на экране). Избранное/«Поделиться» — под
          пальцем, как раньше. */}
      <div className="listing-cta-bar">
        <button
          className="listing-cta-bar__fav"
          aria-label={favorited ? "Убрать из избранного" : "В избранное"}
          aria-pressed={favorited}
          onClick={() => void toggleFavorite()}
        >
          <Heart
            size={22}
            fill={favorited ? "var(--accent)" : "none"}
            color={favorited ? "var(--accent)" : "currentColor"}
            aria-hidden="true"
          />
        </button>
        <button className="listing-cta-bar__fav" aria-label="Поделиться" onClick={shareCurrent}>
          <Share2 size={22} aria-hidden="true" />
        </button>
        <div className="listing-cta-bar__price">{chain.usd ?? chain.original ?? "—"}</div>
        <button
          type="button"
          className="listing-cta-bar__btn"
          disabled={contactSent}
          onClick={toggleContactForm}
        >
          {contactSent ? "Отправлено ✓" : "Связаться"}
        </button>
        <button type="button" className="listing-cta-bar__src" onClick={openSource}>
          Открыть у источника ↗
        </button>
      </div>
    </div>
  );
}

function Gallery({ images, alt }: { images: string[]; alt: string }) {
  const [idx, setIdx] = useState(0);
  const [full, setFull] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbsRef = useRef<HTMLDivElement | null>(null);

  /** Точки синхронны и с треком, и с превью, и с лайтбоксом: открытый
   *  лайтбокс главнее — его фото подсвечивается и в точках, и в превью. */
  const active = full ?? idx;

  /** Прокрутка большого фото к слайду i (auto при reduced-motion). */
  const goToSlide = useCallback((i: number) => {
    const t = trackRef.current;
    setIdx(i);
    if (!t) return;
    const left = i * t.clientWidth;
    const behavior: ScrollBehavior = reducedMotion() ? "auto" : "smooth";
    if (typeof t.scrollTo === "function") t.scrollTo({ left, behavior });
    else t.scrollLeft = left; // старые WebView / jsdom без element.scrollTo
  }, []);

  const show = useCallback(
    (i: number) => {
      haptic("light");
      const n = ((i % images.length) + images.length) % images.length;
      setFull(n);
      // лайтбокс и галерея под ним — на одном фото: закрыл и не «прыгнул»
      goToSlide(n);
    },
    [images.length, goToSlide],
  );

  // Лайтбокс: Esc/стрелки с клавиатуры (ПК), блокировка скролла фона
  useEffect(() => {
    if (full == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(null);
      if (e.key === "ArrowRight") show((full ?? 0) + 1);
      if (e.key === "ArrowLeft") show((full ?? 0) - 1);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [full, show]);

  const thumbs = images.slice(0, 6);
  const rest = images.length - thumbs.length;

  // Активная миниатюра — в центр видимой части ленты превью (snap-скролл).
  // Фото дальше шестого превью не имеет — тогда подсвечиваем «+N».
  useEffect(() => {
    const strip = thumbsRef.current;
    if (!strip) return;
    const t =
      strip.querySelector<HTMLElement>(`.gallery__thumb[data-i="${idx}"]`) ??
      (idx >= thumbs.length
        ? (strip.querySelector<HTMLElement>(".gallery__thumb--more") ?? null)
        : null);
    if (t && typeof t.scrollIntoView === "function") {
      t.scrollIntoView({
        block: "nearest",
        inline: "center",
        behavior: reducedMotion() ? "auto" : "smooth",
      });
    }
  }, [idx, thumbs.length]);

  return (
    <div className="gallery">
      <div
        ref={trackRef}
        className="gallery__track"
        onScroll={(e) => {
          const el = e.currentTarget;
          const w = el.clientWidth || 1;
          const i = Math.min(Math.max(Math.round(el.scrollLeft / w), 0), images.length - 1);
          setIdx(i);
        }}
      >
        {images.map((src, i) => (
          <img
            key={i}
            className="gallery__slide"
            src={src}
            alt={`${alt} — фото ${i + 1}`}
            loading="lazy"
            onClick={() => show(i)}
          />
        ))}
      </div>
      <button
        className="gallery__expand"
        onClick={() => show(idx)}
        aria-label="Открыть фото на весь экран"
      >
        ⤢
      </button>
      <span className="gallery__counter">
        {idx + 1} / {images.length}
      </span>
      {/* Точки-индикаторы под большим фото: ≤10 фото, активная синхронна
          с треком/превью/лайтбоксом; длиннее — только счётчик выше */}
      {images.length > 1 && images.length <= GALLERY_MAX_DOTS && (
        <div className="pdp-dots">
          {images.map((_, i) => (
            <button
              key={i}
              type="button"
              className={
                i === active ? "pdp-dots__dot pdp-dots__dot--active" : "pdp-dots__dot"
              }
              aria-label={`Фото ${i + 1}`}
              aria-current={i === active ? "true" : undefined}
              onClick={() => (full != null ? show(i) : goToSlide(i))}
            />
          ))}
        </div>
      )}
      {images.length > 1 && (
        <div className="gallery__thumbs" ref={thumbsRef}>
          {thumbs.map((src, i) => (
            <img
              key={i}
              data-i={i}
              className={i === idx ? "gallery__thumb gallery__thumb--active" : "gallery__thumb"}
              src={src}
              alt=""
              loading="lazy"
              onClick={() => goToSlide(i)}
            />
          ))}
          {rest > 0 && (
            <span
              className={
                idx >= thumbs.length
                  ? "gallery__thumb gallery__thumb--more gallery__thumb--active"
                  : "gallery__thumb gallery__thumb--more"
              }
            >
              +{rest}
            </span>
          )}
        </div>
      )}

      {/* Фуллскрин-просмотр: тёмный фон, «contain» без обрезки, клик мимо — закрыть */}
      {full != null && (
        <div className="lightbox" onClick={() => setFull(null)} role="dialog" aria-modal="true">
          <img
            className="lightbox__img"
            src={images[full]}
            alt={`${alt} — фото ${full + 1}`}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="lightbox__nav lightbox__nav--prev"
            aria-label="Предыдущее фото"
            onClick={(e) => {
              e.stopPropagation();
              show((full ?? 0) - 1);
            }}
          >
            ‹
          </button>
          <button
            className="lightbox__nav lightbox__nav--next"
            aria-label="Следующее фото"
            onClick={(e) => {
              e.stopPropagation();
              show((full ?? 0) + 1);
            }}
          >
            ›
          </button>
          <span className="lightbox__counter" onClick={(e) => e.stopPropagation()}>
            {full + 1} / {images.length}
          </span>
          <button
            className="lightbox__close"
            aria-label="Закрыть"
            onClick={() => setFull(null)}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
