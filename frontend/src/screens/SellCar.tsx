/**
 * «Продать авто» v2 (07-sell-chats-partner-inspection.md §1, F1;
 * 10-listing-lifecycle.md §5): визард из трёх шагов вместо одной
 * длинной формы.
 *
 * 1 «Авто» — марка*, модель*, год* + пробег/топливо/КПП (валидация при
 *   переходе «Далее»);
 * 2 «Фото» — drag&drop-зона + файловый пикер (multiple): локальное
 *   превью (URL.createObjectURL) и загрузка сразу по одному файлу через
 *   POST /api/market/photos (lib/marketPhotos); мини-прогресс на карточке,
 *   ошибка — красная рамка + ретрай; ≤10, счётчик n/10; можно 0 фото;
 * 3 «Цена и публикация» — цена*+валюта, описание ≤2000, превью карточки
 *   как в ленте и правила тарифа (free: 7 дней бесплатно → 20★/нед;
 *   pro/business: 1 включено).
 *
 * Финальный шаг (10 §5) — две кнопки: «Сохранить черновик» (POST
 * /market/lots {submit:false} → «Мои объявления») и «Отправить на
 * публикацию» (submit:true): accepted → needs_payment-диалог/успех,
 * moderation → тост «Отправлено на проверку», rejected → красный тост
 * причины.
 *
 * Edit-режим /sell?edit={id} (10 §5): форма предзаполнена из GET
 * /market/my-lots (фото — мини-превью, можно удалить/добавить новые);
 * сабмит PATCH /market/lots/{id} (без paid-шага): accepted-лот →
 * «Отправить правки на проверку» ({pending_patch:true} → старая версия
 * продолжает показываться), draft/rejected → PATCH + POST /submit.
 *
 * Черновик визарда — sessionStorage `autobot.sellDraft` (шаг+поля+
 * загруженные URL): восстанавливается при возврате на /sell, сбрасывается
 * после успеха; в edit-режиме не пишется (БД-черновик — отдельная сущность).
 * Гость: deep-link /sell — заглушка с loginPrompt (FAB скрыт).
 *
 * Live-статусы (10 §3): useListingStatus — тост о решении модерации
 * по любому своему лоту прямо из формы.
 *
 * 12-ai-trust §2 (F12): шаг 3 — кнопка «✨ Сгенерировать описание»
 * (POST /market/description с полями визарда + photos_count → текст в
 * textarea, повтор — с confirm; 429 ai_generation_limit — тост лимита)
 * и live-блок «Качество объявления» (фото/описание локально, цену-медиану
 * считает бэк — score придёт в my-lots после сабмита).
 *
 * FAB «+» (SellFab): фиксированная кнопка на ленте (справа-снизу над
 * таббаром), гостю невидима, на /chats/* и остальных путях не рендерится.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Wand2 } from "lucide-react";

import { api } from "../api/client";
import { haptic, isGuest } from "../api/auth";
import { openInvoice } from "../lib/invoice";
import { digits } from "../lib/fx";
import { SELL_COUNTRIES } from "../lib/geo";
import { localQualityChecks } from "../lib/listingQuality";
import {
  isAcceptablePhoto,
  MAX_PHOTO_MB,
  uploadMarketPhoto,
} from "../lib/marketPhotos";
import { listingStatusToast, useListingStatus } from "../lib/chatStore";
import { useToast } from "../ui/Toast";
import { useLoginPrompt } from "../ui/LoginPrompt";
import { apiErrorText } from "./apiErrorText";
import type { CreatedLot, LotSubmitResult, MyLot, PlacementInvoice } from "../api/types";
import "../market.css";

/** Валидация года (ТЗ задачи: 1980–2027). */
const YEAR_MIN = 1980;
const YEAR_MAX = 2027;
/** Лимит фото лота (контракт §2: photos ≤10). */
const MAX_PHOTOS = 10;
/** Цена недели размещения в ★ (§2: market_week_stars=20). */
const WEEK_STARS = 20;
/** Сколько раз ждём вебхук оплаты (needs_payment-лот оживает платёжом,
 *  а callback openInvoice('paid') может прийти раньше бэкенда). */
const PUBLISH_POLLS = 5;
const PUBLISH_POLL_MS = 700;

/** Ключ черновика визарда в sessionStorage. */
const DRAFT_KEY = "autobot.sellDraft";

/** Подписи шагов (прогресс-точки + заголовок тела шага). */
const STEPS = ["Авто", "Фото", "Цена и публикация"] as const;

/** Валюты рынка владельцев (UX-002/GEO): список синхронен со страной
 *  продавца — KRW у источников (KR), в визарде не предлагается. */
type SellCurrency = "RUB" | "USD" | "EUR" | "KZT" | "BYN";

const CURRENCIES: { value: SellCurrency; label: string }[] = [
  { value: "RUB", label: "₽ RUB" },
  { value: "USD", label: "$ USD" },
  { value: "EUR", label: "€ EUR" },
  { value: "KZT", label: "₸ KZT" },
  { value: "BYN", label: "Br BYN" },
];

const CURRENCY_SYMBOL: Record<SellCurrency, string> = {
  RUB: "₽",
  USD: "$",
  EUR: "€",
  KZT: "₸",
  BYN: "Br",
};

/** Дефолт валюты по стране продавца (UX-002): RU→RUB, KZ→KZT, BY→BYN,
 *  GE/AM и остальные → USD; юзер может сменить вручную в селекте. */
