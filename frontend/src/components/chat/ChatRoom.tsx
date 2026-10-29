/**
 * Экран чата (components/chat, ТЗ §7 + 07-sell-chats-partner-inspection.md §2 +
 * 08-group-governance.md §7 + 09-personal-channel.md §1): шапка с типом/
 * предметом (group — title + участники с ролями (корона owner, тап owner по
 * member → кик) + «Пригласить» + меню «⋯»: mute/жалоба/покинуть/архивировать),
 * лента сообщений (дата-разделители, группировка по отправителю, markdown,
 * ✓/✓✓, typing с именем в group), композер с авто-ростом textarea (Enter —
 * отправка, Shift+Enter — перенос). Закрытая переговорная — read-only:
 * композер заменён плашкой «📁 Архив», меню/инвайт скрыты.
 *
 * Данные — единый стор чатов (lib/chatStore, 09 §2): лента/typing/галочки
 * приходят событиями личного канала user:{uid} (append + авто-read открытого
 * треда — на стороне стора); отправка — только REST. «Позвать человека»
 * (support, §6): POST /api/chats/{id}/summon-operator (бот на паузе +
 * system-строка с бэка) с локальной оптимистичной строкой до подтверждения.
 *
 * Typing-отправка (09 §1): композер onChange → debounce 1.5с → POST
 * /api/chats/{id}/typing (локальный мини-интервал 2с, 429 глушим).
 *
 * Онлайн-точка (09 §1): presence участников-юзеров — GET /api/chats/online
 * поллом 30с; 1:1 (seller/deal) — точка в шапке, group — точки в чипах
 * участников; support — без точки.
 *
 * UX-фиксы v2 (07 §2): скелетон истории, inline-ошибка с «Повторить»
 * (не только тост), даты-разделители «Сегодня/Вчера/25 окт», длинные
 * слова не рвут вёрстку (word-break в css), композер не под таббаром
 * (safe-area в css).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { ChatMessage } from "../../lib/chatSocket";
import { chatStore, createTypingSender, useChatRoom } from "../../lib/chatStore";
import {
  archiveChat,
  CHAT_REPORT_REASONS,
  CHAT_REPORT_REASON_LABEL,
  createChatInvite,
  fetchMessages,
  fetchOnlineUsers,
  GROUP_MAX_MEMBERS,
  isOwnerMustArchiveError,
  kickChatParticipant,
  leaveChat,
  reportChat,
  sendMessage,
  sendTyping,
  setChatMuted,
  summonOperator,
  THREAD_TYPE_LABEL,
  type ChatParticipant,
  type ChatReportReason,
  type ChatThread,
} from "../../lib/chatApi";
import { api } from "../../api/client";
import type { User } from "../../api/types";
import { apiErrorText } from "../../screens/apiErrorText";
import { Message } from "./Message";
import { useToast } from "../../ui/Toast";
import { haptic } from "../../api/auth";

/** Максимум строк авто-растущей textarea (~22px строка + паддинги). */
const COMPOSER_MAX_H = 78;

/** Онлайн-статусы: полл presence личных каналов (09 §1). */
const ONLINE_POLL_MS = 30_000;

export interface ChatRoomProps {
  threadId: string;
  /** Тред из списка (или null — стор резолвит сам через GET /api/chats). */
  thread?: ChatThread | null;
  onBack?: () => void;
  /** Тред изменился на бэке (архив/кик/выход) — родитель перечитывает список. */
  onThreadsChanged?: () => void;
}

/** Подтверждение-диалог: leave | archive | kick (08 §2). */
type Confirm =
  | { kind: "leave" }
  | { kind: "archive" }
  | { kind: "kick"; participant: ChatParticipant };

/** Локальная system-строка (ещё не подтверждена бэком) — отрицательный id. */
const localSystem = (body: string): ChatMessage => ({
  id: -Date.now(),
  sender_type: "system",
  sender_id: null,
  body,
  created_at: new Date().toISOString(),
});

// ---------- Дата-разделители ленты (07 §2: «Сегодня»/«Вчера»/«25 окт») ----------

const MONTHS_SHORT = [
  "янв",
  "фев",
  "мар",
  "апр",
  "мая",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getDate() === b.getDate() &&
    a.getMonth() === b.getMonth() &&
    a.getFullYear() === b.getFullYear()
  );
}

