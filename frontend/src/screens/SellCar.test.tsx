/**
 * Тесты визарда «Продать авто» v2/v3 (07-sell-chats-partner-inspection.md
 * §1, F1 + 10-listing-lifecycle.md §5):
 *  - шаги с валидацией: «Далее» из шага 1 с ошибками не уходит на фото,
 *    год 1980–2027; «Назад» сохраняет значения;
 *  - фото: drop файла → uploadMarketPhoto(File) сразу, счётчик n/10,
 *    лимит 10, ретрай ошибки, удаление выкидывает URL из сабмита;
 *  - финальный шаг (10 §5): «Сохранить черновик» (submit=false → тост →
 *    профиль) и «Отправить на публикацию» (submit=true: accepted /
 *    moderation / rejected ветки; needs_payment — диалог как раньше);
 *  - edit-режим /sell?edit={id}: предзаполнение из my-lots, фото-превью,
 *    PATCH (accepted → «Отправить правки на проверку» + pending-тост,
 *    баннер старой версии, patch_reject_reason), draft → PATCH + submit;
 *  - черновик sessionStorage autobot.sellDraft: восстановление полей/шага/
 *    загруженных фото, сброс после успешной публикации (в edit не пишется);
 *  - live listing_status: событие → тост прямо на форме;
 *  - гость: заглушка с loginPrompt, POST не уходит;
 *  - FAB «+»: только на ленте и только не-гостю.
 *  - 12-ai-trust §2: «✨ Сгенерировать описание» (POST /market/description
 *    с photos_count, 429-тост лимита, confirm при повторе) и live-блок
 *    «Качество объявления» (совет по фото <3 исчезает при ≥3, описание 80).
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SellCarScreen, SellFab } from "./SellCar";
import { api } from "../api/client";
import { isGuest } from "../api/auth";
import { chatStore } from "../lib/chatStore";
import type { InvoiceStatus } from "../lib/invoice";
import type { CreatedLot, MyLot, PlacementInvoice } from "../api/types";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  promptShow: vi.fn(),
  toastShow: vi.fn(),
  openInvoice: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: mocks.api }));
vi.mock("../api/auth", () => ({
  haptic: vi.fn(),
  isGuest: vi.fn((): boolean => false),
}));
vi.mock("../ui/Toast", () => ({ useToast: () => ({ show: mocks.toastShow }) }));
vi.mock("../ui/LoginPrompt", () => ({ useLoginPrompt: () => ({ show: mocks.promptShow }) }));
vi.mock("../lib/invoice", () => ({ openInvoice: mocks.openInvoice }));
// Транспорт личного канала — стаб (chatStore стартует синхронизацию для
// listing_status-подписки; реальные ws/поллинг в этих тестах не нужны).
vi.mock("../lib/chatSocket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chatSocket")>();
  return {
    ...actual,
    createChatTransport: vi.fn(async () => ({
      kind: "polling" as const,
      connect: async () => undefined,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      disconnect: vi.fn(),
      onEvent: () => () => undefined,
      onThreads: () => () => undefined,
      setActiveThread: vi.fn(),
    })),
  };
});
// загрузка фото мокается целиком; проверки файла (тип/размер) — реальные
vi.mock("../lib/marketPhotos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/marketPhotos")>();
  return { ...actual, uploadMarketPhoto: mocks.upload };
});

const apiMock = vi.mocked(api);

// jsdom не реализует URL.createObjectURL/revokeObjectURL — стабим для
// blob-превью шага «Фото» (уникальный «url» на файл).
beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    value: () => `blob:mock-${Math.random().toString(36).slice(2)}`,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: () => undefined,
    configurable: true,
    writable: true,
  });
});

/** Ответ POST /api/market/lots — CreatedLotOut (контракт бэка). */
const LOT: CreatedLot = {
  listing_id: 123,
  placement_status: "free",
  is_active: true,
  needs_payment: false,
};

const INVOICE: PlacementInvoice = {
  payment_id: 9,
  invoice_url: "https://t.me/invoice-star",
  amount: 20,
  currency: "XTR",
};

/** Зонд overlay-роута карточки: показывает id из useParams. */
function ListingProbe() {
  const { id } = useParams<{ id: string }>();
  return <div data-testid="listing-route">{id}</div>;
}

/** Зонд прочих overlay-роутов (профиль, /sell). */
function RouteProbe({ testid }: { testid: string }) {
  return <div data-testid={testid} />;
}

/** Зонд таба «Авто» сегмента «Мои объявления» (NAV-V2): показывает
 *  полный адрес перехода — тесты BF-08 проверяют /auto?tab=mine. */
function AutoMineProbe() {
  const loc = useLocation();
  return <div data-testid="auto-mine-route">{`${loc.pathname}${loc.search}`}</div>;
}

const renderScreen = () =>
  render(
    <MemoryRouter initialEntries={["/sell"]}>
      <Routes>
        <Route path="/sell" element={<SellCarScreen />} />
        <Route path="/listing/:id" element={<ListingProbe />} />
        <Route path="/auto" element={<AutoMineProbe />} />
        <Route path="/profile" element={<RouteProbe testid="profile-route" />} />
      </Routes>
    </MemoryRouter>,
  );

