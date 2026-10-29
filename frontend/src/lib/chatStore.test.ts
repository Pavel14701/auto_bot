/**
 * Тесты единого стора чатов (lib/chatStore, 09-personal-channel.md §2):
 *  - события личного канала user:{uid}: message в открытый тред (append +
 *    авто-read чужого), в закрытый (unread++), в незнакомый
 *    (pendingUnread + тихий refresh списка с троттлом 10с);
 *  - typing с TTL 4с (эхо 1:1 не показывается), read → галочки,
 *    lot_expired → пометка;
 *  - listing_status (10 §3) → только подписки onListingStatus,
 *    чат-состояние не меняется;
 *  - старт синхронизации: список + личный транспорт (userChannel user:{uid}),
 *    onThreads поллинг-фоллбэка обновляет список, setActiveThread — after_id;
 *  - createTypingSender: debounce 1.5с, мини-интервал 2с, 429 глушим.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatEvent, ChatMessage } from "./chatSocket";
import { createChatTransport } from "./chatSocket";
import type { ChatThread } from "./chatApi";
import { ChatStore, createTypingSender, type ChatStoreDeps } from "./chatStore";

vi.mock("../api/auth", () => ({ isGuest: () => false, haptic: vi.fn() }));

const th = (id: string, over: Partial<ChatThread> = {}): ChatThread => ({
  id,
  type: "seller",
  title: `T-${id}`,
  status: "active",
  unread: 0,
  last_message: null,
  subject: null,
  ...over,
});

const msg = (
  id: number,
  sender_type: ChatMessage["sender_type"],
  sender_id: number | null = null,
): ChatMessage => ({
  id,
  sender_type,
  sender_id,
  body: `m${id}`,
  created_at: "2026-10-25T10:00:00Z",
});

/** Фабрика стора с DI-шпионами и заглушкой личного транспорта. */
function mkStore(list: ChatThread[] = [th("t1"), th("t2")]) {
  const handlers: Array<(ev: ChatEvent) => void> = [];
  const threadsHandlers: Array<(raw: unknown) => void> = [];
  const transport = {
    kind: "ws" as const,
    connect: vi.fn(async () => undefined),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    disconnect: vi.fn(),
    onEvent: vi.fn((h: (ev: ChatEvent) => void) => {
      handlers.push(h);
      return () => undefined;
    }),
    onThreads: vi.fn((h: (raw: unknown) => void) => {
      threadsHandlers.push(h);
      return () => undefined;
    }),
    setActiveThread: vi.fn(),
  };
  const deps: ChatStoreDeps = {
    fetchChats: vi.fn(async () => list),
    fetchMessages: vi.fn(
      async (_id: string) => ({ items: [msg(10, "user"), msg(11, "bot")], has_more: false }),
    ),
    markRead: vi.fn(async () => undefined),
    fetchMyUid: vi.fn(async () => 42),
    createTransport: vi.fn(async () => transport),
  };
  const store = new ChatStore(deps);
  return { store, deps: deps as Record<string, ReturnType<typeof vi.fn>>, transport, handlers, threadsHandlers };
}

