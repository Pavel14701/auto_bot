/**
 * Тесты PDP (Listing.tsx, V2 — двухколоночный layout + «Связаться
 * с менеджером», жалоба владельца: «вынеси анализ вправо»):
 *  - структура: правая колонка (.listing-page__side) = AI-анализ цены +
 *    CTA-карточка (primary «Связаться с менеджером», secondary «Открыть
 *    у источника»); «Найти похожие» остаётся в левой колонке;
 *  - DOM-порядок мобайла: side встаёт между заголовком/ценой (__main)
 *    и остальным контентом (__rest) — анализ сразу после цены;
 *  - контакт: гость → логин-промпт (без POST /contact); 201 → кнопка
 *    disabled «Заявка отправлена ✓» + тост + флаг autobot.contact.{id}
 *    в localStorage (переживает переоткрытие); 409 → тост-дубль за сутки.
 *  - «🤖 Отчёт истории» (12-ai-trust §1): кнопка «Собрать отчёт истории»
 *    → GET history-report → факты списком + LLM-вывод; 404 no_history_data
 *    → компактная строка; гость (403) панели не видит.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams, useLocation } from "react-router-dom";
import { AppRoot } from "@telegram-apps/telegram-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ListingScreen } from "./Listing";
import { isGuest } from "../api/auth";
import { ToastProvider } from "../ui/Toast";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  promptShow: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: mocks.api }));
vi.mock("../api/auth", () => ({
  isGuest: vi.fn((): boolean => false),
  haptic: vi.fn(),
  getWebApp: () => null,
}));
vi.mock("../ui/LoginPrompt", () => ({ useLoginPrompt: () => ({ show: mocks.promptShow }) }));

/** Ответ POST /listings/7/contact — переключается конкретным тестом
 *  (объект = 201, Error со status = ошибка). */
let contactReply: unknown = { lead_id: 11, status: "created" };

/** Ответ GET /listings/7/history-report (12 §1) — объект = 200,
 *  Error со status = 404/403. */
let historyReply: unknown = null;

/** Полный контракт Listing (карточка GET /api/listings/{id}). */
const listing = (over: Record<string, unknown> = {}) => ({
  id: 7,
  source: "encar",
  source_id: "X7",
  url: "https://encar.com/x",
  make: "Hyundai",
  model: "Sonata",
  year: 2022,
  price: 18_400_000,
  currency: "KRW",
  mileage_km: 32_000,
  vin: null,
  body_type: "Седан",
  fuel: "Бензин",
  transmission: "Автомат",
  drive: "FWD",
  engine_volume: 2.5,
  color: "Чёрный",
  images: [],
  options: ["Люк"],
  parsed_at: "2026-10-01T00:00:00Z",
  is_active: true,
  first_seen_at: "2026-09-01T00:00:00Z",
  first_price: null,
  price_history: [
    { price: 19_000_000, currency: "KRW", recorded_at: "2026-09-01T00:00:00Z" },
    { price: 18_400_000, currency: "KRW", recorded_at: "2026-10-01T00:00:00Z" },
  ],
  title_raw: "현대 쏘나타 뉴라이즈",
  title_ru: "Hyundai Sonata New Rise",
  source_language: "ko",
  updated_at: null,
  last_seen_at: null,
  price_changed_at: null,
  // Рынок владельцев (06 §4): базовая фикстура — лот партнёра (кнопка
  // «Спросить продавца» видна); user/внешний — в describe ниже
  owner_type: "partner",
  owner_description: null,
  ...over,
});

