/**
 * Тесты экрана «Чаты» v2 (07-sell-chats-partner-inspection.md §2 +
 * 08-group-governance.md §7 + 09-personal-channel.md §2-§3):
 *  - гостю — заглушка «Войдите» (без запроса /chats);
 *  - список + overlay-роут /chats/:id (ChatRoom поверх, deep-link, назад);
 *  - сегмент «Диалоги | Переговорные» фильтрует список;
 *  - создание переговорной (08 §1): лот из истории просмотров ОБЯЗАТЕЛЕН
 *    (без выбора — инлайн-ошибка; пустая история — заглушка «Откройте
 *    карточку автомобиля» + «К ленте»; title опц. — пусто = автогенер);
 *  - присоединение по коду: POST /chats/join → переход; 409 group_is_full →
 *    тост «Переговорная заполнена (макс. 5)»;
 *  - говернанс: owner архивирует комнату → тред уезжает в свёрнутую секцию
 *    «Архив» внизу списка; закрытый тред открывается read-only;
 *  - двухколоночный десктоп ≥900px (09 §3): список и комната одновременно,
 *    заглушка «Выберите диалог», live-unread сайдбара из стора; мобайл — стек.
 * Список тредов — единый стор (lib/chatStore): /chats/ws-token в моках
 * падает → транспорт уходит в поллинг-фоллбэк (GET /chats каждые 5с).
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chatStore, resetChatStore } from "../lib/chatStore";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  isGuest: vi.fn((): boolean => false),
  toastShow: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: mocks.api }));
vi.mock("../api/auth", () => ({ isGuest: mocks.isGuest, haptic: vi.fn() }));
vi.mock("../ui/Toast", () => ({ useToast: () => ({ show: mocks.toastShow }) }));

import { ChatsScreen } from "./Chats";

const THREADS = [
  {
    id: "t1",
    type: "support",
    title: "Поддержка",
    status: "active",
    unread: 2,
    last_message: {
      body: "Чем можем помочь?",
      created_at: "2026-10-25T10:00:00Z",
      sender_type: "bot",
    },
    subject: null,
  },
  {
    id: "t2",
    type: "seller",
    title: "Kia K5",
    status: "active",
    unread: 0,
    last_message: {
      body: "Машина ещё в продаже?",
      created_at: "2026-10-24T10:00:00Z",
      sender_type: "user",
    },
    subject: {
      listing_id: 7,
      make: "Kia",
      model: "K5",
      year: 2022,
      price: 18_400_000,
      currency: "KRW",
      image: null,
    },
  },
  {
    id: "g1",
    type: "group",
    title: "Осмотр в субботу",
    status: "active",
    unread: 0,
    last_message: {
      body: "Едем в 10:00",
      created_at: "2026-10-23T10:00:00Z",
      sender_type: "user",
    },
    subject: null,
    is_group: true,
    role: "owner",
    participants: [
      { user_type: "user", user_id: 42, name: "Аня", role: "owner" },
      { user_type: "user", user_id: 100, name: "Борис", role: "member" },
    ],
  },
  {
    id: "g2",
    type: "group",
    title: "Старые переговоры",
    status: "closed",
    unread: 0,
    last_message: {
      body: "Комната архивирована",
      created_at: "2026-10-20T10:00:00Z",
      sender_type: "system",
    },
    subject: null,
    is_group: true,
    role: "member",
    participants: [
      { user_type: "user", user_id: 42, name: "Аня", role: "owner" },
    ],
  },
];

const chatCalls = () => mocks.api.mock.calls.filter(([p]) => p === "/chats").length;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isGuest.mockReturnValue(false);
  localStorage.removeItem("autobot.views.guest");
  resetChatStore(); // стор-синглтон: чистое состояние (и транспорт) на тест
  mocks.api.mockImplementation(async (path: string) => {
    if (path === "/chats") return THREADS;
    if (path === "/chats/group") return { thread_id: "g-new" };
    if (path === "/chats/join") return { thread_id: "j1" };
    if (path.startsWith("/chats/") && path.includes("/messages"))
      return {
        items: [
          {
            id: 1,
            sender_type: "user",
            sender_id: null,
            body: "привет",
            created_at: "2026-10-25T10:00:00Z",
          },
          {
            id: 2,
            sender_type: "bot",
            sender_id: null,
            body: "Чем можем **помочь**?",
            created_at: "2026-10-25T10:00:05Z",
          },
        ],
        has_more: false,
      };
    if (path.endsWith("/read")) return undefined;
    if (path === "/me") return { telegram_id: 42 }; // «Вы» в шапке group + uid канала
    if (path === "/chats/ws-token") throw new Error("401"); // → поллинг-фоллбэк
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  localStorage.removeItem("autobot.views.guest");
  resetChatStore(); // гасим интервал поллинг-фоллбэка между тестами
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ChatsScreen />
    </MemoryRouter>,
  );

describe("Chats: гость", () => {
  it("конверт виден, но экран — заглушка «Войдите», без запроса /chats", async () => {
    mocks.isGuest.mockReturnValue(true);
    renderAt("/chats");
    expect(screen.getByText("Чаты")).toBeTruthy();
    expect(screen.getByText("Войти").getAttribute("href")).toBe("/login");
    // запрос списка не ушёл (гостю ручка недоступна)
    await waitFor(() => expect(screen.getByText(/после входа/i)).toBeTruthy());
    expect(chatCalls()).toBe(0);
  });
});

describe("Chats: список и overlay-роут", () => {
  it("список тредов с unread-бейджем; клик открывает ChatRoom по /chats/:id", async () => {
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    expect(screen.getByLabelText("2 непрочитанных")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Чат: Kia K5/ }));
    // overlay: ChatRoom с сообщениями треда (список скрыт, но живёт в DOM —
    // тексты списка и чата могут пересекаться, проверяем внутри chat-room)
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')).not.toBeNull(),
    );
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')?.textContent).toContain(
        "помочь",
      ),
    );
    expect(mocks.api.mock.calls.some(([p]) => String(p).startsWith("/chats/t2/messages"))).toBe(
      true,
    );
  });

  it("deep-link /chats/t1 открывает чат сразу (тред резолвится сам)", async () => {
    renderAt("/chats/t1");
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')?.textContent).toContain(
        "помочь",
      ),
    );
    // тред подтянется списком стора — тип-бейдж поддержки появляется
    await waitFor(() =>
      expect(document.querySelector(".chat-room__type--support")).not.toBeNull(),
    );
  });

  it("«←» из ChatRoom возвращает к списку (тот же keep-alive экран)", async () => {
    renderAt("/chats/t1");
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')?.textContent).toContain(
        "помочь",
      ),
    );
    fireEvent.click(screen.getByLabelText("К списку чатов"));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')).toBeNull(),
    );
    expect(screen.getByText("Kia K5")).toBeTruthy();
  });

  it("пустой список — «Диалогов пока нет» с кнопкой поддержки", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/chats") return [];
      if (path === "/chats/ws-token") throw new Error("401");
      return undefined;
    });
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Диалогов пока нет")).toBeTruthy());
    // кнопка поддержки и в шапке, и в пустом состоянии
    expect(screen.getAllByText("💬 Написать в поддержку").length).toBe(2);
  });

  it("ошибка загрузки — человекочитаемый текст (маппинг) + ретрай повторяет GET /chats", async () => {
    mocks.api.mockRejectedValueOnce(new Error("503")).mockResolvedValue([]);
    renderAt("/chats");
    // сырой текст ошибки наружу не показываем (UX-005) — маппинг 03 §3.2
    await waitFor(() => expect(screen.getByText(/Что-то пошло не так/)).toBeTruthy());
    fireEvent.click(screen.getByText("Повторить"));
    await waitFor(() => expect(screen.getByText("Диалогов пока нет")).toBeTruthy());
  });
});

describe("Chats v2: сегмент «Диалоги | Переговорные» (07 §2)", () => {
  it("по умолчанию диалоги: переговорная скрыта; сегмент фильтрует список", async () => {
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    // переговорная не в списке диалогов
    expect(screen.queryByText("Осмотр в субботу")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));
    await waitFor(() => expect(screen.getByText("Осмотр в субботу")).toBeTruthy());
    expect(screen.queryByText("Kia K5")).toBeNull(); // диалоги скрыты
    // бейдж типа «Переговорная»
    expect(screen.getAllByText("Переговорная").length).toBeGreaterThan(0);
  });

  it("под «Переговорными» панель создания и кода; в «Диалогах» её нет", async () => {
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    expect(screen.queryByLabelText("Код переговорной")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));
    expect(screen.getByLabelText("Код переговорной")).toBeTruthy();
    expect(screen.getByRole("button", { name: "＋ Создать переговорную" })).toBeTruthy();
  });

  it("пустые переговорные — своё пустое состояние с CTA «Создать»", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/chats") return THREADS.filter((t) => t.type !== "group");
      if (path === "/chats/ws-token") throw new Error("401");
      return undefined;
    });
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));
    await waitFor(() => expect(screen.getByText("Переговорных пока нет")).toBeTruthy());
  });
});

describe("Chats v2: создание переговорной (08 §1: лот обязателен)", () => {
  /** Положить в историю просмотров один лот (Kia K5 2022). */
  const seedViews = () =>
    localStorage.setItem(
      "autobot.views.guest",
      JSON.stringify([
        {
          listing_id: 7,
          make: "Kia",
          model: "K5",
          year: 2022,
          viewed_at: "2026-10-25T09:00:00Z",
        },
      ]),
    );

  it("мини-форма: обязательный лот + title → POST /chats/group → переход", async () => {
    seedViews();
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));
    fireEvent.click(screen.getByRole("button", { name: "＋ Создать переговорную" }));

    // селект лота обязателен: плейсхолдер «Выберите автомобиль» + лот из истории
    const lotSelect = screen.getByLabelText(
      "Автомобиль для переговорной (обязательно)",
    ) as HTMLSelectElement;
    expect(lotSelect.options.length).toBe(2);
    expect(lotSelect.value).toBe("");
    fireEvent.change(lotSelect, { target: { value: "7" } });

    fireEvent.change(screen.getByLabelText("Название переговорной (необязательно)"), {
      target: { value: "Осмотр в субботу" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Создать переговорную" }));

    const groupCall = await waitFor(() =>
      mocks.api.mock.calls.find(([p, o]) => p === "/chats/group" && o?.method === "POST"),
    );
    expect(JSON.parse(String(groupCall?.[1]?.body))).toEqual({
      listing_id: 7,
      title: "Осмотр в субботу",
    });
    // переход в созданный тред
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')).not.toBeNull(),
    );
    expect(mocks.api.mock.calls.some(([p]) => String(p).startsWith("/chats/g-new/messages"))).toBe(
      true,
    );
    expect(mocks.toastShow).toHaveBeenCalledWith("Переговорная создана");
  });

  it("сабмит без выбора лота — инлайн-ошибка, POST не уходит", async () => {
    seedViews();
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));
    fireEvent.click(screen.getByRole("button", { name: "＋ Создать переговорную" }));

    // лот не выбран (title заполнен) — создания нет
    fireEvent.change(screen.getByLabelText("Название переговорной (необязательно)"), {
      target: { value: "Осмотр" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Создать переговорную" }));
    expect(
      await screen.findByText("Выберите автомобиль — переговорная создаётся только по объявлению"),
    ).toBeTruthy();
    expect(mocks.api.mock.calls.some(([p]) => p === "/chats/group")).toBe(false);
  });

  it("пустая история просмотров — заглушка «Откройте карточку» + «К ленте», формы нет", async () => {
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));
    fireEvent.click(screen.getByRole("button", { name: "＋ Создать переговорную" }));

    expect(screen.getByTestId("chats-create-empty")).toBeTruthy();
    expect(
      screen.getByText("Откройте карточку автомобиля, чтобы создать переговорную"),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /К ленте/ }).getAttribute("href")).toBe("/feed");
    // селекта/POST нет
    expect(screen.queryByLabelText("Автомобиль для переговорной (обязательно)")).toBeNull();
    expect(mocks.api.mock.calls.some(([p]) => p === "/chats/group")).toBe(false);
  });

  it("пустой title допустим — уходит только listing_id (автогенер бэка)", async () => {
    seedViews();
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));
    fireEvent.click(screen.getByRole("button", { name: "＋ Создать переговорную" }));
    fireEvent.change(screen.getByLabelText("Автомобиль для переговорной (обязательно)"), {
      target: { value: "7" },
    });
    // title не трогаем — плейсхолдер «Переговоры: марка модель» на бэке
    fireEvent.click(screen.getByRole("button", { name: "Создать переговорную" }));

    const groupCall = await waitFor(() =>
      mocks.api.mock.calls.find(([p, o]) => p === "/chats/group" && o?.method === "POST"),
    );
    expect(JSON.parse(String(groupCall?.[1]?.body))).toEqual({ listing_id: 7 });
  });

  it("короткий title (при выбранном лоте) — инлайн-ошибка, POST не уходит", async () => {
    seedViews();
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));
    fireEvent.click(screen.getByRole("button", { name: "＋ Создать переговорную" }));
    fireEvent.change(screen.getByLabelText("Автомобиль для переговорной (обязательно)"), {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByLabelText("Название переговорной (необязательно)"), {
      target: { value: "A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Создать переговорную" }));
    expect(await screen.findByText("Название — от 3 до 120 символов")).toBeTruthy();
    expect(mocks.api.mock.calls.some(([p]) => p === "/chats/group")).toBe(false);
  });
});