/** Слить микротаски под фейковыми таймерами (цепочки промисов стора). */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatStore: старт синхронизации (список + личный канал)", () => {
  it("startSync грузит список и подключает транспорт user:{uid}", async () => {
    const { store, deps, transport } = mkStore();
    store.startSync();
    await flush();
    await flush();
    expect(deps.fetchChats).toHaveBeenCalledTimes(1);
    // подписка — только личный канал юзера (09 §1)
    expect(deps.createTransport).toHaveBeenCalledWith({ userChannel: "user:42" });
    expect(transport.connect).toHaveBeenCalled();
    expect(store.getSnapshot().threads.get("t1")).toBeTruthy();
  });

  it("onThreads поллинг-фоллбэка обновляет список тредов", async () => {
    const { store, threadsHandlers } = mkStore();
    store.startSync();
    await flush();
    await flush();
    threadsHandlers[0]([th("t9")]);
    const snap = store.getSnapshot();
    expect(snap.threads.has("t9")).toBe(true);
    expect(snap.threads.has("t1")).toBe(false); // список сервера — истина
  });

  it("открытая комната сообщает транспорту after_id (поллинг-фоллбэк)", async () => {
    const { store, transport } = mkStore();
    store.startSync();
    await flush();
    await flush();
    store.openThread("t1");
    await flush();
    expect(transport.setActiveThread).toHaveBeenCalledWith("t1", 11); // курсор = последний id
    store.closeThread("t1");
    expect(transport.setActiveThread).toHaveBeenCalledWith(null, 0);
  });

  it("BF-03: стор активирует канал у polling-транспорта — тик тянет список", async () => {
    // Интеграция фабрика+стор: реальный UserChannelPollingTransport
    // (forcePolling), listFetcher подменён DI. До фикса connectTransport
    // не вызывал subscribe → active=false → tick() навсегда no-op.
    const polled = vi.fn(async () => [th("p1"), th("p2")]);
    const deps: ChatStoreDeps = {
      fetchChats: vi.fn(async () => [th("t1")]),
      fetchMessages: vi.fn(async () => ({ items: [], has_more: false })),
      markRead: vi.fn(async () => undefined),
      fetchMyUid: vi.fn(async () => 42),
      createTransport: (target) =>
        createChatTransport(target, {
          forcePolling: true,
          polling: { intervalMs: 5000, listFetcher: polled },
        }),
    };
    const store = new ChatStore(deps);
    store.startSync();
    await flush();
    await flush();
    await flush();
    // первый тик поллинга (сразу после connect) уже дёрнул GET /chats
    expect(polled.mock.calls.length).toBeGreaterThanOrEqual(1);
    // каждый интервал — новый опрос списка (транспорт жив, не заглох)
    await vi.advanceTimersByTimeAsync(5000);
    expect(polled.mock.calls.length).toBeGreaterThanOrEqual(2);
    // ответы поллинга доходывают до стора через onThreads
    expect(store.getSnapshot().threads.has("p1")).toBe(true);
    store.stopSync();
  });
});

