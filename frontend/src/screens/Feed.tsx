/**
 * Лента объявлений (UI/UX ТЗ §2.2) — по аудиту редизайна (01-ux-audit §1.2,
 * wireframe §3.1):
 *
 * - F1: шапка — компактный суббар в одну строку (Фильтры ·N · сортировка ·
 *   счётчик-eyebrow «N авто · сортировка»), чипсы — вторым рядом; отдельного
 *   ряда с заголовком «Лента» больше нет. Суббар sticky сверху области ленты.
 * - F2: панель фильтров — bottom-sheet со scrim и прилипающим футером
 *   «Применить / Сбросить» (+ живой счётчик found через GET /listings?
 *   limit=1); листается контент шита, а не поля внутри sticky-шапки.
 *   Закрытие: крестик / тап по scrim / Esc. Шит рендерится в portal в
 *   document.body: обёртка keep-alive экрана держит transform после
 *   screen-enter-анимации, и fixed-шит позиционировался бы относительно
 *   колонки контента, а не вьюпорта (кривой рендер на десктопе).
 * - F3: сортировка и фильтры — не два равновесных контрола: фильтры —
 *   иконка-кнопка с бейджем числа активных, сортировка — компактный сегмент.
 * - F4: чипсы двумя группами — «Быстрые» (пресеты) и «Мои сигналы» (🔔).
 * - F10: пустое состояние — с кнопкой «Сбросить фильтры», тексты из
 *   03-content-a11y §2.1.
 *
 * Viewport-scroll (жалоба «лента растягивает окно до бесконечности»):
 * лента живёт в ограниченной области — .feed-viewport занимает высоту
 * app-content (app-shell при активной ленте — 100dvh, body скроллится
 * заблокирован классом .feed-locked), суббар прилипает сверху области,
 * ниже — .feed-scroll (flex:1, overflow-y:auto, свой тонкий скроллбар).
 * ВСЯ прокрутка ленты происходит внутри этой области, страница не
 * растягивается. .feed-locked вешается на body ТОЛЬКО пока лента активна:
 * keep-alive прячет её display:none, и на PDP/профиле окно скроллится
 * как раньше. Пагинация — бесконечный скролл (IntersectionObserver с
 * root = контейнер прокрутки + фолбэк по близости к низу области),
 * keyset-курсор offset как раньше; кэш возврата из карточки сохранён.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { createPortal } from "react-dom";

import { api } from "../api/client";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { ListingCard } from "../components/ListingCard";
import { SkeletonList } from "../ui/Skeleton";
import { EmptyState, ErrorState } from "../ui/States";
import { digits } from "../lib/fx";
import { FEED_COUNTRIES } from "../lib/geo";
import {
  BODIES,
  COLORS,
  DRIVES,
  FUELS,
  TRANSMISSIONS,
} from "../lib/specs";

/** Типичные объёмы двигателей, л (селекты «от/до», как на avtokorea.by). */
const VOLUMES = ["0.8", "1.0", "1.4", "1.6", "2.0", "2.5", "3.0", "3.5", "4.0", "5.0", "6.0"];
import type { Listing, ListingList, UserFilter } from "../api/types";

/** Ключи сортировки ленты (PLP-стандарт e-commerce). */
type SortKey = "new" | "price_asc" | "price_desc" | "mileage_asc" | "year_desc";

const SORTS: { key: SortKey; label: string; counter: string }[] = [
  { key: "new", label: "Новые", counter: "новые сверху" },
  { key: "price_asc", label: "Цена ↑", counter: "дешёвые сверху" },
  { key: "price_desc", label: "Цена ↓", counter: "дорогие сверху" },
  { key: "mileage_asc", label: "Пробег ↑", counter: "малый пробег" },
  { key: "year_desc", label: "Год ↓", counter: "свежие годы" },
];

const PAGE_SIZE = 20;

/**
 * Критерии ленты. Цены — в $ (как на экране фильтров и в deep-link):
 * контракт GET /listings — сравнение по usd_price, бэк сам нормализует
 * валюту источников (listings_read._usd_price_expr). Конвертации на фронте
 * НЕТ (BF-01: ×1350 ломал ценовые фильтры — пресеты шла вонах при
 * долларовом сравнении на бэке).
 */
interface FeedQuery {
  make?: string;
  model?: string;
  yearFrom?: string;
  yearTo?: string;
  priceMin?: string;
  priceMax?: string;
  mileageMin?: string;
  mileageMax?: string;
  volumeMin?: string;
  volumeMax?: string;
  color?: string;
  bodyType?: string;
  fuel?: string;
  transmission?: string;
  drive?: string;
  source?: string;
  /** Страна источника (GEO-V1 §2): ISO2, одна страна (CSV не нужен). */
  country?: string;
}

