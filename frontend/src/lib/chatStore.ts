/**
 * Единый стор чатов мини-аппа (09-personal-channel.md §2): одно состояние
 * для списка тредов (сайдбар + конверт-бейдж) и открытой комнаты.
 *
 * - Треды: Map<id, ChatThreadState> — REST-вид + клиентские поля
 *   (typing с TTL 4с, lot_expired);
 * - сообщения открытого треда (страница + has_more) — один тред открыт
 *   в каждый момент (useChatRoom открывает/закрывает);
 * - события приходят из личного канала user:{uid} (createChatTransport
 *   {userChannel}) → handleEvent распределяет их по правилам:
 *     message → открытый тред: append + авто-read чужого; закрытый:
 *     unread++; незнакомый тред: pendingUnread++ и тихий refresh списка
 *     не чаще раза в 10с (тред появится при следующем GET /api/chats);
 *     typing → set с TTL 4с; read → last_read (галочки ✓✓);
 *     lot_expired → пометка треда;
 *     listing_status (10 §3) → НЕ чат-состояние: только колбэк-подписки
 *     onListingStatus/useListingStatus (Profile/SellCar — тост + refresh);
 * - поллинг-фоллбэк транспорта (ws недоступен): список тредов каждые 5с
 *   (onThreads) + after_id открытого треда (setActiveThread);
 * - отправка — только REST (chatApi), стор только принимает события.
 *
 * Стор — синглтон на сессию (chatStore): экран Chats (useChatThreads) и
 * бейдж таба «Чаты» в Shell (useChatUnread) читает один snapshot через
 * useSyncExternalStore. Гость: startSync не делает запросов (конверт
 * скрыт, список не грузится).
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { api } from "../api/client";
import type { User } from "../api/types";
import { isGuest } from "../api/auth";

import {
  createChatTransport,
  userChannel,
  type ChatEvent,
  type ChatMessage,
  type UserChannelTransport,
} from "./chatSocket";
import {
  fetchChats,
  fetchMessages,
  markRead,
  toChatThread,
  type ChatThread,
} from "./chatApi";

/** Событие смены статуса объявления (10-listing-lifecycle §3): приходит
 *  в тот же личный канал user:{uid}, что и чат-события, но чатом НЕ
 *  является — стор его не складывает, только рассылает подписчикам. */
export type ListingStatusEvent = Extract<ChatEvent, { type: "listing_status" }>;

/** TTL typing-индикатора (09 §1: эфемерное событие живёт на клиенте 4с). */
export const TYPING_TTL_MS = 4000;
/** Троттл тихого refresh списка для незнакомых тредов (message-событие). */
export const UNKNOWN_REFRESH_MS = 10_000;

/** Тред в сторе: REST-вид + клиентские поля (typing/lot_expired). */
export interface ChatThreadState extends ChatThread {
  /** Печатающие участники (user_type), живут TYPING_TTL_MS. */
  typing: Set<string>;
  /** Лот треда снят с продажи (событие lot_expired). */
  lotExpired?: boolean;
}

/** Состояние открытой комнаты (лента сообщений). */
export interface ChatRoomState {
  messages: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** last_read_message_id собеседника (✓✓ у своих сообщений ≤ id). */
  partnerReadId: number;
}

/** Иммутабельный срез стора для useSyncExternalStore. */
export interface ChatSnapshot {
  threads: Map<string, ChatThreadState>;
  rooms: Map<string, ChatRoomState>;
  /** Загрузка/ошибка списка (GET /api/chats). */
  loading: boolean;
  error: string | null;
  /** Непрочитанные в тредах, которых ещё нет в сторе (09 §2). */
  pendingUnread: number;
}

/** DI-зависимости стора (тесты подменяют). */
export interface ChatStoreDeps {
  fetchChats?: typeof fetchChats;
  fetchMessages?: typeof fetchMessages;
  markRead?: typeof markRead;
  /** GET /me → telegram_id (для «своих» сообщений в group). */
  fetchMyUid?: () => Promise<number | null>;
  /** Фабрика личного транспорта (createChatTransport {userChannel}). */
  createTransport?: (target: { userChannel: string }) => Promise<UserChannelTransport>;
}

