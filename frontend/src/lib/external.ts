/**
 * Открыть внешнюю ссылку из миниаппа: в Telegram только WebApp.openLink()
 * проходит через WebView-мост; target="_blank" и window.open там молча
 * не работают. В обычном браузере — обычный window.open.
 */
import { getWebApp } from "../api/auth";

export function openExternal(url: string): void {
  // EXT-01 (аудит 2026-10-29): URL приходит из данных бэка — пропускаем
  // только http(s), иначе javascript:/data: могли бы уйти в WebView.
  if (!/^https?:\/\//i.test(url)) return;
  const wa = getWebApp();
  if (wa?.openLink) {
    wa.openLink(url, { try_instant_view: false });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Подсказка о гео-блокировке источников (encar/kcar недоступны из РФ;
 * парсер ходит через прокси, пользователь — нет). Показывать тостом сразу
 * после клика «Открыть у источника»: WebView не даёт колбека об ошибке.
 */
export const SOURCE_BLOCKED_TOAST =
  "Если страница не открывается — источник заблокирован в вашем регионе. Попробуйте VPN";

/** Строка-подсказка под кнопкой «Открыть у источника» (desktop-блок CTA). */
export const SOURCE_BLOCKED_HINT =
  "Источник может быть недоступен в РФ — все фото и данные уже здесь";

/** Что нужно для карточки «Поделиться»: ключи лота + подпись с ценой. */
export interface ShareListingCardInput {
  id: number;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  price?: number | null;
  currency?: string | null;
}

/** Текст карточки: `${make} ${model}, ${year} — ${цена}`; пустые поля не рендерим. */
function cardText(l: ShareListingCardInput): string {
  const name = `${l.make ?? ""} ${l.model ?? ""}`.trim();
  let text = name;
  if (l.year != null) text = text ? `${text}, ${l.year}` : String(l.year);
  if (l.price != null) {
    const cur = (l.currency ?? "").trim();
    const money = l.price.toLocaleString("ru") + (cur ? ` ${cur}` : "");
    text = text ? `${text} — ${money}` : money;
  }
  return text || "Объявление";
}

/**
 * Ссылка для шаринга: deep-link бота (открывает миниапп сразу на карточке,
 * формат как в App.tsx: listing_<id>) — но username бота в WebApp обычно
 * недоступен (initDataUnsafe.bot есть не во всех клиентах), поэтому фолбэк —
 * прямой URL вебаппа `${location.origin}/listing/${id}`.
 */
function cardUrl(l: ShareListingCardInput): string {
  const wa = getWebApp();
  // В типе TelegramWebApp (api/auth.ts) поля bot нет — читаем оборонительно
  const bot = (
    wa?.initDataUnsafe as { bot?: { username?: string } } | undefined
  )?.bot?.username;
  if (bot) return `https://t.me/${bot}?startapp=listing_${l.id}`;
  return `${location.origin}/listing/${l.id}`;
}

/**
 * «Поделиться» лотом: у бота НЕ включён inline mode (switchInlineQuery всегда
 * молчит), поэтому уходим в нативный диалог Telegram через t.me/share/url —
 * он открывается WebApp.openTelegramLink с готовым текстом карточки и ссылкой.
 * В браузере: navigator.share (системная шторка), фолбэк — копирование
 * ссылки в буфер; в фолбэке возвращаем false, чтобы вызывающий показал тост
 * «Ссылка скопирована».
 */
export async function shareListingCard(
  listing: ShareListingCardInput,
): Promise<boolean> {
  const text = cardText(listing);
  const url = cardUrl(listing);

  // Telegram: нативный диалог «поделиться в Telegram» с готовым текстом.
  // openTelegramLink нет в типе api/auth.ts — дергаем оборонительно.
  const wa = getWebApp();
  const openTelegramLink = (wa as { openTelegramLink?: (u: string) => void } | null)
    ?.openTelegramLink;
  if (openTelegramLink) {
    openTelegramLink(
      `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
    );
    return true;
  }

  // Браузер: системная шторка Web Share API.
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: text, text, url });
      return true;
    } catch (e) {
      // Пользователь закрыл шторку (AbortError) — ничего не произошло,
      // не врём тостом «скопировано».
      if ((e as { name?: string } | null)?.name === "AbortError") return true;
    }
  }

  // Фолбэк: копируем карточку в буфер обмена; true не возвращаем —
  // вызывающий покажет «Ссылка скопирована».
  try {
    await navigator.clipboard?.writeText(`${text}\n${url}`);
  } catch {
    // буфер недоступен — всё равно отдаём false (тост-фолбэк у вызывающего)
  }
  return false;
}