/** Чипс ленты: пресет («Быстрые») или сохранённая подписка («Мои сигналы»). */
interface Chip {
  key: string;
  label: string;
  query: FeedQuery;
}

/** Редкие критерии шита фильтров (закон Хика): цвет/привод/объём/кузов/
 *  КПП/источник по умолчанию спрятаны за «Ещё параметры» — видимый выбор
 *  короче, редкие настройки открывают осознанно. */
const RARE_FIELDS: (keyof FeedQuery)[] = [
  "fuel",
  "transmission",
  "bodyType",
  "drive",
  "volumeMin",
  "volumeMax",
  "color",
  "source",
];

const hasRare = (q: FeedQuery): boolean => RARE_FIELDS.some((k) => q[k]);

const PRESETS: Chip[] = [
  { key: "all", label: "Все", query: {} },
  { key: "p10", label: "до $10 000", query: { priceMax: "10000" } },
  { key: "p10_20", label: "$10–20 тыс.", query: { priceMin: "10000", priceMax: "20000" } },
  { key: "p20_30", label: "$20–30 тыс.", query: { priceMin: "20000", priceMax: "30000" } },
  { key: "p30", label: "от $30 000", query: { priceMin: "30000" } },
  { key: "y2022", label: "2022+", query: { yearFrom: "2022" } },
  { key: "y18_21", label: "2018–2021", query: { yearFrom: "2018", yearTo: "2021" } },
  { key: "m60", label: "до 60 тыс. км", query: { mileageMax: "60000" } },
  { key: "m100", label: "до 100 тыс. км", query: { mileageMax: "100000" } },
];

/** F4: пресеты и подписки — две разные группы чипсов, а не один ряд. */
function buildChips(filters: UserFilter[]): { presets: Chip[]; signals: Chip[] } {
  const signals: Chip[] = filters.map((f) => {
    const c = f.criteria;
    return {
      key: `f${f.id}`,
      // Безымянная подписка — как на экране «Сигналы» (единый словарь IA)
      label: f.name ?? `Сигнал #${f.id}`,
      query: {
        make: c.make,
        model: c.model,
        yearFrom: c.year_from !== undefined ? String(c.year_from) : undefined,
        yearTo: c.year_to !== undefined ? String(c.year_to) : undefined,
        priceMin: c.price_min !== undefined ? String(c.price_min) : undefined,
        priceMax: c.price_max !== undefined ? String(c.price_max) : undefined,
        mileageMax: c.mileage_max !== undefined ? String(c.mileage_max) : undefined,
      },
    };
  });
  return { presets: PRESETS, signals };
}

function sameQuery(a: FeedQuery, b: FeedQuery): boolean {
  const keys: Array<keyof FeedQuery> = [
    "make",
    "model",
    "yearFrom",
    "yearTo",
    "priceMin",
    "priceMax",
    "mileageMin",
    "mileageMax",
    "volumeMin",
    "volumeMax",
    "color",
    "bodyType",
    "fuel",
    "transmission",
    "drive",
    "source",
    "country",
  ];
  return keys.every((k) => a[k] === b[k]);
}

const activeFields = (q: FeedQuery): number =>
  Object.values(q).filter((v) => v !== undefined && v !== "").length;

/** Query-параметры GET /listings из критериев ленты (+ сортировка/лимиты).
 *  Цены — в $ как есть (BF-01): бэк сравнивает по нормализованному
 *  usd_price, конвертация на фронте давала фильтры ×1350. */
function buildListParams(q: FeedQuery, sort: SortKey, offset: number, limit: number) {
  const params = new URLSearchParams();
  if (q.make) params.set("make", q.make);
  if (q.model) params.set("model", q.model);
  if (q.yearFrom) params.set("year_from", q.yearFrom);
  if (q.yearTo) params.set("year_to", q.yearTo);
  if (q.priceMin) params.set("price_min", q.priceMin);
  if (q.priceMax) params.set("price_max", q.priceMax);
  if (q.mileageMax) params.set("mileage_max", q.mileageMax);
  if (q.mileageMin) params.set("mileage_min", q.mileageMin);
  if (q.volumeMin) params.set("engine_volume_min", q.volumeMin);
  if (q.volumeMax) params.set("engine_volume_max", q.volumeMax);
  if (q.color) params.set("color", q.color);
  if (q.bodyType) params.set("body_type", q.bodyType);
  if (q.fuel) params.set("fuel", q.fuel);
  if (q.transmission) params.set("transmission", q.transmission);
  if (q.drive) params.set("drive", q.drive);
  if (q.source) params.set("source", q.source);
  if (q.country) params.set("country", q.country);
  params.set("sort", sort);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return params;
}