/** Вызовы POST /listings/7/contact (path, options). */
const contactCalls = () =>
  mocks.api.mock.calls.filter(([p]) => String(p).endsWith("/contact"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isGuest).mockReturnValue(false);
  contactReply = { lead_id: 11, status: "created" };
  historyReply = null;
  mocks.api.mockImplementation(async (path: string) => {
    if (path.startsWith("/favorites/")) return { favorited: false };
    if (path.endsWith("/inspection")) {
      // 404 → компактная строка «чек не найден», без карты осмотра
      throw Object.assign(new Error("not found"), { status: 404 });
    }
    if (path.endsWith("/analysis")) return null;
    if (path === "/subscription") return { agent: false };
    if (path.endsWith("/contact")) {
      if (contactReply instanceof Error) throw contactReply;
      return contactReply;
    }
    if (path.endsWith("/history-report")) {
      if (historyReply instanceof Error) throw historyReply;
      return historyReply;
    }
    return listing();
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});


/** Зонд роута /calc: показывает строку ?query перехода (UX-003). */
function CalcProbe() {
  const loc = useLocation();
  return <div data-testid="calc-route">{loc.search}</div>;
}

const renderScreen = () =>
  render(
    <AppRoot>
      <ToastProvider>
        <MemoryRouter initialEntries={["/listing/7"]}>
          <Routes>
            <Route path="/listing/:id" element={<ListingScreen />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </AppRoot>,
  );

describe("PDP V2: двухколоночная структура (анализ — вправо)", () => {
  it("правая колонка: AI-анализ цены + CTA (менеджер/источник/избранное)", async () => {
    renderScreen();
    await screen.findByText("Hyundai Sonata");
    const side = document.querySelector(".listing-page__side");
    expect(side).not.toBeNull();
    expect(side?.textContent).toContain("AI-анализ цены");
    expect(side?.textContent).toContain("Связаться с менеджером");
    expect(side?.textContent).toContain("Открыть у источника");
    expect(side?.textContent).toContain("В избранное");
    expect(side?.textContent).toContain("Поделиться");
    expect(side?.textContent).toContain("Доставка и растаможка");
    // цена и статус дублируются в CTA-карточке (задача 1: «цена-статус + кнопки»)
    expect(side?.querySelector(".pdp-cta__price")?.textContent).toBeTruthy();
    expect(side?.textContent).toContain("В продаже");
  });

  it("«Найти похожие» — в левой (контентной) колонке, не в side", async () => {
    renderScreen();
    await screen.findByText("Найти похожие");
    const side = document.querySelector(".listing-page__side");
    const rest = document.querySelector(".listing-page__rest");
    expect(side?.textContent).not.toContain("Найти похожие");
    expect(rest?.textContent).toContain("Найти похожие");
  });

  it("DOM-порядок = порядок мобайла: main(галерея/цена) → side(анализ+CTA) → rest", async () => {
    renderScreen();
    await screen.findByText("Hyundai Sonata");
    const kids = Array.from(document.querySelector(".listing-page")?.children ?? []).map(
      (c) => c.className,
    );
    const iMain = kids.indexOf("listing-page__main");
    const iSide = kids.indexOf("listing-page__side");
    const iRest = kids.indexOf("listing-page__rest");
    expect(iMain).toBeGreaterThanOrEqual(0);
    expect(iSide).toBeGreaterThan(iMain); // анализ/кнопки — сразу под заголовком/ценой
    expect(iRest).toBeGreaterThan(iSide); // остальное — после кнопок
    // sticky-бар мобайла — последний (как было)
    expect(kids[kids.length - 1]).toContain("listing-cta-bar");
  });
});

describe("«Связаться с менеджером» (POST /listings/{id}/contact)", () => {
  it("гость: клик ведёт к логин-промпту, POST /contact не уходит", async () => {
    vi.mocked(isGuest).mockReturnValue(true);
    renderScreen();
    const btn = await screen.findByRole("button", { name: "Связаться с менеджером" });
    fireEvent.click(btn);
    expect(mocks.promptShow).toHaveBeenCalledTimes(1);
    expect(mocks.promptShow).toHaveBeenCalledWith(
      "Связь с менеджером доступна после входа — войдите или зарегистрируйтесь.",
    );
    expect(contactCalls()).toHaveLength(0);
  });

  it("201: форма инлайн (aria-expanded) → тост, кнопка disabled «Заявка отправлена ✓», флаг в localStorage", async () => {
    renderScreen();
    const btn = await screen.findByRole("button", { name: "Связаться с менеджером" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    // форма раскрылась инлайн под кнопкой: textarea + «Отправить заявку»
    const submit = await screen.findByRole("button", { name: "Отправить заявку" });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByLabelText("Комментарий менеджеру (необязательно)"),
    ).toBeTruthy();
    fireEvent.click(submit);
    await waitFor(() => expect(contactCalls()).toHaveLength(1));
    // пустая textarea → comment:null: дефолтную формулировку подставляет
    // бэкенд (RequestContact), на клиенте её не дублируем
    const [path, options] = contactCalls()[0] as [string, RequestInit];
    expect(path).toBe("/listings/7/contact");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({ comment: null });
    // тост успеха + кнопка-статус disabled + персистентный флаг
    expect(await screen.findByText("✅ Менеджер свяжется с вами")).toBeTruthy();
    const sent = screen.getByText("Заявка отправлена ✓").closest("button");
    expect(sent).toBeTruthy();
    expect((sent as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem("autobot.contact.7")).toBe("1");
  });

  it("кастомный комментарий уходит в body, если textarea заполнена", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Связаться с менеджером" }));
    const textarea = await screen.findByLabelText("Комментарий менеджеру (необязательно)");
    fireEvent.change(textarea, { target: { value: "  Хочу тест-драйв  " } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить заявку" }));
    await waitFor(() => expect(contactCalls()).toHaveLength(1));
    const [, options] = contactCalls()[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toEqual({ comment: "Хочу тест-драйв" });
  });

  it("409: тост «Вы уже оставляли заявку по этой машине сегодня», кнопка не «отправлена»", async () => {
    contactReply = Object.assign(new Error("conflict"), { status: 409 });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Связаться с менеджером" }));
    fireEvent.click(await screen.findByRole("button", { name: "Отправить заявку" }));
    expect(
      await screen.findByText("Вы уже оставляли заявку по этой машине сегодня"),
    ).toBeTruthy();
    // дубль ограничен сутками на сервере — локально не блокируем навсегда
    expect(screen.queryByText("Заявка отправлена ✓")).toBeNull();
    expect(screen.getByRole("button", { name: "Связаться с менеджером" })).toBeTruthy();
    expect(localStorage.getItem("autobot.contact.7")).toBeNull();
  });

  it("флаг из localStorage: переоткрытие карточки — сразу «Заявка отправлена ✓» disabled", async () => {
    localStorage.setItem("autobot.contact.7", "1");
    renderScreen();
    const sent = await screen.findByText("Заявка отправлена ✓");
    expect((sent.closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Связаться с менеджером" })).toBeNull();
    expect(contactCalls()).toHaveLength(0);
  });
});

// ---------- Sticky-бар мобайла (UX-004) и ссылка в калькулятор (UX-003) ----------

describe("PDP: sticky-бар мобайла (UX-004)", () => {
  it("primary бара — действие экрана «Связаться», «Открыть у источника» — текстовая ссылка", async () => {
    renderScreen();
    await screen.findByText("Hyundai Sonata");
    const bar = document.querySelector(".listing-cta-bar") as HTMLElement;
    expect(bar).not.toBeNull();
    const primary = bar.querySelector(".listing-cta-bar__btn") as HTMLButtonElement;
    expect(primary.textContent).toContain("Связаться");
    // «Открыть у источника» больше не primary-кнопка, а secondary-ссылка
    const src = bar.querySelector(".listing-cta-bar__src") as HTMLElement;
    expect(src?.textContent).toContain("Открыть у источника");
    // избранное/поделиться в баре остаются
    expect(bar.querySelector('[aria-label="В избранное"]')).toBeTruthy();
    expect(bar.querySelector('[aria-label="Поделиться"]')).toBeTruthy();
    // клик по primary открывает ту же инлайн-форму заявки, что и карточка
    fireEvent.click(primary);
    expect(await screen.findByLabelText("Комментарий менеджеру (необязательно)")).toBeTruthy();
  });

  it("после отправленной заявки primary бара — статус «Отправлено ✓» (disabled)", async () => {
    renderScreen();
    await screen.findByText("Hyundai Sonata");
    const bar = document.querySelector(".listing-cta-bar") as HTMLElement;
    const primary = bar.querySelector(".listing-cta-bar__btn") as HTMLButtonElement;
    fireEvent.click(primary);
    fireEvent.click(await screen.findByRole("button", { name: "Отправить заявку" }));
    await screen.findByText("✅ Менеджер свяжется с вами");
    expect(primary.textContent).toContain("Отправлено ✓");
    expect(primary.disabled).toBe(true);
  });
});

describe("PDP → калькулятор (UX-003, UIUX-GEO §4/§7)", () => {
  /** Рендер с роутом /calc: линк «Доставка и растаможка» прокидывает страну. */
  const renderWithCalc = async (over: Record<string, unknown> = {}) => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/favorites/")) return { favorited: false };
      if (path.endsWith("/inspection")) throw Object.assign(new Error("nf"), { status: 404 });
      if (path.endsWith("/analysis")) return null;
      if (path === "/subscription") return { agent: false };
      if (path.endsWith("/contact")) return { lead_id: 1, status: "created" };
      return listing(over);
    });
    render(
      <AppRoot>
        <ToastProvider>
          <MemoryRouter initialEntries={["/listing/7"]}>
            <Routes>
              <Route path="/listing/:id" element={<ListingScreen />} />
              <Route
                path="/calc"
                element={<CalcProbe />}
              />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </AppRoot>,
    );
    // текст кнопки — со стрелкой «… →»; ищем по роли
    await screen.findByRole("button", { name: /Доставка и растаможка/ });
  };

  it("линк «Доставка и растаможка» несёт ?country= страны лота", async () => {
    await renderWithCalc({ country: "AE" });
    fireEvent.click(screen.getByRole("button", { name: /Доставка и растаможка/ }));
    await waitFor(() => expect(screen.getByTestId("calc-route")).toBeTruthy());
    const search = screen.getByTestId("calc-route").textContent ?? "";
    expect(search).toContain("country=AE");
    expect(search).toContain("price=");
  });

  it("лот без страны: country= пустая — калькулятор останется на дефолте", async () => {
    await renderWithCalc({ country: undefined });
    fireEvent.click(screen.getByRole("button", { name: /Доставка и растаможка/ }));
    await waitFor(() => expect(screen.getByTestId("calc-route")).toBeTruthy());
    expect(screen.getByTestId("calc-route").textContent).toContain("country=");
  });
});

/** PDP с N фото в галерее: тот же мок-api, но listing.images не пустой. */
describe("Галерея PDP: точки-индикаторы и синхронность (задача владельца)", () => {
  const imgs = (n: number) => Array.from({ length: n }, (_, i) => `https://img/g${i + 1}.jpg`);

  /** Рендер PDP с n фото; ждём загрузки карточки, отдаём .gallery. */
  const renderWithPhotos = async (n: number) => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/favorites/")) return { favorited: false };
      if (path.endsWith("/inspection")) {
        // 404 → чеков нет, галерея = только фото лота
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      if (path.endsWith("/analysis")) return null;
      if (path === "/subscription") return { agent: false };
      if (path.endsWith("/contact")) {
        if (contactReply instanceof Error) throw contactReply;
        return contactReply;
      }
      return listing({ images: imgs(n) });
    });
    renderScreen();
    await screen.findByText("Hyundai Sonata");
    return document.querySelector(".gallery") as HTMLElement;
  };

  it("≤10 фото: точки под фото, активная первая; клик — прокрутка трека + подсветка превью", async () => {
    // jsdom не считает layout и не умеет scrollIntoView: центрирование
    // активной миниатюры проверяем стабом на прототипе
    window.HTMLElement.prototype.scrollIntoView = vi.fn() as unknown as typeof window.HTMLElement.prototype.scrollIntoView;
    await renderWithPhotos(4);
    const dots = document.querySelectorAll(".pdp-dots__dot");
    expect(dots).toHaveLength(4);
    expect(dots[0].className).toContain("--active");
    const track = document.querySelector(".gallery__track") as HTMLDivElement;
    Object.defineProperty(track, "clientWidth", { configurable: true, value: 300 });
    const scrollTo = vi.fn();
    track.scrollTo = scrollTo as unknown as HTMLDivElement["scrollTo"];
    fireEvent.click(dots[2]);
    expect(scrollTo).toHaveBeenCalledWith({ left: 600, behavior: "smooth" });
    expect(document.querySelector('.gallery__thumb[data-i="2"]')?.className).toContain(
      "--active",
    );
    expect(document.querySelector(".gallery__counter")?.textContent).toBe("3 / 4");
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      inline: "center",
      behavior: "smooth",
    });
  });

  it("скролл большого фото синхронизирует точки, превью и счётчик «N / M»", async () => {
    await renderWithPhotos(4);
    const track = document.querySelector(".gallery__track") as HTMLDivElement;
    Object.defineProperty(track, "clientWidth", { configurable: true, value: 300 });
    track.scrollLeft = 300; // второй слайд
    fireEvent.scroll(track);
    expect(document.querySelectorAll(".pdp-dots__dot")[1].className).toContain("--active");
    expect(document.querySelector('.gallery__thumb[data-i="1"]')?.className).toContain(
      "--active",
    );
    expect(document.querySelector(".gallery__counter")?.textContent).toBe("2 / 4");
  });

  it(">10 фото: точек нет — остаётся счётчик; превью как раньше 6 + «+N»", async () => {
    await renderWithPhotos(12);
    expect(document.querySelector(".pdp-dots")).toBeNull();
    expect(document.querySelector(".gallery__counter")?.textContent).toBe("1 / 12");
    // 6 миниатюр + пилюля «+6»
    expect(document.querySelectorAll(".gallery__thumb")).toHaveLength(7);
    expect(document.querySelector(".gallery__thumb--more")?.textContent).toBe("+6");
  });

  it("лайтбокс синхронен: стрелки листают — точка/превью следуют, Esc закрывает на том же фото", async () => {
    await renderWithPhotos(4);
    fireEvent.click(document.querySelector(".gallery__slide") as HTMLImageElement);
    expect(document.querySelector(".lightbox")).not.toBeNull();
    expect(document.querySelector(".lightbox__img")?.getAttribute("src")).toBe(imgs(4)[0]);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(document.querySelector(".lightbox__img")?.getAttribute("src")).toBe(imgs(4)[1]);
    // под лайтбоксом точка и превью уже на втором фото (синхронизация)
    expect(document.querySelectorAll(".pdp-dots__dot")[1].className).toContain("--active");
    expect(document.querySelector('.gallery__thumb[data-i="1"]')?.className).toContain(
      "--active",
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".lightbox")).toBeNull();
    // закрыли — галерея осталась на том же (втором) фото
    expect(document.querySelector(".gallery__counter")?.textContent).toBe("2 / 4");
  });

  it("точка при открытом лайтбоксе листает лайтбокс (единый индикатор)", async () => {
    await renderWithPhotos(4);
    fireEvent.click(document.querySelector(".gallery__slide") as HTMLImageElement);
    fireEvent.click(document.querySelectorAll(".pdp-dots__dot")[2]);
    expect(document.querySelector(".lightbox__img")?.getAttribute("src")).toBe(imgs(4)[2]);
    expect(document.querySelector(".lightbox__counter")?.textContent).toContain("3 / 4");
  });
});