describe("Chats v2: присоединение по коду (07 §2)", () => {
  it("кнопка ждёт 6 символов; код → POST /chats/join → переход в тред", async () => {
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));

    const input = screen.getByLabelText("Код переговорной");
    const btn = screen.getByRole("button", { name: "Присоединиться" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "ab12cd" } });
    // инпут апскейлит код
    expect((input as HTMLInputElement).value).toBe("AB12CD");
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);

    const joinCall = await waitFor(() =>
      mocks.api.mock.calls.find(([p, o]) => p === "/chats/join" && o?.method === "POST"),
    );
    expect(JSON.parse(String(joinCall?.[1]?.body))).toEqual({ code: "AB12CD" });
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')).not.toBeNull(),
    );
    expect(mocks.api.mock.calls.some(([p]) => String(p).startsWith("/chats/j1/messages"))).toBe(
      true,
    );
  });

  it("409 group_is_full → тост «Переговорная заполнена», без перехода", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/chats/join") throw new Error("group_is_full");
      if (path === "/chats") return THREADS;
      if (path === "/chats/ws-token") throw new Error("401");
      return undefined;
    });
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));
    fireEvent.change(screen.getByLabelText("Код переговорной"), { target: { value: "XYZ789" } });
    fireEvent.click(screen.getByRole("button", { name: "Присоединиться" }));

    await waitFor(() =>
      expect(mocks.toastShow).toHaveBeenCalledWith("Переговорная заполнена (макс. 5)", {
        error: true,
      }),
    );
    expect(document.querySelector('[data-testid="chat-room"]')).toBeNull();
  });

  it("ошибка join 404 invite_not_found — текст маппинга, без сырого detail (UX-005)", async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/chats/join")
        throw Object.assign(new Error("invite_not_found: код истёк или не существует"), {
          status: 404,
        });
      if (path === "/chats") return THREADS;
      if (path === "/chats/ws-token") throw new Error("401");
      return undefined;
    });
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));
    fireEvent.change(screen.getByLabelText("Код переговорной"), { target: { value: "ZZ9Q1X" } });
    fireEvent.click(screen.getByRole("button", { name: "Присоединиться" }));
    await waitFor(() =>
      expect(mocks.toastShow).toHaveBeenCalledWith(
        "Код приглашения истёк или не существует — попросите новый.",
        { error: true },
      ),
    );
    // сырой detail не показан
    expect(mocks.toastShow).not.toHaveBeenCalledWith(
      expect.stringContaining("invite_not_found"),
      expect.anything(),
    );
  });
});