const defaultDeps: Required<ChatStoreDeps> = {
  fetchChats,
  fetchMessages,
  markRead,
  fetchMyUid: () =>
    api<User>("/me")
      .then((u) => u.telegram_id)
      .catch(() => null),
  createTransport: (target) => createChatTransport(target),
};

/** Комната по умолчанию (нет в rooms — ещё не открывали). */
export const EMPTY_ROOM: ChatRoomState = {
  messages: [],
  hasMore: false,
  loading: false,
  error: null,
  partnerReadId: 0,
};

/** Тред из REST-ответа → состояние стора (клиентские поля — с нуля). */
function toThreadState(t: ChatThread, prev?: ChatThreadState): ChatThreadState {
  return {
    ...t,
    typing: prev?.typing ?? new Set<string>(),
    lotExpired: prev?.lotExpired,
  };
}

export class ChatStore {
  private listeners = new Set<() => void>();
  private threads = new Map<string, ChatThreadState>();
  private rooms = new Map<string, ChatRoomState>();
  private loading = false;
  private error: string | null = null;
  private pendingUnread = 0;
  private snap: ChatSnapshot;
  private deps: Required<ChatStoreDeps>;

  /** Открытая комната (одна в моменте) — драйвит авто-read и after_id. */
  private openThreadId: string | null = null;
  /** Мой telegram_id («свои» user-сообщения в group). */
  private myUid: number | null = null;
  /** Личный транспорт (ws или поллинг-фоллбэк). */
  private transport: UserChannelTransport | null = null;
  private offEvent: (() => void) | null = null;
  private offThreads: (() => void) | null = null;
  private syncing = false;
  private listInFlight = false;
  /** Таймеры TTL typing: ключ `${threadId}|${userType}`. */
  private typingTimers = new Map<string, number>();
  /** Троттл refresh для незнакомых тредов (последний тихий refresh). */
  private unknownRefreshAt = 0;
  /** Подписчики listing_status (10 §3): экраны вне чатов (Profile/SellCar). */
  private listingListeners = new Set<(ev: ListingStatusEvent) => void>();

  constructor(deps: ChatStoreDeps = {}) {
    this.deps = { ...defaultDeps, ...deps };
    this.snap = this.buildSnapshot();
  }

  // ---------- Подписка (useSyncExternalStore) ----------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ChatSnapshot => this.snap;

  private buildSnapshot(): ChatSnapshot {
    return {
      threads: new Map(this.threads),
      rooms: new Map(this.rooms),
      loading: this.loading,
      error: this.error,
      pendingUnread: this.pendingUnread,
    };
  }

  private commit(): void {
    this.snap = this.buildSnapshot();
    this.listeners.forEach((l) => l());
  }

  // ---------- Список тредов ----------

  /** GET /api/chats: silent=true — без скелетона (фоллбэк/refresh). */
  async loadThreads(silent = false): Promise<void> {
    if (this.listInFlight) return;
    this.listInFlight = true;
    if (!silent) {
      this.loading = true;
      this.error = null;
      this.commit();
    }
    try {
      const list = await this.deps.fetchChats();
      this.setThreads(list ?? []);
    } catch (e) {
      if (!silent) {
        this.error = (e as Error).message;
      }
    } finally {
      this.listInFlight = false;
      if (!silent) {
        this.loading = false;
        this.commit();
      }
    }
  }

  /** Список с сервера — истина (unread/статусы); клиентские поля живы. */
  setThreads(list: ChatThread[]): void {
    const next = new Map<string, ChatThreadState>();
    for (const t of list) {
      next.set(t.id, toThreadState(t, this.threads.get(t.id)));
    }
    this.threads = next;
    this.pendingUnread = 0; // незнакомые треды пришли списком — счётчик гасим
    this.commit();
  }

  /** Сырой ответ GET /api/chats (поллинг-фоллбэк) → нормализация. */
  applyPolledThreads(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    this.setThreads(raw.map(toChatThread));
  }

  /** Тред от пропса/списка — занести, если стора ещё не знает. */
  seedThread(t: ChatThread): void {
    if (this.threads.has(t.id)) return;
    this.threads.set(t.id, toThreadState(t));
    this.commit();
  }

