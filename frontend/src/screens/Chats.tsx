/**
 * Экран «Чаты» v2 (ТЗ §7 + 07-sell-chats-partner-inspection.md §2 +
 * 08-group-governance.md §7 + 09-personal-channel.md §3): список тредов +
 * выбор треда → ChatRoom. Данные — единый стор (lib/chatStore, 09 §2):
 * unread/typing/новые сообщения приезжают событиями личного канала,
 * сайдбар обновляется живьём.
 *
 * Двухколоночный десктоп ≥900px (09 §3): сайдбар списка (340px) и комната
 * в одной сетке — выбор треда не уводит со списка, активная строка
 * подсвечена; /chats без :id — заглушка «Выберите диалог» справа.
 * Мобайл <900px: прежний стек — overlay-роут /chats/:id поверх списка
 * (список не размонтируется — экран живёт в keep-alive KEEPALIVE_TABS).
 *
 * Меню v2: сегмент «💬 Диалоги | 👥 Переговорные» (как hist-seg в
 * Analyses); под «Переговорными» — кнопка «+ Создать» (лот из истории
 * просмотров ОБЯЗАТЕЛЕН — 08 §1: переговорная только по автомобилю;
 * пустая история → заглушка «Откройте карточку автомобиля»; title опц. —
 * пусто = автогенер бэка) и блок «Присоединиться по коду» (6 символов;
 * 409 group_is_full → тост «заполнена»).
 *
 * Маршрут /chats НЕ входит в NAV_ITEMS (владельцу нравится меню v3):
 * вход — конверт-кнопка (сайдбар десктопа / плавающая на мобиле).
 * Гость: конверт виден, но экран — заглушка «Войдите».
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";

import { isGuest } from "../api/auth";
import {
  createGroupChat,
  createSupportChat,
  isGroupFullError,
  joinGroupChat,
} from "../lib/chatApi";
import { chatStore, useChatThreads } from "../lib/chatStore";
import { getViews, type ViewedListing } from "../lib/viewHistory";
import { ChatList } from "../components/chat/ChatList";
import { ChatRoom } from "../components/chat/ChatRoom";
import { useToast } from "../ui/Toast";
import { apiErrorText } from "./apiErrorText";
import "./chats.css";

/** Сегмент списка: 1:1-диалоги (support/seller/deal) | переговорные (group). */
type ChatsSegment = "dialogs" | "groups";

/** Мини-длина инвайт-кода (07 §2: 6 символов). */
const INVITE_CODE_LEN = 6;

/** Порог двухколоночного макета (09 §3: ≥900px сайдбар + комната). */
const SPLIT_MEDIA = "(min-width: 900px)";

/**
 * Ширина окна ≥900px (09 §3): matchMedia с защитой от окружений без него
 * (jsdom/старые WebView) — без matchMedia считаем мобайл (стек).
 */