/**
 * Кэш ленты: возврат из карточки по «Назад» восстанавливает фильтры,
 * сортировку, список и позицию скролла (стандарт e-commerce каталога).
 * scrollY — позиция прокрутки ВНУТРИ области (.feed-scroll.scrollTop).
 */
interface FeedCache {
  query: FeedQuery;
  sort: SortKey;
  items: Listing[];
  total: number;
  offset: number;
  scrollY: number;
}
let feedCache: FeedCache | null = null;
// Первый монтаж ленты в жизни модуля НИКОГДА не восстанавливает кэш:
// useNavigationType() на старте приложения и так возвращает "POP", и без
// этого флага свежий визит (и каждый рендер App в тестах) подхватывал бы
// протухший кэш вместо загрузки. В приложении лента живёт в keep-alive и
// не размонтируется, так что восстановление реально только внутри сессии.
let feedMountedOnce = false;

/** Сброс кэша (для тестов и принудительного обновления). */
export function resetFeedCache(): void {
  feedCache = null;
  feedMountedOnce = false;
}

/**
 * Deep-link из бота («Открыть в ленте с фильтром») и из AI-поиска (A2):
 * /feed?make=Kia&model=Sorento&year_from=2020&price_max=25000&mileage_max=80000.
 * Читается при монтировании И при появлении параметров на смонтированном
 * экране (лента живёт в keep-alive и не размонтируется); query из URL
 * вычищается на месте применения (router-навигацией replace), чтобы
 * рефреш/навигация не переактивировали фильтр повторно.
 * Известны ТОЛЬКО feed-ключи: чужие query (?tab=, /calc?price=, ?similar=)
 * возвращают пустой набор и НЕ применяются (BF-02). Цены — в $, как в
 * FeedQuery (и уходят в запрос как есть).
 */
function deepLinkQuery(search: string): FeedQuery {
  const sp = new URLSearchParams(search);
  if (![...sp.keys()].length) return {};
  const pick = (k: string): string | undefined => sp.get(k) || undefined;
  const entries: Partial<Record<keyof FeedQuery, string>> = {
    make: pick("make"),
    model: pick("model"),
    yearFrom: pick("year_from"),
    yearTo: pick("year_to"),
    priceMin: pick("price_min"),
    priceMax: pick("price_max"),
    mileageMax: pick("mileage_max"),
    mileageMin: pick("mileage_min"),
    volumeMin: pick("volume_min"),
    volumeMax: pick("volume_max"),
    color: pick("color"),
    bodyType: pick("body_type"),
    fuel: pick("fuel"),
    transmission: pick("transmission"),
    drive: pick("drive"),
    source: pick("source"),
    country: pick("country"),
  };
  return Object.fromEntries(
    Object.entries(entries).filter(([, v]) => v !== undefined && v !== ""),
  ) as FeedQuery;
}

/** Лента активна (видима, не спрятана keep-alive): путь — ровно таб ленты. */
function isFeedTab(pathname: string): boolean {
  const p = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return p === "/" || p === "";
}

