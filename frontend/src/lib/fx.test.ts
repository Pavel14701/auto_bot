/** Юнит-тесты чистых хелперов миниаппа (vitest, node — без React). */
import { describe, expect, it } from "vitest";

import {
  EUR_PER_USD,
  KRW_PER_USD,
  digits,
  formatOriginal,
  parseQueryVariants,
  toUsd,
} from "./fx";

describe("toUsd", () => {
  it("KRW делит на 1350 и округляет", () => {
    expect(toUsd(18_400_000, "KRW")).toBe(Math.round(18_400_000 / KRW_PER_USD));
    expect(toUsd(1_000_000, "krw")).toBe(741); // регистр не важен
  });

  it("EUR умножает на 1.08", () => {
    expect(toUsd(10_000, "EUR")).toBe(Math.round(10_000 * EUR_PER_USD));
    // GEO-V1: валюты новых источников (KZT/CNY/AED)
    expect(toUsd(12_200_000, "KZT")).toBe(Math.round(12_200_000 / 480));
    expect(toUsd(238_000, "CNY")).toBe(Math.round(238_000 / 7.1));
    expect(toUsd(125_000, "AED")).toBe(Math.round(125_000 / 3.6725));
    expect(toUsd(10_000, "eur")).toBe(10_800);
  });

  it("USD проходит как есть (округление)", () => {
    expect(toUsd(18_000, "USD")).toBe(18_000);
    expect(toUsd(18000.4)).toBe(18_000); // валюта не указана → USD
  });

  it("RUB ÷92, BYN ÷3.05 (фикс-курсы MVP, регистр не важен)", () => {
    expect(toUsd(9_200, "RUB")).toBe(100);
    expect(toUsd(9200, "rub")).toBe(100);
    expect(toUsd(3_050, "BYN")).toBe(1_000);
    expect(toUsd(3050, "byn")).toBe(1_000);
  });

  it("мусор → null", () => {
    expect(toUsd(null)).toBeNull();
    expect(toUsd(0)).toBeNull();
    expect(toUsd(-5)).toBeNull();
    expect(toUsd(undefined, "KRW")).toBeNull();
  });

  it("BF-14: положительная цена — минимум $1 (null только для нуля/пустых)", () => {
    expect(toUsd(100, "KZT")).toBe(1); // 100/480 → 0.2 → не $0, а $1
    expect(toUsd(479, "KZT")).toBe(1);
    expect(toUsd(1, "KRW")).toBe(1);
    expect(toUsd(0.4)).toBe(1); // USD-дробные тоже не схлопываются в $0
    expect(toUsd(0, "KZT")).toBeNull();
    expect(toUsd(480, "KZT")).toBe(1);
    expect(toUsd(481, "KZT")).toBe(1); // 1.002 → 1
    expect(toUsd(960, "KZT")).toBe(2);
  });
});

describe("formatOriginal (символы валют, BF-14)", () => {
  /** Число → строка с разделителями как в formatOriginal (ru-RU, NBSP). */
  const n = (v: number) => v.toLocaleString("ru-RU");

  it("ISO-коды источников → символы: ₩ ₸ ¥ (AED — кодом, дирхам ломает шрифты)", () => {
    expect(formatOriginal(24_300_000, "KRW")).toBe(`${n(24_300_000)} ₩`);
    expect(formatOriginal(12_200_000, "KZT")).toBe(`${n(12_200_000)} ₸`);
    expect(formatOriginal(238_000, "CNY")).toBe(`${n(238_000)} ¥`);
    expect(formatOriginal(125_000, "AED")).toBe(`${n(125_000)} AED`);
    expect(formatOriginal(125_000, "aed")).toBe(`${n(125_000)} AED`); // регистр
  });

  it("локальные валюты: ₽ и Br", () => {
    expect(formatOriginal(1_656_000, "RUB")).toBe(`${n(1_656_000)} ₽`);
    expect(formatOriginal(54_900, "BYN")).toBe(`${n(54_900)} Br`);
    expect(formatOriginal(18_000, "USD")).toBe(`${n(18_000)} $`);
    expect(formatOriginal(10_000, "EUR")).toBe(`${n(10_000)} €`);
  });

  it("неизвестный код — как есть; без валюты — просто число", () => {
    expect(formatOriginal(999, "GBP")).toBe(`${n(999)} GBP`);
    expect(formatOriginal(999)).toBe(n(999));
    expect(formatOriginal(999, null)).toBe(n(999));
  });
});

describe("digits", () => {
  it("оставляет только цифры", () => {
    expect(digits("18 000")).toBe("18000");
    expect(digits("abc12x34")).toBe("1234");
    expect(digits("")).toBe("");
  });
});

describe("parseQueryVariants", () => {
  it("парсит deep-link ?v=...", () => {
    expect(parseQueryVariants("18000x2000x2022,15000x1600x2021")).toEqual([
      { price: "18000", cc: "2000", year: "2022" },
      { price: "15000", cc: "1600", year: "2021" },
    ]);
  });

  it("подставляет cc=2000 по умолчанию", () => {
    expect(parseQueryVariants("18000x2022")).toEqual([
      { price: "18000", cc: "2000", year: "2022" },
    ]);
  });

  it("null/мусор → пустой список", () => {
    expect(parseQueryVariants(null)).toEqual([]);
    expect(parseQueryVariants("abc,def")).toEqual([]);
  });

  it("пропускает только битые куски, годные оставляет", () => {
    expect(parseQueryVariants("xx,18000x2000x2022")).toEqual([
      { price: "18000", cc: "2000", year: "2022" },
    ]);
  });
});