/** Ключ дня для группировки сообщений по датам (локальное время). */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Подпись разделителя: «Сегодня» / «Вчера» / «25 окт». */
export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (sameCalendarDay(d, now)) return "Сегодня";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameCalendarDay(d, yesterday)) return "Вчера";
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

/** Имя участника в шапке group: «Вы» для себя, иначе имя/фолбэк (07 §2). */
export function memberName(
  p: ChatParticipant,
  myTelegramId: number | null,
): string {
  if (p.user_type === "user" && myTelegramId !== null && p.user_id === myTelegramId) {
    return "Вы";
  }
  return p.name || (p.user_type === "partner" ? "Партнёр" : "Участник");
}

/** Имя для typing-индикатора в group: участник с этим user_type (не «Вы»). */
export function typingNameByType(
  thread: ChatThread | null,
  userType: string,
  myTelegramId: number | null,
): string {
  const p = (thread?.participants ?? []).find(
    (x) => x.user_type === userType && !(x.user_type === "user" && x.user_id === myTelegramId),
  );
  if (p?.name) return p.name;
  if (userType === "partner") return "Партнёр";
  if (userType === "operator") return "Оператор";
  return "Участник";
}

/**
 * Онлайн-статусы участников-юзеров (09 §1): GET /api/chats/online?ids=
 * раз в 30с (+ первый запрос сразу). Пустой список/выключено — без запроса.
 */