  /** Локальное обновление полей треда (mute/архив/кик — после REST). */
  patchThread(threadId: string, patch: Partial<ChatThread>): void {
    const th = this.threads.get(threadId);
    if (!th) return;
    this.threads.set(threadId, { ...th, ...patch });
    this.commit();
  }

  /** Суммарный unread конверта: не-muted + незнакомые треды (08 §6). */
  getUnreadCount(): number {
    let n = this.pendingUnread;
    for (const t of this.threads.values()) {
      if (!t.muted) n += t.unread ?? 0;
    }
    return n;
  }

  // ---------- Открытая комната ----------

  /** Открыть комнату: грузим страницу сообщений + сразу читаем тред. */
  openThread(threadId: string): void {
    this.openThreadId = threadId;
    this.syncActiveThread();
    const room = this.rooms.get(threadId) ?? { ...EMPTY_ROOM, loading: true };
    this.rooms.set(threadId, { ...room, loading: true, error: null });
    this.commit();
    void this.loadRoom(threadId);
  }

  /** Закрыть комнату (unmount): after_id-поллинг возвращается к списку. */
  closeThread(threadId: string): void {
    if (this.openThreadId === threadId) {
      this.openThreadId = null;
      this.syncActiveThread();
    }
  }

  /** Перезагрузить ленту (кнопка «Повторить» после ошибки). */
  reloadRoom(threadId: string): void {
    this.openThreadId = threadId;
    this.syncActiveThread();
    const room = this.rooms.get(threadId) ?? EMPTY_ROOM;
    this.rooms.set(threadId, { ...room, loading: true, error: null });
    this.commit();
    void this.loadRoom(threadId);
  }

  private async loadRoom(threadId: string): Promise<void> {
    try {
      const page = await this.deps.fetchMessages(threadId);
      const items = [...page.items].sort((a, b) => a.id - b.id);
      const room = this.rooms.get(threadId) ?? EMPTY_ROOM;
      // partnerReadId переживает перезагрузку (read-событие могло прийти раньше)
      this.rooms.set(threadId, {
        ...room,
        messages: items,
        hasMore: page.has_more,
        loading: false,
        error: null,
      });
      // открыли тред — читаем до последнего и гасим локальный unread
      const last = items[items.length - 1];
      const th = this.threads.get(threadId);
      if (th && th.unread > 0) {
        this.threads.set(threadId, { ...th, unread: 0 });
      }
      this.commit();
      if (last) void this.deps.markRead(threadId, last.id).catch(() => undefined);
    } catch (e) {
      const room = this.rooms.get(threadId) ?? EMPTY_ROOM;
      this.rooms.set(threadId, { ...room, loading: false, error: (e as Error).message });
      this.commit();
    } finally {
      this.syncActiveThread();
    }
  }

  /** Дозагрузка истории вверх (before_id): ChatRoom отсортировал/отфильтровал. */
  prependOlder(threadId: string, items: ChatMessage[], hasMore: boolean): void {
    const room = this.rooms.get(threadId);
    if (!room) return;
    this.rooms.set(threadId, { ...room, messages: [...items, ...room.messages], hasMore });
    this.commit();
  }

  /** Сообщение в ленту (REST-ответ / оптимистичная system-строка).
   *  Подтверждённая system-строка бэка заменяет локальные заглушки (id<0);
   *  дубликаты по id не проходят (эхо сокета после REST-отправки). */
  appendMessage(threadId: string, m: ChatMessage): void {
    const room = this.ensureRoom(threadId);
    const base =
      m.sender_type === "system"
        ? room.messages.filter((x) => !(x.id < 0 && x.sender_type === "system"))
        : room.messages;
    if (base.some((x) => x.id === m.id)) return;
    this.rooms.set(threadId, { ...room, messages: [...base, m] });
    this.commit();
    this.syncActiveThread();
  }

  private ensureRoom(threadId: string): ChatRoomState {
    return this.rooms.get(threadId) ?? EMPTY_ROOM;
  }

  /** Транспорт должен знать открытый тред и курсор after_id (фоллбэк). */
  private syncActiveThread(): void {
    const t = this.transport;
    if (!t) return;
    if (this.openThreadId === null) {
      t.setActiveThread(null, 0);
      return;
    }
    const room = this.rooms.get(this.openThreadId);
    const last = room?.messages[room.messages.length - 1];
    t.setActiveThread(this.openThreadId, last && last.id > 0 ? last.id : 0);
  }