describe("ChatStore: message-события личного канала", () => {
  it("открытый тред: append без дублей + авто-read чужого; своё — без read", async () => {
    const { store, deps } = mkStore();
    store.startSync();
    await flush();
    await flush();
    store.openThread("t1");
    await flush();
    expect(deps.markRead).toHaveBeenCalledWith("t1", 11); // чтение при открытии

    store.handleEvent({ type: "message", thread_id: "t1", message: msg(30, "bot") });
    let snap = store.getSnapshot();
    expect(snap.rooms.get("t1")!.messages.map((m) => m.id)).toEqual([10, 11, 30]);
    expect(deps.markRead).toHaveBeenCalledWith("t1", 30); // чужое — сразу прочитано
    expect(snap.threads.get("t1")!.unread).toBe(0);

    // дубликат (эхо после REST) не попадает в ленту
    store.handleEvent({ type: "message", thread_id: "t1", message: msg(30, "bot") });
    expect(store.getSnapshot().rooms.get("t1")!.messages).toHaveLength(3);

    // своё (1:1: user — это я): append есть, авто-read нет
    store.handleEvent({ type: "message", thread_id: "t1", message: msg(31, "user") });
    snap = store.getSnapshot();
    expect(snap.rooms.get("t1")!.messages.map((m) => m.id)).toContain(31);
    expect(deps.markRead).not.toHaveBeenCalledWith("t1", 31);
    expect(snap.threads.get("t1")!.unread).toBe(0);
  });

  it("закрытый тред: unread++ и сниппет списка обновляется, read не уходит", async () => {
    const { store, deps } = mkStore();
    store.startSync();
    await flush();
    await flush();
    store.handleEvent({ type: "message", thread_id: "t2", message: msg(40, "partner", 7) });
    const t2 = store.getSnapshot().threads.get("t2")!;
    expect(t2.unread).toBe(1);
    expect(t2.last_message?.body).toBe("m40");
    expect(deps.markRead).not.toHaveBeenCalledWith("t2", 40);
  });

  it("незнакомый тред: pendingUnread++ и тихий refresh списка с троттлом 10с", async () => {
    const { store, deps, handlers } = mkStore();
    store.startSync();
    await flush();
    await flush();
    expect(deps.fetchChats).toHaveBeenCalledTimes(1);

    // первое событие незнакомого треда — тихий refresh уходит сразу
    handlers[0]({ type: "message", thread_id: "t9", message: msg(50, "bot") });
    expect(store.getSnapshot().pendingUnread).toBe(1);
    await flush();
    expect(deps.fetchChats).toHaveBeenCalledTimes(2);
    // список пришёл без t9 — счётчик незнакомых сброшен серверной картиной
    expect(store.getSnapshot().pendingUnread).toBe(0);

    // второе событие в пределах 10с — refresh троттлится
    handlers[0]({ type: "message", thread_id: "t9", message: msg(51, "bot") });
    expect(store.getSnapshot().pendingUnread).toBe(1);
    await flush();
    expect(deps.fetchChats).toHaveBeenCalledTimes(2);

    // через 10с — снова тихий refresh
    await vi.advanceTimersByTimeAsync(10_001);
    handlers[0]({ type: "message", thread_id: "t9", message: msg(52, "bot") });
    await flush();
    expect(deps.fetchChats).toHaveBeenCalledTimes(3);
  });

  it("group: чужое user-сообщение (sender_id ≠ мой) — unread, своё — нет", async () => {
    const { store } = mkStore([
      th("g1", { type: "group", is_group: true, participants: [] }),
    ]);
    store.startSync();
    await flush();
    await flush();
    store.handleEvent({ type: "message", thread_id: "g1", message: msg(60, "user", 100) });
    expect(store.getSnapshot().threads.get("g1")!.unread).toBe(1);
    // мой uid = 42 (fetchMyUid) — своё user-сообщение unread не поднимает
    store.handleEvent({ type: "message", thread_id: "g1", message: msg(61, "user", 42) });
    expect(store.getSnapshot().threads.get("g1")!.unread).toBe(1);
  });
});

describe("ChatStore: typing / read / lot_expired", () => {
  it("typing живёт 4с (TTL), повтор продлевает; эхо 1:1 user не показывается", async () => {
    const { store } = mkStore();
    store.startSync();
    await flush();
    await flush();
    store.handleEvent({ type: "typing", thread_id: "t1", user_type: "partner" });
    expect(store.getSnapshot().threads.get("t1")!.typing.has("partner")).toBe(true);
    // повтор до истечения — продлевает
    await vi.advanceTimersByTimeAsync(2500);
    store.handleEvent({ type: "typing", thread_id: "t1", user_type: "partner" });
    await vi.advanceTimersByTimeAsync(2500);
    expect(store.getSnapshot().threads.get("t1")!.typing.has("partner")).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getSnapshot().threads.get("t1")!.typing.size).toBe(0);
    // 1:1: user-тип — сам юзер (эхо), индикатор не зажигаем
    store.handleEvent({ type: "typing", thread_id: "t1", user_type: "user" });
    expect(store.getSnapshot().threads.get("t1")!.typing.size).toBe(0);
  });

  it("read: partner поднимает галочку до max; своё read-эхо игнорируется", async () => {
    const { store } = mkStore();
    store.startSync();
    await flush();
    await flush();
    store.openThread("t1");
    await flush();
    store.handleEvent({ type: "read", thread_id: "t1", user_type: "partner", last_read_message_id: 11 });
    expect(store.getSnapshot().rooms.get("t1")!.partnerReadId).toBe(11);
    // меньший id не откатывает
    store.handleEvent({ type: "read", thread_id: "t1", user_type: "partner", last_read_message_id: 5 });
    expect(store.getSnapshot().rooms.get("t1")!.partnerReadId).toBe(11);
    // своё read-эхо галочки не двигает
    store.handleEvent({ type: "read", thread_id: "t1", user_type: "user", last_read_message_id: 99 });
    expect(store.getSnapshot().rooms.get("t1")!.partnerReadId).toBe(11);
  });

  it("lot_expired помечает тред; пометка живёт refresh списка", async () => {
    const { store, deps } = mkStore();
    store.startSync();
    await flush();
    await flush();
    store.handleEvent({ type: "lot_expired", thread_id: "t1", listing_id: 7 });
    expect(store.getSnapshot().threads.get("t1")!.lotExpired).toBe(true);
    // refresh списка не сбрасывает клиентскую пометку
    await store.loadThreads(true);
    expect(deps.fetchChats).toHaveBeenCalled();
    expect(store.getSnapshot().threads.get("t1")!.lotExpired).toBe(true);
  });

  it("setThreads merge сохраняет typing; muted не входит в unread конверта", async () => {
    const { store } = mkStore([th("a"), th("b", { muted: true }), th("c")]);
    store.startSync();
    await flush();
    await flush();
    store.handleEvent({ type: "typing", thread_id: "a", user_type: "partner" });
    store.setThreads([th("a"), th("b", { muted: true, unread: 9 }), th("c", { unread: 2 })]);
    expect(store.getSnapshot().threads.get("a")!.typing.has("partner")).toBe(true);
    // muted unread считается, но бейдж не показывает (08 §6); c — показывает
    expect(store.getUnreadCount()).toBe(2);
  });
});

