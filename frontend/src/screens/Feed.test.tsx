/** Тесты пагинации и области прокрутки ленты: авто-подгрузка скроллом
 *  внутри viewport-области, ретрай после ошибки, конец списка, skeleton,
 *  IntersectionObserver с root = контейнер области. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { AppRoot } from "@telegram-apps/telegram-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedScreen, resetFeedCache } from "./Feed";
import { api } from "../api/client";
import type { Listing } from "../api/types";

vi.mock("../api/client", () => ({ api: vi.fn() }));
vi.mock("../api/auth", () => ({ haptic: vi.fn() }));
vi.mock("../ui/Toast", () => ({ useToast: () => ({ show: vi.fn() }) }));

// jsdom не умеет ни IntersectionObserver, ни реальный скролл. Стаб-заглушка
// IO СОХРАНЯЕТ опции — тест проверяет, что root передан (контейнер области
// прокрутки), а авто-подгрузку в тестах триггерим событием scroll на
// контейнере (фолбэк «близко к низу» в jsdom: scrollHeight=0 → всегда true).
const ioInstances: Array<{
  opts: IntersectionObserverInit;
  observed: Element[];
}> = [];
vi.stubGlobal(
  "IntersectionObserver",
  class {
    opts: IntersectionObserverInit;
    observed: Element[] = [];
    constructor(_cb: IntersectionObserverCallback, opts: IntersectionObserverInit) {
      this.opts = opts;
      ioInstances.push(this);
    }
    observe(el: Element) {
      this.observed.push(el);
    }
    unobserve() {}
    disconnect() {}
  },
);

/** Имитация прокрутки ленты пользователем — событие scroll на контейнере
 *  области (.feed-scroll), а не на window: вся прокрутка теперь внутренняя. */
const scrollFeed = () => {
  const el = document.querySelector('[data-testid="feed-scroll"]');
  expect(el).not.toBeNull();
  fireEvent.scroll(el as HTMLElement);
};

/** Контейнер области прокрутки ленты. */
const feedScroll = () =>
  document.querySelector('[data-testid="feed-scroll"]') as HTMLElement;

const apiMock = vi.mocked(api);

const listing = (id: number): Listing => ({
  id,
  source: "kcar",
  source_id: `X${id}`,
  url: `https://example.com/${id}`,
  make: "Kia",
  model: "Carnival",
  year: 2022,
  price: 18_400_000,
  currency: "KRW",
  mileage_km: 42_000,
  vin: null,
  country: "KR", // GEO-V1 §2: ListingOut.country (ISO2)
  city: null, // город — только у owner-лотов рынка
  images: [`https://img/${id}.jpg`],
  parsed_at: "2026-10-01T00:00:00Z",
  is_active: true,
  first_seen_at: null,
  first_price: null,
  price_history: null,
  title_raw: null,
  title_ru: null,
});

const page = (offset: number, total: number, size: number) => ({
  total,
  items: Array.from({ length: size }, (_, i) => listing(offset + i + 1)),
});

const TOTAL = 45;

/** Стандартное поведение API: фильтры/фасеты пустые, лента — страницами. */
const listOk = async (path: string) => {
  if (path.startsWith("/filters")) return [];
  if (path.includes("/listings/facets")) {
    return path.includes("make=") ? { models: ["Carnival", "K5"] } : { makes: ["Kia", "Hyundai"] };
  }
  const offset = Number(new URLSearchParams(path.split("?")[1]).get("offset") ?? 0);
  return page(offset, TOTAL, Math.min(20, TOTAL - offset));
};

beforeEach(() => {
  resetFeedCache(); // кэш ленты не должен перетекать между тестами
  document.body.classList.remove("feed-locked");
  ioInstances.length = 0;
  apiMock.mockReset();
  apiMock.mockImplementation(listOk);
});

afterEach(() => {
  cleanup();
  document.body.classList.remove("feed-locked");
});

const renderFeed = () =>
  render(
    <AppRoot>
      <MemoryRouter>
        <FeedScreen />
      </MemoryRouter>
    </AppRoot>,
  );