  // ---------- События личного канала (09 §1) ----------

  /** Своё сообщение: 1:1 — любой user; group — по sender_id == my uid. */
  private isOwnMessage(th: ChatThreadState, m: ChatMessage): boolean {
    if (m.sender_type !== "user") return false;
    if (!th.is_group) return true;
    if (this.myUid != null) return m.sender_id === this.myUid;
    return m.sender_id == null; // uid не знаем: безымянное user-сообщение — своё
  }

  /** Тихий refresh списка для незнакомых тредов — не чаще 10с (09 §2). */
  private refreshUnknownThrottled(): void {
    const now = Date.now();
    if (now - this.unknownRefreshAt < UNKNOWN_REFRESH_MS) return;
    this.unknownRefreshAt = now;
    void this.loadThreads(true);
  }

  handleEvent(ev: ChatEvent): void {
    if (ev.type === "message") {
      const tid = ev.thread_id;
      const m = ev.message;
      if (!tid) return; // личный режим без thread_id не маршрутизируется
      let th = this.threads.get(tid);
      if (!th) {
        // Незнакомый тред (создан на другом устройстве/собеседник новый):
        // не дёргаем список на каждое событие — тихий refresh с троттлом.
        this.pendingUnread += this.isOwnMessageGuess(m) ? 0 : 1;
        this.commit();
        this.refreshUnknownThrottled();
        return;
      }
      // сниппет/время списка — по последнему сообщению треда
      this.threads.set(tid, {
        ...th,
        last_message: { body: m.body, created_at: m.created_at, sender_type: m.sender_type },
      });
      th = this.threads.get(tid)!;
      if (this.openThreadId === tid) {
        this.appendMessage(tid, m);
        // чужое в открытой комнате — сразу читаем (unread не растёт)
        if (!this.isOwnMessage(th, m)) {
          void this.deps.markRead(tid, m.id).catch(() => undefined);
        }
      } else if (!this.isOwnMessage(th, m)) {
        this.threads.set(tid, { ...th, unread: (th.unread ?? 0) + 1 });
      }
      this.commit();
      return;
    }
    if (ev.type === "typing") {
      const tid = ev.thread_id;
      if (!tid) return;
      const th = this.threads.get(tid);
      if (!th) return;
      // Эхо своего typing в 1:1 не показываем (в group печатают и другие user-ы)
      const ownEcho = ev.user_type === "user" && !th.is_group;
      if (ownEcho) return;
      // иммутабельно: новый объект треда + новый Set (useMemo в UI видит смену)
      if (!th.typing.has(ev.user_type)) {
        const typing = new Set(th.typing);
        typing.add(ev.user_type);
        this.threads.set(tid, { ...th, typing });
        this.commit();
      }
      const key = `${tid}|${ev.user_type}`;
      const prev = this.typingTimers.get(key);
      if (prev !== undefined) window.clearTimeout(prev);
      this.typingTimers.set(
        key,
        window.setTimeout(() => {
          this.typingTimers.delete(key);
          const cur = this.threads.get(tid);
          if (cur?.typing.has(ev.user_type)) {
            const typing = new Set(cur.typing);
            typing.delete(ev.user_type);
            this.threads.set(tid, { ...cur, typing });
            this.commit();
          }
        }, TYPING_TTL_MS),
      );
      return;
    }
    if (ev.type === "read") {
      const tid = ev.thread_id;
      if (!tid) return;
      // Свои read-эхо галочки не двигают; партнёр/оператор — до max
      if (ev.user_type === "user") return;
      const room = this.rooms.get(tid);
      const next = Math.max(room?.partnerReadId ?? 0, ev.last_read_message_id);
      if (next !== (room?.partnerReadId ?? 0)) {
        this.rooms.set(tid, { ...(room ?? EMPTY_ROOM), partnerReadId: next });
        this.commit();
      }
      return;
    }
    // lot_expired: помечаем тред — шапка комнаты покажет «лот снят»
    if (ev.type === "lot_expired") {
      const th = this.threads.get(ev.thread_id);
      if (th && !th.lotExpired) {
        this.threads.set(ev.thread_id, { ...th, lotExpired: true });
        this.commit();
      }
      return;
    }
    // listing_status (10 §3): чат-состояние не трогаем — только подписки
    // (Profile/SellCar показывают тост и перечитывают my-lots).
    if (ev.type === "listing_status") {
      this.listingListeners.forEach((cb) => cb(ev));
    }
  }

