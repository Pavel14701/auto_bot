/** Компонентные тесты гостевого режима сайта (jsdom + testing-library).
 *
 * Сценарий «незалогиненный посетитель открыл сайт в браузере»:
 * initData нет → автоматический гостевой вход → лента и демо-баннер;
 * /login доступен гостю; Personal-функции ведут к полноценному входу.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Моки API-слоя (App и экраны импортируют только эти два модуля) ---

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  guestLogin: vi.fn(),
  isGuest: vi.fn((): boolean => true),
  clearGuest: vi.fn(),
  api: vi.fn(),
  getAccessToken: vi.fn((): string | null => null),
  isTelegramContext: vi.fn((): boolean => true),
}));

vi.mock("./api/auth", () => ({
  authorize: mocks.authorize,
  guestLogin: mocks.guestLogin,
  isGuest: mocks.isGuest,
  clearGuest: mocks.clearGuest,
  getWebApp: () => null,
  isTelegramContext: mocks.isTelegramContext,
  haptic: vi.fn(),
  logout: vi.fn(),
  tgUser: () => null,
  webLogin: vi.fn(),
  webRegister: vi.fn(),
}));

vi.mock("./api/client", () => ({
  api: mocks.api,
  getAccessToken: mocks.getAccessToken,
  getRefreshToken: vi.fn(),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  setSessionExpiredHandler: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { App } from "./App";

const LISTING = {
  id: 7,
  url: "https://encar.com/x",
  source: "encar",
  make: "Kia",
  model: "K5",
  year: 2022,
  price: 18_400_000,
  currency: "KRW",
  mileage_km: 32_000,
  fuel: "gasoline",
  transmission: "auto",
  region: null,
  parsed_at: "2026-01-01T00:00:00Z",
  photo_url: null,
  title: null,
  images: ["https://img.example/k5.jpg"],
  first_price: null,
};
const USER = {
  telegram_id: -123,
  username: null,
  first_name: "Гость",
  last_name: null,
  language_code: null,
  role: "buyer",
  subscription_tier: "free",
  subscription_until: null,
  onboarded_at: "2026-01-01",
  created_at: "2026-01-01",
  is_active: true,
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  // Тесты проверяют Mini App: лендинг на «/» (NAV-V2) показывается только
  // в браузере — мокаем контекст Telegram, как в реальном Mini App.
  mocks.isTelegramContext.mockReturnValue(true);
  mocks.getAccessToken.mockReturnValue(null);
  mocks.isGuest.mockReturnValue(true);
  mocks.authorize.mockResolvedValue(null); // вне Telegram
  mocks.guestLogin.mockResolvedValue({ access_token: "a", refresh_token: "r", user: USER });
  mocks.api.mockImplementation(async (path: string) => {
    if (path.startsWith("/listings?")) return { total: 1, items: [LISTING] };
    // карточка лота (стек поверх табов): другой автомобиль, чтобы тексты
    // карточки и скрытой ленты не конфликтовали в запросах testing-library
    if (path.startsWith("/listings/undefined"))
      throw new Error("422: id must be a number (регрессия useParams)");
    if (path.startsWith("/listings/") && path.endsWith("/inspection")) return null;
    if (path.startsWith("/listings/"))
      return { ...LISTING, make: "Hyundai", model: "Sonata" };
    if (path === "/filters") return [];
    if (path === "/favorites") return [];
    if (path === "/me") return USER;
    if (path === "/me/onboarded") return undefined;
    return undefined;
  });
  // jsdom не умеет IntersectionObserver (Feed: бесконечный скролл)
  vi.stubGlobal("IntersectionObserver", class {
    observe() {} unobserve() {} disconnect() {}
  });
  // jsdom не умеет scrollIntoView (AiSearch: автоскролл чата к последнему сообщению)
  Element.prototype.scrollIntoView = () => undefined;
  // jsdom не умеет matchMedia (useIsDesktop)
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  window.history.replaceState(null, "", "/");
});

describe("гостевой режим сайта", () => {
  it("вне Telegram происходит гостевой вход, видна лента и демо-баннер", async () => {
    render(<App />);
    await waitFor(() => expect(mocks.guestLogin).toHaveBeenCalledOnce());
    // лента загрузилась
    await waitFor(() => expect(screen.getByText(/Kia/)).toBeTruthy());
    // демо-баннер гостя
    expect(screen.getByText(/Демо без регистрации/)).toBeTruthy();
    // ссылка «Войти» ведёт на /login
    expect(screen.getByText("Войти").getAttribute("href")).toBe("/login");
  });

  it("баннер скрывается крестиком (в рамках сессии)", async () => {
    render(<App />);
    await waitFor(() => screen.getByText(/Демо без регистрации/));
    screen.getByLabelText("Скрыть").click();
    await waitFor(() => expect(screen.queryByText(/Демо без регистрации/)).toBeNull());
  });

  it("гостевой /login показывает форму входа (апгрейд из гостя)", async () => {
    window.history.replaceState(null, "", "/login");
    render(<App />);
    // «Вход» есть и в заголовке формы, и в табе-переключателе — проверяем наличие
    await waitFor(() => expect(screen.getAllByText("Вход").length).toBeGreaterThan(0));
    expect(mocks.guestLogin).toHaveBeenCalled(); // гость всё равно был заведён
  });

  it("у авторизованного Telegram-юзера гостевого входа нет и баннера нет", async () => {
    mocks.authorize.mockResolvedValue({ access_token: "a", refresh_token: "r", user: USER });
    mocks.isGuest.mockReturnValue(false);
    render(<App />);
    await waitFor(() => screen.getByText(/Kia/));
    expect(mocks.guestLogin).not.toHaveBeenCalled();
    expect(screen.queryByText(/Демо без регистрации/)).toBeNull();
  });

  it("BF-09: вход из лендинга — браузерный «Назад» возвращает лендинг, а не выходит с сайта", async () => {
    // Браузерный сценарий: лендинг на «/» (не Telegram), вход пушит вторую
    // запись истории — Назад попадает на лендинг без перезагрузки.
    mocks.isTelegramContext.mockReturnValue(false);
    window.history.replaceState(null, "", "/");
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("landing")).toBeTruthy());
    screen.getByText("Приложение для пользователей").click();
    // приложение смонтировалось (гостевой вход + лента)
    await waitFor(() => expect(screen.getByText(/Kia/)).toBeTruthy());
    // Назад: с записи приложения на запись лендинга (state=null) — лендинг
    window.history.back();
    await waitFor(() => expect(screen.getByTestId("landing")).toBeTruthy());
    expect(screen.queryByText(/Демо без регистрации/)).toBeNull();
  });
});

describe("keep-alive таб-экранов", () => {
  /** Запросы именно ленты (не карточки лота /listings/:id). */
  const listingsCalls = () =>
    mocks.api.mock.calls.filter(([p]) => String(p).startsWith("/listings?")).length;

  /** Ждём ленту и возвращаем мобильный таббар (кликабельные вкладки). */
  async function renderWithFeed(): Promise<HTMLElement> {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Kia/)).toBeTruthy());
    const tabbar = document.querySelector(".app-tabbar") as HTMLElement;
    expect(tabbar).toBeTruthy();
    return tabbar;
  }

  it("переключение вкладок прячет ленту классом, но не размонтирует её", async () => {
    const tabbar = await renderWithFeed();
    const before = listingsCalls();
    const kiaCard = screen.getByText(/Kia/);

    within(tabbar).getByText("Авто").click();
    // Авто смонтировался (сегменты Избранное/История); лента скрыта
    // .keepalive-hidden, но в DOM (keep-alive внутри Главной)
    await waitFor(() => expect(screen.getByTestId("auto-screen")).toBeTruthy());
    expect(screen.getByText(/Kia/).closest(".keepalive-hidden")).not.toBeNull();

    within(tabbar).getByText("Главная").click();
    await waitFor(() =>
      expect(screen.getByText(/Kia/).closest(".keepalive-hidden")).toBeNull(),
    );
    // тот же DOM-узел и ноль новых запросов — ремаунта ленты не было (keep-alive)
    expect(screen.getByText(/Kia/)).toBe(kiaCard);
    expect(listingsCalls()).toBe(before);
  });

  it("карточка лота — keep-alive: смена вкладки прячет её, но не размонтирует", async () => {
    const tabbar = await renderWithFeed();
    const before = listingsCalls();

    // deep-link-стиль: открываем /listing/7 (ListingKeepAlive)
    window.history.pushState(null, "", "/listing/7");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() =>
      expect(document.querySelector('[class*="listing-page"]')).not.toBeNull(),
    );
    expect(screen.getByText(/Kia/).closest(".keepalive-hidden")).not.toBeNull();

    // уходим на другую вкладку: карточка скрыта, но ЖИВА (keep-alive)
    within(tabbar).getByText("Профиль").click();
    await waitFor(() =>
      expect(screen.getByText("Подписка")).toBeTruthy(),
    );
    await waitFor(() => {
      const page = document.querySelector('[class*="listing-page"]');
      expect(page?.closest(".keepalive-hidden")).not.toBeNull();
    });

    // на табе-источнике (Главная) — плашка возврата к живой карточке
    within(tabbar).getByText("Главная").click();
    await waitFor(() =>
      expect(screen.getByText("← Вернуться к карточке")).toBeTruthy(),
    );
    // клик по плашке возвращает карточку (тот же DOM-узел — без ремаунта)
    screen.getByText("← Вернуться к карточке").click();
    await waitFor(() =>
      expect(document.querySelector('[class*="listing-page"]')?.closest(".keepalive-hidden")).toBeNull(),
    );
    // лента не перезапрашивалась всё это время
    expect(listingsCalls()).toBe(before);
  });
});