describe("Feed: область прокрутки (viewport-scroll)", () => {
  it("лента живёт в фиксированной области: обёртка + контейнер прокрутки", async () => {
    renderFeed();
    expect(document.querySelector('[data-testid="feed-viewport"]')).not.toBeNull();
    const scroll = feedScroll();
    expect(scroll).not.toBeNull();
    expect(scroll.className).toContain("feed-scroll");
    // пока лента активна — скролл страницы заблокирован (класс на body)
    expect(document.body.classList.contains("feed-locked")).toBe(true);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20));
  });

  it("IntersectionObserver наблюдает сентинел относительно КОНТЕЙНЕРА области (root)", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20));
    const io = ioInstances[ioInstances.length - 1];
    expect(io).not.toBeUndefined();
    expect(io.opts.root).toBe(feedScroll());
    expect(io.observed.length).toBeGreaterThan(0);
  });

  it("первая загрузка — 4 skeleton-карточки той же геометрии в сетке", async () => {
    let resolveList!: (v: unknown) => void;
    apiMock.mockImplementation((path: string) =>
      path.startsWith("/filters") || path.includes("/listings/facets")
        ? Promise.resolve(path.includes("make=") ? { models: [] } : { makes: [] })
        : new Promise((r) => {
            resolveList = r;
          }),
    );
    renderFeed();
    const skel = document.querySelectorAll(".lcard[aria-hidden='true']");
    expect(skel.length).toBe(4);
    // геометрия карточки: фото 16:9 (skeleton в .lcard__media) + строки тела
    expect(skel[0].querySelector(".lcard__media .skeleton")).not.toBeNull();
    resolveList(page(0, TOTAL, 20));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20));
  });

  it("ошибка первой загрузки — центрированное состояние с «Повторить», повтор загружает ленту", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/filters")) return [];
      throw new Error("сеть");
    });
    renderFeed();
    await waitFor(() => expect(screen.getByText("Что-то пошло не так")).toBeTruthy());
    // состояние — внутри области прокрутки (не «в никуда»)
    const state = document.querySelector(".feed-states");
    expect(state?.closest('[data-testid="feed-scroll"]')).not.toBeNull();
    apiMock.mockImplementation(listOk);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20));
  });

  it("при открытом шите фильтров область под ним заблокирована (нет двойного скролла)", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByRole("button", { name: /Фильтры/ })).toBeTruthy());
    expect(feedScroll().className).not.toContain("feed-scroll--locked");
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Фильтры ленты" })).toBeTruthy());
    expect(feedScroll().className).toContain("feed-scroll--locked");
    // шит рендерится в portal на body — fixed-геометрия от вьюпорта
    const sheet = screen.getByRole("dialog", { name: "Фильтры ленты" });
    expect(sheet.parentElement).toBe(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(feedScroll().className).not.toContain("feed-scroll--locked"),
    );
  });

  it("уход с ленты (keep-alive) закрывает открытый шит: portal не остаётся в body", async () => {
    // Шит рендерится в portal на document.body, а лента живёт в keep-alive:
    // при переключении вкладки/переходе на PDP scrim и шит остались бы
    // висеть над чужим экраном (клавиатурная навигация/Back при открытом шите).
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate("/ai")}>На AI</button>
          <FeedScreen />
        </>
      );
    }
    render(
      <AppRoot>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </AppRoot>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Фильтры ленты" })).toBeTruthy());
    expect(document.body.classList.contains("feed-locked")).toBe(true);
    fireEvent.click(screen.getByText("На AI"));
    // шит исчез из body, лок страницы снят
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(feedScroll().className).not.toContain("feed-scroll--locked");
    await waitFor(() =>
      expect(document.body.classList.contains("feed-locked")).toBe(false),
    );
  });
});

