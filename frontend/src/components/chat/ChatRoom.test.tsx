/**
 * Тесты экрана чата (ChatRoom) v2 (07 §2 + 09 §1): markdown в пузырях,
 * отправка по Enter (Shift+Enter — перенос), read-статус ✓→✓✓, typing
 * (в group — с именем), «Позвать человека» (support), переговорные:
 * шапка с участниками «Вы, … · N/5», «Пригласить» → код + копирование,
 * дата-разделители ленты, inline-ошибка с «Повторить».
 * Данные — единый стор (lib/chatStore, 09 §2): события стреляем в стор
 * (chatStore.handleEvent) с thread_id, как их приносит личный канал.
 * Новое (09 §1): typing-отправка с debounce (POST /chats/{id}/typing,
 * 429 глушим), онлайн-точки (GET /chats/online).
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatEvent } from "../../lib/chatSocket";
import type { ChatThread } from "../../lib/chatApi";

const mocks = vi.hoisted(() => ({
  fetchChats: vi.fn(),
  fetchMessages: vi.fn(),
  sendMessage: vi.fn(),
  markRead: vi.fn(),
  summonOperator: vi.fn(),
  createChatInvite: vi.fn(),
  sendTyping: vi.fn(),
  fetchOnlineUsers: vi.fn(),
  meApi: vi.fn(),
  toastShow: vi.fn(),
  clipboardWrite: vi.fn(),
  // говернанс (08 §2/§4/§6)
  setChatMuted: vi.fn(),
  leaveChat: vi.fn(),
  archiveChat: vi.fn(),
  kickChatParticipant: vi.fn(),
  reportChat: vi.fn(),
}));

vi.mock("../../lib/chatApi", async (importOriginal) => ({
  // реальный toChatThread и словари + шпионы запросов (стор зовёт их же)
  ...(await importOriginal<typeof import("../../lib/chatApi")>()),
  fetchChats: mocks.fetchChats,
  fetchMessages: mocks.fetchMessages,
  sendMessage: mocks.sendMessage,
  markRead: mocks.markRead,
  summonOperator: mocks.summonOperator,
  createChatInvite: mocks.createChatInvite,
  sendTyping: mocks.sendTyping,
  fetchOnlineUsers: mocks.fetchOnlineUsers,
  setChatMuted: mocks.setChatMuted,
  leaveChat: mocks.leaveChat,
  archiveChat: mocks.archiveChat,
  kickChatParticipant: mocks.kickChatParticipant,
  reportChat: mocks.reportChat,
}));

vi.mock("../../api/client", () => ({ api: mocks.meApi }));
vi.mock("../../api/auth", () => ({ haptic: vi.fn(), isGuest: vi.fn(() => false) }));
vi.mock("../../ui/Toast", () => ({ useToast: () => ({ show: mocks.toastShow }) }));

import { ChatRoom } from "./ChatRoom";
import { chatStore, resetChatStore } from "../../lib/chatStore";

const thread: ChatThread = {
  id: "t1",
  type: "support",
  title: "Поддержка",
  status: "active",
  unread: 0,
  last_message: null,
  subject: null,
};

const groupThread: ChatThread = {
  id: "g1",
  type: "group",
  title: "Осмотр Kia K5",
  status: "active",
  unread: 0,
  last_message: null,
  subject: null,
  is_group: true,
  role: "owner",
  muted: false,
  participants: [
    { user_type: "user", user_id: 42, name: "Аня", role: "owner" },
    { user_type: "user", user_id: 100, name: "Борис", role: "member" },
    { user_type: "partner", user_id: 7, name: "Партнёр Сеул", role: "member" },
  ],
};

const msg = (
  id: number,
  sender_type: "user" | "bot" | "system" | "operator" | "partner",
  body: string,
  created_at = "2026-10-25T10:00:00Z",
  sender_id: number | null = null,
) => ({
  id,
  sender_type,
  sender_id,
  body,
  created_at,
});

/** Стрельнуть событием личного канала в стор (как сделал бы транспорт). */
const fire = (ev: ChatEvent) => chatStore.handleEvent(ev);