  // ---------- Подписки listing_status (10 §3: вне чат-состояния) ----------

  /** Подписка на смену статуса объявлений; отписка — возвращенная функция.
   *  Событие НЕ меняет чат-состояние стора (треды/unread как были). */
  onListingStatus(cb: (ev: ListingStatusEvent) => void): () => void {
    this.listingListeners.add(cb);
    return () => {
      this.listingListeners.delete(cb);
    };
  }

  /** Грубая проверка «своего» для незнакомого треда (без is_group). */
  private isOwnMessageGuess(m: ChatMessage): boolean {
    if (m.sender_type !== "user") return false;
    if (m.sender_id == null) return true; // 1:1-эхо без id отправителя
    return this.myUid != null && m.sender_id === this.myUid;
  }

  // ---------- Транспорт личного канала ----------

  /** Подключить личный канал (идемпотентно; гость — пусто). */
  startSync(): void {
    if (this.syncing || isGuest()) return;
    this.syncing = true;
    void this.loadThreads();
    void this.connectTransport();
  }

  private async connectTransport(): Promise<void> {
    const uid = await this.deps.fetchMyUid();
    if (uid == null || !this.syncing || this.transport) return;
    this.myUid = uid;
    const channel = userChannel(uid);
    let t: UserChannelTransport | null = null;
    try {
      t = await this.deps.createTransport({ userChannel: channel });
    } catch {
      t = null; // совсем без транспорта: список уже грузится loadThreads-ом
    }
    if (!t || !this.syncing || this.transport) {
      t?.disconnect();
      return;
    }
    this.transport = t;
    this.offEvent = t.onEvent((ev) => this.handleEvent(ev));
    // фоллбэк-поллинг обновляет список тредов; ws-режим — заглушка
    this.offThreads = t.onThreads((raw) => this.applyPolledThreads(raw));
    // BF-03: активируем личный канал ДО connect — поллинг-транспорт без
    // подписки навсегда неактивен (tick() выходит при !active: ни список
    // тредов, ни after_id не опрашиваются). ws-режим подписан фабрикой
    // сам (createChatTransport), повторная подписка идемпотентна.
    t.subscribe(channel);
    await t.connect().catch(() => undefined);
    this.syncActiveThread();
  }

  /** Остановить транспорт (смена сессии/тесты). Состояние не трогаем. */
  stopSync(): void {
    this.syncing = false;
    this.offEvent?.();
    this.offEvent = null;
    this.offThreads?.();
    this.offThreads = null;
    this.transport?.disconnect();
    this.transport = null;
  }

  /** Полный сброс (тесты / смена пользователя): транспорт + состояние. */
  reset(): void {
    this.stopSync();
    for (const timer of this.typingTimers.values()) window.clearTimeout(timer);
    this.typingTimers.clear();
    this.threads = new Map();
    this.rooms = new Map();
    this.openThreadId = null;
    this.myUid = null;
    this.loading = false;
    this.error = null;
    this.pendingUnread = 0;
    this.unknownRefreshAt = 0;
    this.commit();
  }

  /** Смена сессии (autobot:auth): чистим всё и заводимся заново. */
  restartForAuth(): void {
    this.reset();
    this.startSync();
  }
}

/** Синглтон на сессию мини-аппа (экран Chats + бейдж таба «Чаты»). */
export const chatStore = new ChatStore();

// Смена пользователя (вход/выход/апгрейд гостя) — стор перезапускается сам:
// после logout транспорт гаснет (не течёт под мёртвым токеном), после
// входа — заводится без ожидания ре-маунта конверта/экрана.
if (typeof window !== "undefined") {
  window.addEventListener("autobot:auth", () => chatStore.restartForAuth());
}

// ---------- React-хуки над синглтоном ----------