describe("Feed pagination", () => {
  it("загружает первую страницу, затем авто-подгружает при скролле до конца списка", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20));
    // страница 2: offset=20 → ещё 20 карточек
    scrollFeed();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(40));
    // страница 3: последние 5 → плашка «все показаны»
    scrollFeed();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(45));
    expect(screen.getByText("Показаны все найденные варианты")).toBeTruthy();
    // лишних запросов после конца списка нет
    const before = apiMock.mock.calls.length;
    scrollFeed();
    expect(apiMock.mock.calls.length).toBe(before);
  });

  it("при ошибке догрузки показывает ретрай и дозагружает после клика", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/filters")) return [];
      const offset = Number(new URLSearchParams(path.split("?")[1]).get("offset") ?? 0);
      if (offset > 0) throw new Error("502");
      return page(0, TOTAL, 20);
    });
    renderFeed();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20));
    scrollFeed();
    await waitFor(() =>
      expect(screen.getByText("Не удалось загрузить следующие объявления")).toBeTruthy(),
    );
    // вторая попытка — успешная (mockImplementation из beforeEach уже нет,
    // восстанавливаем поведение вручную)
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/filters")) return [];
      const offset = Number(new URLSearchParams(path.split("?")[1]).get("offset") ?? 0);
      return page(offset, TOTAL, Math.min(20, TOTAL - offset));
    });
    fireEvent.click(screen.getByText("Повторить"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(40));
    expect(screen.queryByText("Не удалось загрузить следующие объявления")).toBeNull();
  });

  it("чип цены шлёт price_max в долларах как есть (бэк сам нормализует usd_price, BF-01)", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText("до $10 000")).toBeTruthy());
    fireEvent.click(screen.getByText("до $10 000"));
    await waitFor(() => {
      const listingCalls = apiMock.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/listings"));
      expect(listingCalls.some((p) => p.includes("price_max=10000"))).toBe(true);
    });
  });

  it("панель фильтров: цена и год пробрасываются в $ без конвертации, кнопка показывает счётчик", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByRole("button", { name: /Фильтры/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    fireEvent.change(screen.getByLabelText("Цена $ до"), { target: { value: "5000" } });
    fireEvent.change(screen.getByLabelText("Год от"), { target: { value: "2020" } });
    fireEvent.click(screen.getByText("Применить"));
    await waitFor(() => {
      const listingCalls = apiMock.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/listings"));
      expect(listingCalls.some((p) => p.includes("price_max=5000"))).toBe(true);
      expect(listingCalls.some((p) => p.includes("year_from=2020"))).toBe(true);
    });
    // панель закрылась, на кнопке счётчик активных критериев
    expect(screen.queryByText("Применить")).toBeNull();
    expect(screen.getByText("Фильтры · 2")).toBeTruthy();
  });

  it("«Сбросить» возвращает полную ленту", async () => {
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    // Марка теперь селект из фасетов — ждём загрузки опций
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Hyundai" })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Марка"), { target: { value: "Hyundai" } });
    fireEvent.click(screen.getByText("Применить"));
    await waitFor(() => expect(screen.getByText("Фильтры · 1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    fireEvent.click(screen.getByText("Сбросить"));
    await waitFor(() => {
      const calls = apiMock.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/listings"));
      const last = calls[calls.length - 1] ?? "";
      expect(last.includes("make=")).toBe(false);
    });
  });

  it("сортировка «Цена ↑» перезагружает ленту с sort=price_asc и сбросом offset", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20));
    scrollFeed(); // offset=20
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(40));
    fireEvent.change(screen.getByLabelText("Сортировка"), { target: { value: "price_asc" } });
    await waitFor(() => {
      const calls = apiMock.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/listings"));
      const last = calls[calls.length - 1] ?? "";
      expect(last.includes("sort=price_asc")).toBe(true);
      expect(last.includes("offset=0")).toBe(true);
    });
    // счётчик отражает выбранную сортировку
    expect(screen.getByText(/дешёвые сверху/)).toBeTruthy();
  });

  it("возврат по «Назад» восстанавливает ленту без повторного запроса", async () => {
    const { unmount } = renderFeed();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20));
    unmount(); // лента сохранена в кэш
    renderFeed(); // POP-навигация → гидратация из кэша
    expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20);
    // повторного запроса ленты не было (1 вызов — от первого рендера)
    const listingCalls = apiMock.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/listings"));
    expect(listingCalls.length).toBe(1);
  });

  it("F10: пустой результат — «Сбросить фильтры» возвращает полную ленту", async () => {
    apiMock.mockImplementation(async () => ({ total: 0, items: [] }));
    renderFeed();
    await waitFor(() => expect(screen.getByText("Ничего не найдено")).toBeTruthy());
    expect(screen.getByText(/Под ваши фильтры машин сейчас нет/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Сбросить фильтры" })).toBeTruthy();
    // сброс из пустого состояния (F10): действие вместо тупика
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/filters")) return [];
      const offset = Number(new URLSearchParams(path.split("?")[1]).get("offset") ?? 0);
      return page(offset, TOTAL, Math.min(20, TOTAL - offset));
    });
    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20),
    );
  });

  it("F2: панель фильтров — bottom-sheet (dialog) с живым счётчиком, Esc закрывает", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByRole("button", { name: /Фильтры/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    // шит — модальный диалог с aria, id для aria-controls тумблера
    const sheet = screen.getByRole("dialog", { name: "Фильтры ленты" });
    expect(sheet.id).toBe("feed-panel");
    // живой счётчик в футере (F2): total по черновику, debounce 350мс
    await waitFor(() => expect(screen.getByText("45 авто найдено")).toBeTruthy(), {
      timeout: 2000,
    });
    // Esc закрывает шит (03 §5.3)
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keep-alive: deep-link /?… применяется и к уже смонтированной ленте (A2)", async () => {
    // Лента живёт в keep-alive: переход из AI-поиска не размонтирует её,
    // поэтому критерии из URL должны применяться на смонтированном экране.
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate("/?make=Kia&price_max=25000")}>
            Показать в ленте
          </button>
          <FeedScreen />
        </>
      );
    }
    render(
      <AppRoot>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </AppRoot>,
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20));
    fireEvent.click(screen.getByRole("button", { name: "Показать в ленте" }));
    await waitFor(() => {
      const listingCalls = apiMock.mock.calls
        .map((c) => String(c[0]))
        .filter((p) => p.includes("/listings"));
      const last = listingCalls[listingCalls.length - 1] ?? "";
      // критерии из URL ушли в запрос в $ как есть (контракт usd_price, BF-01)
      expect(last.includes("make=Kia")).toBe(true);
      expect(last.includes("price_max=25000")).toBe(true);
    });
  });
});