beforeEach(() => {
  vi.clearAllMocks();
  resetChatStore();
  mocks.fetchChats.mockResolvedValue([]);
  mocks.fetchMessages.mockResolvedValue({
    items: [msg(10, "user", "привет"), msg(11, "bot", "**важно** сообщение")],
    has_more: false,
  });
  mocks.sendMessage.mockImplementation(async (_t: string, body: string) =>
    msg(12, "user", body),
  );
  mocks.markRead.mockResolvedValue(undefined);
  mocks.summonOperator.mockResolvedValue({ bot_paused: true, message: null });
  mocks.createChatInvite.mockResolvedValue("AB12CD");
  mocks.sendTyping.mockResolvedValue(undefined);
  mocks.fetchOnlineUsers.mockResolvedValue(new Set<number>());
  mocks.meApi.mockResolvedValue({ telegram_id: 42 });
  // говернанс: по умолчанию всё успешно
  mocks.setChatMuted.mockImplementation(async (_id: string, muted: boolean) => muted);
  mocks.leaveChat.mockResolvedValue(undefined);
  mocks.archiveChat.mockResolvedValue(undefined);
  mocks.kickChatParticipant.mockResolvedValue(undefined);
  mocks.reportChat.mockResolvedValue(undefined);
  // clipboard в jsdom отсутствует — подменяем
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mocks.clipboardWrite },
    configurable: true,
  });
  mocks.clipboardWrite.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  resetChatStore();
  cleanup();
});

const renderRoom = (t: ChatThread = thread) =>
  render(
    <MemoryRouter>
      <ChatRoom threadId={t.id} thread={t} />
    </MemoryRouter>,
  );