const fillStep1 = () => {
  fireEvent.change(screen.getByLabelText("Марка"), { target: { value: "Kia" } });
  fireEvent.change(screen.getByLabelText("Модель"), { target: { value: "K5" } });
  fireEvent.change(screen.getByLabelText("Год выпуска"), { target: { value: "2022" } });
};

/** Заполнить шаг 1 и уйти на шаг 2 «Фото». */
const gotoPhotos = () => {
  fillStep1();
  fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
};

/** Со шага 2 — на шаг 3 (цена/публикация), фото пропускаем. */
const gotoPublish = () => {
  gotoPhotos();
  fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
};

const fillPrice = (value = "20000000") => {
  fireEvent.change(screen.getByLabelText("Цена"), { target: { value } });
};

const lotCalls = () => apiMock.mock.calls.filter(([p]) => p === "/market/lots");

/** Мок-файл фото (контракт: image/jpeg ≤8МБ). */
const photoFile = (name = "car.jpg") => new File(["photo-bytes"], name, { type: "image/jpeg" });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.removeItem("autobot.sellDraft");
  vi.mocked(isGuest).mockReturnValue(false);
  apiMock.mockResolvedValue(LOT);
  mocks.upload.mockResolvedValue("https://s3/photo-1.jpg");
  mocks.openInvoice.mockImplementation(
    (_url: string, cb: (s: InvoiceStatus) => void) => {
      (mocks.openInvoice as unknown as { lastCb?: (s: InvoiceStatus) => void }).lastCb = cb;
      return true;
    },
  );
});

afterEach(() => {
  cleanup();
  sessionStorage.removeItem("autobot.sellDraft");
});

describe("SellCar v2: шаги визарда и валидация", () => {
  it("старт — шаг 1 «Авто», прогресс-точки трёх шагов", () => {
    renderScreen();
    expect(screen.getByLabelText("Марка")).toBeTruthy();
    expect(screen.getByText("Авто")).toBeTruthy();
    expect(screen.getByText("Фото")).toBeTruthy();
    expect(screen.getByText("Цена и публикация")).toBeTruthy();
    // шаг 2/3 ещё скрыты
    expect(screen.queryByLabelText("Добавить фото: перетащите файлы или нажмите")).toBeNull();
    expect(screen.queryByLabelText("Цена")).toBeNull();
  });

  it("пустой шаг 1: ошибки под полями, «Далее» не уходит дальше", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    expect(screen.getByText("Укажите марку (Kia, Hyundai…)")).toBeTruthy();
    expect(screen.getByText("Укажите модель")).toBeTruthy();
    expect(screen.getByText("Укажите год выпуска")).toBeTruthy();
    // остались на шаге 1 — поля авто на месте
    expect(screen.getByLabelText("Марка")).toBeTruthy();
    expect(lotCalls()).toHaveLength(0);
  });

  it("год вне 1980–2027 — инлайн-ошибка, шаг не меняется", () => {
    renderScreen();
    fillStep1();
    fireEvent.change(screen.getByLabelText("Год выпуска"), { target: { value: "1975" } });
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    expect(screen.getByText("Год — от 1980 до 2027")).toBeTruthy();
    expect(screen.queryByLabelText("Добавить фото: перетащите файлы или нажмите")).toBeNull();
  });

  it("«Далее»/«Назад» ходят по шагам, значения сохраняются", () => {
    renderScreen();
    gotoPhotos();
    expect(screen.getByLabelText("Добавить фото: перетащите файлы или нажмите")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Назад" }));
    // вернулись на шаг 1 — поля с прежними значениями
    expect((screen.getByLabelText("Марка") as HTMLInputElement).value).toBe("Kia");
    expect((screen.getByLabelText("Год выпуска") as HTMLInputElement).value).toBe("2022");
  });

  it("шаг 2 можно пропустить (0 фото ок) — «Далее» без загрузок", () => {
    renderScreen();
    gotoPublish();
    expect(screen.getByLabelText("Цена")).toBeTruthy();
    expect(screen.getByLabelText("Описание")).toBeTruthy();
  });
});