function useIsWide(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia(SPLIT_MEDIA).matches : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(SPLIT_MEDIA);
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

/** Overlay-роут /chats/:id — ChatRoom (тред резолвит стор). */
function ChatRoomRoute({
  onBack,
  onThreadsChanged,
}: {
  onBack: () => void;
  /** Архив/кик/выход из комнаты — тихо перечитываем список (08 §7). */
  onThreadsChanged: () => void;
}) {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <ChatRoom threadId={id} onBack={onBack} onThreadsChanged={onThreadsChanged} />;
}

/** Заглушка правой колонки десктопа: /chats без :id (09 §3). */
function ChatsPlaceholder() {
  return (
    <div className="chats-placeholder" data-testid="chats-placeholder">
      <div className="chats-placeholder__emoji" aria-hidden="true">💬</div>
      <div className="chats-placeholder__title">Выберите диалог</div>
      <div className="chats-placeholder__text">
        Слева — ваши чаты и переговорные. Непрочитанные подсвечиваются счётчиком.
      </div>
    </div>
  );
}

/** Строка лота в селекте создания переговорной. */
const listingOptionLabel = (v: ViewedListing): string =>
  [v.make, v.model, v.year].filter(Boolean).join(" ") || `Лот №${v.listing_id}`;

export function ChatsScreen() {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  // Единый стор (09 §2): список + live-обновления из личного канала
  const { threads, loading, error, reload } = useChatThreads();
  const [supportBusy, setSupportBusy] = useState(false);

  // Меню v2: сегмент + мини-форма создания + присоединение по коду
  const [segment, setSegment] = useState<ChatsSegment>("dialogs");
  const [creating, setCreating] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupListing, setGroupListing] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [recentViews, setRecentViews] = useState<ViewedListing[]>([]);
  const [joinCode, setJoinCode] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);

  const guest = isGuest();
  const wide = useIsWide();
  const overlayMatch = /^\/chats\/([^/]+)$/.exec(location.pathname);
  /** Открытый тред (id) — подсветка строки сайдбара в двухколоночном макете. */
  const openId = overlayMatch?.[1] ?? null;

  /** Тихое обновление списка (после создания/join — без скелетонов). */
  const refresh = useCallback(() => {
    void chatStore.loadThreads(true);
  }, []);

  /** Диалоги = support/seller/deal; переговорные = group (07 §2). */
  const dialogs = useMemo(
    () => threads.filter((t) => t.type !== "group" && !t.is_group),
    [threads],
  );
  const groups = useMemo(
    () => threads.filter((t) => t.type === "group" || t.is_group),
    [threads],
  );
  const visible = segment === "groups" ? groups : dialogs;

  /** «Написать в поддержку»: создать/reuse singleton и открыть чат. */
  const openSupport = async () => {
    if (supportBusy) return;
    setSupportBusy(true);
    try {
      const threadId = await createSupportChat();
      navigate(`/chats/${threadId}`);
    } catch {
      toast.show("Не удалось открыть чат поддержки — попробуйте позже", { error: true });
    } finally {
      setSupportBusy(false);
    }
  };

  /** Открыть мини-форму создания: подтягиваем последние просмотренные лоты. */
  const openCreateForm = () => {
    setRecentViews(getViews().slice(0, 5));
    setGroupError(null);
    setCreating(true);
  };

  /** POST /chats/group {listing_id!, title?} → переход в созданный тред
   *  (08 §1: лот обязателен, title пуст — автогенер бэка). */
  const createGroup = async () => {
    if (createBusy) return;
    if (!groupListing) {
      setGroupError("Выберите автомобиль — переговорная создаётся только по объявлению");
      return;
    }
    const title = groupTitle.trim();
    if (title.length > 0 && (title.length < 3 || title.length > 120)) {
      setGroupError("Название — от 3 до 120 символов");
      return;
    }
    setCreateBusy(true);
    setGroupError(null);
    try {
      const threadId = await createGroupChat(Number(groupListing), title || undefined);
      toast.show("Переговорная создана");
      setCreating(false);
      setGroupTitle("");
      setGroupListing("");
      setGroupError(null);
      navigate(`/chats/${threadId}`);
      refresh(); // список пополнятся новой переговорной в фоне
    } catch (e) {
      // 409-контракты 08 §1: без листинга / лот снят — человеческим текстом;
      // остальное — маппинг 03 §3.2 (сырой detail наружу не показываем)
      const msg = (e as Error).message;
      if (/group_needs_listing/i.test(msg)) {
        setGroupError("Переговорная создаётся только по автомобилю — выберите лот");
      } else if (/listing_not_active/i.test(msg)) {
        setGroupError("Этот лот уже неактивен — выберите другой");
      } else {
        setGroupError(apiErrorText(e));
      }
    } finally {
      setCreateBusy(false);
    }
  };

  /** POST /chats/join {code} → переход; 409 group_is_full → тост. */
  const join = async () => {
    const code = joinCode.trim();
    if (code.length !== INVITE_CODE_LEN || joinBusy) return;
    setJoinBusy(true);
    try {
      const threadId = await joinGroupChat(code);
      setJoinCode("");
      navigate(`/chats/${threadId}`);
      refresh();
    } catch (e) {
      if (isGroupFullError(e)) {
        toast.show("Переговорная заполнена (макс. 5)", { error: true });
      } else {
        // 404 invite_not_found и прочее — по маппингу, без сырого detail
        toast.show(apiErrorText(e), { error: true });
      }
    } finally {
      setJoinBusy(false);
    }
  };

  if (guest) {
    return (
      <div className="chats-page chats-page--guest">
        <div className="chats-guest">
          <div className="chats-guest__emoji" aria-hidden="true">💬</div>
          <h3>Чаты</h3>
          <p>
            Поддержка, продавцы и агент на сделку — после входа.
            Войдите, чтобы переписка была под вашим аккаунтом.
          </p>
          <Link className="chats-guest__login" to="/login">
            Войти
          </Link>
        </div>
      </div>
    );
  }

  /** Правая колонка: Routes с подменой location (wide-режим всегда живёт,
   *  /chats без :id — заглушка; overlay-режим монтируется только с :id). */
  const roomRoutes = (
    <Routes location={location.pathname}>
      <Route
        path="/chats/:id"
        element={<ChatRoomRoute onBack={() => navigate("/chats")} onThreadsChanged={refresh} />}
      />
      {wide ? <Route path="/chats" element={<ChatsPlaceholder />} /> : null}
    </Routes>
  );

  return (
    <div className={wide ? "chats-page chats-page--split" : "chats-page"}>
      {/* Список: мобайл — прячем классом под overlay (не размонтируем);
          десктоп ≥900px — сайдбар всегда виден рядом с комнатой (09 §3) */}
      <div className={wide || !overlayMatch ? "chats-page__list" : "chats-page__list keepalive-hidden"}>
        <header className="chats-head">
          <h3>Чаты</h3>
          {segment === "dialogs" && (
            <button
              type="button"
              className="chats-head__support"
              disabled={supportBusy}
              onClick={() => void openSupport()}
            >
              💬 Написать в поддержку
            </button>
          )}
        </header>

        {/* Сегмент «Диалоги | Переговорные» (07 §2, стиль hist-seg) */}
        <div className="chats-seg" role="tablist" aria-label="Разделы чатов">
          <button
            type="button"
            role="tab"
            aria-selected={segment === "dialogs"}
            className={
              segment === "dialogs" ? "chats-seg__btn chats-seg__btn--active" : "chats-seg__btn"
            }
            onClick={() => setSegment("dialogs")}
          >
            💬 Диалоги
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={segment === "groups"}
            className={
              segment === "groups" ? "chats-seg__btn chats-seg__btn--active" : "chats-seg__btn"
            }
            onClick={() => setSegment("groups")}
          >
            👥 Переговорные
          </button>
        </div>

        {/* Панель переговорных: создать + присоединиться по коду (07 §2) */}
        {segment === "groups" && (
          <section className="chats-groups" aria-label="Переговорные">
            {creating ? (
              recentViews.length === 0 ? (
                /* 08 §7: пустая история просмотров — переговорную не создать */
                <div className="chats-create chats-create--empty" data-testid="chats-create-empty">
                  <div className="chats-create__empty-title">
                    Откройте карточку автомобиля, чтобы создать переговорную
                  </div>
                  <div className="chats-create__empty-text">
                    Переговорная собирается вокруг конкретного лота — выберите машину
                    в ленте, и она появится здесь.
                  </div>
                  <div className="chats-create__actions">
                    <Link className="chats-create__feed-btn" to="/feed">
                      🚗 К ленте
                    </Link>
                    <button
                      type="button"
                      className="chats-create__cancel"
                      onClick={() => {
                        setCreating(false);
                        setGroupError(null);
                      }}
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              ) : (
                <form
                  className="chats-create"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void createGroup();
                  }}
                >
                  <label className="chats-field">
                    <span>Автомобиль *</span>
                    <select
                      className="chats-create__select"
                      value={groupListing}
                      onChange={(e) => setGroupListing(e.target.value)}
                      aria-label="Автомобиль для переговорной (обязательно)"
                    >
                    <option value="" disabled>
                      Выберите автомобиль
                    </option>
                      {recentViews.map((v) => (
                        <option key={v.listing_id} value={v.listing_id}>
                          {listingOptionLabel(v)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="chats-field">
                    <span>Название (необязательно)</span>
                    <input
                      className="chats-create__input"
                      value={groupTitle}
                      onChange={(e) => setGroupTitle(e.target.value)}
                      placeholder="Пусто — «Переговоры: марка модель»"
                      aria-label="Название переговорной (необязательно)"
                      maxLength={120}
                    />
                  </label>
                  {groupError && (
                    <div className="chats-create__error" role="alert">
                      {groupError}
                    </div>
                  )}
                  <div className="chats-create__actions">
                    <button type="submit" className="chats-create__submit" disabled={createBusy}>
                      {createBusy ? "Создаём…" : "Создать переговорную"}
                    </button>
                    <button
                      type="button"
                      className="chats-create__cancel"
                      onClick={() => {
                        setCreating(false);
                        setGroupTitle("");
                        setGroupListing("");
                        setGroupError(null);
                      }}
                    >
                      Отмена
                    </button>
                  </div>
                </form>
              )
            ) : (
              <button type="button" className="chats-groups__create" onClick={openCreateForm}>
                ＋ Создать переговорную
              </button>
            )}

            <div className="chats-join">
              <label className="chats-field">
                <span>Код переговорной</span>
                <input
                  className="chats-join__input"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase().slice(0, INVITE_CODE_LEN))}
                  placeholder="Код из 6 символов"
                  aria-label="Код переговорной"
                  maxLength={INVITE_CODE_LEN}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
              <button
                type="button"
                className="chats-join__btn"
                disabled={joinCode.trim().length !== INVITE_CODE_LEN || joinBusy}
                onClick={() => void join()}
              >
                {joinBusy ? "…" : "Присоединиться"}
              </button>
            </div>
          </section>
        )}

        {/* Скелетоны списка (07 §2): 3 строки-заглушки вместо спиннера */}
        {loading && (
          <div className="chats-skel" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div className="chats-skel__row" key={i}>
                <span className="chats-skel__ava" />
                <span className="chats-skel__lines">
                  <span className="chats-skel__line" style={{ width: "62%" }} />
                  <span className="chats-skel__line" style={{ width: "40%" }} />
                </span>
              </div>
            ))}
          </div>
        )}
        {!loading && error && (
          <div className="chats-error">
            {apiErrorText(error)}
            <button type="button" className="chats-error__retry" onClick={reload}>
              Повторить
            </button>
          </div>
        )}
        {!loading && !error && visible.length === 0 && segment === "dialogs" && (
          <div className="chats-empty">
            <div className="chats-empty__emoji" aria-hidden="true">📭</div>
            <div className="chats-empty__title">Диалогов пока нет</div>
            <div className="chats-empty__text">
              Задайте вопрос поддержке или спросите продавца машины
              прямо из карточки объявления.
            </div>
            <button
              type="button"
              className="chats-empty__btn"
              disabled={supportBusy}
              onClick={() => void openSupport()}
            >
              💬 Написать в поддержку
            </button>
          </div>
        )}
        {!loading && !error && visible.length === 0 && segment === "groups" && (
          <div className="chats-empty">
            <div className="chats-empty__emoji" aria-hidden="true">👥</div>
            <div className="chats-empty__title">Переговорных пока нет</div>
            <div className="chats-empty__text">
              Соберите до 5 участников (друзья, агент, партнёр) в один чат —
              например, чтобы вместе выбрать машину и съездить на осмотр.
            </div>
            <button type="button" className="chats-empty__btn" onClick={openCreateForm}>
              ＋ Создать переговорную
            </button>
          </div>
        )}
        {!loading && !error && visible.length > 0 && (
          <ChatList
            threads={visible}
            activeId={openId}
            onSelect={(id) => navigate(`/chats/${id}`)}
          />
        )}
      </div>

      {/* Десктоп ≥900px (09 §3): комната рядом со списком (в одной сетке),
          /chats без :id — заглушка «Выберите диалог». */}
      {wide ? (
        <div className="chats-page__pane">{roomRoutes}</div>
      ) : (
        /* Мобайл: overlay-стек поверх списка (прежнее поведение) */
        overlayMatch && <div className="chats-page__overlay">{roomRoutes}</div>
      )}
    </div>
  );
}