describe("Chats: говернанс переговорных (08-group-governance §7)", () => {
  /** Дефолтный мок с флипом статуса g1 после POST /archive. */
  const mockWithArchive = () => {
    let archived = false;
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/chats") {
        return archived
          ? THREADS.map((t) => (t.id === "g1" ? { ...t, status: "closed" } : t))
          : THREADS;
      }
      if (path === "/chats/g1/archive" && init?.method === "POST") {
        archived = true;
        return undefined;
      }
      if (path.startsWith("/chats/") && path.includes("/messages")) {
        return {
          items: [
            {
              id: 1,
              sender_type: "user",
              sender_id: 42,
              body: "поехали",
              created_at: "2026-10-25T10:00:00Z",
            },
          ],
          has_more: false,
        };
      }
      if (path.endsWith("/read")) return undefined;
      if (path === "/me") return { telegram_id: 42 };
      if (path === "/chats/ws-token") throw new Error("401");
      return undefined;
    });
  };

  it("owner архивирует комнату → список показывает её в свёрнутой секции «Архив»", async () => {
    mockWithArchive();
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));
    fireEvent.click(screen.getByRole("button", { name: /Чат: Осмотр в субботу/ }));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')).not.toBeNull(),
    );

    // owner-меню: архивировать → confirm «только для чтения»
    fireEvent.click(screen.getByRole("button", { name: "Меню комнаты" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Архивировать/ }));
    fireEvent.click(screen.getByRole("button", { name: "Архивировать" }));
    await waitFor(() =>
      expect(screen.getByTestId("chat-archive-plate").textContent).toContain(
        "📁 Архив — комната закрыта",
      ),
    );
    expect(mocks.toastShow).toHaveBeenCalledWith("Комната архивирована");

    // назад к списку — тред переехал в свёрнутую секцию «Архив»
    fireEvent.click(screen.getByLabelText("К списку чатов"));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')).toBeNull(),
    );
    const archive = await waitFor(() => {
      const el = screen.getByTestId("chat-archive");
      expect(el).toBeTruthy();
      return el;
    });
    // свернуто: строки архива не видно, счётчик 2 (g1 + старый g2)
    expect(archive.textContent).toContain("2");
    expect(screen.queryByRole("button", { name: /Чат: Осмотр в субботу/ })).toBeNull();

    // разворачиваем — серые строки с меткой «архив»
    fireEvent.click(screen.getByRole("button", { name: /Архив/ }));
    expect(screen.getByRole("button", { name: /Чат: Осмотр в субботу/ })).toBeTruthy();
    expect(screen.getAllByText("архив").length).toBeGreaterThanOrEqual(2);
  });

  it("закрытый тред из «Архива» открывается read-only (плашка вместо композера)", async () => {
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "👥 Переговорные" }));
    fireEvent.click(screen.getByRole("button", { name: /Архив/ }));
    fireEvent.click(screen.getByRole("button", { name: /Чат: Старые переговоры/ }));
    await waitFor(() =>
      expect(screen.getByTestId("chat-archive-plate").textContent).toContain(
        "📁 Архив — комната закрыта",
      ),
    );
    expect(screen.queryByLabelText("Сообщение")).toBeNull();
    expect(screen.queryByRole("button", { name: "Меню комнаты" })).toBeNull();
  });
});