describe("SellCar v2: шаг «Фото» (07 §1)", () => {
  it("drop файла → uploadMarketPhoto(File) сразу; счётчик 1/10; URL попадает в сабмит", async () => {
    renderScreen();
    gotoPhotos();
    const dropzone = screen.getByLabelText("Добавить фото: перетащите файлы или нажмите");
    fireEvent.drop(dropzone, { dataTransfer: { files: [photoFile()] } });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    expect(mocks.upload.mock.calls[0][0]).toBeInstanceOf(File);
    // карточка появилась и дошла до done
    await waitFor(() =>
      expect(document.querySelector(".sell-pcard--done")).not.toBeNull(),
    );
    expect(screen.getByText("1/10")).toBeTruthy();

    // до сабмита доходим с ценой
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    await waitFor(() => expect(lotCalls()).toHaveLength(1));
    const [, options] = lotCalls()[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body)).photos).toEqual(["https://s3/photo-1.jpg"]);
  });

  it("файловый пикер (input multiple) тоже грузит файлы", async () => {
    renderScreen();
    gotoPhotos();
    const input = screen.getByLabelText("Выбрать файлы фото");
    fireEvent.change(input, { target: { files: [photoFile("a.png")] } });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    expect((mocks.upload.mock.calls[0][0] as File).name).toBe("a.png");
  });

  it("лимит 10: лишние файлы не принимаются и не грузятся", async () => {
    renderScreen();
    gotoPhotos();
    const dropzone = screen.getByLabelText("Добавить фото: перетащите файлы или нажмите");
    const files = Array.from({ length: 12 }, (_, i) => photoFile(`car-${i}.jpg`));
    fireEvent.drop(dropzone, { dataTransfer: { files } });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(10));
    expect(screen.getByText("10/10")).toBeTruthy();
    expect(mocks.toastShow).toHaveBeenCalledWith("Максимум 10 фото — лишние пропущены");
  });

  it("ошибка загрузки: карточка с ошибкой и ретрай повторяет запрос", async () => {
    mocks.upload.mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce("https://s3/ok.jpg");
    renderScreen();
    gotoPhotos();
    fireEvent.drop(screen.getByLabelText("Добавить фото: перетащите файлы или нажмите"), {
      dataTransfer: { files: [photoFile()] },
    });
    await waitFor(() =>
      expect(document.querySelector(".sell-pcard--error")).not.toBeNull(),
    );
    expect(screen.getByText("Ошибка")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку фото 1" }));
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(document.querySelector(".sell-pcard--done")).not.toBeNull(),
    );
  });

  it("крестик удаляет фото — URL выпадает из сабмита", async () => {
    renderScreen();
    gotoPhotos();
    fireEvent.drop(screen.getByLabelText("Добавить фото: перетащите файлы или нажмите"), {
      dataTransfer: { files: [photoFile()] },
    });
    await waitFor(() =>
      expect(document.querySelector(".sell-pcard--done")).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Удалить фото 1" }));
    expect(document.querySelector(".sell-pcard")).toBeNull();
    expect(screen.getByText("0/10")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    await waitFor(() => expect(lotCalls()).toHaveLength(1));
    const [, options] = lotCalls()[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body)).photos).toEqual([]);
  });
});

describe("SellCar v2: сабмит POST /market/lots (как в v1)", () => {
  it("тело запроса: обязательные числами, опциональные опущены", async () => {
    renderScreen();
    fillStep1();
    fireEvent.change(screen.getByLabelText("Пробег, км"), { target: { value: "35000" } });
    fireEvent.change(screen.getByLabelText("Топливо"), { target: { value: "petrol" } });
    fireEvent.change(screen.getByLabelText("КПП"), { target: { value: "auto" } });
    gotoPublish();
    fillPrice();
    fireEvent.change(screen.getByLabelText("Валюта"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "Хорошая машина" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    await waitFor(() => expect(lotCalls()).toHaveLength(1));
    const [path, options] = lotCalls()[0] as [string, RequestInit];
    expect(path).toBe("/market/lots");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({
      make: "Kia",
      model: "K5",
      year: 2022,
      country: "RU", // GEO-V1 §2: страна owner-лота обязательна (дефолт RU)
      price: 20_000_000,
      currency: "USD",
      mileage_km: 35_000,
      fuel: "petrol",
      transmission: "auto",
      description: "Хорошая машина",
      photos: [],
      submit: true,
    });
    // бесплатное размещение: тост + переход на карточку созданного лота
    expect(mocks.toastShow).toHaveBeenCalledWith("Объявление опубликовано");
    await waitFor(() => expect(screen.getByTestId("listing-route").textContent).toBe("123"));
  });

  it("пустая цена на шаге 3 — инлайн-ошибка, POST не уходит", async () => {
    renderScreen();
    gotoPublish();
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    expect(await screen.findByText("Укажите цену")).toBeTruthy();
    expect(lotCalls()).toHaveLength(0);
  });

  it("цена 0 — ошибка валидации", async () => {
    renderScreen();
    gotoPublish();
    fillPrice("0");
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    expect(await screen.findByText("Цена должна быть больше нуля")).toBeTruthy();
    expect(lotCalls()).toHaveLength(0);
  });

  it("409 market_limit_reached — апселл-текст лимита, без диалога оплаты", async () => {
    apiMock.mockRejectedValueOnce(Object.assign(new Error("market_limit_reached"), { status: 409 }));
    renderScreen();
    gotoPublish();
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    expect(await screen.findByText(/Лимит объявлений достигнут/)).toBeTruthy();
    expect(screen.queryByText("Лот создан, но требует оплаты")).toBeNull();
  });
});

describe("SellCar v2: needs_payment → Stars-продление (§3)", () => {
  it("диалог «продлить сейчас?» → extend(1 нед) → openInvoice → paid → публикация", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/market/lots") return { ...LOT, placement_status: "needs_payment" };
      if (path === "/market/lots/123/extend") return INVOICE;
      return undefined;
    });
    renderScreen();
    gotoPublish();
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    expect(await screen.findByText("Лот создан, но требует оплаты")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Продлить за 20★" }));
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([p, o]) => p === "/market/lots/123/extend" && o?.method === "POST")).toBe(true),
    );
    const extendCall = apiMock.mock.calls.find(([p]) => p === "/market/lots/123/extend");
    expect(JSON.parse(String(extendCall?.[1]?.body))).toEqual({ weeks: 1 });
    // инвойс открыт нативно (в Telegram), сумма/ссылка — из ответа extend
    expect(mocks.openInvoice).toHaveBeenCalledWith("https://t.me/invoice-star", expect.any(Function));

    // статус paid: объявление опубликовано → карточка лота
    const cb = (mocks.openInvoice as unknown as { lastCb: (s: string) => void }).lastCb;
    cb("paid");
    expect(mocks.toastShow).toHaveBeenCalledWith("Объявление опубликовано");
    await waitFor(() => expect(screen.getByTestId("listing-route").textContent).toBe("123"));
  });

  it("«Позже» — без оплаты: лот сохранён, путь в профиль", async () => {
    apiMock.mockResolvedValue({ ...LOT, placement_status: "needs_payment" });
    renderScreen();
    gotoPublish();
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    fireEvent.click(await screen.findByRole("button", { name: "Позже" }));
    expect(mocks.toastShow).toHaveBeenCalledWith("Лот сохранён — продлить можно в «Мои объявления»");
    expect(mocks.openInvoice).not.toHaveBeenCalled();
    // BF-08: «Мои объявления» живут в табе Авто (NAV-V2), не в профиле
    await waitFor(() =>
      expect(screen.getByTestId("auto-mine-route").textContent).toBe("/auto?tab=mine"),
    );
  });
});