const COUNTRY_CURRENCY: Record<string, SellCurrency> = {
  RU: "RUB",
  KZ: "KZT",
  BY: "BYN",
  GE: "USD",
  AM: "USD",
};

const currencyForCountry = (country: string): SellCurrency =>
  COUNTRY_CURRENCY[country.toUpperCase()] ?? "USD";

const isSellCurrency = (c: string): c is SellCurrency =>
  CURRENCIES.some((x) => x.value === c);

/** Значения совпадают со словарём lib/specs (карточки ленты подписываются). */
const FUEL_OPTIONS: { value: string; label: string }[] = [
  { value: "petrol", label: "Бензин" },
  { value: "diesel", label: "Дизель" },
  { value: "hybrid", label: "Гибрид" },
  { value: "electric", label: "Электро" },
  { value: "lpg", label: "Газ" },
];

const TRANSMISSION_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "АКПП" },
  { value: "manual", label: "МКПП" },
];

/** Инлайн-валидация: ключ поля → текст ошибки (пусто = поле в порядке). */
interface FieldErrors {
  make?: string;
  model?: string;
  year?: string;
  country?: string;
  price?: string;
  description?: string;
}

/** Валидация шага 1 «Авто» (марка/модель/год + страна, GEO-V1 §2:
 *  country обязателен для owner-лотов; селект с дефолтом RU пустым
 *  быть не может — проверка защитная). */
function validateCar(
  make: string,
  model: string,
  year: string,
  country: string,
): FieldErrors {
  const e: FieldErrors = {};
  if (!make.trim()) e.make = "Укажите марку (Kia, Hyundai…)";
  if (!model.trim()) e.model = "Укажите модель";
  const y = Number(year);
  if (!year.trim()) e.year = "Укажите год выпуска";
  else if (!Number.isInteger(y) || y < YEAR_MIN || y > YEAR_MAX)
    e.year = `Год — от ${YEAR_MIN} до ${YEAR_MAX}`;
  if (!country.trim()) e.country = "Укажите страну";
  return e;
}

/** Валидация шага 3 «Цена и публикация». */
function validatePublish(price: string, description: string): FieldErrors {
  const e: FieldErrors = {};
  const p = Number(price);
  if (!price.trim()) e.price = "Укажите цену";
  else if (!Number.isFinite(p) || p <= 0) e.price = "Цена должна быть больше нуля";
  if (description.length > 2000) e.description = "Описание — максимум 2000 символов";
  return e;
}

/** Ждать публикацию лота: GET /api/listings/{id} отвечает 200, когда
 *  вебхук successful_payment оживил needs_payment-лот (is_active=true). */
async function waitForPublished(listingId: number): Promise<boolean> {
  for (let i = 0; i < PUBLISH_POLLS; i++) {
    try {
      await api(`/listings/${listingId}`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, PUBLISH_POLL_MS));
    }
  }
  return false;
}

// ---------- Черновик (sessionStorage) ----------

/** Черновик визарда: шаг + поля + URL уже загруженных фото. */
interface DraftData {
  step: number;
  make: string;
  model: string;
  year: string;
  mileage: string;
  fuel: string;
  transmission: string;
  /** Гео owner-лота (GEO-V1 §2): ISO2 (дефолт RU) + город (опционально). */
  country: string;
  city: string;
  price: string;
  currency: SellCurrency;
  description: string;
  /** URL загруженных фото (незагруженные/ошибки не сохраняются). */
  photos: string[];
}

function loadDraft(): DraftData | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as DraftData;
    return typeof d === "object" && d !== null && Array.isArray(d.photos) ? d : null;
  } catch {
    return null;
  }
}

function saveDraft(d: DraftData): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // sessionStorage недоступен — черновик не критичен
  }
}

function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* noop */
  }
}

// ---------- Фото шага 2 ----------

/** Карточка фото в визарде: превью + статус немедленной загрузки. */
interface PhotoItem {
  key: string;
  /** File для ретрая (у фото из черновика — null, ретраить нечего). */
  file: File | null;
  /** blob:-превью (новые) либо готовый URL (из черновика). */
  previewUrl: string;
  /** URL с бэка после успешной загрузки. */
  remoteUrl: string | null;
  status: "uploading" | "done" | "error";
}