describe("Chats: двухколоночный десктоп ≥900px (09-personal-channel.md §3)", () => {
  /** Мок matchMedia: срабатывает только на min-width: 900px (сплит-макет). */
  const enableWideMedia = () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes("900"),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  };
  const disableWideMedia = () => {
    // jsdom без matchMedia — возвращаем исходное отсутствие (мобайл)
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  };
  afterEach(disableWideMedia);

  it("/chats без :id: список и заглушка «Выберите диалог» в одной сетке", async () => {
    enableWideMedia();
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    expect(document.querySelector(".chats-page--split")).not.toBeNull();
    expect(screen.getByTestId("chats-placeholder").textContent).toContain("Выберите диалог");
    expect(screen.queryByTestId("chat-room")).toBeNull();
  });

  it("выбор треда не уводит со списка: комната справа, активная строка подсвечена", async () => {
    enableWideMedia();
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Чат: Kia K5/ }));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')).not.toBeNull(),
    );
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')?.textContent).toContain(
        "помочь",
      ),
    );
    // сайдбар живёт рядом с комнатой (не спрятан под overlay)
    expect(document.querySelector(".chats-page__list.keepalive-hidden")).toBeNull();
    expect(screen.getByRole("button", { name: /Чат: Kia K5/ })).toBeTruthy();
    expect(document.querySelector(".chat-item--active")).not.toBeNull();
  });

  it("message-событие закрытого треда обновляет unread сайдбара (стор), комната не дёргается", async () => {
    enableWideMedia();
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Чат: Kia K5/ }));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')).not.toBeNull(),
    );
    // открыта комната t2; в закрытый t1 (поддержка, unread 2) приходит сообщение
    expect(screen.getByLabelText("2 непрочитанных")).toBeTruthy();
    act(() => {
      chatStore.handleEvent({
        type: "message",
        thread_id: "t1",
        message: {
          id: 99,
          sender_type: "bot",
          sender_id: null,
          body: "новое сообщение",
          created_at: "2026-10-25T12:00:00Z",
        },
      });
    });
    await waitFor(() => expect(screen.getByLabelText("3 непрочитанных")).toBeTruthy());
    // лента открытой комнаты (t2) сообщение чужого треда не попало
    expect(document.querySelector('[data-testid="chat-room"]')?.textContent).not.toContain(
      "новое сообщение",
    );
  });

  it("мобайл (<900px): прежний стек — overlay накрывает список", async () => {
    renderAt("/chats");
    await waitFor(() => expect(screen.getByText("Kia K5")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Чат: Kia K5/ }));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="chat-room"]')).not.toBeNull(),
    );
    expect(document.querySelector(".chats-page__list.keepalive-hidden")).not.toBeNull();
    expect(document.querySelector(".chats-page__overlay")).not.toBeNull();
    expect(document.querySelector(".chats-page--split")).toBeNull();
  });
});