describe("ChatRoom: лента сообщений", () => {
  it("тело сообщения рендерится как markdown (bold → strong)", async () => {
    renderRoom();
    await waitFor(() => expect(mocks.fetchMessages).toHaveBeenCalledWith("t1"));
    const strong = await waitFor(() => {
      const el = document.querySelector(".chat-md strong");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(strong.textContent).toBe("важно");
    // первое чтение треда: read-маркер до последнего сообщения
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith("t1", 11));
  });

  it("свои сообщения справа (✓), bot — центр-строки", async () => {
    renderRoom();
    await screen.findByText(/важно/);
    const own = document.querySelector('.chat-msg--own[data-id="10"]');
    const bot = document.querySelector('.chat-msg--centered[data-id="11"]');
    expect(own).not.toBeNull();
    expect(bot).not.toBeNull();
    expect(own?.querySelector(".chat-msg__ticks")?.getAttribute("data-read")).toBe("sent");
  });

  it("дата-разделители: «Сегодня» у свежих, дата у старых (07 §2)", async () => {
    // не зависим от системных часов: вчера/сегодня считаем от now
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}T10:00:00Z`;
    mocks.fetchMessages.mockResolvedValue({
      items: [
        msg(9, "user", "вчерашнее", fmt(yesterday)),
        msg(10, "user", "привет", fmt(now)),
        msg(11, "bot", "**важно** сообщение", fmt(now)),
      ],
      has_more: false,
    });
    renderRoom();
    await screen.findByText(/важно/);
    const labels = Array.from(document.querySelectorAll(".chat-date span")).map(
      (el) => el.textContent,
    );
    expect(labels).toHaveLength(2);
    expect(labels[0]).toBe("Вчера");
    expect(labels[1]).toBe("Сегодня");
  });

  it("ошибка истории — inline-баннер с «Повторить» перезагружает ленту", async () => {
    mocks.fetchMessages
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue({ items: [msg(10, "user", "привет")], has_more: false });
    renderRoom();
    // сырой текст наружу не показываем (UX-005): маппинг 03 §3.2
    expect(await screen.findByText(/Что-то пошло не так/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(mocks.fetchMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("привет")).toBeTruthy());
  });

  it("lot_expired помечает предмет треда «лот снят» (09 §1)", async () => {
    renderRoom({ ...thread, type: "seller", subject: { listing_id: 7, make: "Kia", model: "K5", year: 2022, price: 1, currency: "KRW", image: null } });
    await screen.findByText(/важно/);
    fire({ type: "lot_expired", thread_id: "t1", listing_id: 7 });
    await waitFor(() => expect(screen.getByTestId("chat-lot-expired").textContent).toBe("лот снят"));
  });
});

describe("ChatRoom: композер", () => {
  it("Enter отправляет (POST sendMessage), сообщение падает в ленту с ✓", async () => {
    renderRoom();
    await screen.findByText(/важно/);
    const ta = screen.getByLabelText("Сообщение");
    fireEvent.change(ta, { target: { value: "сколько стоит доставка?" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith("t1", "сколько стоит доставка?"),
    );
    await waitFor(() =>
      expect(document.querySelector('.chat-msg--own[data-id="12"]')).not.toBeNull(),
    );
    // ✓ — отправлено (партнёр ещё не читал)
    expect(
      document.querySelector('.chat-msg--own[data-id="12"] .chat-msg__ticks')?.getAttribute("data-read"),
    ).toBe("sent");
    // поле очистилось
    expect((screen.getByLabelText("Сообщение") as HTMLTextAreaElement).value).toBe("");
  });

  it("Shift+Enter — перенос, не отправка", async () => {
    renderRoom();
    await screen.findByText(/важно/);
    const ta = screen.getByLabelText("Сообщение");
    fireEvent.change(ta, { target: { value: "строка" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("кнопка «Позвать человека» (support): POST summon-operator + оптимистичная system-строка", async () => {
    renderRoom();
    await screen.findByText(/важно/);
    fireEvent.click(screen.getByText("👥 Позвать человека"));
    await waitFor(() => expect(mocks.summonOperator).toHaveBeenCalledOnce());
    expect(mocks.summonOperator).toHaveBeenCalledWith("t1");
    await waitFor(() => expect(screen.getByText("Позвали оператора — бот на паузе")).toBeTruthy());
  });

  it("system-сообщение бэка (личный канал) заменяет оптимистичную заглушку зова", async () => {
    renderRoom();
    await screen.findByText(/важно/);
    fireEvent.click(screen.getByText("👥 Позвать человека"));
    await waitFor(() => expect(screen.getByText("Позвали оператора — бот на паузе")).toBeTruthy());
    // Бэк записал system-строку — событие личного канала приносит подтверждение
    fire({
      type: "message",
      thread_id: "t1",
      message: msg(20, "system", "Пользователь позвал оператора — бот на паузе"),
    });
    await waitFor(() =>
      expect(screen.getByText("Пользователь позвал оператора — бот на паузе")).toBeTruthy(),
    );
    // Заглушка (отрицательный id) удалена — в ленте одна system-строка зова
    expect(screen.queryByText("Позвали оператора — бот на паузе")).toBeNull();
  });

  it("ошибка зова — оптимистичная строка остаётся (тост о повторе)", async () => {
    mocks.summonOperator.mockRejectedValueOnce(new Error("network"));
    renderRoom();
    await screen.findByText(/важно/);
    fireEvent.click(screen.getByText("👥 Позвать человека"));
    await waitFor(() => expect(mocks.summonOperator).toHaveBeenCalledOnce());
    expect(screen.getByText("Позвали оператора — бот на паузе")).toBeTruthy();
  });

  it("у seller-чата кнопки «Позвать человека» нет", async () => {
    renderRoom({ ...thread, id: "s1", type: "seller", title: "Sonata" });
    await screen.findByText(/важно/);
    expect(screen.queryByText("👥 Позвать человека")).toBeNull();
  });
});

describe("ChatRoom: typing-отправка (09 §1: debounce 1.5с + rate)", () => {
  it("пачка ввода — один POST /typing после 1.5с", async () => {
    vi.useFakeTimers();
    renderRoom();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10); // лента загрузилась (микротаски)
    });
    const ta = screen.getByLabelText("Сообщение");
    fireEvent.change(ta, { target: { value: "пр" } });
    fireEvent.change(ta, { target: { value: "прив" } });
    fireEvent.change(ta, { target: { value: "привет" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    expect(mocks.sendTyping).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200); // 1.5с — debounce стреляет
    });
    expect(mocks.sendTyping).toHaveBeenCalledTimes(1);
    expect(mocks.sendTyping).toHaveBeenCalledWith("t1");
  });

  it("429 глушится: promise отклонён — UI не падает, ретрая нет", async () => {
    vi.useFakeTimers();
    mocks.sendTyping.mockRejectedValueOnce(new Error("429"));
    renderRoom();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    fireEvent.change(screen.getByLabelText("Сообщение"), { target: { value: "х" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600); // reject проглочен
    });
    expect(mocks.sendTyping).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="chat-room"]')).not.toBeNull();
  });
});

describe("ChatRoom: события личного канала (user:{uid})", () => {
  it("read-событие партнёра переводит ✓ в ✓✓", async () => {
    renderRoom();
    await screen.findByText(/важно/);
    const tick = document.querySelector('.chat-msg--own[data-id="10"] .chat-msg__ticks');
    expect(tick?.getAttribute("data-read")).toBe("sent");
    fire({ type: "read", thread_id: "t1", user_type: "partner", last_read_message_id: 10 });
    await waitFor(() =>
      expect(
        document
          .querySelector('.chat-msg--own[data-id="10"] .chat-msg__ticks')
          ?.getAttribute("data-read"),
      ).toBe("read"),
    );
    expect(
      document.querySelector('.chat-msg--own[data-id="10"] .chat-msg__ticks')?.textContent,
    ).toContain("✓✓");
  });

  it("typing-событие рисует индикатор «печатает»", async () => {
    renderRoom();
    await screen.findByText(/важно/);
    expect(screen.queryByText(/печатает/)).toBeNull();
    fire({ type: "typing", thread_id: "t1", user_type: "partner" });
    await waitFor(() => expect(screen.getByText(/печатает/)).toBeTruthy());
  });

  it("typing живёт 4с и гаснет (TTL стора)", async () => {
    vi.useFakeTimers();
    renderRoom();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    fire({ type: "typing", thread_id: "t1", user_type: "partner" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/печатает/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.queryByText(/печатает/)).toBeNull();
  });

  it("message-событие дописывает сообщение без дублей + авто-read чужого", async () => {
    renderRoom();
    await screen.findByText(/важно/);
    fire({ type: "message", thread_id: "t1", message: msg(11, "bot", "**важно** сообщение") }); // дубль id
    fire({ type: "message", thread_id: "t1", message: msg(13, "operator", "оператор на связи") });
    await waitFor(() => expect(screen.getByText(/оператор на связи/)).toBeTruthy());
    expect(document.querySelectorAll('[data-id="11"]').length).toBe(1);
    // входящее чужое в открытый тред — стор сразу помечает прочитанным
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith("t1", 13));
  });
});

describe("ChatRoom v2: переговорная (group, 07 §2 + 08 §2)", () => {
  it("шапка: title, участники-чипы с короной owner и счётчиком 3/5 (Вы — по /me)", async () => {
    renderRoom(groupThread);
    await screen.findByText(/привет/);
    // свой telegram_id подтянут через GET /me
    await waitFor(() => expect(mocks.meApi).toHaveBeenCalledWith("/me"));
    expect(screen.getByText("Осмотр Kia K5")).toBeTruthy();
    const members = screen.getByTestId("chat-members");
    // чипы: 👑Вы (owner, 42 по /me), Борис, Партнёр Сеул + счётчик
    expect(members.textContent).toContain("Вы");
    expect(members.textContent).toContain("Борис");
    expect(members.textContent).toContain("Партнёр Сеул");
    expect(members.textContent).toContain("3/5");
    // корона — только у owner
    expect(document.querySelectorAll(".chat-member__crown")).toHaveLength(1);
    // тип-бейдж «Переговорная», «Позвать человека» в group нет
    expect(document.querySelector(".chat-room__type--group")).not.toBeNull();
    expect(screen.queryByText("👥 Позвать человека")).toBeNull();
  });

  it("«Пригласить» → POST invite → код крупно → «Копировать» в буфер + тост", async () => {
    renderRoom(groupThread);
    await screen.findByText(/привет/);
    fireEvent.click(screen.getByRole("button", { name: "🔗 Пригласить" }));
    await waitFor(() => expect(mocks.createChatInvite).toHaveBeenCalledWith("g1"));
    expect(screen.getByTestId("invite-code").textContent).toBe("AB12CD");

    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    await waitFor(() => expect(mocks.clipboardWrite).toHaveBeenCalledWith("AB12CD"));
    expect(mocks.toastShow).toHaveBeenCalledWith("Код скопирован");
  });

  it("чужие сообщения в group подписаны именем автора (не свои)", async () => {
    mocks.fetchMessages.mockResolvedValue({
      items: [
        msg(10, "user", "привет", "2026-10-25T10:00:00Z", 100),
        msg(11, "partner", "готов показать", "2026-10-25T10:01:00Z", 7),
      ],
      has_more: false,
    });
    renderRoom(groupThread);
    await screen.findByText("готов показать");
    // имя участника по sender_id (не словарь SENDER_LABEL)
    const senders = Array.from(document.querySelectorAll(".chat-msg__sender")).map(
      (el) => el.textContent,
    );
    expect(senders).toContain("Борис"); // user_id 100
    expect(senders).toContain("Партнёр Сеул"); // partner user_id 7
  });

  it("typing в group показывает имя участника («… Партнёр Сеул печатает»)", async () => {
    renderRoom(groupThread);
    await screen.findByText(/привет/);
    await waitFor(() => expect(mocks.meApi).toHaveBeenCalled());
    fire({ type: "typing", thread_id: "g1", user_type: "partner" });
    await waitFor(() => expect(screen.getByText(/Партнёр Сеул печатает/)).toBeTruthy());
  });
});

describe("ChatRoom: онлайн-точки (09 §1: GET /chats/online)", () => {
  const sellerThread: ChatThread = {
    ...thread,
    id: "s9",
    type: "seller",
    title: "Kia K5",
    participants: [
      { user_type: "user", user_id: 42, name: "Я", role: "member" },
      { user_type: "user", user_id: 100, name: "Борис", role: "member" },
    ],
  };

  it("1:1 (seller): зелёная точка + «онлайн», когда участник в presence", async () => {
    mocks.fetchOnlineUsers.mockResolvedValue(new Set([100]));
    renderRoom(sellerThread);
    await screen.findByText(/привет/);
    // ids = участники-юзеры без себя (42) → [100]
    await waitFor(() => expect(mocks.fetchOnlineUsers).toHaveBeenCalledWith([100]));
    const dot = await waitFor(() => {
      const el = screen.getByTestId("chat-online");
      expect(el.getAttribute("data-state")).toBe("on");
      return el;
    });
    expect(dot.textContent).toContain("онлайн");
  });

  it("1:1: участник не в presence — серая точка «не в сети»", async () => {
    mocks.fetchOnlineUsers.mockResolvedValue(new Set());
    renderRoom(sellerThread);
    await screen.findByText(/привет/);
    await waitFor(() =>
      expect(screen.getByTestId("chat-online").getAttribute("data-state")).toBe("off"),
    );
    expect(screen.getByTestId("chat-online").textContent).toContain("не в сети");
  });

  it("support: точки нет вовсе (и presence не спрашиваем)", async () => {
    renderRoom(); // support-тред
    await screen.findByText(/важно/);
    expect(screen.queryByTestId("chat-online")).toBeNull();
    expect(mocks.fetchOnlineUsers).not.toHaveBeenCalled();
  });

  it("group: точки по каждому онлайн-юзеру в чипах участников", async () => {
    mocks.fetchOnlineUsers.mockResolvedValue(new Set([100])); // Борис онлайн, я (42) нет
    renderRoom(groupThread);
    await screen.findByText(/привет/);
    await waitFor(() =>
      expect(mocks.fetchOnlineUsers).toHaveBeenCalledWith(expect.arrayContaining([100, 42])),
    );
    await waitFor(() => expect(screen.getAllByTestId("chat-member-dot").length).toBe(1));
    expect(screen.queryByTestId("chat-online")).toBeNull(); // в шапке group точки нет
  });
});

describe("ChatRoom: говернанс переговорной (08-group-governance §2/§4/§6)", () => {
  /** Тред-участник (не owner): я — 42 (member), owner — Аня. */
  const memberThread: ChatThread = {
    ...groupThread,
    id: "gm",
    role: "member",
    participants: [
      { user_type: "user", user_id: 42, name: "Аня", role: "owner" },
      { user_type: "user", user_id: 100, name: "Борис", role: "member" },
    ],
  };

  it("mute-тоггл: колокольчик вызывает POST mute/unmute и меняет иконку", async () => {
    renderRoom(groupThread);
    await screen.findByText(/привет/);
    const bell = screen.getByTestId("chat-bell");
    expect(bell.textContent).toBe("🔔");

    fireEvent.click(bell);
    await waitFor(() => expect(mocks.setChatMuted).toHaveBeenCalledWith("g1", true));
    await waitFor(() => expect(screen.getByTestId("chat-bell").textContent).toBe("🔕"));

    // обратный тоггл — unmute
    fireEvent.click(screen.getByTestId("chat-bell"));
    await waitFor(() => expect(mocks.setChatMuted).toHaveBeenCalledWith("g1", false));
    await waitFor(() => expect(screen.getByTestId("chat-bell").textContent).toBe("🔔"));
    expect(mocks.toastShow).toHaveBeenCalledWith("Уведомления отключены");
    expect(mocks.toastShow).toHaveBeenCalledWith("Уведомления включены");
  });

  it("жалоба: чип + комментарий → POST report → тост; повтор (200) — тоже ок", async () => {
    renderRoom(groupThread);
    await screen.findByText(/привет/);
    fireEvent.click(screen.getByRole("button", { name: "Меню комнаты" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Пожаловаться/ }));

    // панель: 4 reason-чипа, отправка без причины недоступна
    expect(screen.getByRole("dialog", { name: "Жалоба на комнату" })).toBeTruthy();
    const send = screen.getByRole("button", { name: "Отправить жалобу" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Мошенничество" }));
    expect(send.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Комментарий к жалобе (необязательно)"), {
      target: { value: "просит предоплату вне площадки" },
    });
    fireEvent.click(send);

    await waitFor(() =>
      expect(mocks.reportChat).toHaveBeenCalledWith("g1", "fraud", "просит предоплату вне площадки"),
    );
    expect(mocks.toastShow).toHaveBeenCalledWith("Жалоба отправлена");
    // панель закрылась (reason сброшен)
    expect(screen.queryByRole("dialog", { name: "Жалоба на комнату" })).toBeNull();

    // повторная жалоба (бэк 200 идемпотентно) — тот же тост без ошибки
    fireEvent.click(screen.getByRole("button", { name: "Меню комнаты" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Пожаловаться/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Спам" }));
    fireEvent.click(screen.getByRole("button", { name: "Отправить жалобу" }));
    await waitFor(() => expect(mocks.reportChat).toHaveBeenCalledWith("g1", "spam", undefined));
    expect(mocks.toastShow).toHaveBeenCalledWith("Жалоба отправлена");
  });

  it("member: «Покинуть комнату» → confirm → POST leave → назад к списку", async () => {
    const onBack = vi.fn();
    render(
      <MemoryRouter>
        <ChatRoom threadId="gm" thread={memberThread} onBack={onBack} />
      </MemoryRouter>,
    );
    await screen.findByText(/привет/);
    fireEvent.click(screen.getByRole("button", { name: "Меню комнаты" }));
    // member: «Архивировать» нет, «Покинуть комнату» активен
    expect(screen.queryByRole("menuitem", { name: /Архивировать/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /Покинуть комнату/ }));

    // confirm-диалог
    expect(screen.getByText("Покинуть комнату?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Покинуть" }));
    await waitFor(() => expect(mocks.leaveChat).toHaveBeenCalledWith("gm"));
    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(mocks.toastShow).toHaveBeenCalledWith("Вы покинули комнату");
  });

  it("owner (не последний): «Покинуть» серым с подсказкой, POST не уходит", async () => {
    renderRoom(groupThread);
    await screen.findByText(/привет/);
    fireEvent.click(screen.getByRole("button", { name: "Меню комнаты" }));
    const leave = screen.getByRole("menuitem", { name: /Покинуть комнату/ }) as HTMLButtonElement;
    expect(leave.disabled).toBe(true);
    expect(screen.getByText("Сначала архивируйте или исключите участников")).toBeTruthy();
    // owner-меню: «Архивировать» есть
    expect(screen.getByRole("menuitem", { name: /Архивировать/ })).toBeTruthy();
  });

  it("owner: архив → confirm «только для чтения» → композер скрыт, плашка «Архив»", async () => {
    renderRoom(groupThread);
    await screen.findByText(/привет/);
    fireEvent.click(screen.getByRole("button", { name: "Меню комнаты" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Архивировать/ }));
    expect(screen.getByText("Архивировать комнату?")).toBeTruthy();
    expect(screen.getByText(/только для чтения/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Архивировать" }));
    await waitFor(() => expect(mocks.archiveChat).toHaveBeenCalledWith("g1"));
    await waitFor(() =>
      expect(screen.getByTestId("chat-archive-plate").textContent).toContain(
        "📁 Архив — комната закрыта",
      ),
    );
    // read-only: композера и кнопок действий больше нет
    expect(screen.queryByLabelText("Сообщение")).toBeNull();
    expect(screen.queryByRole("button", { name: "🔗 Пригласить" })).toBeNull();
    expect(screen.queryByTestId("chat-bell")).toBeNull();
    expect(screen.queryByRole("button", { name: "Меню комнаты" })).toBeNull();
  });

  it("owner: тап по участнику-member → мини-меню «Исключить» → DELETE → чип исчезает", async () => {
    renderRoom(groupThread);
    await screen.findByText(/привет/);
    // owner (42) тапает member Бориса
    fireEvent.click(screen.getByRole("button", { name: "Участник Борис: исключить" }));
    expect(screen.getByText("Исключить участника?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Исключить" }));

    await waitFor(() => expect(mocks.kickChatParticipant).toHaveBeenCalledWith("g1", "user", 100));
    await waitFor(() =>
      expect(screen.getByTestId("chat-members").textContent).not.toContain("Борис"),
    );
    expect(screen.getByTestId("chat-members").textContent).toContain("2/5");
    expect(mocks.toastShow).toHaveBeenCalledWith("Борис исключён из комнаты");
  });

  it("закрытый тред (status=closed): read-only — плашка вместо композера, меню/инвайт скрыты", async () => {
    renderRoom({ ...groupThread, status: "closed" });
    await screen.findByText(/привет/);
    expect(screen.getByTestId("chat-archive-plate").textContent).toContain(
      "📁 Архив — комната закрыта",
    );
    expect(screen.queryByLabelText("Сообщение")).toBeNull();
    expect(screen.queryByRole("button", { name: "Меню комнаты" })).toBeNull();
    expect(screen.queryByTestId("chat-bell")).toBeNull();
    expect(screen.queryByRole("button", { name: "🔗 Пригласить" })).toBeNull();
  });
});