// ---------- listing_status: live-статусы объявлений (10 §3) ----------

describe("ChatStore: listing_status (10 §3) — не чат-состояние", () => {
  it("событие дёргает подписки onListingStatus, снапшот чатов не меняется", async () => {
    const { store } = mkStore();
    store.startSync();
    await flush();
    await flush();
    const before = store.getSnapshot();
    const cb = vi.fn();
    const off = store.onListingStatus(cb);

    store.handleEvent({
      type: "listing_status",
      listing_id: 7,
      status: "rejected",
      reason: "контакты в описании",
    });
    expect(cb).toHaveBeenCalledWith({
      type: "listing_status",
      listing_id: 7,
      status: "rejected",
      reason: "контакты в описании",
    });
    // треды/комнаты/unread — как были (событие не чат-состояние)
    expect(store.getSnapshot()).toBe(before);

    // отписка: повторное событие колбэк не зовёт
    off();
    store.handleEvent({ type: "listing_status", listing_id: 7, status: "accepted" });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("без подписчиков событие молча игнорируется (нет ошибок/коммитов)", async () => {
    const { store } = mkStore();
    store.startSync();
    await flush();
    await flush();
    const before = store.getSnapshot();
    store.handleEvent({ type: "listing_status", listing_id: 9, status: "expired" });
    expect(store.getSnapshot()).toBe(before);
  });
});

describe("createTypingSender: debounce + rate (09 §1)", () => {
  it("пачка ввода — один POST после 1.5с; локальный мини-интервал 2с", async () => {
    const send = vi.fn(async () => undefined);
    const s = createTypingSender(send, { debounceMs: 1500, minIntervalMs: 2000 });
    s.notify();
    s.notify();
    s.notify();
    await vi.advanceTimersByTimeAsync(1400);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1); // три ввода — один вызов

    // сразу после отправки новая пачка: debounce пройдёт, но rate 2с режет
    s.notify();
    await vi.advanceTimersByTimeAsync(1500);
    expect(send).toHaveBeenCalledTimes(1); // 1.5с < 2с — локально скипнули

    s.notify();
    await vi.advanceTimersByTimeAsync(2500);
    expect(send).toHaveBeenCalledTimes(2);
    s.cancel();
  });

  it("429/сетевые ошибки глушатся; cancel гасит незавершённый debounce", async () => {
    const send = vi.fn(async () => {
      throw new Error("429");
    });
    const s = createTypingSender(send, { debounceMs: 1500 });
    s.notify();
    await vi.advanceTimersByTimeAsync(1600); // reject проглочен — тест не падает
    expect(send).toHaveBeenCalledTimes(1);
    s.notify();
    s.cancel();
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