describe("Feed: чипс «🏪 Рынок» (source=market, витрина партнёров)", () => {
  /** Вызовы GET /listings (не фасеты и не limit=1-счётчик). */
  const listingCalls = () =>
    apiMock.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/listings?"));

  it("клик по чипсу подставляет source=market в GET /listings, повторный — снимает", async () => {
    renderFeed();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBeGreaterThan(0),
    );

    const chip = screen.getByRole("button", { name: "🏪 Рынок" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    await waitFor(() =>
      expect(listingCalls().some((p) => p.includes("source=market"))).toBe(true),
    );
    // чипс активен, фильтр держится при перезагрузке той же страницы критериев
    expect(
      screen.getByRole("button", { name: "🏪 Рынок" }).getAttribute("aria-pressed"),
    ).toBe("true");

    // повторный клик снимает: последний запрос без source=market
    fireEvent.click(screen.getByRole("button", { name: "🏪 Рынок" }));
    await waitFor(() =>
      expect(listingCalls()[listingCalls().length - 1].includes("source=market")).toBe(false),
    );
    expect(
      screen.getByRole("button", { name: "🏪 Рынок" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("чипс рынка не сбрасывает остальные критерии (toggle, не пресет)", async () => {
    renderFeed();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBeGreaterThan(0),
    );
    // пресет «до $10 000» + рынок → в запросе и цена, и source
    fireEvent.click(screen.getByRole("button", { name: "до $10 000" }));
    await waitFor(() =>
      expect(listingCalls().some((p) => p.includes("price_max=10000"))).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "🏪 Рынок" }));
    await waitFor(() => {
      const last = listingCalls()[listingCalls().length - 1];
      expect(last.includes("source=market")).toBe(true);
      expect(last.includes("price_max=10000")).toBe(true);
    });
  });
});

describe("Feed: гео-фильтры стран (GEO-V1 §3)", () => {
  /** Вызовы GET /listings (не фасеты и не limit=1-счётчик). */
  const listingCalls = () =>
    apiMock.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/listings?"));

  it("чипс страны шлёт country=KR, повторный клик снимает фильтр", async () => {
    renderFeed();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBeGreaterThan(0),
    );
    const chip = screen.getByRole("button", { name: "Корея" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    await waitFor(() =>
      expect(listingCalls().some((p) => p.includes("country=KR"))).toBe(true),
    );
    expect(
      screen.getByRole("button", { name: "Корея" }).getAttribute("aria-pressed"),
    ).toBe("true");

    // повторный клик снимает: последний запрос без country=
    fireEvent.click(screen.getByRole("button", { name: "Корея" }));
    await waitFor(() =>
      expect(listingCalls()[listingCalls().length - 1].includes("country=")).toBe(false),
    );
    expect(
      screen.getByRole("button", { name: "Корея" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("чипс страны не сбрасывает остальные критерии (toggle, не пресет)", async () => {
    renderFeed();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByRole("button", { name: "до $10 000" }));
    await waitFor(() =>
      expect(listingCalls().some((p) => p.includes("price_max=10000"))).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Китай" }));
    await waitFor(() => {
      const last = listingCalls()[listingCalls().length - 1];
      expect(last.includes("country=CN")).toBe(true);
      expect(last.includes("price_max=10000")).toBe(true);
    });
  });

  it("шит фильтров: сегмент «Страна» (5 стран + «Все») применяется через «Применить»", async () => {
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    const sheet = screen.getByRole("dialog", { name: "Фильтры ленты" });
    // те же пять стран, что и в чипсах над лентой
    const seg = within(sheet).getByRole("group", { name: "Страна" });
    for (const name of ["Корея", "Китай", "ОАЭ", "США", "Казахстан"]) {
      expect(within(seg).getByRole("button", { name })).toBeTruthy();
    }
    expect(within(seg).getByRole("button", { name: "Все" })).toBeTruthy();
    fireEvent.click(within(seg).getByRole("button", { name: "ОАЭ" }));
    fireEvent.click(screen.getByText("Применить"));
    await waitFor(() =>
      expect(listingCalls().some((p) => p.includes("country=AE"))).toBe(true),
    );
    // страна учтена в счётчике активных критериев и подсветила чипс ленты
    expect(screen.getByText("Фильтры · 1")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "ОАЭ" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keep-alive: deep-link /?country=AE применяется к смонтированной ленте", async () => {
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate("/?country=AE")}>Показать в ленте</button>
          <FeedScreen />
        </>
      );
    }
    render(
      <AppRoot>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </AppRoot>,
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20));
    fireEvent.click(screen.getByRole("button", { name: "Показать в ленте" }));
    await waitFor(() => {
      const last = listingCalls()[listingCalls().length - 1] ?? "";
      expect(last.includes("country=AE")).toBe(true);
    });
  });
});

describe("Feed: шит фильтров — Хик: секции и «Ещё параметры»", () => {
  it("редкие поля (цвет/привод/объём) свёрнуты в «Ещё параметры», частые — всегда видны", async () => {
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Фильтры ленты" })).toBeTruthy());
    // свёрнуто: редких полей в DOM нет, кнопка-раскрытие с aria-expanded
    expect(screen.queryByLabelText("Цвет")).toBeNull();
    expect(screen.queryByLabelText("Привод")).toBeNull();
    expect(screen.queryByLabelText("Объём, л — от")).toBeNull();
    const more = screen.getByRole("button", { name: /Ещё параметры/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(screen.getByLabelText("Цвет")).toBeTruthy();
    expect(screen.getByLabelText("Привод")).toBeTruthy();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    // частые поля живут вне блока раскрытия — видны без раскрытия
    expect(screen.getByLabelText("Цена $ до")).toBeTruthy();
    expect(screen.getByLabelText("Пробег, км — не более")).toBeTruthy();
  });

  it("активный редкий фильтр раскрывает блок автоматически при повторном открытии шита", async () => {
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Фильтры ленты" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Ещё параметры/ }));
    fireEvent.change(screen.getByLabelText("Цвет"), { target: { value: "white" } });
    fireEvent.click(screen.getByText("Применить"));
    await waitFor(() => expect(screen.getByText("Фильтры · 1")).toBeTruthy());
    // переоткрытие шита: цвет уже активен — «Ещё параметры» раскрыты сами
    fireEvent.click(screen.getByRole("button", { name: /Фильтры/ }));
    await waitFor(() => expect(screen.getByLabelText("Цвет")).toBeTruthy());
    expect((screen.getByLabelText("Цвет") as HTMLSelectElement).value).toBe("white");
  });
});

describe("Feed: фиксы аудита 2026-10-29", () => {
  /** Вызовы GET /listings (не фасеты и не limit=1-счётчик). */
  const listingCalls = () =>
    apiMock.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/listings?"));

  it("BF-02: чужой query (?tab=) на смонтированной ленте не сбрасывает фильтры", async () => {
    // Лента в keep-alive слушает location.search всего приложения: раньше
    // /auto?tab=history (только чужие ключи) давал deepLinkQuery → {} →
    // setQuery({}) — сброс фильтров + фоновая перезагрузка.
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate("/auto?tab=mine")}>На авто</button>
          <FeedScreen />
        </>
      );
    }
    render(
      <AppRoot>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </AppRoot>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20),
    );
    fireEvent.click(screen.getByRole("button", { name: "до $10 000" }));
    await waitFor(() =>
      expect(listingCalls().some((p) => p.includes("price_max=10000"))).toBe(true),
    );
    const before = listingCalls().length;

    fireEvent.click(screen.getByText("На авто"));
    // вернулись на таб с чужим query: фильтр жив, чипс активен
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "до $10 000" }).className).toContain(
        "chip--active",
      ),
    );
    // перезагрузки «Все» не было — новых запросов ленты нет
    expect(listingCalls().length).toBe(before);
  });

  it("BF-02: монтирование ленты на /auto?tab=mine не трогает query и не чистит URL", async () => {
    render(
      <AppRoot>
        <MemoryRouter initialEntries={["/auto?tab=mine"]}>
          <FeedScreen inactive />
        </MemoryRouter>
      </AppRoot>,
    );
    // лента грузится с пустыми критериями (глубоких feed-ключей в URL нет)
    await waitFor(() =>
      expect(listingCalls().some((p) => p.includes("offset=0"))).toBe(true),
    );
    expect(listingCalls().some((p) => p.includes("price_"))).toBe(false);
    expect(listingCalls().some((p) => p.includes("country="))).toBe(false);
  });

  it("BF-07: смена фильтра во время догрузки не приклеивает старые карточки", async () => {
    // Управляемые промисы: первая страница — сразу; догрузка (offset>0)
    // «висит», параллельно меняется query (reset) — поздний ответ старой
    // догрузки должен быть проигнорирован (seq-счётчик запросов).
    let resolveMore!: (v: unknown) => void;
    let resolveReset!: (v: unknown) => void;
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/filters")) return Promise.resolve([]);
      if (path.includes("/listings/facets")) return Promise.resolve({ makes: [] });
      const sp = new URLSearchParams(path.split("?")[1]);
      const offset = Number(sp.get("offset") ?? 0);
      const country = sp.get("country");
      if (country != null && offset === 0)
        return new Promise((r) => {
          resolveReset = r;
        });
      if (offset > 0)
        return new Promise((r) => {
          resolveMore = r;
        });
      return Promise.resolve(page(0, TOTAL, 20));
    });
    renderFeed();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20),
    );
    scrollFeed(); // догрузка страницы 2 — в полёте
    await waitFor(() => expect(resolveMore).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Корея" })); // reset — в полёте
    await waitFor(() => expect(resolveReset).toBeTruthy());

    // старый ответ (догрузка «без страны») пришёл ПЕРВЫМ — игнорируется
    resolveMore(page(20, TOTAL, 20));
    // новый ответ: 2 карточки страны KR
    resolveReset({ total: 2, items: [listing(101), listing(102)] });

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(2),
    );
    // чужих карточек из старой догрузки не приклеилось (иначе 22)
    expect(screen.getByText("Показаны все найденные варианты")).toBeTruthy();
  });

  it("BF-10: повторный одинаковый deep-link применяется снова (router-state синхронен)", async () => {
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate("/?country=AE")}>Показать в ленте</button>
          <FeedScreen />
        </>
      );
    }
    render(
      <AppRoot>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </AppRoot>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Kia/ }).length).toBe(20),
    );
    // первый deep-link применён и «потреблён»
    fireEvent.click(screen.getByRole("button", { name: "Показать в ленте" }));
    await waitFor(() =>
      expect(listingCalls()[listingCalls().length - 1].includes("country=AE")).toBe(true),
    );
    // пользователь снял страну чипсом (навигации нет)
    fireEvent.click(screen.getByRole("button", { name: "ОАЭ" }));
    await waitFor(() =>
      expect(listingCalls()[listingCalls().length - 1].includes("country=")).toBe(false),
    );
    // повторный deep-link с ТЕМИ ЖЕ критериями должен сработать снова
    fireEvent.click(screen.getByRole("button", { name: "Показать в ленте" }));
    await waitFor(() =>
      expect(listingCalls()[listingCalls().length - 1].includes("country=AE")).toBe(true),
    );
    expect(
      screen.getByRole("button", { name: "ОАЭ" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("BF-15: после входа (autobot:auth) чипсы «Мои сигналы» перечитываются", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText("до $10 000")).toBeTruthy());
    expect(screen.queryByText(/Сигнал #/)).toBeNull(); // гостю /filters пуст
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/filters")) {
        return [
          {
            id: 5,
            name: null,
            criteria: { price_max: 30000 },
            notify_mode: "instant",
            quiet_hours: null,
            created_at: "2026-10-01T00:00:00Z",
            updated_at: null,
          },
        ];
      }
      return listOk(path);
    });
    window.dispatchEvent(new Event("autobot:auth"));
    await waitFor(() => expect(screen.getByText(/Сигнал #5/)).toBeTruthy());
    // клик по чипсу применяет подписку
    fireEvent.click(screen.getByText(/Сигнал #5/));
    await waitFor(() =>
      expect(listingCalls().some((p) => p.includes("price_max=30000"))).toBe(true),
    );
  });

  it("BF-05: событие autobot:open-feed переключает Главную на сегмент «Лента»", async () => {
    // «Показать в ленте» из AI-поиска диспатчит событие (меняется только
    // query) — Главная обязана показать ленту, а не оставаться в AI-чате.
    // jsdom не умеет scrollIntoView (AiSearch: автоскролл чата к низу).
    Element.prototype.scrollIntoView = () => undefined;
    const { HomeScreen } = await import("./Home");
    render(
      <AppRoot>
        <MemoryRouter>
          <HomeScreen />
        </MemoryRouter>
      </AppRoot>,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: "Лента" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "AI-поиск" }));
    await waitFor(() =>
      expect(
        screen.getByTestId("feed-viewport").closest(".keepalive-hidden"),
      ).not.toBeNull(),
    );
    window.dispatchEvent(new CustomEvent("autobot:open-feed"));
    await waitFor(() =>
      expect(screen.getByTestId("feed-viewport").closest(".keepalive-hidden")).toBeNull(),
    );
    expect(
      screen.getByRole("tab", { name: "Лента" }).getAttribute("aria-selected"),
    ).toBe("true");
  });
});