describe("SellCar v2: черновик sessionStorage autobot.sellDraft", () => {
  it("шаг и поля восстанавливаются при возврате на /sell", () => {
    renderScreen();
    fillStep1();
    fireEvent.change(screen.getByLabelText("Топливо"), { target: { value: "diesel" } });
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    // ушли с экрана (unmount)
    cleanup();
    expect(sessionStorage.getItem("autobot.sellDraft")).toBeTruthy();

    renderScreen();
    // вернулись сразу на шаг 2 «Фото»
    expect(screen.getByLabelText("Добавить фото: перетащите файлы или нажмите")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Назад" }));
    expect((screen.getByLabelText("Марка") as HTMLInputElement).value).toBe("Kia");
    expect((screen.getByLabelText("Модель") as HTMLInputElement).value).toBe("K5");
    expect((screen.getByLabelText("Год выпуска") as HTMLInputElement).value).toBe("2022");
    expect((screen.getByLabelText("Топливо") as HTMLSelectElement).value).toBe("diesel");
  });

  it("загруженные фото восстанавливаются как готовые (без повторной загрузки)", async () => {
    renderScreen();
    gotoPhotos();
    fireEvent.drop(screen.getByLabelText("Добавить фото: перетащите файлы или нажмите"), {
      dataTransfer: { files: [photoFile()] },
    });
    await waitFor(() =>
      expect(document.querySelector(".sell-pcard--done")).not.toBeNull(),
    );
    cleanup();
    expect(JSON.parse(sessionStorage.getItem("autobot.sellDraft") ?? "{}").photos).toEqual([
      "https://s3/photo-1.jpg",
    ]);

    mocks.upload.mockClear();
    renderScreen();
    // черновик вернул на шаг «Фото» с уже загруженной карточкой — done без загрузки
    expect(screen.getByLabelText("Добавить фото: перетащите файлы или нажмите")).toBeTruthy();
    expect(document.querySelector(".sell-pcard--done")).not.toBeNull();
    expect(screen.getByText("1/10")).toBeTruthy();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("черновик сбрасывается после успешной публикации", async () => {
    renderScreen();
    fillStep1();
    gotoPublish();
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    await waitFor(() => expect(lotCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("listing-route").textContent).toBe("123"));
    expect(sessionStorage.getItem("autobot.sellDraft")).toBeNull();
  });
});

// ---------- Финальный шаг: черновик vs публикация (10-listing-lifecycle §5) ----------

describe("SellCar v3: финальный шаг — черновик/публикация (10 §5)", () => {
  it("«Сохранить черновик»: submit=false → тост → /profile, визард-черновик сброшен", async () => {
    apiMock.mockResolvedValueOnce({ ...LOT, status: "draft" });
    renderScreen();
    gotoPublish();
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    await waitFor(() => expect(lotCalls()).toHaveLength(1));
    const [, options] = lotCalls()[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body)).submit).toBe(false);
    expect(mocks.toastShow).toHaveBeenCalledWith("Черновик сохранён");
    await waitFor(() => expect(screen.getByTestId("auto-mine-route")).toBeTruthy());
    // БД-черновик — отдельная сущность; sessionStorage-визард чист
    expect(sessionStorage.getItem("autobot.sellDraft")).toBeNull();
  });

  it("publish → moderation: тост «Отправлено на проверку» → /profile (без карточки)", async () => {
    apiMock.mockResolvedValueOnce({ ...LOT, status: "moderation" });
    renderScreen();
    gotoPublish();
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    await waitFor(() => expect(lotCalls()).toHaveLength(1));
    expect(mocks.toastShow).toHaveBeenCalledWith("Отправлено на проверку — результат придёт здесь");
    await waitFor(() => expect(screen.getByTestId("auto-mine-route")).toBeTruthy());
    expect(screen.queryByTestId("listing-route")).toBeNull();
  });

  it("publish → rejected: красный тост причины, в профиль", async () => {
    apiMock.mockResolvedValueOnce({
      ...LOT,
      status: "rejected",
      rejected_reason: "Контакты в описании",
    });
    renderScreen();
    gotoPublish();
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    await waitFor(() => expect(lotCalls()).toHaveLength(1));
    expect(mocks.toastShow).toHaveBeenCalledWith("Объявление отклонено: Контакты в описании", {
      error: true,
    });
    await waitFor(() => expect(screen.getByTestId("auto-mine-route")).toBeTruthy());
  });
});

// ---------- Edit-режим /sell?edit={id} (10-listing-lifecycle §5) ----------

/** Лот my-lots для edit-режима (контракт MyLotOut += status, 10 §4;
 *  country/city — гео owner-лота, GEO-V1 §2). */
const EDIT_LOT: MyLot = {
  listing_id: 7,
  status: "accepted",
  placement_status: "paid",
  placement_paid_until: "2026-11-09T12:00:00Z",
  is_active: true,
  make: "Hyundai",
  model: "Sonata",
  year: 2021,
  price: 18_000_000,
  currency: "KRW",
  mileage_km: 42_000,
  images: ["https://s3/edit-1.jpg", "https://s3/edit-2.jpg"],
  url: null,
  owner_description: "Описание лота",
  country: "KZ",
  city: "Алматы",
};

const renderEdit = (initial = "/sell?edit=7") =>
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/sell" element={<SellCarScreen />} />
        <Route path="/listing/:id" element={<ListingProbe />} />
        <Route path="/auto" element={<AutoMineProbe />} />
        <Route path="/profile" element={<RouteProbe testid="profile-route" />} />
      </Routes>
    </MemoryRouter>,
  );