function useOnlineStatus(ids: number[], enabled: boolean): Set<number> {
  const [online, setOnline] = useState<Set<number>>(() => new Set<number>());
  const key = ids.join(",");
  useEffect(() => {
    if (!enabled || key === "") {
      setOnline(new Set<number>());
      return;
    }
    let alive = true;
    const load = () => {
      fetchOnlineUsers(ids)
        .then((s) => {
          if (alive) setOnline(s);
        })
        .catch(() => undefined); // presence не критичен — точка просто не сменится
    };
    load();
    const timer = window.setInterval(load, ONLINE_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // ids стабильны внутри треда: зависимость от ключа, не от массива
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return online;
}

export function ChatRoom({ threadId, thread: threadProp, onBack, onThreadsChanged }: ChatRoomProps) {
  const navigate = useNavigate();
  const toast = useToast();

  // Единый стор (09 §2): лента/typing/галочки/тред — из личного канала
  const { thread, room } = useChatRoom(threadId);
  const messages = room.messages;

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  /** Дозагрузка истории вверх — локальный UI-флаг (лента в сторе). */
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** telegram_id текущего юзера (для «Вы» в шапке group и имён typing). */
  const [myTelegramId, setMyTelegramId] = useState<number | null>(null);
  /** Инвайт-код переговорной: null — попап закрыт. */
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

  // Говернанс group (08 §2/§4/§6): меню «⋯», подтверждения, панель жалобы
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<Confirm | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<ChatReportReason | null>(null);
  const [reportComment, setReportComment] = useState("");
  const [reportBusy, setReportBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const isGroup = thread?.is_group === true;

  // Тред передан пропсом (список/тесты), но стора его ещё не знает — заносим
  useEffect(() => {
    if (threadProp) chatStore.seedThread(threadProp);
  }, [threadId, threadProp]);

  // Свой telegram_id: подпись «Вы» в group + исключение себя из online-ids
  useEffect(() => {
    let alive = true;
    api<User>("/me")
      .then((u) => alive && setMyTelegramId(u.telegram_id))
      .catch(() => undefined); // /me недоступен — все участники «по имени»
    return () => {
      alive = false;
    };
  }, [threadId]);

  /** Typing-отправка (09 §1): debounce 1.5с, локальный rate 2с, 429 глушим. */
  const typingSender = useMemo(
    () => createTypingSender(() => sendTyping(threadId)),
    [threadId],
  );
  useEffect(() => () => typingSender.cancel(), [typingSender]);

  /**
   * Своё сообщение: в 1:1 любой user — это сам юзер; в group свои
   * определяем по sender_id (другие участники тоже user_type='user').
   */
  const isOwn = useCallback(
    (m: ChatMessage): boolean => {
      if (m.sender_type !== "user") return false;
      if (!isGroup) return true;
      return myTelegramId !== null && m.sender_id === myTelegramId;
    },
    [isGroup, myTelegramId],
  );

  /** Онлайн-точки (09 §1): участники-юзеры без себя; support — без точки. */
  const onlineIds = useMemo(
    () =>
      (thread?.participants ?? [])
        .filter(
          (p) =>
            p.user_type === "user" &&
            (myTelegramId === null || p.user_id !== myTelegramId),
        )
        .map((p) => p.user_id),
    [thread, myTelegramId],
  );
  const online = useOnlineStatus(onlineIds, thread?.type !== "support");

  /** Typing-индикатор: имена из participants (group) или просто «печатает». */
  const typingLabel = useMemo(() => {
    if (!thread || thread.typing.size === 0) return null;
    if (!isGroup) return "печатает";
    const names: string[] = [];
    thread.typing.forEach((ut) => names.push(typingNameByType(thread, ut, myTelegramId)));
    return `${names.join(", ")} печатает`;
  }, [thread, isGroup, myTelegramId]);

  // Новые сообщения — держим ленту прижатой к низу
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, [messages.length, typingLabel]);

  /** Дозагрузка истории вверх (before_id-пагинация). */
  const loadOlder = async () => {
    const first = messages[0];
    if (loadingOlder || !first) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const keep = el?.scrollHeight ?? 0;
    try {
      const page = await fetchMessages(threadId, { beforeId: first.id });
      const items = [...page.items].sort((a, b) => a.id - b.id).filter((m) => m.id < first.id);
      chatStore.prependOlder(threadId, items, page.has_more);
      // не даём ленте прыгнуть: держим позицию относительно старого низа
      requestAnimationFrame(() => {
        const el2 = scrollRef.current;
        if (el2 && el2.scrollTo) el2.scrollTo({ top: el2.scrollHeight - keep });
      });
    } catch {
      toast.show("Не удалось загрузить историю", { error: true });
    } finally {
      setLoadingOlder(false);
    }
  };

  /** Отправка: только REST; ответ бэка (MessageView) падает в ленту стора. */
  const send = async () => {
    const body = input.trim();
    if (!body || sending) return;
    setSending(true);
    haptic("light");
    try {
      const m = await sendMessage(threadId, body);
      chatStore.appendMessage(threadId, m);
      setInput("");
      // авто-рост вернул высоту — сбрасываем после очистки поля
      if (inputRef.current) inputRef.current.style.height = "";
    } catch {
      toast.show("Сообщение не отправлено — попробуйте ещё раз", { error: true });
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  /**
   * «Позвать человека» (support, §6): POST summon-operator — бот на паузе.
   * Оптимистичная system-строка сразу; подтверждённая строка бэка
   * «Пользователь позвал оператора — бот на паузе» приедет событием личного
   * канала и заменит заглушку (chatStore.appendMessage выметает id<0).
   */
  const callHuman = async () => {
    haptic("light");
    // Локальная заглушка с отрицательным id — не смешивается с бэком.
    chatStore.appendMessage(threadId, localSystem("Позвали оператора — бот на паузе"));
    try {
      await summonOperator(threadId);
    } catch {
      toast.show("Не получилось позвать оператора — попробуйте позже", { error: true });
    }
  };

  /**
   * «Пригласить» в переговорной (07 §2): POST invite → 6-символьный код
   * крупно + «Копировать» (navigator.clipboard → тост).
   */
  const invite = async () => {
    if (inviteBusy || !thread) return;
    setInviteBusy(true);
    try {
      const code = await createChatInvite(threadId);
      setInviteCode(code);
    } catch (e) {
      // сырой detail наружу не показываем (03 §3.2) — маппинг
      toast.show(apiErrorText(e), { error: true });
    } finally {
      setInviteBusy(false);
    }
  };

  const copyInvite = async () => {
    if (!inviteCode) return;
    try {
      await navigator.clipboard.writeText(inviteCode);
      toast.show("Код скопирован");
    } catch {
      // clipboard недоступен (WebView без https) — код виден в попапе
      toast.show("Скопировать не удалось — перепишите код вручную", { error: true });
    }
  };

  // ---------- Говернанс переговорной (08-group-governance.md §2/§4/§6) ----------

  /** Mute/unmute своих уведомлений (08 §6): колокольчик в шапке + пункт меню. */
  const toggleMute = async () => {
    if (!thread || actionBusy) return;
    const want = !muted;
    setActionBusy(true);
    try {
      const next = await setChatMuted(threadId, want);
      // стор — чтобы сайдбар (двухколоночный десктоп) тоже обновился
      chatStore.patchThread(threadId, { muted: next });
      toast.show(next ? "Уведомления отключены" : "Уведомления включены");
    } catch {
      toast.show("Не удалось изменить уведомления — попробуйте позже", { error: true });
    } finally {
      setActionBusy(false);
    }
  };

  /** Жалоба на комнату (08 §4): reason-чипы + опц. комментарий; идемпотентна. */
  const sendReport = async () => {
    if (!reportReason || reportBusy) return;
    setReportBusy(true);
    try {
      await reportChat(threadId, reportReason, reportComment || undefined);
      toast.show("Жалоба отправлена");
      setReportOpen(false);
      setReportReason(null);
      setReportComment("");
    } catch {
      toast.show("Не удалось отправить жалобу — попробуйте позже", { error: true });
    } finally {
      setReportBusy(false);
    }
  };

  /** Покинуть комнату (08 §2): member свободно; owner — только последним. */
  const doLeave = async () => {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await leaveChat(threadId);
      toast.show("Вы покинули комнату");
      setConfirmState(null);
      onThreadsChanged?.(); // тред исчезнет из списка после перечитывания
      (onBack ?? (() => navigate("/chats")))();
    } catch (e) {
      if (isOwnerMustArchiveError(e)) {
        toast.show("Сначала архивируйте комнату или исключите участников", { error: true });
      } else {
        toast.show("Не удалось покинуть комнату — попробуйте позже", { error: true });
      }
    } finally {
      setActionBusy(false);
    }
  };

  /** Архивировать (owner, 08 §2): комната становится только для чтения. */
  const doArchive = async () => {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await archiveChat(threadId);
      chatStore.patchThread(threadId, { status: "closed" });
      setConfirmState(null);
      setMenuOpen(false);
      toast.show("Комната архивирована");
      onThreadsChanged?.();
    } catch {
      toast.show("Не удалось архивировать — попробуйте позже", { error: true });
    } finally {
      setActionBusy(false);
    }
  };

  /** Кик участника (owner кикает member, 08 §2): строка исчезает из шапки. */
  const doKick = async (p: ChatParticipant) => {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await kickChatParticipant(threadId, p.user_type, p.user_id);
      chatStore.patchThread(threadId, {
        participants: (thread?.participants ?? []).filter(
          (x) => !(x.user_type === p.user_type && x.user_id === p.user_id),
        ),
      });
      setConfirmState(null);
      toast.show(`${memberName(p, myTelegramId)} исключён из комнаты`);
      onThreadsChanged?.();
    } catch {
      toast.show("Не удалось исключить участника — попробуйте позже", { error: true });
    } finally {
      setActionBusy(false);
    }
  };

  /** Выполнить подтверждённое действие (единый диспетчер диалогов). */
  const runConfirm = () => {
    if (!confirmState) return;
    if (confirmState.kind === "leave") void doLeave();
    else if (confirmState.kind === "archive") void doArchive();
    else void doKick(confirmState.participant);
  };

  /** Тексты диалога-подтверждения по типу действия. */
  const confirmTexts = (
    c: Confirm,
  ): { title: string; text: string; action: string } => {
    if (c.kind === "leave") {
      return {
        title: "Покинуть комнату?",
        text: "Вы выйдете из переговорной. Вернуться можно только по новому коду приглашения.",
        action: "Покинуть",
      };
    }
    if (c.kind === "archive") {
      return {
        title: "Архивировать комнату?",
        text: "Комната станет только для чтения — отправлять сообщения будет нельзя.",
        action: "Архивировать",
      };
    }
    return {
      title: "Исключить участника?",
      text: `${memberName(c.participant, myTelegramId)} больше не сможет писать в эту переговорную.`,
      action: "Исключить",
    };
  };

  /** Имя автора чужого сообщения в group (по participants+sender_id). */
  const senderNameFor = (m: ChatMessage): string | null => {
    if (!isGroup || isOwn(m)) return null;
    if (m.sender_type !== "user" && m.sender_type !== "partner") return null;
    const p = thread?.participants?.find(
      (x) => x.user_type === m.sender_type && x.user_id === m.sender_id,
    );
    return p?.name ?? null;
  };

  /** Авто-рост textarea до 3 строк: дальше внутренний скролл. */
  const grow = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`;
  };

  const closed = thread?.status === "closed";
  const isSupport = thread?.type === "support";
  // Говернанс (08 §2/§6): мой mute/роль, участники с короной owner
  const muted = thread?.muted === true;
  const isOwner = isGroup && (thread?.role ?? "member") === "owner";
  const participants = thread?.participants ?? [];
  // owner может выйти только последним участником (иначе 409 owner_must_archive)
  const ownerAlone = isOwner && participants.length <= 1;
  // Онлайн-точка в шапке — только 1:1 (seller/deal) с юзерами-участниками
  const showHeaderOnline =
    !!thread && !isGroup && !isSupport && onlineIds.length > 0;
  const headerOnline = online.size > 0;

  return (
    <div className="chat-room" data-testid="chat-room">
      <header className="chat-room__head">
        <button
          type="button"
          className="chat-room__back"
          aria-label="К списку чатов"
          onClick={onBack ?? (() => navigate("/chats"))}
        >
          ‹
        </button>
        <div className="chat-room__titles">
          {thread && (
            <span className={`chat-room__type chat-room__type--${thread.type}`}>
              {THREAD_TYPE_LABEL[thread.type]}
            </span>
          )}
          <h3 className="chat-room__title">
            {thread?.title ||
              (thread?.subject
                ? `${thread.subject.make ?? ""} ${thread.subject.model ?? ""}`.trim()
                : isGroup
                  ? "Переговорная"
                  : "Чат")}
          </h3>
          {/* Онлайн-точка 1:1 (09 §1): зелёная «онлайн» / серая «не в сети» */}
          {showHeaderOnline && (
            <span
              className={
                headerOnline
                  ? "chat-room__online chat-room__online--on"
                  : "chat-room__online"
              }
              data-testid="chat-online"
              data-state={headerOnline ? "on" : "off"}
            >
              <span className="chat-room__online-dot" aria-hidden="true" />
              {headerOnline ? "онлайн" : "не в сети"}
            </span>
          )}
          {isGroup && participants.length > 0 && (
            <div className="chat-room__members" data-testid="chat-members">
              {participants.map((p) => {
                const me =
                  p.user_type === "user" && myTelegramId !== null && p.user_id === myTelegramId;
                const name = memberName(p, myTelegramId);
                // owner шапки кикает member по тапу (08 §2); себя и owner — нельзя
                const kickable = isOwner && !me && p.role !== "owner";
                const crown =
                  p.role === "owner" ? (
                    <span className="chat-member__crown" title="Владелец комнаты" aria-hidden="true">
                      👑
                    </span>
                  ) : null;
                // Онлайн-точка юзера в чипе (09 §1): presence личного канала
                const dot =
                  p.user_type === "user" && online.has(p.user_id) ? (
                    <span
                      className="chat-member__dot"
                      data-testid="chat-member-dot"
                      title="онлайн"
                      aria-label={`${name} онлайн`}
                    />
                  ) : null;
                return kickable ? (
                  <button
                    type="button"
                    key={`${p.user_type}:${p.user_id}`}
                    className="chat-member chat-member--kickable"
                    aria-label={`Участник ${name}: исключить`}
                    disabled={actionBusy}
                    onClick={() => setConfirmState({ kind: "kick", participant: p })}
                  >
                    {dot}
                    {crown}
                    {name}
                  </button>
                ) : (
                  <span key={`${p.user_type}:${p.user_id}`} className="chat-member">
                    {dot}
                    {crown}
                    {name}
                  </span>
                );
              })}
              <span className="chat-room__members-count">
                · {participants.length}/{GROUP_MAX_MEMBERS}
              </span>
            </div>
          )}
          {thread?.subject && (
            <button
              type="button"
              className="chat-room__subject"
              onClick={() => navigate(`/listing/${thread.subject!.listing_id}`)}
            >
              {thread.subject.image && (
                <img src={thread.subject.image} alt="" loading="lazy" />
              )}
              <span>
                {[thread.subject.make, thread.subject.model, thread.subject.year]
                  .filter(Boolean)
                  .join(" ")}
              </span>
              {/* Лот снят (событие lot_expired, 09 §1) — пометка в шапке */}
              {thread.lotExpired && (
                <span className="chat-room__lot-expired" data-testid="chat-lot-expired">
                  лот снят
                </span>
              )}
            </button>
          )}
        </div>
        {isGroup && !closed && (
          <button
            type="button"
            className="chat-room__invite-btn"
            disabled={inviteBusy}
            onClick={() => void invite()}
          >
            🔗 Пригласить
          </button>
        )}
        {/* Mute-колокольчик (08 §6): состояние своих уведомлений, клик = тоггл */}
        {isGroup && !closed && (
          <button
            type="button"
            className={muted ? "chat-room__bell chat-room__bell--muted" : "chat-room__bell"}
            data-testid="chat-bell"
            aria-label={muted ? "Уведомления отключены" : "Уведомления включены"}
            title={muted ? "Уведомления отключены — включить" : "Уведомления включены — отключить"}
            disabled={actionBusy}
            onClick={() => void toggleMute()}
          >
            {muted ? "🔕" : "🔔"}
          </button>
        )}
        {/* Меню «⋯» (08 §7): mute/жалоба/покинуть/архивировать; закрытый тред — только просмотр */}
        {isGroup && !closed && (
          <div className="chat-menu">
            <button
              type="button"
              className="chat-menu__btn"
              aria-label="Меню комнаты"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="chat-menu__dropdown" role="menu" aria-label="Действия с комнатой">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void toggleMute();
                  }}
                >
                  {muted ? "🔔 Включить уведомления" : "🔕 Отключить уведомления"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setReportOpen(true);
                  }}
                >
                  🚩 Пожаловаться
                </button>
                {isOwner ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirmState({ kind: "archive" });
                      }}
                    >
                      📦 Архивировать
                    </button>
                    {/* owner не последний — «Покинуть» серым с подсказкой (08 §2) */}
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!ownerAlone}
                      onClick={() => {
                        if (!ownerAlone) return;
                        setMenuOpen(false);
                        setConfirmState({ kind: "leave" });
                      }}
                    >
                      🚪 Покинуть комнату
                    </button>
                    {!ownerAlone && (
                      <span className="chat-menu__hint">
                        Сначала архивируйте или исключите участников
                      </span>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmState({ kind: "leave" });
                    }}
                  >
                    🚪 Покинуть комнату
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {isSupport && !closed && (
          <button
            type="button"
            className="chat-room__human"
            onClick={() => void callHuman()}
          >
            👥 Позвать человека
          </button>
        )}
      </header>

      <div className="chat-room__feed" ref={scrollRef} role="log" aria-label="Сообщения чата">
        {room.hasMore && (
          <button
            type="button"
            className="chat-room__older"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? "Загружаем…" : "Ещё сообщения"}
          </button>
        )}
        {/* Скелетон истории (07 §2): три пузыря-заглушки вместо текста */}
        {room.loading && (
          <div className="chat-feed-skel" aria-hidden="true">
            <span className="chat-feed-skel__row" />
            <span className="chat-feed-skel__row chat-feed-skel__row--own" />
            <span className="chat-feed-skel__row" />
          </div>
        )}
        {!room.loading && room.error && (
          <div className="chat-room__load-error" role="alert">
            {/* стор хранит исходный текст — наружу отдаём через маппинг
                (03 §3.2: без сырого английского detail/Failed to fetch) */}
            <span>{apiErrorText(room.error)}</span>
            <button
              type="button"
              className="chat-room__retry"
              onClick={() => chatStore.reloadRoom(threadId)}
            >
              Повторить
            </button>
          </div>
        )}
        {!room.loading &&
          messages.map((m, i) => {
            const prev = messages[i - 1];
            // дата-разделитель перед первым сообщением дня
            const prevDay = prev ? dayKey(prev.created_at) : "";
            const day = dayKey(m.created_at);
            const dayLabel = day !== prevDay ? formatDayLabel(m.created_at) : null;
            // группа = тот же отправитель подряд (bot/system всегда «сами»);
            // в group разные участники-юзеры не склеиваются (sender_id)
            const sameSender =
              !!prev &&
              prev.sender_type === m.sender_type &&
              prev.sender_id === m.sender_id;
            return (
              <Fragment key={m.id}>
                {dayLabel && (
                  <div className="chat-date" aria-hidden="true">
                    <span>{dayLabel}</span>
                  </div>
                )}
                <Message
                  message={m}
                  own={isOwn(m)}
                  read={isOwn(m) && m.id <= room.partnerReadId}
                  showSender={!sameSender}
                  senderName={senderNameFor(m)}
                />
              </Fragment>
            );
          })}
        {typingLabel && (
          <div className="chat-typing" aria-live="polite">
            <span className="chat-typing__dots" aria-hidden="true">…</span>{" "}
            {typingLabel}
          </div>
        )}
      </div>

      {/* Закрытая переговорная — read-only (08 §2): композера нет, плашка архива */}
      {closed && isGroup ? (
        <div className="chat-composer chat-composer--archived" data-testid="chat-archive-plate">
          📁 Архив — комната закрыта
        </div>
      ) : (
        <div className="chat-composer">
          <textarea
            ref={inputRef}
            className="chat-composer__input"
            aria-label="Сообщение"
            placeholder={closed ? "Чат закрыт" : "Сообщение… (Enter — отправить)"}
            rows={1}
            maxLength={4000}
            value={input}
            disabled={closed}
            onChange={(e) => {
              setInput(e.target.value);
              grow();
              // «Я печатаю» (09 §1): debounce 1.5с внутри typingSender
              typingSender.notify();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="button"
            className="chat-composer__send"
            aria-label="Отправить"
            disabled={!input.trim() || sending || closed}
            onClick={() => void send()}
          >
            ➤
          </button>
        </div>
      )}

      {/* Инвайт-код переговорной (07 §2): крупно + «Копировать» */}
      {isGroup && inviteCode !== null && (
        <div className="chat-invite" role="dialog" aria-modal="false" aria-label="Код приглашения">
          <div className="chat-invite__card">
            <button
              type="button"
              className="chat-invite__close"
              aria-label="Закрыть код приглашения"
              onClick={() => setInviteCode(null)}
            >
              ✕
            </button>
            <div className="chat-invite__title">Код приглашения</div>
            <div className="chat-invite__code" data-testid="invite-code">
              {inviteCode}
            </div>
            <div className="chat-invite__hint">
              Отправьте код друзьям или партнёру — вход по коду на экране чатов,
              переговорная до {GROUP_MAX_MEMBERS} участников.
            </div>
            <button type="button" className="chat-invite__copy" onClick={() => void copyInvite()}>
              Копировать
            </button>
          </div>
        </div>
      )}

      {/* Жалоба на комнату (08 §4/§7): reason-чипы + опц. комментарий → тост */}
      {reportOpen && (
        <div className="chat-invite chat-report" role="dialog" aria-label="Жалоба на комнату">
          <div className="chat-invite__card">
            <button
              type="button"
              className="chat-invite__close"
              aria-label="Закрыть панель жалобы"
              onClick={() => setReportOpen(false)}
            >
              ✕
            </button>
            <div className="chat-invite__title">Пожаловаться</div>
            <div className="chat-report__chips" role="radiogroup" aria-label="Причина жалобы">
              {CHAT_REPORT_REASONS.map((r) => (
                <button
                  type="button"
                  key={r}
                  role="radio"
                  aria-checked={reportReason === r}
                  className={
                    reportReason === r
                      ? "chat-report__chip chat-report__chip--active"
                      : "chat-report__chip"
                  }
                  onClick={() => setReportReason(r)}
                >
                  {CHAT_REPORT_REASON_LABEL[r]}
                </button>
              ))}
            </div>
            <textarea
              className="chat-report__comment"
              aria-label="Комментарий к жалобе (необязательно)"
              placeholder="Комментарий (необязательно)"
              maxLength={2000}
              rows={3}
              value={reportComment}
              onChange={(e) => setReportComment(e.target.value)}
            />
            <button
              type="button"
              className="chat-invite__copy"
              disabled={!reportReason || reportBusy}
              onClick={() => void sendReport()}
            >
              {reportBusy ? "Отправляем…" : "Отправить жалобу"}
            </button>
          </div>
        </div>
      )}

      {/* Подтверждение действия (08 §7): покинуть / архивировать / кик */}
      {confirmState && (
        <div className="chat-invite" role="dialog" aria-label="Подтверждение действия">
          <div className="chat-invite__card">
            <div className="chat-invite__title">{confirmTexts(confirmState).title}</div>
            <div className="chat-report__hint">{confirmTexts(confirmState).text}</div>
            <div className="chat-confirm__actions">
              <button
                type="button"
                className="chat-confirm__ok"
                disabled={actionBusy}
                onClick={runConfirm}
              >
                {confirmTexts(confirmState).action}
              </button>
              <button
                type="button"
                className="chat-confirm__cancel"
                onClick={() => setConfirmState(null)}
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