describe("PDP: «Спросить продавца» (чаты, 05-chats-marketplace §7)", () => {
  /** Зонд overlay-роута чата — фиксирует id треда после navigate. */
  function ChatsProbe() {
    const { id } = useParams<{ id: string }>();
    return <div data-testid="chats-route">{id}</div>;
  }

  /** Рендер PDP + маршрута /chats/:id (для проверки navigate из кнопки). */
  const renderWithChats = () =>
    render(
      <AppRoot>
        <ToastProvider>
          <MemoryRouter initialEntries={["/listing/7"]}>
            <Routes>
              <Route path="/listing/:id" element={<ListingScreen />} />
              <Route path="/chats/:id" element={<ChatsProbe />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </AppRoot>,
    );

  const sellerCalls = () =>
    mocks.api.mock.calls.filter(([p]) => String(p) === "/chats/seller/7");

  it("кнопка в CTA-панели: POST /api/chats/seller/7 → navigate в /chats/{thread_id}", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/chats/seller/7") return { thread_id: "t-42" };
      if (path.startsWith("/favorites/")) return { favorited: false };
      if (path.endsWith("/inspection")) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      if (path.endsWith("/analysis")) return null;
      if (path === "/subscription") return { agent: false };
      return listing();
    });
    renderWithChats();
    await screen.findByText("Hyundai Sonata");
    fireEvent.click(screen.getByRole("button", { name: /Спросить продавца/ }));
    await waitFor(() => expect(screen.getByTestId("chats-route").textContent).toBe("t-42"));
    // создан именно POST /api/chats/seller/{listing_id}
    expect(sellerCalls().length).toBe(1);
    expect((sellerCalls()[0] as unknown[])[1]).toMatchObject({ method: "POST" });
  });

  it("гость — логин-промпт, запроса seller-чата нет", async () => {
    vi.mocked(isGuest).mockReturnValue(true);
    renderWithChats();
    await screen.findByText("Hyundai Sonata");
    fireEvent.click(screen.getByRole("button", { name: /Спросить продавца/ }));
    await waitFor(() => expect(mocks.promptShow).toHaveBeenCalledOnce());
    expect(sellerCalls().length).toBe(0);
  });
});