describe("SellCar v3: edit-режим /sell?edit={id} (10 §5)", () => {
  it("предзаполнение из my-lots + фото-превью + PATCH → «Правки отправлены на проверку»", async () => {
    apiMock.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === "/market/my-lots") return [EDIT_LOT];
      if (path === "/market/lots/7" && opts?.method === "PATCH") return { pending_patch: true };
      return undefined;
    });
    renderEdit();
    // поля предзаполнены данными лота
    expect(await screen.findByDisplayValue("Hyundai")).toBeTruthy();
    expect((screen.getByLabelText("Модель") as HTMLInputElement).value).toBe("Sonata");
    expect((screen.getByLabelText("Год выпуска") as HTMLInputElement).value).toBe("2021");
    expect((screen.getByLabelText("Пробег, км") as HTMLInputElement).value).toBe("42000");
    // гео предзаполнено из MyLotOut.country/city (GEO-V1 §2)
    expect((screen.getByLabelText("Страна") as HTMLSelectElement).value).toBe("KZ");
    expect((screen.getByLabelText("Город") as HTMLInputElement).value).toBe("Алматы");
    // баннер о старой версии (10 §1) + нет кнопки черновика у опубликованного
    expect(screen.getByText(/старая версия объявления/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Сохранить черновик" })).toBeNull();
    // визард-черновик в edit-режиме не пишется
    fireEvent.change(screen.getByLabelText("Марка"), { target: { value: "Hyundai2" } });
    expect(sessionStorage.getItem("autobot.sellDraft")).toBeNull();

    // фото лота — готовые мини-превью (2 шт., без повторной загрузки)
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    await waitFor(() =>
      expect(document.querySelectorAll(".sell-pcard--done")).toHaveLength(2),
    );
    expect(mocks.upload).not.toHaveBeenCalled();
    // удаление фото выпадает из PATCH
    fireEvent.click(screen.getByRole("button", { name: "Удалить фото 2" }));
    expect(screen.getByText("1/10")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    expect((screen.getByLabelText("Цена") as HTMLInputElement).value).toBe("18000000");
    expect((screen.getByLabelText("Описание") as HTMLTextAreaElement).value).toBe("Описание лота");
    fireEvent.click(screen.getByRole("button", { name: "Отправить правки на проверку" }));
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([p, o]) => p === "/market/lots/7" && o?.method === "PATCH"),
      ).toBe(true),
    );
    const patchCall = apiMock.mock.calls.find(
      ([p, o]) => p === "/market/lots/7" && o?.method === "PATCH",
    );
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      make: "Hyundai2",
      model: "Sonata",
      year: 2021,
      country: "KZ", // гео предзаполнено из my-lots (GEO-V1 §2)
      city: "Алматы",
      price: 18_000_000,
      currency: "KZT",
      mileage_km: 42_000,
      description: "Описание лота",
      photos: ["https://s3/edit-1.jpg"],
    });
    // PATCH не запускает оплату — paid-шага нет, только тост и профиль
    expect(mocks.toastShow).toHaveBeenCalledWith("Правки отправлены на проверку");
    await waitFor(() => expect(screen.getByTestId("auto-mine-route")).toBeTruthy());
  });

  it("draft-лот: «Сохранить черновик» — PATCH без submit-запроса", async () => {
    apiMock.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === "/market/my-lots") return [{ ...EDIT_LOT, listing_id: 8, status: "draft" }];
      if (path === "/market/lots/8" && opts?.method === "PATCH") return {};
      return undefined;
    });
    renderEdit("/sell?edit=8");
    await screen.findByDisplayValue("Hyundai");
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([p, o]) => p === "/market/lots/8" && o?.method === "PATCH"),
      ).toBe(true),
    );
    expect(mocks.toastShow).toHaveBeenCalledWith("Черновик сохранён");
    await waitFor(() => expect(screen.getByTestId("auto-mine-route")).toBeTruthy());
    expect(apiMock.mock.calls.some(([p]) => p === "/market/lots/8/submit")).toBe(false);
  });

  it("draft-лот: публикация — PATCH + POST /submit → moderation-тост", async () => {
    apiMock.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === "/market/my-lots") return [{ ...EDIT_LOT, listing_id: 8, status: "draft" }];
      if (path === "/market/lots/8" && opts?.method === "PATCH") return {};
      if (path === "/market/lots/8/submit") return { status: "moderation" };
      return undefined;
    });
    renderEdit("/sell?edit=8");
    await screen.findByDisplayValue("Hyundai");
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([p, o]) => p === "/market/lots/8" && o?.method === "PATCH")).toBe(true),
    );
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([p, o]) => p === "/market/lots/8/submit" && o?.method === "POST")).toBe(true),
    );
    expect(mocks.toastShow).toHaveBeenCalledWith("Отправлено на проверку — результат придёт здесь");
    await waitFor(() => expect(screen.getByTestId("auto-mine-route")).toBeTruthy());
  });

  it("patch_reject_reason лота показывается баннером в edit-режиме", async () => {
    const withPatch: MyLot = {
      ...EDIT_LOT,
      pending_patch: { patch_reject_reason: "телефон в описании" },
    };
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/market/my-lots") return [withPatch];
      return undefined;
    });
    renderEdit();
    expect(await screen.findByText(/Предыдущие правки отклонены: телефон в описании/)).toBeTruthy();
  });

  it("лот не найден в my-lots — заглушка вместо пустой формы", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/market/my-lots") return [];
      return undefined;
    });
    renderEdit();
    expect(await screen.findByText("Объявление не найдено")).toBeTruthy();
    expect(screen.queryByLabelText("Марка")).toBeNull();
    expect(lotCalls()).toHaveLength(0);
  });
});

