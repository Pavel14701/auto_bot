/** Корневой компонент: авторизация, онбординг, навигация (UI/UX ТЗ §2.1). */

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppRoot } from "@telegram-apps/telegram-ui";

import { applyTheme, subscribeTheme, watchSystemTheme, type Appearance } from "./lib/theme";

import { authorize, guestLogin, isGuest, clearGuest, getWebApp, isTelegramContext } from "./api/auth";
import { api, getAccessToken, setSessionExpiredHandler } from "./api/client";
import { addView } from "./lib/viewHistory";
import { LoginScreen } from "./screens/Login";
import { ListingScreen } from "./screens/Listing";
import { FiltersScreen } from "./screens/Filters";
import { CalcScreen } from "./screens/Calc";
import { CompareScreen } from "./screens/Compare";
import { ProfileScreen } from "./screens/Profile";
import { HomeScreen } from "./screens/Home";
import { AutoScreen } from "./screens/Auto";
import { SellCarScreen, SellFab } from "./screens/SellCar";
import { OnboardingScreen } from "./screens/Onboarding";
import { ChatsScreen } from "./screens/Chats";
import { Landing, chooseSurface } from "./screens/Landing";
import { Shell } from "./components/Shell";
import { ToastProvider } from "./ui/Toast";
import { LoginPromptProvider } from "./ui/LoginPrompt";
import { PartnerApp } from "./partner/PartnerApp";
import { AdminApp } from "./admin/AdminApp";
import type { User as UserT } from "./api/types";

/** Отдельные поверхности: партнёрский ЛК и админка — вне Telegram-гейта. */
function SurfaceRouter() {
  const path = window.location.pathname;
  if (path.startsWith("/partner")) {
    return (
      <ToastProvider>
        <PartnerApp />
      </ToastProvider>
    );
  }
  if (path.startsWith("/admin")) {
    return (
      <ToastProvider>
        <AdminApp />
      </ToastProvider>
    );
  }
  return null;
}


type AuthState = "loading" | "ready";

/**
 * Deep-link из карточки в чате: t.me/<bot>?startapp=listing_<id>
 * → открываем лот в вебаппе. Только внутри BrowserRouter (нужен useNavigate).
 */
function StartParamRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    const sp = getWebApp()?.initDataUnsafe?.start_param;
    if (!sp) return;
    const m = /^listing[_-]?(\d+)$/.exec(sp);
    if (m) navigate(`/listing/${m[1]}`, { replace: true });
  }, [navigate]);
  return null;
}

/** Скролл при навигации (01-ux-audit §3.4): карточка лота — стек поверх
 *  табов, открывается от шапки (а не «серединой» с прошлой позиции);
 *  позиции скролла таб-экранов (keep-alive) сохраняем на время ухода и
 *  восстанавливаем при возврате — как в нативных таб-приложениях. */
function ScrollManager() {
  const { pathname } = useLocation();
  const prevPath = useRef(pathname);
  const tabScroll = useRef(new Map<string, number>());
  useEffect(() => {
    const from = prevPath.current;
    prevPath.current = pathname;
    if (from === pathname) return;
    if (KEEPALIVE_TABS.some((t) => t.path === from)) {
      tabScroll.current.set(from, window.scrollY);
    }
    // возврат на таб — своя сохранённая позиция; вход в стек (листинг) — сверху
    window.scrollTo(0, tabScroll.current.get(pathname) ?? 0);
  }, [pathname]);
  return null;
}

/** Реакция на ширину окна для mobile/desktop переключения. */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 768);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

// ---------- Keep-alive таб-экранов (сохранение состояния вкладок) ----------

