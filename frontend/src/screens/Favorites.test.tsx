/**
 * Тесты «Избранного» (01-ux-audit-ia.md §1.6; тексты — 03 §2.7):
 *  - гостевой гейт с модалкой входа;
 *  - пустое состояние с CTA «К ленте» (текст 03 буквально);
 *  - бейдж «цена снизилась» (--deal) и «снято с продажи» (--danger).
 */

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoot } from "@telegram-apps/telegram-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FavoritesScreen } from "./Favorites";
import { isGuest } from "../api/auth";

const { promptShow } = vi.hoisted(() => ({ promptShow: vi.fn() }));

vi.mock("../api/client", () => ({ api: vi.fn() }));
vi.mock("../api/auth", () => ({ isGuest: vi.fn(() => false) }));
vi.mock("../ui/LoginPrompt", () => ({ useLoginPrompt: () => ({ show: promptShow }) }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const renderScreen = () =>
  render(
    <AppRoot>
      <MemoryRouter>
        <FavoritesScreen />
      </MemoryRouter>
    </AppRoot>,
  );

/** Полный контракт Listing (favorites — список, без price_history). */
const listing = (over: Record<string, unknown> = {}) => ({
  id: 7,
  source: "encar",
  source_id: "X7",
  url: "https://example.com/7",
  make: "Hyundai",
  model: "Staria",
  year: 2023,
  price: 30_000_000,
  currency: "KRW",
  mileage_km: 10_000,
  vin: null,
  images: [],
  parsed_at: "2026-10-01T00:00:00Z",
  is_active: true,
  first_seen_at: null,
  first_price: null,
  price_history: null,
  title_raw: null,
  title_ru: null,
  ...over,
});

describe("FavoritesScreen", () => {
  it("гость: экран-гейт «Нужен вход» + кнопка «Войти», модалка и API не вызываются", async () => {
    vi.mocked(isGuest).mockReturnValue(true);
    const { api } = await import("../api/client");
    renderScreen();
    expect(screen.getByText("Нужен вход")).toBeTruthy();
    expect(document.body.textContent).toContain("Войти");
    // Модалка с просьбой входа показана сразу при открытии раздела
    expect(promptShow).toHaveBeenCalledWith(
      "Избранное доступно после входа — так машины сохраняются за вашим аккаунтом.",
    );
    expect(api).not.toHaveBeenCalled();
    vi.mocked(isGuest).mockReturnValue(false);
  });

  it("не гость: грузит список избранного", async () => {
    vi.mocked(isGuest).mockReturnValue(false);
    const { api } = await import("../api/client");
    vi.mocked(api).mockResolvedValue([listing()]);
    renderScreen();
    await screen.findByText("Избранное: 1");
    expect(screen.getByText("Hyundai Staria")).toBeTruthy();
  });

  it("BF-04: после апгрейда гостя (autobot:auth) гейт уходит и список грузится", async () => {
    // Экран в keep-alive: гость открыл Избранное (гейт «Нужен вход»),
    // вошёл через /login — App диспатчит autobot:auth, экран должен
    // перечитать гостя и догрузить данные без F5.
    vi.mocked(isGuest).mockReturnValue(true);
    const { api } = await import("../api/client");
    vi.mocked(api).mockResolvedValue([listing()]);
    vi.mocked(api).mockClear(); // счётчик не должен тянуться из прошлого теста
    renderScreen();
    expect(screen.getByText("Нужен вход")).toBeTruthy();
    expect(api).not.toHaveBeenCalled();

    vi.mocked(isGuest).mockReturnValue(false); // вход выполнен
    window.dispatchEvent(new Event("autobot:auth"));

    await screen.findByText("Избранное: 1");
    expect(screen.queryByText("Нужен вход")).toBeNull();
  });

  it("пусто: текст 03 §2.7 + CTA «К ленте»", async () => {
    vi.mocked(isGuest).mockReturnValue(false);
    const { api } = await import("../api/client");
    vi.mocked(api).mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText("Пока пусто")).toBeTruthy();
    expect(
      screen.getByText("Нажмите ❤️ на любом объявлении — машина сохранится здесь."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "К ленте" })).toBeTruthy();
  });

  it("цена снизилась — бейдж --deal с процентом; снято с продажи — --danger", async () => {
    vi.mocked(isGuest).mockReturnValue(false);
    const { api } = await import("../api/client");
    vi.mocked(api).mockResolvedValue([
      // 30 из 32 млн ₩ → −6%
      listing({ id: 1, first_price: 32_000_000, price: 30_000_000 }),
      listing({ id: 2, is_active: false }),
    ]);
    renderScreen();
    await screen.findByText("Избранное: 2");
    const dealBadge = document.querySelector(".fav-badge--deal");
    expect(dealBadge).not.toBeNull();
    expect(dealBadge?.textContent?.replace(/\u00A0/g, " ")).toContain("цена снизилась −6%");
    const goneBadge = document.querySelector(".fav-badge--gone");
    expect(goneBadge).not.toBeNull();
    expect(goneBadge?.textContent).toContain("снято с продажи");
  });
});