// ---------- Генерация описания + «Качество объявления» (12-ai-trust §2) ----------

describe("SellCar: «✨ Сгенерировать описание» (12 §2)", () => {
  it("POST /market/description с полями визарда + photos_count → текст в textarea", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/market/description") return { text: "Продаю Kia K5 2022 года, один владелец." };
      return LOT;
    });
    renderScreen();
    fillStep1();
    fireEvent.change(screen.getByLabelText("Пробег, км"), { target: { value: "35000" } });
    fireEvent.change(screen.getByLabelText("Топливо"), { target: { value: "petrol" } });
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    // 2 фото на шаге «Фото» — их количество уходит в photos_count
    fireEvent.drop(screen.getByLabelText("Добавить фото: перетащите файлы или нажмите"), {
      dataTransfer: { files: [photoFile("a.jpg"), photoFile("b.jpg")] },
    });
    await waitFor(() => expect(document.querySelectorAll(".sell-pcard--done")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "✨ Сгенерировать описание" }));

    await waitFor(() =>
      expect(apiMock.mock.calls.some(([p]) => p === "/market/description")).toBe(true),
    );
    const call = apiMock.mock.calls.find(([p]) => p === "/market/description");
    expect(call?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      make: "Kia",
      model: "K5",
      year: 2022,
      price: 20_000_000,
      currency: "RUB", // UX-002: дефолт визарда — RU/RUB
      mileage_km: 35_000,
      fuel: "petrol",
      photos_count: 2,
    });
    // текст подставился в textarea — юзер может править
    await waitFor(() =>
      expect((screen.getByLabelText("Описание") as HTMLTextAreaElement).value).toBe(
        "Продаю Kia K5 2022 года, один владелец.",
      ),
    );
  });

  it("429 ai_generation_limit — тост лимита, описание не меняется", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/market/description")
        throw Object.assign(new Error("ai_generation_limit"), { status: 429 });
      return LOT;
    });
    renderScreen();
    gotoPublish();
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "✨ Сгенерировать описание" }));
    await waitFor(() =>
      expect(mocks.toastShow).toHaveBeenCalledWith(
        "Лимит генераций на сегодня исчерпан — обновится завтра",
        { error: true },
      ),
    );
    expect((screen.getByLabelText("Описание") as HTMLTextAreaElement).value).toBe("");
  });

  it("повторная генерация — confirm: ок перезаписывает, отмена не шлёт POST", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    let n = 0;
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/market/description") return { text: `вариант ${++n}` };
      return LOT;
    });
    renderScreen();
    gotoPublish();
    fillPrice();
    // первая генерация (textarea пуста) — без confirm
    fireEvent.click(screen.getByRole("button", { name: "✨ Сгенерировать описание" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Описание") as HTMLTextAreaElement).value).toBe("вариант 1"),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    // повтор: confirm «ок» → новый POST → перезапись
    fireEvent.click(screen.getByRole("button", { name: "✨ Сгенерировать описание" }));
    expect(confirmSpy).toHaveBeenCalledWith("Заменить текущее описание новым текстом?");
    await waitFor(() =>
      expect((screen.getByLabelText("Описание") as HTMLTextAreaElement).value).toBe("вариант 2"),
    );
    // повтор: confirm «отмена» — текст прежний, новых запросов нет
    confirmSpy.mockReturnValue(false);
    const posts = apiMock.mock.calls.filter(([p]) => p === "/market/description").length;
    fireEvent.click(screen.getByRole("button", { name: "✨ Сгенерировать описание" }));
    expect((screen.getByLabelText("Описание") as HTMLTextAreaElement).value).toBe("вариант 2");
    expect(apiMock.mock.calls.filter(([p]) => p === "/market/description").length).toBe(posts);
    confirmSpy.mockRestore();
  });
});