/** Таб-экраны для keep-alive: монтируются при первом заходе и дальше живут
 *  до конца сессии — фильтры ленты, AI-чат, избранное и история не
 *  теряются при переключении вкладок. Листинги (/listing/*) сюда НЕ входят:
 *  это стек поверх табов, они ходят через обычный <Routes>.
 *  Табы NAV-V2: Главная (/, Лента|AI — Home), Авто (/auto, Избранное|
 *  История|Мои — Auto), Чаты, Профиль. /filters, /calc, /compare —
 *  стек-экраны в keep-alive (без места в таб-баре, ссылки из Ленты и
 *  Профиля). /chats/:id — оверлей комнаты: держит активным таб /chats. */
const KEEPALIVE_TABS = [
  { path: "/", Component: HomeScreen },
  { path: "/auto", Component: AutoScreen },
  { path: "/filters", Component: FiltersScreen },
  { path: "/calc", Component: CalcScreen },
  { path: "/compare", Component: CompareScreen },
  { path: "/profile", Component: ProfileScreen },
  { path: "/chats", Component: ChatsScreen },
] as const;

/** Активный таб-путь для pathname: точное совпадение (без хвостового
 *  слэша); /listing/* и мусорные пути — не табы (null). /login — таб
 *  только для гостя (апгрейд до полноценного входа). /chats/:id — оверлей
 *  комнаты: держит активным таб /chats (список живёт в keep-alive). */
function tabPath(pathname: string, guest: boolean): string | null {
  const p = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (p === "/login") return guest ? p : null;
  if (p === "/chats") return "/chats";
  if (p.startsWith("/chats/")) return "/chats";
  return KEEPALIVE_TABS.some((t) => t.path === p) ? p : null;
}

/**
 * Keep-alive слой таб-экранов: переключение вкладок прячет экран классом
 * .keepalive-hidden (display:none), а не размонтирует — useEffect-ы экранов
 * не перезапускаются, данные грузятся один раз. Первый монтаж ленивый:
 * экран появляется при первом заходе на вкладку (на старте — только
 * активная лента), чтобы не простреливать все ручки разом.
 */
function KeepAliveTabs({ guest, onGuestAuthed }: { guest: boolean; onGuestAuthed: () => void }) {
  const location = useLocation();
  const active = tabPath(location.pathname, guest);
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!active) return;
    setVisited((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
  }, [active]);

  const mounted = (path: string): boolean => active === path || visited.has(path);

  return (
    <>
      {KEEPALIVE_TABS.filter((t) => mounted(t.path)).map(({ path, Component }) => (
        // Активная вкладка появляется с motion-переходом экрана (§6),
        // неактивная живёт в DOM скрытой (display:none, keep-alive)
        <div key={path} className={path === active ? "screen-enter" : "keepalive-hidden"}>
          <Component />
        </div>
      ))}
      {guest && mounted("/login") ? (
        <div key="/login" className={active === "/login" ? "screen-enter" : "keepalive-hidden"}>
          <LoginScreen onAuthed={onGuestAuthed} />
        </div>
      ) : null}
    </>
  );
}

/** Писатель истории просмотров: ListingScreen диспатчит "listing:view",
 *  здесь пишем в localStorage (гостю и юзеру). Один слушатель на приложение. */
function ViewHistoryWriter() {
  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail.listing_id === "number") {
        addView(detail);
      }
    };
    window.addEventListener("listing:view", on);
    return () => window.removeEventListener("listing:view", on);
  }, []);
  return null;
}

/** Keep-alive карточки лота (фидбек 2026-10-25 «карточка сбрасывается при
 *  смене меню»): экземпляр ListingScreen живёт после первого открытия и
 *  НЕ размонтируется при переключении вкладок (скрыт классом). Новый id —
 *  новый экземпляр (лёгкий стек по key). На табе-источнике, пока карточка
 *  жива, показываем плашку «Вернуться к карточке». */