export function SellCarScreen() {
  const navigate = useNavigate();
  const toast = useToast();
  const loginPrompt = useLoginPrompt();

  // Edit-режим (10 §5): /sell?edit={id} — предзаполнение из my-lots.
  const [searchParams] = useSearchParams();
  const editId = useMemo(() => {
    const raw = Number(searchParams.get("edit"));
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }, [searchParams]);

  // Восстановление черновика визарда — один раз при монтировании;
  // в edit-режиме sessionStorage-черновик не участвует (там БД-лот).
  const initialDraft = useMemo(() => (editId ? null : loadDraft()), [editId]);

  const [step, setStep] = useState(() =>
    Math.min(2, Math.max(0, initialDraft?.step ?? 0)),
  );
  const [make, setMake] = useState(initialDraft?.make ?? "");
  const [model, setModel] = useState(initialDraft?.model ?? "");
  const [year, setYear] = useState(initialDraft?.year ?? "");
  const [price, setPrice] = useState(initialDraft?.price ?? "");
  // UX-002: валюта по умолчанию следует за страной (новый лот — RU/RUB);
  // черновик без валидной валюты (старые KRW-записи) — дефолт страны
  const [currency, setCurrency] = useState<SellCurrency>(
    initialDraft && isSellCurrency(initialDraft.currency)
      ? initialDraft.currency
      : currencyForCountry(initialDraft?.country ?? "RU"),
  );
  const [mileage, setMileage] = useState(initialDraft?.mileage ?? "");
  const [fuel, setFuel] = useState(initialDraft?.fuel ?? "");
  const [transmission, setTransmission] = useState(initialDraft?.transmission ?? "");
  /** Гео лота (GEO-V1 §2): страна продавца, ISO2; дефолт RU — внутренний
   *  рынок (импортные источники KR/CN/AE/US в списке не предлагаются). */
  const [country, setCountry] = useState(initialDraft?.country ?? "RU");
  const [city, setCity] = useState(initialDraft?.city ?? "");
  const [description, setDescription] = useState(initialDraft?.description ?? "");
  /** Фото шага 2: загруженные из черновика стартуют как done с готовым URL. */
  const [photos, setPhotos] = useState<PhotoItem[]>(() =>
    (initialDraft?.photos ?? []).slice(0, MAX_PHOTOS).map((url, i) => ({
      key: `draft-${i}-${url}`,
      file: null,
      previewUrl: url,
      remoteUrl: url,
      status: "done" as const,
    })),
  );

  /** Лот edit-режима (my-lots): null — не грузили/не нашли. */
  const [editLot, setEditLot] = useState<MyLot | null>(null);
  const [editLoading, setEditLoading] = useState(editId != null);
  const [editMissing, setEditMissing] = useState(false);

  const [errors, setErrors] = useState<FieldErrors>({});
  /** Ошибка сабмита (409 лимит/регистрация, сеть) — баннером над кнопкой. */
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Созданный лот, ждущий оплаты: диалог «продлить сейчас?» (§3 free-правила). */
  const [needsPayment, setNeedsPayment] = useState<CreatedLot | null>(null);
  const [extending, setExtending] = useState(false);
  /** Генерация описания (12 §2) в полёте — кнопка «✨ Сгенерировать» занята. */
  const [genBusy, setGenBusy] = useState(false);
  /** drag&drop-зона в состоянии «над ней тащат файл». */
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Счётчик ключей фото (стабильные key вне индексов массива). */
  const photoSeq = useRef(0);
  /** Свежий список фото для отзыва blob:-превью на unmount (см. эффект). */
  const photosRef = useRef<PhotoItem[]>(photos);
  photosRef.current = photos;

  const anyUploading = photos.some((p) => p.status === "uploading");
  /** Загруженные фото (done): их же отправляем в сабмите, генерации описания
   *  и live-качестве (12 §2) — ошибки/в полёте не считаем. */
  const donePhotos = photos.filter((p) => p.status === "done").length;

  /** Черновик визарда: любое изменение полей/шага/загруженных фото — в
   *  sessionStorage. Гостю экран не показывается — черновик гостя не пишем;
   *  edit-режим не пишет вовсе (источник истины — БД-лот, 10 §5). */
  useEffect(() => {
    if (isGuest() || editId != null) return;
    saveDraft({
      step,
      make,
      model,
      year,
      mileage,
      fuel,
      transmission,
      country,
      city,
      price,
      currency,
      description,
      photos: photos
        .filter((p) => p.status === "done" && p.remoteUrl)
        .map((p) => p.remoteUrl as string),
    });
  }, [step, make, model, year, mileage, fuel, transmission, country, city, price, currency, description, photos, editId]);

  /** Edit-режим: грузим лот из my-lots и предзаполняем визард (10 §5).
   *  Фото — готовые URL как мини-превью (можно удалить/добавить новые). */
  useEffect(() => {
    if (editId == null || isGuest()) return;
    let alive = true;
    setEditLoading(true);
    setEditMissing(false);
    api<MyLot[]>("/market/my-lots")
      .then((r) => {
        if (!alive) return;
        const lot = (Array.isArray(r) ? r : []).find((l) => l.listing_id === editId) ?? null;
        if (!lot) {
          setEditMissing(true);
          return;
        }
        setEditLot(lot);
        setMake(lot.make ?? "");
        setModel(lot.model ?? "");
        setYear(lot.year != null ? String(lot.year) : "");
        setMileage(lot.mileage_km != null ? String(lot.mileage_km) : "");
        setFuel(lot.fuel ?? "");
        setTransmission(lot.transmission ?? "");
        setCountry(lot.country ?? "RU");
        setCity(lot.city ?? "");
        setPrice(lot.price != null ? String(lot.price) : "");
        // валюта лота, если она из списка визарда; легаси-KRW и прочие —
        // дефолт по стране лота (UX-002: KZ → ₸, RU → ₽)
        setCurrency(
          lot.currency && isSellCurrency(lot.currency)
            ? lot.currency
            : currencyForCountry(lot.country ?? "RU"),
        );
        setDescription(lot.owner_description ?? "");
        setPhotos(
          lot.images.slice(0, MAX_PHOTOS).map((url, i) => ({
            key: `edit-${i}-${url}`,
            file: null,
            previewUrl: url,
            remoteUrl: url,
            status: "done" as const,
          })),
        );
      })
      .catch(() => {
        if (alive) setEditMissing(true);
      })
      .finally(() => {
        if (alive) setEditLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [editId]);

  /** Live-статусы объявлений (10 §3): тост о решении модерации по любому
   *  своему лоту приходит и на форму продажи (событие — не чат). */
  useListingStatus((ev) => {
    const t = listingStatusToast(ev);
    toast.show(t.text, { error: t.error });
  });

  /** Освобождаем blob:-превью при демонтаже визарда (последний снимок списка). */
  useEffect(
    () => () => {
      photosRef.current.forEach((p) => {
        if (p.previewUrl.startsWith("blob:")) URL.revokeObjectURL(p.previewUrl);
      });
    },
    // намеренно пустые депсы: только unmount-очистка, не каждый рендер
    [],
  );

  // Гость: рынок — только для зарегистрированных (§1: гость — ничего).
  // Проверка после всех хуков — иначе «условные» эффекты сломают порядок.
  if (isGuest()) {
    return (
      <div className="screen">
        <div className="state state--page">
          <div className="state__emoji">🔒</div>
          <div className="state__title">Продажа — после входа</div>
          <div className="state__text">
            Размещение объявлений, чат с покупателями и уведомления доступны
            зарегистрированным пользователям.
          </div>
          <button
            className="btn btn--primary"
            onClick={() =>
              loginPrompt.show(
                "Размещение объявлений доступно после входа — войдите или зарегистрируйтесь.",
              )
            }
          >
            Войти и разместить
          </button>
        </div>
      </div>
    );
  }

  /** Загрузка одного файла (или ретрай): uploading → done/error. */
  const uploadOne = useCallback((key: string, file: File) => {
    setPhotos((prev) =>
      prev.map((p) => (p.key === key ? { ...p, status: "uploading", remoteUrl: null } : p)),
    );
    uploadMarketPhoto(file)
      .then((url) =>
        setPhotos((prev) =>
          prev.map((p) => (p.key === key ? { ...p, status: "done", remoteUrl: url } : p)),
        ),
      )
      .catch(() =>
        setPhotos((prev) => prev.map((p) => (p.key === key ? { ...p, status: "error" } : p))),
      );
  }, []);

  /** Принять файлы (drop или file input): фильтр типа/размера, лимит 10. */
  const addFiles = (list: FileList | File[]) => {
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) {
      toast.show(`Максимум ${MAX_PHOTOS} фото — удалите лишние`, { error: true });
      return;
    }
    const accepted: File[] = [];
    for (const f of Array.from(list)) {
      if (!isAcceptablePhoto(f)) {
        toast.show(`«${f.name}»: нужен JPEG, PNG или WebP до ${MAX_PHOTO_MB} МБ`, { error: true });
        continue;
      }
      accepted.push(f);
    }
    const take = accepted.slice(0, room);
    if (accepted.length > take.length) {
      toast.show(`Максимум ${MAX_PHOTOS} фото — лишние пропущены`);
    }
    if (take.length === 0) return;
    const items: PhotoItem[] = take.map((file) => {
      photoSeq.current += 1;
      return {
        key: `p${photoSeq.current}`,
        file,
        previewUrl: URL.createObjectURL(file),
        remoteUrl: null,
        status: "uploading" as const,
      };
    });
    setPhotos((prev) => [...prev, ...items]);
    // грузим по одному файлу (контракт §1), старт сразу после выбора
    items.forEach((it) => uploadOne(it.key, it.file as File));
  };

  /** Удалить фото: blob-превью ревокаем, URL выпадает из сабмита. */
  const removePhoto = (key: string) => {
    setPhotos((prev) => {
      const victim = prev.find((p) => p.key === key);
      if (victim?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(victim.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  };

  /** «Далее»: шаг валидируется (шаг 1 — авто, шаг 2 — ждём загрузки). */
  const next = () => {
    if (step === 0) {
      const errs = validateCar(make, model, year, country);
      setErrors(errs);
      if (Object.keys(errs).length > 0) {
        haptic("heavy");
        return;
      }
    }
    if (step === 1 && anyUploading) return; // кнопка disabled, но и подстрахуем
    setErrors({});
    setStep((s) => Math.min(2, s + 1));
  };

  const back = () => setStep((s) => Math.max(0, s - 1));

  /** Тело лота из полей визарда — общее для POST (создание) и PATCH
   *  (правка), контракт MarketLotCreate (10 §4 + GEO-V1 §2: country
   *  обязателен для owner-лотов, city опционален). */
  const buildBody = () => ({
    make: make.trim(),
    model: model.trim(),
    year: Number(year),
    country,
    ...(city.trim() ? { city: city.trim() } : {}),
    price: Number(price),
    currency,
    ...(mileage.trim() ? { mileage_km: Number(mileage) } : {}),
    ...(fuel ? { fuel } : {}),
    ...(transmission ? { transmission } : {}),
    ...(description.trim() ? { description: description.trim() } : {}),
    photos: photos.map((p) => p.remoteUrl).filter((u): u is string => Boolean(u)),
  });

  /** «✨ Сгенерировать описание» (12 §2): POST /api/market/description с
   *  текущими полями визарда + photos_count → LLM-текст в textarea (юзер
   *  может править). Повторная генерация перезаписывает — с confirm;
   *  429 ai_generation_limit — тост лимита (5 генераций/день free). */
  const generateDescription = async () => {
    if (genBusy) return;
    // уже есть текст (сгенерированный или свой) — перезапись только с confirm
    if (description.trim() && !window.confirm("Заменить текущее описание новым текстом?")) {
      return;
    }
    setGenBusy(true);
    haptic("medium");
    try {
      const r = await api<{ text: string }>("/market/description", {
        method: "POST",
        body: JSON.stringify({
          make: make.trim(),
          model: model.trim(),
          year: Number(year),
          price: Number(price),
          currency,
          ...(mileage.trim() ? { mileage_km: Number(mileage) } : {}),
          ...(fuel ? { fuel } : {}),
          ...(transmission ? { transmission } : {}),
          photos_count: photos.filter((p) => p.status === "done").length,
        }),
      });
      if (r?.text) setDescription(r.text);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429) {
        toast.show("Лимит генераций на сегодня исчерпан — обновится завтра", { error: true });
      } else {
        toast.show("Не удалось сгенерировать описание — попробуйте позже", { error: true });
      }
    } finally {
      setGenBusy(false);
    }
  };

  /** Валидация финального шага; true = можно отправлять. */
  const validateFinal = (): boolean => {
    const errs = validatePublish(price, description);
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      haptic("heavy");
      return false;
    }
    return true;
  };

  /** Сетевая ошибка создания: 409 лимит / 403 вход / прочее — баннером. */
  const handleCreateError = (e: unknown) => {
    const status = (e as { status?: number }).status;
    if (status === 409) {
      setSubmitError(
        "Лимит объявлений достигнут: первое — бесплатно на 7 дней, дополнительные — 20★/нед (до 3). Продлите или снимите другое объявление в «Мои объявления».",
      );
    } else if (status === 403) {
      loginPrompt.show(
        "Размещение объявлений доступно после входа — войдите или зарегистрируйтесь.",
      );
    } else {
      setSubmitError(apiErrorText(e));
    }
  };

  /** Создание лота (10 §5): publish=false — черновик в my-lots; true —
   *  сразу модерация (синхронный вердикт в ответе POST). */
  const submitCreate = async (publish: boolean) => {
    if (busy || anyUploading) return;
    if (!validateFinal()) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const lot = await api<CreatedLot>("/market/lots", {
        method: "POST",
        body: JSON.stringify({ ...buildBody(), submit: publish }),
      });
      // лот создан — черновик визарда больше не нужен (даже ждущий оплаты)
      clearDraft();
      haptic("medium");
      if (!publish) {
        // БД-черновик — отдельная сущность в «Моих объявлениях» (10 §5)
        toast.show("Черновик сохранён");
        navigate("/auto?tab=mine");
        return;
      }
      const st = lot.status ?? "accepted"; // старый бэк без status — публикация
      if (st === "moderation") {
        toast.show("Отправлено на проверку — результат придёт здесь");
        navigate("/auto?tab=mine");
      } else if (st === "rejected") {
        toast.show(
          `Объявление отклонено: ${lot.rejected_reason ?? "нарушение правил размещения"}`,
          { error: true },
        );
        navigate("/auto?tab=mine");
      } else if (lot.placement_status === "needs_payment") {
        // Бесплатный слот занят: лот одобрен, опубликуется после оплаты
        setNeedsPayment(lot);
      } else {
        toast.show("Объявление опубликовано");
        navigate(`/listing/${lot.listing_id}`);
      }
    } catch (e) {
      handleCreateError(e);
    } finally {
      setBusy(false);
    }
  };

  /** Правка лота в edit-режиме (10 §5): PATCH всегда; publish=true —
   *  затем POST /submit (draft/rejected → модерация). PATCH оплату не
   *  запускает — paid-шага нет, «Одобрено — оплата» живёт в my-lots. */
  const submitEdit = async (publish: boolean) => {
    if (busy || anyUploading || editId == null) return;
    if (!validateFinal()) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await api<{ pending_patch?: boolean }>(`/market/lots/${editId}`, {
        method: "PATCH",
        body: JSON.stringify(buildBody()),
      });
      haptic("medium");
      if (!publish) {
        // accepted-лот: правки ушли версией на проверку (pending_patch);
        // draft/rejected — просто сохранены без отправки на модерацию
        toast.show(
          editLot?.status === "accepted"
            ? "Правки отправлены на проверку"
            : "Черновик сохранён",
        );
        navigate("/auto?tab=mine");
        return;
      }
      const r = await api<LotSubmitResult>(`/market/lots/${editId}/submit`, {
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
        // accepted: размещение (в т.ч. needs_payment) — в «Моих объявлениях»
        toast.show("Объявление одобрено");
      }
      navigate("/auto?tab=mine");
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409) {
        // moderation/archived → invalid_state (10 §4)
        setSubmitError(
          "Лот сейчас на проверке или снят — правки станут доступны после решения модерации.",
        );
      } else {
        setSubmitError(apiErrorText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  /** Финальный сабмит формы: создание или правка (accepted — PATCH без
   *  submit, draft/rejected — PATCH + submit). */
  const submitFinal = () => {
    if (editId != null) {
      void submitEdit(editLot?.status !== "accepted");
      return;
    }
    void submitCreate(true);
  };

  /** Диалог needs_payment: закрытие без оплаты (кнопка «Позже», тап по
   *  фону или Esc — единообразно с остальными модалками). Лот остаётся
   *  ждать оплаты в «Моих объявлениях». */
  const dismissNeedsPayment = useCallback(() => {
    setNeedsPayment(null);
    toast.show("Лот сохранён — продлить можно в «Мои объявления»");
    navigate("/auto?tab=mine");
  }, [toast, navigate]);

  // Esc закрывает диалог оплаты (03 §5.3 — как шит ленты и лайтбокс)
  useEffect(() => {
    if (!needsPayment) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissNeedsPayment();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [needsPayment, dismissNeedsPayment]);

  /** Диалог needs_payment → extend(1 нед): Stars-инвойс как в Profile.buy.
   *  После «paid» ждём вебхук (лот оживает) и уходим в карточку. */
  const extendNow = async () => {
    if (!needsPayment || extending) return;
    setExtending(true);
    try {
      const inv = await api<PlacementInvoice>(`/market/lots/${needsPayment.listing_id}/extend`, {
        method: "POST",
        body: JSON.stringify({ weeks: 1 }),
      });
      haptic("medium");
      const inTg = openInvoice(inv.invoice_url, (status) => {
        if (status === "paid") {
          toast.show("Объявление опубликовано");
          // callback 'paid' может опередить вебхук successful_payment —
          // коротко поллим карточку, пока is_active не станет true
          void waitForPublished(needsPayment.listing_id).then((ok) => {
            setExtending(false);
            navigate(ok ? `/listing/${needsPayment.listing_id}` : "/auto?tab=mine");
          });
        } else {
          setExtending(false);
          if (status === "failed") {
            toast.show("❌ Оплата не прошла — лот ждёт оплаты в «Мои объявления»", { error: true });
          } else if (status === "cancelled") {
            toast.show("Оплата отменена — лот ждёт оплаты в «Мои объявления»");
          } else {
            toast.show("⏳ Платёж в обработке — объявление появится после подтверждения");
          }
          navigate("/auto?tab=mine");
        }
      });
      if (!inTg) {
        setExtending(false);
        toast.show("💳 Счёт открыт в новой вкладке — оплата ★ Stars работает только в Telegram");
      }
    } catch (e) {
      setExtending(false);
      toast.show(apiErrorText(e), { error: true });
    }
  };

  // Edit-режим: лот не найден (нет в my-lots) — не даём пустую форму,
  // которая создала бы дубликат. После всех хуков (правила хуков).
  if (editMissing) {
    return (
      <div className="screen">
        <div className="state state--page">
          <div className="state__emoji">🤷</div>
          <div className="state__title">Объявление не найдено</div>
          <div className="state__text">
            Лот не найден в «Моих объявлениях» — возможно, он уже снят с продажи.
          </div>
          <button type="button" className="btn btn--primary" onClick={() => navigate("/auto?tab=mine")}>
            К моим объявлениям
          </button>
        </div>
      </div>
    );
  }

  const fuelLabel = FUEL_OPTIONS.find((f) => f.value === fuel)?.label;
  const transmissionLabel = TRANSMISSION_OPTIONS.find((t) => t.value === transmission)?.label;
  const previewTitle = `${make} ${model} ${year}`.trim() || "Марка Модель Год";
  const previewMeta = [
    mileage ? `${Number(mileage).toLocaleString("ru-RU")} км` : "",
    fuelLabel ?? "",
    transmissionLabel ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  const firstPreview = photos.find((p) => p.previewUrl)?.previewUrl ?? null;

  return (
    <div className="screen sell-page">
      <button className="listing-back" aria-label="Назад" onClick={() => navigate(-1)}>
        ‹
      </button>

      <section className="panel sell-head">
        <h3>{editId != null ? "Редактирование объявления" : "Продать авто"}</h3>
        <p className="sell-hint">
          {editId != null
            ? "Изменения сохраняются как версия на проверке — в ленте пока показывается старая."
            : "Объявление попадёт в ленту рынка, покупатели напишут вам в чат. Первое объявление — 7 дней бесплатно."}
        </p>
        {/* Edit опубликованного (10 §1): старая версия остаётся видимой */}
        {editLot?.status === "accepted" && (
          <div className="sell-note" role="note">
            Пока правки на проверке, в ленте продолжает показываться старая версия объявления.
          </div>
        )}
        {/* Предыдущие правки отклонены модерацией — покажем причину */}
        {editLot?.pending_patch?.patch_reject_reason && (
          <div className="sell-note sell-note--warn" role="note">
            Предыдущие правки отклонены: {editLot.pending_patch.patch_reject_reason}
          </div>
        )}
      </section>

      {/* Edit-режим: пока лот грузится из my-lots — скелетон вместо формы
          (пустая форма создала бы дубликат-черновик). */}
      {editLoading ? (
        <section className="panel sell-form" aria-busy="true">
          <div className="state">
            <span className="skeleton" style={{ width: 220, height: 16 }} />
          </div>
        </section>
      ) : (
      <>
      {/* Прогресс-точки визарда: пройденные с ✓, текущий подсвечен */}
      <ol className="sell-steps" aria-label={`Шаг ${step + 1} из 3: ${STEPS[step]}`}>
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={
              i === step
                ? "sell-steps__item sell-steps__item--current"
                : i < step
                  ? "sell-steps__item sell-steps__item--done"
                  : "sell-steps__item"
            }
            aria-current={i === step ? "step" : undefined}
          >
            <span className="sell-steps__dot" aria-hidden="true">
              {i < step ? "✓" : i + 1}
            </span>
            <span className="sell-steps__label">{label}</span>
          </li>
        ))}
      </ol>

      <form
        className="panel sell-form"
        onSubmit={(e) => {
          e.preventDefault();
          submitFinal();
        }}
        noValidate
      >
        {/* ---------- Шаг 1: Авто ---------- */}
        {step === 0 && (
          <div className="sell-grid">
            <label className="sell-field">
              <span>Марка *</span>
              <input
                value={make}
                onChange={(e) => setMake(e.target.value)}
                placeholder="Kia"
                aria-label="Марка"
                maxLength={60}
              />
              {errors.make && <em className="sell-field__error" role="alert">{errors.make}</em>}
            </label>
            <label className="sell-field">
              <span>Модель *</span>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="K5"
                aria-label="Модель"
                maxLength={60}
              />
              {errors.model && <em className="sell-field__error" role="alert">{errors.model}</em>}
            </label>
            <label className="sell-field">
              <span>Год выпуска *</span>
              <input
                inputMode="numeric"
                value={year}
                onChange={(e) => setYear(digits(e.target.value).slice(0, 4))}
                placeholder="2022"
                aria-label="Год выпуска"
              />
              {errors.year && <em className="sell-field__error" role="alert">{errors.year}</em>}
            </label>
            <label className="sell-field">
              <span>Пробег, км</span>
              <input
                inputMode="numeric"
                value={mileage}
                onChange={(e) => setMileage(digits(e.target.value).slice(0, 9))}
                placeholder="35 000"
                aria-label="Пробег, км"
              />
            </label>
            <label className="sell-field">
              <span>Топливо</span>
              <select value={fuel} onChange={(e) => setFuel(e.target.value)} aria-label="Топливо">
                <option value="">Не выбрано</option>
                {FUEL_OPTIONS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="sell-field">
              <span>КПП</span>
              <select
                value={transmission}
                onChange={(e) => setTransmission(e.target.value)}
                aria-label="КПП"
              >
                <option value="">Не выбрано</option>
                {TRANSMISSION_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            {/* Гео owner-лота (GEO-V1 §3): страна продавца (дефолт RU —
                внутренний рынок) + город (опционально, но рекомендуемо).
                Смена страны подтягивает её валюту (UX-002) — юзер может
                после выбрать любую вручную в селекте на шаге 3. */}
            <label className="sell-field">
              <span>Страна *</span>
              <select
                value={country}
                onChange={(e) => {
                  const v = e.target.value;
                  setCountry(v);
                  setCurrency(currencyForCountry(v));
                }}
                aria-label="Страна"
              >
                {SELL_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code === "RU"
                      ? `${c.flag} ${c.name} — внутренний рынок`
                      : `${c.flag} ${c.name}`}
                  </option>
                ))}
              </select>
              {errors.country && (
                <em className="sell-field__error" role="alert">{errors.country}</em>
              )}
            </label>
            <label className="sell-field">
              <span>Город</span>
              <input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Москва"
                aria-label="Город"
                maxLength={64}
              />
            </label>
          </div>
        )}

        {/* ---------- Шаг 2: Фото ---------- */}
        {step === 1 && (
          <fieldset className="sell-photo-step">
            <legend>
              Фото <span className="sell-photo-step__count">{photos.length}/{MAX_PHOTOS}</span>
            </legend>
            <div
              className={dragOver ? "sell-drop sell-drop--over" : "sell-drop"}
              role="button"
              tabIndex={0}
              aria-label="Добавить фото: перетащите файлы или нажмите"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                addFiles(e.dataTransfer.files);
              }}
            >
              <span className="sell-drop__icon" aria-hidden="true">📷</span>
              <span className="sell-drop__text">
                Перетащите фото сюда или нажмите — до {MAX_PHOTOS} шт.,
                JPEG/PNG/WebP до {MAX_PHOTO_MB} МБ
              </span>
              <span className="sell-drop__hint">Первое фото станет обложкой. Можно продолжить без фото.</span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="sell-drop__input"
                aria-label="Выбрать файлы фото"
                onChange={(e) => {
                  addFiles(e.target.files ?? []);
                  e.target.value = ""; // тот же файл можно выбрать повторно
                }}
              />
            </div>

            {photos.length > 0 && (
              <ul className="sell-pcards">
                {photos.map((p, i) => (
                  <li
                    key={p.key}
                    className={`sell-pcard sell-pcard--${p.status}`}
                    data-status={p.status}
                  >
                    <img className="sell-pcard__img" src={p.previewUrl} alt="" />
                    {p.status === "uploading" && (
                      <>
                        <span className="sell-pcard__bar" aria-hidden="true" />
                        <span className="sell-pcard__hint">Загружаем…</span>
                      </>
                    )}
                    {p.status === "error" && (
                      <>
                        <span className="sell-pcard__hint sell-pcard__hint--error">Ошибка</span>
                        {p.file && (
                          <button
                            type="button"
                            className="sell-pcard__retry"
                            aria-label={`Повторить загрузку фото ${i + 1}`}
                            onClick={() => uploadOne(p.key, p.file as File)}
                          >
                            ⟳
                          </button>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      className="sell-pcard__del"
                      aria-label={`Удалить фото ${i + 1}`}
                      onClick={() => removePhoto(p.key)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        )}

        {/* ---------- Шаг 3: Цена и публикация ---------- */}
        {step === 2 && (
          <>
            <div className="sell-grid">
              <label className="sell-field">
                <span>Цена *</span>
                <input
                  inputMode="numeric"
                  value={price}
                  onChange={(e) => setPrice(digits(e.target.value).slice(0, 12))}
                  placeholder="20 000 000"
                  aria-label="Цена"
                />
                {errors.price && <em className="sell-field__error" role="alert">{errors.price}</em>}
              </label>
              <label className="sell-field">
                <span>Валюта *</span>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as SellCurrency)}
                  aria-label="Валюта"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="sell-field sell-field--wide">
              {/* 12 §2: генерация описания — кнопка возле textarea */}
              <div className="sell-field__head">
                <span>Описание от владельца</span>
                <button
                  type="button"
                  className="sell-desc-gen"
                  disabled={genBusy}
                  onClick={() => void generateDescription()}
                >
                  <Wand2 size={16} aria-hidden="true" />
                  {genBusy ? "Генерируем…" : "✨ Сгенерировать описание"}
                </button>
              </div>
              <textarea
                rows={4}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Комплектация, состояние, история обслуживания, причина продажи…"
                aria-label="Описание"
              />
              <em className="sell-field__counter" aria-hidden="true">
                {description.length}/2000
              </em>
              {errors.description && (
                <em className="sell-field__error" role="alert">{errors.description}</em>
              )}
            </div>

            {/* Качество объявления (12 §2): live-чек-лист по фото и описанию.
                Цену-медиану локально не считаем — авторитетный score с бэка
                (quality в my-lots) появится в «Моих объявлениях» профиля. */}
            <div className="sell-quality" aria-label="Качество объявления">
              <div className="sell-quality__title">Качество объявления</div>
              <ul className="sell-quality__list">
                {localQualityChecks(donePhotos, description).map((c) => (
                  <li
                    key={c.label}
                    className={
                      c.ok ? "sell-quality__item sell-quality__item--ok" : "sell-quality__item sell-quality__item--warn"
                    }
                  >
                    <span className="sell-quality__icon" aria-hidden="true">
                      {c.ok ? "✓" : "⚠"}
                    </span>
                    <span className="sell-quality__label">{c.label}</span>
                    {!c.ok && <span className="sell-quality__tip">{c.tip}</span>}
                  </li>
                ))}
              </ul>
            </div>

            {/* Итог-превью карточки как в ленте (простой свой блок) */}
            <div className="sell-preview" aria-label="Предпросмотр объявления">
              {firstPreview ? (
                <img className="sell-preview__img" src={firstPreview} alt="" />
              ) : (
                <span className="sell-preview__img sell-preview__img--empty" aria-hidden="true">
                  🚗
                </span>
              )}
              <div className="sell-preview__body">
                <span className="sell-preview__title">{previewTitle}</span>
                {previewMeta && <span className="sell-preview__meta">{previewMeta}</span>}
                <span className="sell-preview__price">
                  {price
                    ? `${Number(price).toLocaleString("ru-RU")} ${CURRENCY_SYMBOL[currency]}`
                    : "Цена не указана"}
                </span>
              </div>
            </div>

            {/* Правила тарифа (§3) */}
            <div className="sell-tariff">
              <div className="sell-tariff__title">Правила размещения</div>
              <ul className="sell-tariff__list">
                <li>
                  <b>free</b> — первое объявление 7 дней бесплатно, далее{" "}
                  {WEEK_STARS}★/нед (до 3 объявлений)
                </li>
                <li>
                  <b>pro / business</b> — одно объявление включено в подписку
                </li>
                <li>до {MAX_PHOTOS} фото, JPEG/PNG/WebP до {MAX_PHOTO_MB} МБ</li>
              </ul>
            </div>

            {submitError && (
              <div className="form-error-inline" role="alert">
                {submitError}
              </div>
            )}
          </>
        )}

        {/* Навигация визарда: Назад / Далее / финальный шаг — черновик +
            публикация (10 §5); edit опубликованного — только правки. */}
        <div className="sell-nav">
          {step > 0 && (
            <button type="button" className="btn sell-nav__back" onClick={back}>
              ← Назад
            </button>
          )}
          {step < 2 && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={next}
              disabled={step === 1 && anyUploading}
            >
              {step === 1 && anyUploading ? "Загружаем фото…" : "Далее →"}
            </button>
          )}
          {step === 2 && editLot?.status !== "accepted" && (
            <button
              type="button"
              className="btn sell-nav__draft"
              disabled={busy || anyUploading}
              onClick={() => (editId != null ? void submitEdit(false) : void submitCreate(false))}
            >
              Сохранить черновик
            </button>
          )}
          {step === 2 && (
            <button type="submit" className="btn btn--primary" disabled={busy || anyUploading}>
              {busy
                ? editId != null
                  ? "Сохраняем…"
                  : "Публикуем…"
                : editLot?.status === "accepted"
                  ? "Отправить правки на проверку"
                  : "Отправить на публикацию"}
            </button>
          )}
        </div>
      </form>
      </>
      )}

      {/* Диалог needs_payment (§3): лот создан, опубликуется после оплаты */}
      {needsPayment && (
        <div
          className="sell-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Требуется оплата"
          onClick={dismissNeedsPayment}
        >
          <div className="sell-dialog__card" onClick={(e) => e.stopPropagation()}>
            <div className="sell-dialog__title">Лот создан, но требует оплаты</div>
            <p className="sell-dialog__text">
              Бесплатный слот занят другим объявлением. Публикация этого лота —
              {WEEK_STARS}★ за неделю. Продлить сейчас?
            </p>
            <div className="sell-dialog__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={extending}
                onClick={() => void extendNow()}
              >
                {extending ? "Открываем счёт…" : `Продлить за ${WEEK_STARS}★`}
              </button>
              <button type="button" className="btn" onClick={dismissNeedsPayment}>
                Позже
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * FAB «+» на ленте (06 §6): фиксированная кнопка справа-снизу над таббаром.
 * Гостю невидим (рынок — после входа); рендерится только на табе ленты —
 * на /chats/*, PDP, /sell и остальных путях кнопки нет.
 */
export function SellFab() {
  const location = useLocation();
  const navigate = useNavigate();
  if (isGuest()) return null;
  const p =
    location.pathname !== "/" && location.pathname.endsWith("/")
      ? location.pathname.slice(0, -1)
      : location.pathname;
  if (p !== "/" && p !== "") return null;
  return (
    <button
      type="button"
      className="sell-fab"
      aria-label="Продать авто"
      onClick={() => {
        haptic();
        navigate("/sell");
      }}
    >
      ＋
    </button>
  );
}