describe("персистентная сессия (F5 не разлогинивает)", () => {
  it("с токенами из прошлого запуска guestLogin повторно не вызывается", async () => {
    mocks.getAccessToken.mockReturnValue("stale-jwt");
    render(<App />);
    // лента грузится на старых токенах (авто-refresh включится при 401)
    await waitFor(() => expect(screen.getByText(/Kia/)).toBeTruthy());
    expect(mocks.guestLogin).not.toHaveBeenCalled();
    expect(mocks.authorize).toHaveBeenCalledOnce();
  });
});

describe("маршрут /chats (таб «Чаты», NAV-V2)", () => {
  it("гость: /chats рендерится заглушкой «Войдите», список не запрашивается", async () => {
    window.history.pushState(null, "", "/chats");
    render(<App />);
    // конверт-экран смонтировался (KEEPALIVE_TABS) — заглушка гостя
    await waitFor(() => expect(screen.getByText(/после входа/i)).toBeTruthy());
    // «Войти» есть и в гостевом баннере — проверяем ссылку заглушки чатов
    expect(
      screen
        .getAllByText("Войти")
        .some((el) => el.getAttribute("href") === "/login"),
    ).toBe(true);
    expect(mocks.api.mock.calls.some(([p]) => p === "/chats")).toBe(false);
    window.history.replaceState(null, "", "/");
  });

  it("мусорный путь не редиректит /chats, а карточка лота остаётся стеком", async () => {
    window.history.pushState(null, "", "/chats/t-uuid");
    render(<App />);
    await waitFor(() => expect(screen.getByText(/после входа/i)).toBeTruthy());
    window.history.replaceState(null, "", "/");
  });
});