function ListingKeepAlive({ guest }: { guest: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const m = /^\/listing\/(\d+)$/.exec(location.pathname);
  const currentId = m ? m[1] : null;
  const [alive, setAlive] = useState<{ id: string; origin: string | null } | null>(null);
  const prevTab = useRef<string | null>(null);

  useEffect(() => {
    if (currentId) {
      setAlive((prev) =>
        prev && prev.id === currentId
          ? prev
          : { id: currentId, origin: prevTab.current },
      );
    } else {
      const tab = tabPath(location.pathname, guest);
      if (tab) prevTab.current = tab;
    }
  }, [currentId, location.pathname, guest]);

  const visible = currentId !== null && alive?.id === currentId;
  const tab = tabPath(location.pathname, guest);
  const showPill = alive !== null && !visible && tab !== null && alive.origin === tab;

  return (
    <>
      {alive && (
        <div className={visible ? "screen-enter" : "keepalive-hidden"}>
          {/* Routes с подменой location: ListingScreen читает id через
              useParams — без Route-обёртки параметр undefined (баг
              /api/listings/undefined). Подмена держит id=alive.id даже
              когда карточка скрыта на другом табе. */}
          <Routes location={`/listing/${alive.id}`}>
            <Route path="/listing/:id" element={<ListingScreen key={alive.id} />} />
          </Routes>
        </div>
      )}
      {showPill && (
        <button
          type="button"
          className="listing-return-pill"
          onClick={() => navigate(`/listing/${alive.id}`)}
        >
          ← Вернуться к карточке
        </button>
      )}
    </>
  );
}

/** Мусорные пути — редирект на ленту. Таб-пути (включая гостевой /login),
 *  карточки лота и чаты (/chats, overlay /chats/:id) рендерятся другими
 *  слоями — сюда не попадают. Старые пути меню (NAV-V2): /ai — сегмент
 *  Главной, /favorites и /analyses — сегменты «Авто» (query сохраняем:
 *  «Найти похожие» /analyses?similar=N → /auto?tab=history&similar=N). */
function OverlayRoutes({ guest }: { guest: boolean }) {
  const location = useLocation();
  if (tabPath(location.pathname, guest)) return null;
  if (/^\/listing\/\d+$/.test(location.pathname)) return null;
  if (/^\/chats(\/|$)/.test(location.pathname)) return null; // keep-alive слой
  if (location.pathname === "/ai") {
    return <Navigate to="/" replace />;
  }
  if (location.pathname === "/favorites") {
    return <Navigate to="/auto?tab=favorites" replace />;
  }
  if (location.pathname === "/analyses") {
    const extra = location.search ? `&${location.search.slice(1)}` : "";
    return <Navigate to={`/auto?tab=history${extra}`} replace />;
  }
  // «Продать авто» (06 §6): стек поверх табов, НЕ keep-alive — форма
  // должна сбрасываться после ухода (навигация на созданный лот)
  if (location.pathname === "/sell") {
    return (
      <Routes>
        <Route path="/sell" element={<SellCarScreen />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** Точка входа: партнёрский ЛК и админка — свои поверхности без Telegram-авторизации. */
/** Лендинг-вход (NAV-V2 §1): в браузере на корне «/» лендинг показывается
 *  ВСЕГДА — быстрый вход в приложение пользователей или кабинет партнёра
 *  (последний выбор лишь ставит карточку первой с меткой «● последний
 *  вход», ничего не запирает). В Telegram и по deep-link'ам с query
 *  (/?make=…) сразу открывается приложение — лишний экран не встаёт на
 *  пути сценария. Вернуться на лендинг из приложения: Профиль →
 *  «Сменить поверхность».
 *
 * BF-09: лендинг и приложение раньше жили на ОДНОЙ записи истории «/» —
 * браузерный «Назад» из приложения покидал сайт. Вход пушит вторую запись
 * с маркером {app:1}: Назад попадает на запись лендинга (state=null) —
 * лендинг показывается снова без перезагрузки; «Вперёд» возвращает
 * приложение. Внутренние переходы приложения пушат свои записи (state
 * без маркера app) — popstate по ним гейт не трогает. */
function LandingGate() {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const s = e.state as { app?: number } | null;
      if (s === null) setEntered(false); // вернулись на запись лендинга
      else if (s && s.app) setEntered(true); // вперёд/назад на запись приложения
      // остальные записи (внутренняя навигация MiniApp) — не наше дело
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (entered) return <MiniApp />;
  return (
    <AppRoot appearance={applyTheme()}>
      <Landing
        onChooseUser={() => {
          chooseSurface("user");
          // Вторая запись истории: [лендинг state=null, приложение {app:1}]
          window.history.pushState({ app: 1 }, "", "/");
          setEntered(true); // Mini App без перезагрузки страницы
        }}
      />
    </AppRoot>
  );
}

export function App() {
  if (
    window.location.pathname.startsWith("/partner") ||
    window.location.pathname.startsWith("/admin")
  ) {
    return <SurfaceRouter />;
  }
  // Корень в браузере — лендинг-вход (всегда, NAV-V2 §1). Deep-link с
  // query-критериями ленты (/?make=…&price_max=…) — сразу приложение.
  if (
    window.location.pathname === "/" &&
    !window.location.search &&
    !isTelegramContext()
  ) {
    return <LandingGate />;
  }
  return <MiniApp />;
}

function MiniApp() {
  const [auth, setAuth] = useState<AuthState>("loading");
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [authed, setAuthed] = useState(() => Boolean(getAccessToken()));
  const [guest, setGuest] = useState(() => isGuest());
  const [bannerHidden, setBannerHidden] = useState(
    () => sessionStorage.getItem("autobot.guestBanner") === "1",
  );
  const isDesktop = useIsDesktop();

  // Тема (lib/theme): выбор пользователя (Profile) + системная в режиме system.
  // appearance нужен AppRoot telegram-ui — без него Tabbar всегда светлый.
  const [appearance, setAppearance] = useState<Appearance>(() => applyTheme());
  useEffect(() => {
    const stopSystem = watchSystemTheme(setAppearance);
    const stopChanges = subscribeTheme(setAppearance);
    return () => {
      stopSystem();
      stopChanges();
    };
  }, []);

  useEffect(() => {
    // Смерть сессии (refresh не прошёл): тихо восстанавливаем доступ —
    // в Telegram повторным authorize(), в браузере — гостевым входом.
    // На экран входа не выкидываем: «Выход» в профиле — единственный
    // способ разлогиниться (api/client сам зовёт этот хук при неудаче refresh).
    setSessionExpiredHandler(async () => {
      try {
        if (await authorize()) return;
        await guestLogin();
        setGuest(true);
        setAuthed(true);
      } catch {
        // backend недоступен — остаёмся на текущем экране с ошибкой запроса
      }
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  useEffect(() => {
    authorize()
      .then(async (r) => {
        if (r) {
          setAuthed(true);
          return;
        }
        // Персистентная сессия из прошлого запуска (вход или гость): токены
        // в localStorage и переживают F5 — гостя повторно не заводим.
        if (getAccessToken()) {
          setAuthed(true);
          setGuest(isGuest());
          return;
        }
        // Вне Telegram без сессии — гостевой вход: демо без регистрации
        // (лента, карточка, калькулятор, избранное; без AI-анализа).
        try {
          await guestLogin();
          setAuthed(true);
          setGuest(true);
        } catch {
          // backend недоступен — покажем форму входа как раньше
        }
      })
      .catch(() => undefined)
      .finally(() => setAuth("ready"));
  }, []);

  // Онбординг-флаг из БД (users.onboarded_at, ТЗ §2.8); без БД — раз в сессию.
  useEffect(() => {
    if (!authed || onboarded !== null) return;
    if (guest) {
      setOnboarded(true); // гостю онбординг не нужен — сразу демо ленты
      return;
    }
    if (sessionStorage.getItem("autobot.onboarded") === "1") {
      setOnboarded(true);
      return;
    }
    api<UserT>("/me")
      .then((u) => setOnboarded(u.onboarded_at !== null))
      .catch(() => setOnboarded(true)); // /me недоступен — не блокируем UI
  }, [authed, guest, onboarded]);

  const finishOnboarding = (_data: { role: string; countries: string[] }) => {
    // role/countries будут применены к фильтрам на следующих шагах (P4);
    // сейчас фиксируем только флаг онбординга (users.onboarded_at).
    api("/me/onboarded", { method: "POST" }).catch(() => undefined);
    sessionStorage.setItem("autobot.onboarded", "1");
    setOnboarded(true);
  };

  // Стабильный колбэк апгрейда гостя: LoginScreen в keep-alive слое,
  // его эффекты не должны перезапускаться из-за нового пропа каждый рендер.
  const onGuestAuthed = useCallback(() => {
    clearGuest();
    setGuest(false);
    setAuthed(true);
    // keep-alive экраны (История и др.) сами не узнают о смене пользователя:
    // оповещаем событием — они перечитывают данные под новый ключ сессии.
    window.dispatchEvent(new CustomEvent("autobot:auth"));
  }, []);

  if (auth === "loading" || (authed && onboarded === null)) {
    return (
      <AppRoot appearance={appearance}>
        <div className="state" style={{ minHeight: "60vh" }}>
          <div className="state__title">Загрузка…</div>
        </div>
      </AppRoot>
    );
  }

  if (!authed) {
    return (
      <AppRoot appearance={appearance}>
        <LoginScreen onAuthed={() => setAuthed(true)} />
      </AppRoot>
    );
  }

  if (!onboarded) {
    return (
      <AppRoot appearance={appearance}>
        <OnboardingScreen onDone={finishOnboarding} />
      </AppRoot>
    );
  }

  return (
    <ToastProvider>
      <AppRoot appearance={appearance}>
        <div className={isDesktop ? "app-shell app-shell--desktop" : "app-shell"}>
          <BrowserRouter>
            <StartParamRedirect />
            <ScrollManager />
            {isDesktop && <Shell desktop />}
            {guest && !bannerHidden && (
              <div className="guest-banner">
                <span>
                  👀 Демо без регистрации: смотрите, фильтруйте, считайте
                  доставку.{" "}
                  <Link to="/login">Войти</Link>{" "}
                  — для AI-анализа цены, сохранённых машин и уведомлений.
                </span>
                <button
                  className="guest-banner__close"
                  aria-label="Скрыть"
                  onClick={() => {
                    sessionStorage.setItem("autobot.guestBanner", "1");
                    setBannerHidden(true);
                  }}
                >
                  ✕
                </button>
              </div>
            )}
            <div className="app-content">
              <LoginPromptProvider>
                {/* Карточка лота: keep-alive, живёт при переключении вкладок.
                    Слой ПЕРВЫМ: когда карточка скрыта, плашка «Вернуться к
                    карточке» (sticky, в потоке) оказывается вверху вкладки,
                    а не под длинным контентом таб-экрана. */}
                <ListingKeepAlive guest={guest} />
                {/* Таб-экраны: keep-alive (см. KeepAliveTabs) */}
                <KeepAliveTabs guest={guest} onGuestAuthed={onGuestAuthed} />
                {/* История просмотров: слушает listing:view из карточки */}
                <ViewHistoryWriter />
                {/* FAB «+ Продать» (06 §6): только на Главной (путь «/»)
                    и не для гостя — сам скрывается на остальных путях */}
                <SellFab />
                {/* Мусорные пути — редирект */}
                <OverlayRoutes guest={guest} />
              </LoginPromptProvider>
            </div>
            <Shell />
          </BrowserRouter>
        </div>
      </AppRoot>
    </ToastProvider>
  );
}

