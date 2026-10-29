/** Юнит-тесты маппинга API-ошибок (03-content-a11y.md §3.2). */

import { describe, expect, it } from "vitest";

import { apiErrorText, apiErrorView } from "./apiErrorText";

/** Локальный ApiError-двойник (импортить реальный не нужно — хелпер
 *  смотрит только на поля status/message). */
const err = (status: number | undefined, message: string) =>
  Object.assign(new Error(message), { status });

describe("apiErrorView: маппинг по префиксу detail и статусу", () => {
  it("403 quota_exceeded → апселл «Безлимит в Pro» → /profile", () => {
    const v = apiErrorView(err(403, "quota_exceeded: Free 1 в неделю"));
    expect(v.text).toContain("Бесплатный разбор этой недели уже использован");
    expect(v.action?.label).toBe("⚡ Безлимит в Pro");
    expect(v.action?.to).toBe("/profile");
  });

  it("403 Filter limit reached → лимит Free-3 + «Смотреть тарифы»", () => {
    const v = apiErrorView(err(403, "Filter limit reached (3 on free tier)"));
    expect(v.text).toContain("Лимит уведомлений Free — 3");
    expect(v.action?.label).toBe("Смотреть тарифы");
  });

  it("422 price_min → человеческий текст про границы цены", () => {
    expect(apiErrorText(err(422, "price_min > price_max"))).toBe(
      "«Цена от» больше «цены до». Поменяйте границы местами или очистите одно из полей.",
    );
  });

  it("503 AI → «AI-агент отдыхает» + фолбэк к сигналам", () => {
    const v = apiErrorView(err(503, "AI temporarily unavailable"));
    expect(v.text).toContain("AI-агент отдыхает");
    expect(v.action?.to).toBe("/filters");
  });

  it("503 оплата → «Платежи временно недоступны»", () => {
    expect(apiErrorText(err(503, "Telegram invoice creation failed"))).toContain(
      "Платежи временно недоступны",
    );
  });

  it("429 → подождать минуту", () => {
    expect(apiErrorText(err(429, "rate limit"))).toContain("Слишком много вопросов подряд");
  });

  it("сеть (TypeError без статуса) → «Нет соединения»", () => {
    expect(apiErrorText(new TypeError("Failed to fetch"))).toContain("Нет соединения");
  });

  it("неизвестный detail → «Что-то пошло не так»", () => {
    expect(apiErrorText(err(500, "weird internal stuff"))).toContain("Что-то пошло не так");
    // сырой detail наружу не отдаём
    expect(apiErrorText(err(500, "weird internal stuff"))).not.toContain("weird");
  });
});

describe("apiErrorView: чаты/платежи/логин (UX-005/006 — недостающие detail-коды)", () => {
  it("401 Invalid credentials → «Неверный email или пароль» (Login)", () => {
    expect(apiErrorText(err(401, "Invalid credentials"))).toContain("Неверный email или пароль");
  });

  it("409 Email already registered → «уже зарегистрирован — попробуйте войти»", () => {
    expect(apiErrorText(err(409, "Email already registered"))).toContain(
      "уже зарегистрирован",
    );
  });

  it("403 chats_registration_required → чаты после входа", () => {
    expect(apiErrorText(err(403, "chats_registration_required: чаты доступны после входа"))).toBe(
      "Чаты доступны после входа или регистрации.",
    );
  });

  it("403 thread_archived → комната архивирована", () => {
    expect(apiErrorText(err(403, "thread_archived: тред архивирован, отправка недоступна"))).toBe(
      "Комната архивирована — отправка сообщений недоступна.",
    );
  });

  it("404 invite_not_found → код приглашения истёк", () => {
    expect(apiErrorText(err(404, "invite_not_found: код истёк или не существует"))).toContain(
      "Код приглашения истёк",
    );
  });

  it("409-коды переговорных: group_is_full / owner_must_archive", () => {
    expect(apiErrorText(err(409, "group_is_full: в переговорной уже 5 участников"))).toContain(
      "Переговорная заполнена",
    );
    expect(
      apiErrorText(err(409, "owner_must_archive: владелец уходит последним")),
    ).toContain("Сначала архивируйте комнату");
  });

  it("строка-сообщение (room.error из стора) тоже маппится без сырого текста", () => {
    const text = apiErrorText("network down");
    expect(text).toContain("Что-то пошло не так");
    expect(text).not.toContain("network down");
    expect(apiErrorText("Failed to fetch")).toContain("Нет соединения");
  });
});