describe("SellCar: «Качество объявления» live (12 §2)", () => {
  it("совет по фото виден при <3 и исчезает при ≥3 (✓)", async () => {
    renderScreen();
    gotoPublish(); // фото не загружали
    const photoTip = "Добавьте фото салона и кузова — объявления с 3+ фото смотрят чаще";
    expect(screen.getByText(photoTip)).toBeTruthy();
    expect(document.querySelector(".sell-quality__item--warn")).toBeTruthy();

    // вернулись на шаг «Фото» и доложили до трёх — совет исчез, ✓
    fireEvent.click(screen.getByRole("button", { name: "← Назад" }));
    fireEvent.drop(screen.getByLabelText("Добавить фото: перетащите файлы или нажмите"), {
      dataTransfer: { files: [photoFile(), photoFile("b.jpg"), photoFile("c.jpg")] },
    });
    await waitFor(() => expect(document.querySelectorAll(".sell-pcard--done")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    expect(screen.queryByText(photoTip)).toBeNull();
    const okPhoto = Array.from(document.querySelectorAll(".sell-quality__item--ok")).find((el) =>
      el.textContent?.includes("Фото"),
    );
    expect(okPhoto).toBeTruthy();
  });

  it("описание live: совет при <80 символов, ✓ при ≥80", () => {
    renderScreen();
    gotoPublish();
    const descTip = "Опишите комплектацию, состояние и историю обслуживания";
    expect(screen.getByText(descTip)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "а".repeat(80) } });
    expect(screen.queryByText(descTip)).toBeNull();
    const okDesc = Array.from(document.querySelectorAll(".sell-quality__item--ok")).find((el) =>
      el.textContent?.includes("Описание"),
    );
    expect(okDesc).toBeTruthy();
  });
});

// ---------- Гео owner-лота: страна + город (GEO-V1 §2–§3) ----------

describe("SellCar: гео лота — страна и город (GEO-V1)", () => {
  it("селект страны: дефолт RU («внутренний рынок»), выбор KZ + город уходят в POST", async () => {
    renderScreen();
    const sel = screen.getByLabelText("Страна") as HTMLSelectElement;
    expect(sel.value).toBe("RU");
    expect(sel.options[sel.selectedIndex]?.text).toContain("внутренний рынок");
    fillStep1();
    fireEvent.change(screen.getByLabelText("Страна"), { target: { value: "KZ" } });
    fireEvent.change(screen.getByLabelText("Город"), { target: { value: "Алматы" } });
    gotoPublish();
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    await waitFor(() => expect(lotCalls()).toHaveLength(1));
    const body = JSON.parse(String((lotCalls()[0] as [string, RequestInit])[1].body));
    expect(body.country).toBe("KZ");
    expect(body.city).toBe("Алматы");
  });

  it("город опционален: без города ключа city в теле нет, страна всё равно уходит", async () => {
    renderScreen();
    fillStep1();
    gotoPublish();
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    await waitFor(() => expect(lotCalls()).toHaveLength(1));
    const body = JSON.parse(String((lotCalls()[0] as [string, RequestInit])[1].body));
    expect(body.country).toBe("RU");
    expect("city" in body).toBe(false);
  });

  it("импортные страны-источники (KR/CN/AE/US) в селекте не предлагаются", () => {
    renderScreen();
    const values = Array.from(
      (screen.getByLabelText("Страна") as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(values).toContain("RU");
    expect(values).toContain("KZ");
    expect(values).toContain("GE");
    expect(values).toContain("AM");
    expect(values).toContain("BY");
    expect(values).not.toContain("KR");
    expect(values).not.toContain("CN");
    expect(values).not.toContain("AE");
    expect(values).not.toContain("US");
  });

  it("гео живёт в черновике визарда: страна и город восстанавливаются", () => {
    renderScreen();
    fillStep1();
    fireEvent.change(screen.getByLabelText("Страна"), { target: { value: "GE" } });
    fireEvent.change(screen.getByLabelText("Город"), { target: { value: "Тбилиси" } });
    fireEvent.click(screen.getByRole("button", { name: "Далее →" }));
    cleanup();
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "← Назад" }));
    expect((screen.getByLabelText("Страна") as HTMLSelectElement).value).toBe("GE");
    expect((screen.getByLabelText("Город") as HTMLInputElement).value).toBe("Тбилиси");
  });
});

// ---------- Валюта следует за страной продавца (UX-002/GEO) ----------

