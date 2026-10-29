/**
 * Хелпер маппинга API-ошибок на человекочитаемые тексты
 * (03-content-a11y.md §3.2). Живёт в screens/ специально — lib/ не трогаем.
 *
 * Сырой `detail` бэкенда пользователю не показываем: по машиночитаемому
 * префиксу (quota_exceeded, instant_business_only, Filter limit…) или по
 * HTTP-статусу выбираем готовую строку «что случилось → почему → как
 * исправить» (≤ 2 предложений). Любая ошибка может нести CTA-кнопку
 * (апселл на тарифы / фолбэк в сигналы) — экран сам решает, рисовать ли её.
 */

export interface ApiErrorAction {
  /** Подпись кнопки (глагол действия, 03 §1 принцип 2) */
  label: string;
  /** Внутренний роут для кнопки (например, апселл → /profile) */
  to?: string;
}

export interface ApiErrorView {
  /** Готовый русский текст (что случилось → почему → как исправить) */
  text: string;
  /** Необязательная кнопка действия (апселл/фолбэк) */
  action?: ApiErrorAction;
}

/** Извлечь статус и detail из ApiError/Error/неизвестного броска. */
function parts(e: unknown): { status: number; detail: string } {
  const err = e as { status?: number; message?: string } | null;
  return {
    status: typeof err?.status === "number" ? err.status : 0,
    detail: String(err?.message ?? e ?? "").toLowerCase(),
  };
}

/** Сеть умерла ещё до ответа (fetch TypeError — без статуса и detail). */
function isNetwork(e: unknown): boolean {
  const { status, detail } = parts(e);
  return !status && (detail.startsWith("failed to fetch") || detail === "typeerror" || detail.includes("load failed") || detail === "");
}

/**
 * Текст ошибки по маппингу 03-content-a11y.md §3.2. Чистая функция:
 * одинаковый бросок → одинаковый текст и CTA на любом экране.
 */
export function apiErrorView(e: unknown): ApiErrorView {
  const { status, detail } = parts(e);
  const has = (...keys: string[]) => keys.some((k) => detail.includes(k));

  if (status === 401) {
    // Вход по email (Login): неверная пара — не «сессия истекла»
    if (has("invalid credentials")) {
      return { text: "Неверный email или пароль. Проверьте данные и попробуйте ещё раз." };
    }
    return {
      text: "Сессия истекла. Закройте мини-апп и откройте заново из Telegram-бота.",
    };
  }

  if (status === 403) {
    if (has("quota_exceeded")) {
      return {
        text: "Бесплатный разбор этой недели уже использован. Безлимит — в Pro и Business.",
        action: { label: "⚡ Безлимит в Pro", to: "/profile" },
      };
    }
    if (has("instant_business_only")) {
      return {
        text: "«Сразу при публикации» — тариф Business. На Pro подборка приходит дайджестом раз в день.",
        action: { label: "Смотреть тарифы", to: "/profile" },
      };
    }
    if (has("filter limit")) {
      return {
        text: "Лимит уведомлений Free — 3. Удалите ненужное или оформите Pro.",
        action: { label: "Смотреть тарифы", to: "/profile" },
      };
    }
    if (has("agent_forbidden")) {
      return {
        text: "Агент на сделку — тариф Business. Оформите подписку, и мы поручим осмотр и оформление агенту.",
        action: { label: "Смотреть тарифы", to: "/profile" },
      };
    }
    if (has("guest_forbidden")) {
      return {
        text: "AI-анализ доступен после входа. Войдите через Telegram — разборы и уведомления привяжутся к аккаунту.",
      };
    }
    // Чаты (09 §1/08 §2): гостевой гейт и архивная переговорная
    if (has("chats_registration_required")) {
      return { text: "Чаты доступны после входа или регистрации." };
    }
    if (has("thread_archived")) {
      return { text: "Комната архивирована — отправка сообщений недоступна." };
    }
    return {
      text: "Сессия истекла. Закройте мини-апп и откройте заново из Telegram-бота.",
    };
  }

  if (status === 404) {
    if (has("filter")) {
      return {
        text: "Уведомление не найдено — возможно, вы удалили его с другого устройства.",
      };
    }
    // Переговорные (07 §2): код приглашения истёк/не существует
    if (has("invite_not_found", "invite")) {
      return { text: "Код приглашения истёк или не существует — попросите новый." };
    }
    return {
      text: "Объявление не найдено. Возможно, его уже продали — оно исчезло с источника.",
    };
  }

  if (status === 409) {
    // Переговорные (08 §1–§2) и рынок владельцев (10 §4): доменные конфликты
    if (has("group_is_full")) {
      return { text: "Переговорная заполнена (макс. 5 участников)." };
    }
    if (has("group_needs_listing")) {
      return { text: "Переговорная создаётся только по автомобилю — выберите лот." };
    }
    if (has("listing_not_active")) {
      return { text: "Этот лот уже неактивен — выберите другой." };
    }
    if (has("owner_must_archive")) {
      return { text: "Сначала архивируйте комнату или исключите участников." };
    }
    if (has("lot_invalid_state")) {
      return {
        text: "Лот сейчас на проверке или снят — действие станет доступно после решения модерации.",
      };
    }
    // Регистрация (Login): email занят
    if (has("email already registered", "email_taken")) {
      return { text: "Пользователь с таким email уже зарегистрирован — попробуйте войти." };
    }
    return { text: "Действие недоступно: состояние изменилось. Обновите страницу и попробуйте ещё раз." };
  }

  if (status === 422) {
    if (has("price_min")) {
      return { text: "«Цена от» больше «цены до». Поменяйте границы местами или очистите одно из полей." };
    }
    if (has("year")) {
      return { text: "«Год от» больше «года до». Проверьте диапазон — например, 2019–2024." };
    }
    if (has("mileage")) {
      return { text: "«Пробег от» больше «пробега до». Укажите диапазон, например 10 000–100 000 км." };
    }
    if (has("engine_volume")) {
      return { text: "«Объём от» больше «объёма до». Проверьте диапазон, например 1.6–3.0 л." };
    }
    return { text: "Проверьте цену и год. Цена — от 1 до 1 000 000 $, год — от 1980 до следующего." };
  }

  if (status === 429) {
    return { text: "Слишком много вопросов подряд. Подождите минуту и продолжите." };
  }

  if (status === 502 || status === 503) {
    if (has("invoice", "payment", "bot token")) {
      return { text: "Платежи временно недоступны. Мы уже знаем и чиним — попробуйте через пару минут." };
    }
    return {
      text: "AI-агент отдыхает. Попробуйте через минуту — или настройте уведомления вручную.",
      action: { label: "Настроить уведомления вручную →", to: "/filters" },
    };
  }

  if (isNetwork(e)) {
    return { text: "Нет соединения. Проверьте интернет и повторите." };
  }

  return {
    text: "Что-то пошло не так. Попробуйте ещё раз — если не поможет, напишите в поддержку.",
  };
}

/** Короткая форма: только текст без CTA. */
export function apiErrorText(e: unknown): string {
  return apiErrorView(e).text;
}

/** Тексты inline-валидации формы сигналов (03 §3.2, разделы 422). */
export const VALIDATION_TEXTS = {
  priceRange: "«Цена от» больше «цены до». Поменяйте границы местами или очистите одно из полей.",
  yearRange: "«Год от» больше «года до». Проверьте диапазон — например, 2019–2024.",
  yearBounds: "Проверьте год: от 1980 до следующего.",
  mileage: "Укажите пробег, например 10 000–100 000 км.",
  emptyForm: "Заполните хотя бы один параметр поиска",
} as const;