/** Список тредов + загрузка списка; стартует синхронизацию (однократно). */
export function useChatThreads(): {
  threads: ChatThreadState[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const snap = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot);
  useEffect(() => {
    chatStore.startSync();
  }, []);
  const threads = useMemo(() => Array.from(snap.threads.values()), [snap.threads]);
  const reload = useCallback(() => {
    void chatStore.loadThreads();
  }, []);
  return { threads, loading: snap.loading, error: snap.error, reload };
}

/** Открытая комната: открывает тред на время жизни компонента. */
export function useChatRoom(threadId: string): {
  thread: ChatThreadState | null;
  room: ChatRoomState;
} {
  const snap = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot);
  useEffect(() => {
    chatStore.openThread(threadId);
    return () => chatStore.closeThread(threadId);
  }, [threadId]);
  return {
    thread: snap.threads.get(threadId) ?? null,
    room: snap.rooms.get(threadId) ?? EMPTY_ROOM,
  };
}

/** Суммарный unread конверта (не-muted + незнакомые треды). */
export function useChatUnread(): number {
  const snap = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot);
  useEffect(() => {
    chatStore.startSync();
  }, []);
  return useMemo(() => {
    let n = snap.pendingUnread;
    for (const t of snap.threads.values()) {
      if (!t.muted) n += t.unread ?? 0;
    }
    return n;
  }, [snap]);
}

// ---------- Live-статусы объявлений (10-listing-lifecycle §3/§5) ----------

/** Подписка на listing_status вне React (возвращает функцию отписки). */
export function onListingStatus(cb: (ev: ListingStatusEvent) => void): () => void {
  return chatStore.onListingStatus(cb);
}

/** React-подписка на смену статуса объявлений (личный канал user:{uid}):
 *  событие приходит в тот же транспорт, что и чаты, но чат-состояние
 *  не трогает. Колбэк всегда свежий (ref), эффект подписывается один раз. */
export function useListingStatus(cb: (ev: ListingStatusEvent) => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    // транспорт личного канала мог ещё не подняться (чаты не открывали) —
    // стартуем синхронизацию, как это делает бейдж таба «Чаты»
    chatStore.startSync();
    return chatStore.onListingStatus((ev) => ref.current(ev));
  }, []);
}

/** Тост о смене статуса объявления (единый словарь для Profile/SellCar). */
export function listingStatusToast(ev: ListingStatusEvent): { text: string; error: boolean } {
  switch (ev.status) {
    case "accepted":
      return { text: "Объявление одобрено", error: false };
    case "moderation":
      return { text: "Объявление отправлено на проверку", error: false };
    case "rejected":
      return {
        text: ev.reason ? `Объявление отклонено: ${ev.reason}` : "Объявление отклонено",
        error: true,
      };
    case "expired":
      return { text: "Срок размещения объявления истёк", error: false };
    case "archived":
      return { text: "Объявление снято с публикации", error: false };
    default:
      return { text: `Статус объявления: ${ev.status}`, error: false };
  }
}

/** Полный сброс синглтона (тесты изолируют состояние между тестами). */
export function resetChatStore(): void {
  chatStore.reset();
}

// ---------- Отправка «я печатаю» (09 §1: debounce + rate) ----------

export interface TypingSender {
  /** Вызвать на каждое изменение композера (внутри — debounce). */
  notify(): void;
  /** Отменить незавершённый debounce (unmount). */
  cancel(): void;
}

/**
 * Debounce-отправитель typing: пачка ввода → один POST через 1.5с;
 * локальный мини-интервал 2с (бэк режет 1/2с — 429 глушим вместе с
 * остальными сетевыми ошибками: typing эфемерен, ретраи не нужны).
 */
export function createTypingSender(
  send: () => Promise<unknown>,
  opts: { debounceMs?: number; minIntervalMs?: number } = {},
): TypingSender {
  const debounceMs = opts.debounceMs ?? 1500;
  const minIntervalMs = opts.minIntervalMs ?? 2000;
  let timer: number | null = null;
  let lastSent = 0;
  const fire = (): void => {
    timer = null;
    const now = Date.now();
    if (now - lastSent < minIntervalMs) return; // локальный rate — бэк не дёргаем
    lastSent = now;
    void Promise.resolve(send()).catch(() => undefined); // 429/сеть — глушим
  };
  return {
    notify(): void {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(fire, debounceMs);
    },
    cancel(): void {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    },
  };
}