describe("SellCar: валюта по стране (UX-002)", () => {
  it("новый лот: дефолт RU → валюта RUB (не KRW), символ ₽ в превью", async () => {
    renderScreen();
    expect((screen.getByLabelText("Страна") as HTMLSelectElement).value).toBe("RU");
    gotoPublish();
    const cur = screen.getByLabelText("Валюта") as HTMLSelectElement;
    expect(cur.value).toBe("RUB");
    fillPrice("1500000");
    // toLocaleString("ru-RU") даёт NBSP-разделители — нормализуем
    const preview = document.querySelector(".sell-preview__price")?.textContent ?? "";
    expect(preview.replace(/ /g, " ")).toContain("1 500 000 ₽");
  });

  it("смена страны подтягивает её валюту: KZ → KZT, BY → BYN, GE/AM → USD", async () => {
    // Страна — шаг 1, валюта — шаг публикации: узел селекта страны после
    // перехода detached, поэтому меняем страну ДО ухода с шага и сверяем
    // валюту на публикации (независимый рендер на каждую страну).
    for (const [code, cur] of [["KZ", "KZT"], ["BY", "BYN"], ["GE", "USD"]] as const) {
      cleanup();
      sessionStorage.removeItem("autobot.sellDraft"); // иначе рендер откроет шаг 3 прошлого черновика
      renderScreen();
      fireEvent.change(screen.getByLabelText("Страна"), { target: { value: code } });
      fillStep1();
      gotoPublish();
      expect((screen.getByLabelText("Валюта") as HTMLSelectElement).value).toBe(cur);
    }
    // выбор страны уходит в сабмит вместе с её валютой
    cleanup();
    sessionStorage.removeItem("autobot.sellDraft");
    renderScreen();
    fireEvent.change(screen.getByLabelText("Страна"), { target: { value: "KZ" } });
    fillStep1();
    gotoPublish();
    expect((screen.getByLabelText("Валюта") as HTMLSelectElement).value).toBe("KZT");
    fillPrice("8000000");
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    await waitFor(() => expect(lotCalls()).toHaveLength(1));
    const body = JSON.parse(String((lotCalls()[0] as [string, RequestInit])[1].body));
    expect(body.country).toBe("KZ");
    expect(body.currency).toBe("KZT");
  });

  it("юзер может сменить валюту вручную после смены страны", async () => {
    renderScreen();
    fillStep1();
    gotoPublish();
    expect((screen.getByLabelText("Валюта") as HTMLSelectElement).value).toBe("RUB");
    fireEvent.change(screen.getByLabelText("Валюта"), { target: { value: "EUR" } });
    fillPrice();
    fireEvent.click(screen.getByRole("button", { name: "Отправить на публикацию" }));
    await waitFor(() => expect(lotCalls()).toHaveLength(1));
    const body = JSON.parse(String((lotCalls()[0] as [string, RequestInit])[1].body));
    expect(body.currency).toBe("EUR");
  });

  it("в списке валют: RUB/USD/EUR/KZT/BYN — KRW у источников недоступна", async () => {
    renderScreen();
    gotoPublish();
    const values = Array.from(
      (screen.getByLabelText("Валюта") as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(values).toEqual(["RUB", "USD", "EUR", "KZT", "BYN"]);
  });
});

// ---------- Live-статусы объявлений (10-listing-lifecycle §3) ----------

describe("SellCar v3: live listing_status (10 §3)", () => {
  it("событие личного канала → тост на форме продажи", async () => {
    renderScreen();
    expect(await screen.findByLabelText("Марка")).toBeTruthy();
    act(() => {
      chatStore.handleEvent({
        type: "listing_status",
        listing_id: 123,
        status: "rejected",
        reason: "контакты в описании",
      });
    });
    expect(mocks.toastShow).toHaveBeenCalledWith("Объявление отклонено: контакты в описании", {
      error: true,
    });
  });

  it("accepted/expired — нейтральные тосты без error", async () => {
    renderScreen();
    await screen.findByLabelText("Марка");
    act(() => {
      chatStore.handleEvent({ type: "listing_status", listing_id: 1, status: "accepted" });
      chatStore.handleEvent({ type: "listing_status", listing_id: 2, status: "expired" });
    });
    expect(mocks.toastShow).toHaveBeenCalledWith("Объявление одобрено", { error: false });
    expect(mocks.toastShow).toHaveBeenCalledWith("Срок размещения объявления истёк", {
      error: false,
    });
  });
});

describe("SellCar: гость", () => {
  it("гостю — заглушка и логин-промпт, POST не уходит", async () => {
    vi.mocked(isGuest).mockReturnValue(true);
    renderScreen();
    expect(screen.getByText("Продажа — после входа")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Войти и разместить" }));
    expect(mocks.promptShow).toHaveBeenCalledWith(
      "Размещение объявлений доступно после входа — войдите или зарегистрируйтесь.",
    );
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe("FAB «+» на ленте (SellFab)", () => {
  const renderFab = (initial: string) =>
    render(
      <MemoryRouter initialEntries={[initial]}>
        <SellFab />
        <Routes>
          <Route path="/sell" element={<RouteProbe testid="sell-route" />} />
        </Routes>
      </MemoryRouter>,
    );

  it("на ленте: клик ведёт на /sell", async () => {
    renderFab("/");
    fireEvent.click(screen.getByRole("button", { name: "Продать авто" }));
    await waitFor(() => expect(screen.getByTestId("sell-route")).toBeTruthy());
  });

  it("на /chats/* FAB скрыт", () => {
    renderFab("/chats/t-uuid");
    expect(screen.queryByRole("button", { name: "Продать авто" })).toBeNull();
  });

  it("гостю FAB невидим даже на ленте", () => {
    vi.mocked(isGuest).mockReturnValue(true);
    renderFab("/");
    expect(screen.queryByRole("button", { name: "Продать авто" })).toBeNull();
  });
});