export function FeedScreen({ inactive = false }: { inactive?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const navType = useNavigationType(); // POP = назад/вперёд по истории
  const restore = useRef(
    feedMountedOnce && navType === "POP" ? feedCache : null,
  );
  feedMountedOnce = true;
  const [items, setItems] = useState<Listing[]>(() => restore.current?.items ?? []);
  const [total, setTotal] = useState(() => restore.current?.total ?? 0);
  const [loading, setLoading] = useState(() => !restore.current);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chips, setChips] = useState<{ presets: Chip[]; signals: Chip[] }>({
    presets: PRESETS,
    signals: [],
  });
  /** Deep-link с первого рендера (если был): после монтажа вычистим query
   *  и из router-state (BF-10) — см. эффект ниже. */
  const initialDeepLink = useRef<FeedQuery>({});
  const [query, setQuery] = useState<FeedQuery>(() => {
    if (restore.current) return restore.current.query;
    const dl = deepLinkQuery(location.search);
    initialDeepLink.current = dl;
    return dl;
  });
  const [sort, setSort] = useState<SortKey>(() => restore.current?.sort ?? "new");
  const [panelOpen, setPanelOpen] = useState(false);
  /** Хик: редкие поля шита свёрнуты; авто-раскрытие — если уже активны. */
  const [moreOpen, setMoreOpen] = useState(false);
  const [draft, setDraft] = useState<FeedQuery>({});
  /** F2: живой счётчик в футере шита (GET /listings?…&limit=1, total). */
  const [panelCount, setPanelCount] = useState<number | null>(null);
  // Фасеты для зависимых селектов марка→модель (как на avtokorea.by)
  const [makes, setMakes] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [showTop, setShowTop] = useState(() => (restore.current?.scrollY ?? 0) > 1600);
  const offsetRef = useRef(restore.current?.offset ?? 0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /** Контейнер прокрутки ленты (.feed-scroll): весь скролл — внутри него. */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const filtersBtnRef = useRef<HTMLButtonElement | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const sortRef = useRef(sort);
  sortRef.current = sort;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const totalRef = useRef(total);
  totalRef.current = total;
  const scrollYRef = useRef(restore.current?.scrollY ?? 0);
  // refs для авто-подгрузки: слушатели скролла/IO читают свежие значения
  const busyRef = useRef(false);
  const errorRef = useRef(false);

  // Viewport-scroll: пока лента АКТИВНА (не спрятана keep-alive), скролл
  // страницы запрещён — прокрутка происходит внутри .feed-scroll. Уходим на
  // PDP/другой таб ИЛИ на сегмент AI внутри Главной (NAV-V2, проп inactive) —
  // класс снимается, окно снова скроллится как раньше.
  const feedActive = !inactive && isFeedTab(location.pathname);
  useEffect(() => {
    if (!feedActive) {
      // Лента спрятана keep-alive (другой таб/PDP), а шит фильтров — в
      // portal на document.body: без закрытия scrim и шит остались бы
      // висеть над чужим экраном (клавиатурная навигация/Back при
      // открытом шите). Закрываем при уходе с ленты.
      setPanelOpen(false);
      return;
    }
    document.body.classList.add("feed-locked");
    return () => document.body.classList.remove("feed-locked");
  }, [feedActive]);

  // Динамические чипсы: пресеты + сохранённые фильтры (ТЗ §2.2).
  // BF-15: лента живёт в keep-alive — после апгрейда гостя (autobot:auth)
  // /filters перечитываем, иначе чипсы 🔔 «Мои сигналы» не появятся до F5.
  const loadChips = useCallback(() => {
    api<UserFilter[]>("/filters")
      .then((filters) => setChips(buildChips(filters)))
      .catch(() => setChips(buildChips([])));
  }, []);
  useEffect(() => {
    loadChips();
    const onAuth = () => loadChips();
    window.addEventListener("autobot:auth", onAuth);
    return () => window.removeEventListener("autobot:auth", onAuth);
  }, [loadChips]);

  /** Счётчик запросов (BF-07): ответ устаревшего запроса (фильтр сменился
   *  во время полёта догрузки/перезагрузки) игнорируется — чужие карточки
   *  не приклеиваются к новому списку, busy/loading сбрасывает только
   *  актуальный запрос. */
  const loadSeq = useRef(0);

  const load = useCallback(async (q: FeedQuery, reset: boolean) => {
    const seq = ++loadSeq.current;
    busyRef.current = true;
    if (reset) setLoading(true);
    else setLoadingMore(true);
    setError(null);
    errorRef.current = false;
    try {
      const params = buildListParams(q, sortRef.current, reset ? 0 : offsetRef.current, PAGE_SIZE);
      const data = await api<ListingList>(`/listings?${params.toString()}`);
      if (seq !== loadSeq.current) return; // гонка: актуален уже другой запрос
      setTotal(data.total);
      setItems((prev) => (reset ? data.items : [...prev, ...data.items]));
      offsetRef.current = reset ? data.items.length : offsetRef.current + data.items.length;
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError((e as Error).message);
      errorRef.current = true;
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false);
        setLoadingMore(false);
        busyRef.current = false;
      }
    }
    // sort в deps: смена сортировки перезагружает ленту с первой страницы
  }, [sort]);

  useEffect(() => {
    if (restore.current) return; // возврат по «Назад» — лента уже восстановлена
    void load(query, true);
  }, [query, load]);

  // Deep-link на уже смонтированной ленте: экран живёт в keep-alive и не
  // размонтируется при переходах, поэтому критерии из URL применяем при
  // каждом их появлении — иначе «Показать в ленту» из AI-поиска (A2) и
  // ссылки из бота молча игнорировались бы после первого рендера.
  // BF-02: применяем ТОЛЬКО известные feed-ключи и только на пути ленты:
  // чужие query (?tab=, /calc?price=, ?similar=) дают пустой набор и
  // фильтры ленты не сбрасывают (раньше setQuery({}) обнулял их).
  const appliedSearch = useRef(location.search);
  useEffect(() => {
    if (location.search === appliedSearch.current) return;
    appliedSearch.current = location.search;
    if (!location.search || !isFeedTab(location.pathname)) return;
    const clean = deepLinkQuery(location.search);
    if (!Object.keys(clean).length) return; // только чужие ключи — игнор
    setQuery(clean);
    // BF-10: вычищаем query и из router-state (replace), а не только из
    // window.history: иначе роутер «думает», что search не изменился, и
    // повторный deep-link с теми же критериями молча игнорируется.
    navigate(location.pathname, { replace: true });
  }, [location.search, location.pathname, navigate]);

  // Deep-link с первого рендера потреблён в инициализаторе query — чистим
  // query и в router-state (BF-10, ветка монтажа), чтобы appliedSearch выше
  // был синхронен с реальным URL с самого старта.
  useEffect(() => {
    if (!Object.keys(initialDeepLink.current).length) return;
    navigate(location.pathname, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только монтаж
  }, []);

  // Возврат из карточки: восстановить позицию скролла ОБЛАСТИ ленты
  // (window больше не скроллится — крутится .feed-scroll)
  useEffect(() => {
    if (!restore.current) return;
    const y = restore.current.scrollY;
    restore.current = null; // дальше — обычная логика
    const t = window.setTimeout(() => scrollRef.current?.scrollTo?.(0, y), 50);
    return () => window.clearTimeout(t);
  }, []);

  // Скролл области: позиция для кэша + кнопка «Наверх» после пары экранов
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      scrollYRef.current = el.scrollTop;
      setShowTop(el.scrollTop > 1600);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      // Сохраняем ленту на выходе — «Назад» из карточки вернёт как было
      feedCache = {
        query: queryRef.current,
        sort: sortRef.current,
        items: itemsRef.current,
        total: totalRef.current,
        offset: offsetRef.current,
        scrollY: scrollYRef.current,
      };
    };
  }, []);

  // Бесконечный скролл «как в Instagram»: лента сама догружается, когда
  // пользователь приближается к концу ОБЛАСТИ. Два триггера: сентинел в
  // видимой части контейнера (IntersectionObserver, root = .feed-scroll —
  // прокрутка идёт внутри области, а не окна) и близость к низу области
  // (фолбэк для вьюпортов, где IO ведёт себя капризно).
  const loadMore = useCallback(() => {
    if (busyRef.current || errorRef.current) return;
    if (itemsRef.current.length >= totalRef.current) return;
    void load(queryRef.current, false);
  }, [load]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      {
        // root — контейнер прокрутки ленты (передаём элемент области):
        // без root наблюдается окно, и сентинел глубоко в скролл-области
        // срабатывал бы неверно (в jsdom/старых WebView).
        root: scrollRef.current ?? null,
        rootMargin: "800px", // начинаем грузить заранее, до конца списка
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 1200;
      if (nearBottom) loadMore();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [loadMore]);

  const activeChip =
    [...chips.presets, ...chips.signals].find((c) => sameQuery(c.query, query))?.key ?? "";
  const activeCount = activeFields(query);
  /** Внутренний рынок (ТЗ §1): toggle-чипс source=market в критериях
   *  ленты (buildListParams уже прокидывает source в GET /listings). */
  const marketOn = query.source === "market";

  const retry = useCallback(() => {
    void load(queryRef.current, items.length === 0);
  }, [load, items.length]);

  /** F2: живой счётчик «N авто найдено» в футере шита — total по черновику
   *  критериев (debounce 350мс, limit=1 — сами карточки не тянем). */
  useEffect(() => {
    if (!panelOpen) return;
    setPanelCount(null);
    const t = window.setTimeout(() => {
      const params = buildListParams(draft, sort, 0, 1);
      api<ListingList>(`/listings?${params.toString()}`)
        .then((d) => setPanelCount(d.total))
        .catch(() => setPanelCount(null));
    }, 350);
    return () => window.clearTimeout(t);
  }, [panelOpen, draft, sort]);

  // Esc закрывает шит, фокус возвращается на кнопку «Фильтры» (03 §5.3)
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPanelOpen(false);
        filtersBtnRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    filtersBtnRef.current?.focus();
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpen((v) => {
      if (!v) {
        setDraft(queryRef.current); // открыть с текущими значениями
        // редкие критерии уже активны — показываем их сразу, не прячем
        setMoreOpen(hasRare(queryRef.current));
        // Марки грузим один раз при первом открытии панели
        if (makes.length === 0) {
          api<{ makes: string[] }>("/listings/facets")
            .then((r) => setMakes(r.makes ?? []))
            .catch(() => setMakes([]));
        }
        // Модели — под выбранную марку
        const mk = queryRef.current.make;
        if (mk) {
          api<{ models: string[] }>(
            `/listings/facets?make=${encodeURIComponent(mk)}`,
          )
            .then((r) => setModels(r.models ?? []))
            .catch(() => setModels([]));
        } else {
          setModels([]);
        }
      }
      return !v;
    });
  }, [makes.length]);

  const setField =
    (key: keyof FeedQuery, numeric = false) =>
    (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const raw = numeric ? digits(e.target.value) : e.target.value;
      setDraft((d) => ({ ...d, [key]: raw || undefined }));
    };

  const applyPanel = useCallback(() => {
    setQuery(draft);
    setPanelOpen(false);
  }, [draft]);

  const resetPanel = useCallback(() => {
    setDraft({});
    setQuery({});
  }, []);

  // F10: сброс из пустого состояния
  const resetQuery = useCallback(() => setQuery({}), []);

  // «Наверх» крутит контейнер области (не окно); при prefers-reduced-motion
  // без плавного скролла (03-content-a11y §5.1)
  const scrollTop = useCallback(() => {
    const el = scrollRef.current;
    if (!el?.scrollTo) return;
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }, []);

  return (
    <div className="feed-viewport" data-testid="feed-viewport">
      {/* Область прокрутки: суббар прилипает к её верхнему краю (sticky),
          карточки/состояния листаются внутри; при открытом шите фильтров
          область блокируется (feed-scroll--locked) — фон не скроллится
          под шитом (двойной скролл исчезает) */}
      <div
        ref={scrollRef}
        className={panelOpen ? "feed-scroll feed-scroll--locked" : "feed-scroll"}
        data-testid="feed-scroll"
        tabIndex={0}
        aria-label="Лента объявлений"
      >
        {/* F1: шапка — суббар в одну строку + чипсы вторым рядом (без
            отдельного ряда-заголовка: до 25% первого экрана уходило на управление) */}
        <div className="feed-head">
          <div className="feed-head__row">
            <button
              ref={filtersBtnRef}
              className={panelOpen || activeCount > 0 ? "feed-toggle feed-toggle--on" : "feed-toggle"}
              onClick={togglePanel}
              aria-expanded={panelOpen}
              aria-controls="feed-panel"
            >
              Фильтры{activeCount > 0 ? ` · ${activeCount}` : ""}
            </button>
            {/* F3: сортировка — компактный сегмент, значение видно на контроле */}
            <select
              className="feed-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Сортировка"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            {/* Счётчик-eyebrow (F1, типографика §3.2): 13/500 caps-трекинг,
                tabular-nums — не огромный заголовок, а тихая подпись справа */}
            {!loading && !error && (
              <span className="feed-head__count tabular">
                {total.toLocaleString("ru")} авто ·{" "}
                {SORTS.find((s) => s.key === sort)?.counter ?? "новые сверху"}
              </span>
            )}
          </div>
          {/* F4: две группы — «Быстрые» (пресеты) и «Мои сигналы» (🔔) */}
          <div className="feed-head__chips" role="group" aria-label="Быстрые фильтры и мои сигналы">
            {chips.presets.map((c) => (
              <button
                key={c.key}
                className={c.key === activeChip ? "chip chip--active" : "chip"}
                onClick={() => setQuery(c.query)}
              >
                {c.label}
              </button>
            ))}
            {/* Чипс-переключатель «🏪 Рынок»: source=market (витрина
                партнёров, INNER JOIN partner_offers на бэке); второй клик
                снимает фильтр, остальные критерии сохраняются */}
            <button
              key="market"
              className={marketOn ? "chip chip--active" : "chip"}
              aria-pressed={marketOn}
              onClick={() =>
                setQuery((q) => ({ ...q, source: marketOn ? undefined : "market" }))
              }
            >
              🏪 Рынок
            </button>
            {/* Быстрые чипсы-стран (GEO-V1 §3): флаг + имя, toggle как рынок
                (повторный клик снимает), остальные критерии не трогает */}
            {FEED_COUNTRIES.map((c) => {
              const on = query.country === c.code;
              return (
                <button
                  key={c.code}
                  className={on ? "chip chip--active" : "chip"}
                  aria-pressed={on}
                  onClick={() =>
                    setQuery((q) => ({ ...q, country: on ? undefined : c.code }))
                  }
                >
                  <span aria-hidden="true">{c.flag}</span> {c.name}
                </button>
              );
            })}
            {chips.signals.map((c) => (
              <button
                key={c.key}
                className={c.key === activeChip ? "chip chip--active" : "chip"}
                onClick={() => setQuery(c.query)}
              >
                <span aria-hidden="true">🔔</span> {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Пустые/ошибочные состояния — по центру области прокрутки,
            а не «в никуда» под шапкой */}
        {!loading && error && items.length === 0 && (
          <div className="feed-states">
            <ErrorState
              description="Не удалось загрузить ленту. Проверьте интернет и попробуйте ещё раз."
              onRetry={retry}
            />
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="feed-states">
            <EmptyState
              title="Ничего не найдено"
              description="Под ваши фильтры машин сейчас нет. Сбросьте часть условий или расширьте диапазон цены."
              actionLabel="Сбросить фильтры"
              onAction={resetQuery}
            />
          </div>
        )}

        <div className="feed-grid">
          {items.map((l) => (
            <ListingCard key={l.id} listing={l} />
          ))}

          {loading && <SkeletonList count={4} />}
        </div>

        {/* Сентинел бесконечного скролла (наблюдается относительно .feed-scroll) */}
        <div ref={sentinelRef} className="feed-sentinel" />
        {loadingMore && (
          <div className="feed-more">
            <SkeletonList count={1} />
          </div>
        )}

        {/* Ошибка подгрузки: лента не должна молча останавливаться */}
        {!loading && !loadingMore && error && items.length > 0 && (
          <div className="feed-more feed-more--error">
            <span>Не удалось загрузить следующие объявления</span>
            <button
              className="feed-more__btn"
              onClick={() => void load(query, false)}
            >
              Повторить
            </button>
          </div>
        )}

        {!loading && !error && items.length >= total && items.length > 0 && (
          <div className="state feed-end">
            Показаны все найденные варианты
          </div>
        )}
      </div>

      {/* F2: панель фильтров — bottom-sheet (scrim + прилипающий футер).
          Portal в body: обёртка keep-alive держит transform после входной
          анимации экрана, и fixed-шит позиционировался бы относительно
          колонки контента (на десктопе уезжал влево, scrim не накрывал
          сайдбар) — теперь координаты всегда от вьюпорта */}
      {panelOpen &&
        createPortal(
          <>
            <div className="feed-sheet__scrim" onClick={closePanel} aria-hidden="true" />
            <div
              className="feed-sheet"
              id="feed-panel"
              role="dialog"
              aria-modal="true"
              aria-label="Фильтры ленты"
            >
              <div className="feed-sheet__head">
                <span className="feed-sheet__handle" aria-hidden="true" />
                <h3 className="feed-sheet__title">Фильтры</h3>
                <button className="feed-sheet__close" aria-label="Закрыть" onClick={closePanel}>
                  ✕
                </button>
              </div>
              <div className="feed-sheet__body">
                {/* Хик/гештальт: поля сгруппированы секциями с подписями —
                    «Авто / Цена и год / Пробег», а не один длинный список */}
                <div className="feed-panel__section" aria-hidden="true">Авто</div>
                <label className="feed-panel__field feed-panel__field--wide">
                  <span>Марка</span>
                  <select
                    value={draft.make ?? ""}
                    onChange={(e) => {
                      const mk = e.target.value || undefined;
                      setDraft((d) => ({ ...d, make: mk, model: undefined }));
                      if (mk) {
                        api<{ models: string[] }>(
                          `/listings/facets?make=${encodeURIComponent(mk)}`,
                        )
                          .then((r) => setModels(r.models ?? []))
                          .catch(() => setModels([]));
                      } else {
                        setModels([]);
                      }
                    }}
                  >
                    <option value="">Любая марка</option>
                    {makes.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="feed-panel__field feed-panel__field--wide">
                  <span>Модель</span>
                  <select
                    value={draft.model ?? ""}
                    onChange={setField("model")}
                    disabled={!draft.make}
                  >
                    <option value="">
                      {draft.make ? "Любая модель" : "Сначала выберите марку"}
                    </option>
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                {/* Страна источника (GEO-V1 §3): сегмент один-выбор + «Все»;
                    те же пять стран, что и в быстрых чипсах над лентой */}
                <div className="feed-panel__section" aria-hidden="true">Страна</div>
                <div
                  className="feed-panel__pair feed-panel__pair--chips"
                  role="group"
                  aria-label="Страна"
                >
                  <button
                    type="button"
                    className={!draft.country ? "chip chip--active" : "chip"}
                    aria-pressed={!draft.country}
                    onClick={() => setDraft((d) => ({ ...d, country: undefined }))}
                  >
                    Все
                  </button>
                  {FEED_COUNTRIES.map((c) => (
                    <button
                      key={c.code}
                      type="button"
                      className={draft.country === c.code ? "chip chip--active" : "chip"}
                      aria-pressed={draft.country === c.code}
                      onClick={() => setDraft((d) => ({ ...d, country: c.code }))}
                    >
                      <span aria-hidden="true">{c.flag}</span> {c.name}
                    </button>
                  ))}
                </div>
                <div className="feed-panel__section" aria-hidden="true">Цена и год</div>
                <label className="feed-panel__field">
                  <span>Цена $ от</span>
                  <input
                    inputMode="numeric"
                    value={draft.priceMin ?? ""}
                    onChange={setField("priceMin", true)}
                    placeholder="5 000"
                  />
                </label>
                <label className="feed-panel__field">
                  <span>Цена $ до</span>
                  <input
                    inputMode="numeric"
                    value={draft.priceMax ?? ""}
                    onChange={setField("priceMax", true)}
                    placeholder="30 000"
                  />
                </label>
                <label className="feed-panel__field">
                  <span>Год от</span>
                  <input
                    inputMode="numeric"
                    value={draft.yearFrom ?? ""}
                    onChange={setField("yearFrom", true)}
                    placeholder="2019"
                  />
                </label>
                <label className="feed-panel__field">
                  <span>Год до</span>
                  <input
                    inputMode="numeric"
                    value={draft.yearTo ?? ""}
                    onChange={setField("yearTo", true)}
                    placeholder="2024"
                  />
                </label>
                <div className="feed-panel__section" aria-hidden="true">Пробег</div>
                <label className="feed-panel__field">
                  <span>Пробег, км — не менее</span>
                  <input
                    inputMode="numeric"
                    value={draft.mileageMin ?? ""}
                    onChange={setField("mileageMin", true)}
                    placeholder="10 000"
                  />
                </label>
                <label className="feed-panel__field">
                  <span>Пробег, км — не более</span>
                  <input
                    inputMode="numeric"
                    value={draft.mileageMax ?? ""}
                    onChange={setField("mileageMax", true)}
                    placeholder="100 000"
                  />
                </label>
                {/* Прогрессивное раскрытие (Хик): редкие поля свёрнуты;
                    кнопка — полноценная тач-зона 44px (стили .feed-panel__more) */}
                <button
                  type="button"
                  className="feed-panel__more"
                  aria-expanded={moreOpen}
                  aria-controls="feed-panel-more"
                  onClick={() => setMoreOpen((v) => !v)}
                >
                  Ещё параметры {moreOpen ? "▴" : "▾"}
                </button>
                {moreOpen && (
                <div id="feed-panel-more" className="feed-panel__extra">
                <div className="feed-panel__pair">
                  <label className="feed-panel__field">
                    <span>Топливо</span>
                    <select value={draft.fuel ?? ""} onChange={setField("fuel")}>
                      {FUELS.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="feed-panel__field">
                    <span>КПП</span>
                    <select
                      value={draft.transmission ?? ""}
                      onChange={setField("transmission")}
                    >
                      {TRANSMISSIONS.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="feed-panel__pair">
                  <label className="feed-panel__field">
                    <span>Кузов</span>
                    <select value={draft.bodyType ?? ""} onChange={setField("bodyType")}>
                      {BODIES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="feed-panel__field">
                    <span>Привод</span>
                    <select value={draft.drive ?? ""} onChange={setField("drive")}>
                      {DRIVES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="feed-panel__pair">
                  <label className="feed-panel__field">
                    <span>Объём, л — от</span>
                    <select value={draft.volumeMin ?? ""} onChange={setField("volumeMin")}>
                      <option value="">Любой</option>
                      {VOLUMES.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="feed-panel__field">
                    <span>Объём, л — до</span>
                    <select value={draft.volumeMax ?? ""} onChange={setField("volumeMax")}>
                      <option value="">Любой</option>
                      {VOLUMES.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="feed-panel__field">
                  <span>Цвет</span>
                  <select value={draft.color ?? ""} onChange={setField("color")}>
                    {COLORS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="feed-panel__field">
                  <span>Источник</span>
                  <select value={draft.source ?? ""} onChange={setField("source")}>
                    <option value="">Любой</option>
                    <option value="encar">Encar</option>
                    <option value="kcar">Kcar</option>
                  </select>
                </label>
                </div>
                )}
              </div>
              <div className="feed-sheet__foot">
                {/* Живой счётчик по черновику критериев (F2): строка
                    зарезервирована (min-height) — layout не дёргается */}
                <span className="feed-sheet__count tabular" aria-live="polite">
                  {panelCount != null ? `${panelCount.toLocaleString("ru")} авто найдено` : ""}
                </span>
                <div className="feed-sheet__actions">
                  <button className="feed-sheet__apply" onClick={applyPanel}>
                    Применить
                  </button>
                  <button className="feed-sheet__reset" onClick={resetPanel}>
                    Сбросить
                  </button>
                </div>
              </div>
            </div>
          </>,
          document.body,
        )}

      {/* Кнопка «Наверх» — после пары экранов прокрутки области */}
      {showTop && (
        <button className="to-top" aria-label="Наверх" onClick={scrollTop}>
          ↑
        </button>
      )}
    </div>
  );
}