describe("PDP: рынок владельцев (06 §4)", () => {
  /** Мок с одним лотом-переопределением (остальное — как в beforeEach). */
  const mockListing = (over: Record<string, unknown>) => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/favorites/")) return { favorited: false };
      if (path.endsWith("/inspection")) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      if (path.endsWith("/analysis")) return null;
      if (path === "/subscription") return { agent: false };
      if (path.endsWith("/contact")) {
        if (contactReply instanceof Error) throw contactReply;
        return contactReply;
      }
      if (path.endsWith("/history-report")) {
        if (historyReply instanceof Error) throw historyReply;
        return historyReply;
      }
      return listing(over);
    });
  };

  it("owner_description → панель «От владельца» после цены/статуса", async () => {
    mockListing({ owner_description: "Один владелец, сервис по регламенту." });
    renderScreen();
    const note = await screen.findByText(/^От владельца/);
    const panel = note.closest("section");
    expect(panel?.textContent).toContain("Один владелец, сервис по регламенту.");
    // панель — в левой колонке, сразу после блока цены/статуса (spec-card)
    const main = document.querySelector(".listing-page__main");
    const spec = document.querySelector(".spec-card");
    expect(main?.contains(panel)).toBe(true);
    expect(
      Boolean(spec?.compareDocumentPosition(panel as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("owner_description нет — панели «От владельца» нет", async () => {
    mockListing({});
    renderScreen();
    await screen.findByText("Hyundai Sonata");
    expect(screen.queryByText(/^От владельца/)).toBeNull();
  });

  it("owner_history → таймлайн «История машины» (свежие первыми)", async () => {
    mockListing({
      owner_history: [
        { date: "2026-01-10", title: "Пригон из Кореи", note: "Таможня оформлена" },
        { date: "2023-05-01", title: "TO у дилера", note: null },
      ],
    });
    renderScreen();
    const head = await screen.findByText("История машины");
    const panel = head.closest("section");
    expect(panel?.textContent).toContain("Пригон из Кореи");
    expect(panel?.textContent).toContain("TO у дилера");
    // порядок = порядок массива (бэк сортирует свежими первыми)
    const items = panel!.querySelectorAll(".pdp-owner-history__item");
    expect(items[0].textContent).toContain("Пригон из Кореи");
    expect(items[1].textContent).toContain("TO у дилера");
  });

  it("owner_history пуст/нет — блока истории нет", async () => {
    mockListing({ owner_history: [] });
    renderScreen();
    await screen.findByText("Hyundai Sonata");
    expect(screen.queryByText("История машины")).toBeNull();
  });

  it("user-лот → «Спросить владельца» (не «продавца»)", async () => {
    mockListing({ owner_type: "user" });
    renderScreen();
    await screen.findByText("Hyundai Sonata");
    expect(screen.getByRole("button", { name: "Спросить владельца" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Спросить продавца" })).toBeNull();
  });

  it("внешний лот (owner_type=null) — кнопки продавца нет вовсе", async () => {
    mockListing({ owner_type: null });
    renderScreen();
    await screen.findByText("Hyundai Sonata");
    expect(screen.queryByRole("button", { name: /Спросить/ })).toBeNull();
  });
});

// ---------- «🤖 Отчёт истории» (12-ai-trust.md §1, F12) ----------

describe("PDP: «🤖 Отчёт истории»", () => {
  /** Полный контракт HistoryReportView: факты + LLM-вывод. */
  const REPORT = {
    listing_id: 7,
    facts: {
      accidents_count: 2,
      last_accident: "2023-04-12, передний бампер",
      owners: 3,
      mileage_confirmed: true,
      usage: "такси",
      report_grade: "fair",
      report_date: "2026-10-20",
    },
    llm_summary: "Машина с историей: два ДТП, работала в такси. Стоит смотреть лично.",
    generated_at: "2026-10-21T10:00:00Z",
  };

  it("кнопка → загрузка → факты списком с русскими подписями + вывод LLM", async () => {
    historyReply = REPORT;
    renderScreen();
    // панель в левой (контентной) колонке, до неё нужно кликнуть «Собрать»
    const btn = await screen.findByRole("button", { name: "Собрать отчёт истории" });
    const panel = (await screen.findByText("Отчёт истории")).closest("section");
    expect(document.querySelector(".listing-page__rest")?.contains(panel)).toBe(true);
    // до клика фактов нет
    expect(screen.queryByText("ДТП по страховой базе")).toBeNull();

    fireEvent.click(btn);
    // GET /listings/7/history-report
    await waitFor(() =>
      expect(mocks.api.mock.calls.some(([p]) => p === "/listings/7/history-report")).toBe(true),
    );
    // факты: русские подписи + значения (булев пробег → да, дата → ru-формат)
    const facts = await screen.findByText("ДТП по страховой базе");
    const list = facts.closest(".hist-report__facts") as HTMLElement;
    const factValue = (label: string) =>
      Array.from(list.querySelectorAll(".hist-report__fact")).find(
        (el) => el.querySelector(".hist-report__fact-label")?.textContent === label,
      )?.querySelector(".hist-report__fact-value")?.textContent;
    expect(factValue("ДТП по страховой базе")).toBe("2");
    expect(factValue("Последнее ДТП")).toBe("2023-04-12, передний бампер");
    expect(factValue("Владельцев")).toBe("3");
    expect(factValue("Пробег подтверждён")).toBe("да");
    expect(factValue("Использование")).toBe("такси");
    expect(factValue("Дата отчёта")).toBe("20.10.2026");
    // вывод — отдельным абзацем
    expect(screen.getByText("Вывод")).toBeTruthy();
    expect(
      screen.getByText(/Стоит смотреть лично/).closest(".hist-report__summary"),
    ).toBeTruthy();
  });

  it("панель стоит сразу после блока осмотра (до истории цен)", async () => {
    historyReply = REPORT;
    // осмотр есть (200) — секция «Осмотр» отрисована
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/favorites/")) return { favorited: false };
      if (path.endsWith("/inspection")) {
        return {
          source: "encar",
          inspected_at: "2026-09-10T00:00:00Z",
          grade: "good",
          summary: null,
          marks: [],
          items: [],
          images: [],
        };
      }
      if (path.endsWith("/analysis")) return null;
      if (path === "/subscription") return { agent: false };
      if (path.endsWith("/history-report")) return historyReply;
      return listing();
    });
    renderScreen();
    await screen.findByText("Собрать отчёт истории");
    const insp = Array.from(document.querySelectorAll("section")).find((s) =>
      s.textContent?.startsWith("🔍 Осмотр"),
    );
    const hist = (await screen.findByText("Отчёт истории")).closest("section");
    const priceHist = (await screen.findByText("История цен")).closest("section");
    expect(insp).toBeTruthy();
    expect(hist).toBeTruthy();
    expect(priceHist).toBeTruthy();
    // осмотр → отчёт истории → история цен (DOM-порядок)
    expect(
      Boolean(insp!.compareDocumentPosition(hist!) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(hist!.compareDocumentPosition(priceHist!) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("404 no_history_data → компактная строка «Данных по истории нет»", async () => {
    historyReply = Object.assign(new Error("no_history_data"), { status: 404 });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Собрать отчёт истории" }));
    const missing = await screen.findByText("Данных по истории нет");
    // компактная строка, не тост и не панель-ошибка
    expect(missing.className).toContain("hist-report__missing");
    // повторного сбора не предлагаем
    expect(screen.queryByRole("button", { name: "Собрать отчёт истории" })).toBeNull();
  });

  it("гость: панели «Отчёт истории» нет вовсе (403-контур)", async () => {
    vi.mocked(isGuest).mockReturnValue(true);
    renderScreen();
    await screen.findByText("Hyundai Sonata");
    expect(screen.queryByText("Отчёт истории")).toBeNull();
    expect(screen.queryByRole("button", { name: "Собрать отчёт истории" })).toBeNull();
    expect(
      mocks.api.mock.calls.some(([p]) => p === "/listings/7/history-report"),
    ).toBe(false);
  });

  it("403 от /history-report (сессия умерла) — панель скрывается после клика", async () => {
    historyReply = Object.assign(new Error("forbidden"), { status: 403 });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Собрать отчёт истории" }));
    await waitFor(() => expect(screen.queryByText("Отчёт истории")).toBeNull());
  });
});
