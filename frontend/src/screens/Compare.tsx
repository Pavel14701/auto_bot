/**
 * Сравнение вариантов «под ключ» (MVP): 2–4 варианта, бары, дельта к лучшему.
 * Сид вариантами: location.state.seed {price, cc, year} из калькулятора
 * или query ?v=18000x2000x2022,15000x1600x2021 (deep-link из бота).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { api } from "../api/client";
import { haptic } from "../api/auth";
import { type Region, digits, getRegion, parseQueryVariants, setRegion, type Variant } from "../lib/fx";
import { BackButton } from "../ui/BackButton";
import { apiErrorText } from "./apiErrorText";

interface CompareItem {
  title: string;
  price_usd: number;
  total_usd: number;
  total_rub: number;
  total_local: number;
  currency: string;
  age_group: string;
}

const fmt = (n: number) => Math.round(n).toLocaleString("ru-RU");

export function CompareScreen() {
  const location = useLocation();
  const [params] = useSearchParams();
  const seed = (location.state as { seed?: Variant } | null)?.seed;
  const fromQuery = parseQueryVariants(params.get("v"));

  const [variants, setVariants] = useState<Variant[]>(
    fromQuery.length
      ? fromQuery
      : seed
        ? [seed, { price: "", cc: "2000", year: "" }]
        : [
            { price: "", cc: "2000", year: "" },
            { price: "", cc: "2000", year: "" },
          ],
  );
  const [items, setItems] = useState<CompareItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Юрисдикция сравнения (как в Calc): BYN-объявления → РБ, по умолчанию — регион юзера
  const [region, setRegionLocal] = useState<Region>(() => getRegion());

  const update = (i: number, field: keyof Variant, value: string) => {
    setVariants((prev) =>
      prev.map((v, idx) => (idx === i ? { ...v, [field]: digits(value) } : v)),
    );
  };

  const compare = useCallback(async (vs: Variant[], r: Region) => {
    const payload = vs
      .filter((v) => digits(v.price) && digits(v.year))
      .map((v, i) => ({
        price_usd: Number(digits(v.price)),
        engine_cc: Number(digits(v.cc)) || 2000,
        year: Number(digits(v.year)),
        title: `Вариант ${i + 1}`,
        region: r,
      }));
    if (payload.length < 2) {
      setError("Заполните минимум два варианта (цена и год)");
      return;
    }
    setLoading(true);
    setError(null);
    haptic("light");
    try {
      const out = await api<{ items: CompareItem[] }>("/calc/compare", {
        method: "POST",
        body: JSON.stringify({ items: payload }),
      });
      setItems(out.items);
      haptic("medium");
    } catch (e) {
      // Ошибки API — по маппингу 03 §3.2 (сырой detail не показываем)
      setError(apiErrorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Автосравнение при входе с сид-данными (из калькулятора или deep-link).
  // Экран в keep-alive: применяем сид при каждом его изменении, а не только
  // при первом монтировании — повторное «Сравнить» из калькулятора с новыми
  // цифрами не должно показывать прошлогодний результат.
  const appliedSeed = useRef("");
  useEffect(() => {
    const key = `${location.search}|${JSON.stringify(location.state ?? null)}`;
    if (key === appliedSeed.current) return;
    appliedSeed.current = key;
    const seeded = fromQuery.length ? fromQuery : seed ? [seed] : [];
    if (!seeded.length) return;
    if (fromQuery.length) {
      setVariants(fromQuery);
    } else if (seed) {
      setVariants([seed, { price: "", cc: "2000", year: "" }]);
    }
    const ready = seeded.filter((v) => digits(v.price) && digits(v.year));
    if (ready.length) void compare(ready, region);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, location.state]);

  const pickRegion = (r: Region) => {
    haptic("light");
    setRegionLocal(r);
    setRegion(r); // синхронизируем с Calc/лентой
    if (items) void compare(variants, r);
  };

  const maxTotal = items ? Math.max(...items.map((i) => i.total_usd)) : 1;

  return (
    <div className="calc">
      <div className="feed-header feed-header--with-back">
        <BackButton />
        <div>
          <div className="feed-header__title">⚖️ Сравнение «под ключ»</div>
          <div className="feed-header__counter">
            Пошлина зависит от возраста и объёма — итог может удивить
          </div>
        </div>
      </div>

      <div className="calc-form">
        <div className="chip-row" role="group" aria-label="Юрисдикция сравнения">
          <button
            type="button"
            aria-pressed={region === "ru"}
            className={region === "ru" ? "chip chip--active" : "chip"}
            onClick={() => pickRegion("ru")}
          >
            🇷🇺 РФ
          </button>
          <button
            type="button"
            aria-pressed={region === "by"}
            className={region === "by" ? "chip chip--active" : "chip"}
            onClick={() => pickRegion("by")}
          >
            🇧🇾 Беларусь
          </button>
        </div>
        {variants.map((v, i) => (
          <div key={i} className="compare-variant">
            <div className="compare-variant__label">Вариант {i + 1}</div>
            <div className="compare-variant__fields">
              <label className="calc-field">
                <span>Цена, $</span>
                <input
                  inputMode="numeric"
                  value={v.price ? Number(v.price).toLocaleString("ru-RU") : ""}
                  onChange={(e) => update(i, "price", e.target.value)}
                  placeholder="18 000"
                />
              </label>
              <label className="calc-field">
                <span>Объём, см³</span>
                <input
                  inputMode="numeric"
                  value={v.cc ? Number(v.cc).toLocaleString("ru-RU") : ""}
                  onChange={(e) => update(i, "cc", e.target.value)}
                  placeholder="2 000"
                />
              </label>
              <label className="calc-field">
                <span>Год</span>
                <input
                  inputMode="numeric"
                  value={v.year}
                  onChange={(e) => update(i, "year", e.target.value)}
                  placeholder="2022"
                />
              </label>
            </div>
            {variants.length > 2 && (
              <button
                type="button"
                className="compare-remove"
                onClick={() => {
                  haptic("light");
                  setVariants((prev) => prev.filter((_, idx) => idx !== i));
                }}
              >
                ✕ убрать
              </button>
            )}
          </div>
        ))}

        <div className="chip-row">
          {variants.length < 4 && (
            <button
              type="button"
              className="chip"
              onClick={() => {
                haptic("light");
                setVariants((prev) => [...prev, { price: "", cc: "2000", year: "" }]);
              }}
            >
              + вариант
            </button>
          )}
        </div>

        <button
          className="btn btn--primary btn--block"
          disabled={loading}
          onClick={() => void compare(variants, region)}
        >
          {loading ? "Сравниваю…" : "Сравнить"}
        </button>
      </div>

      {error && (
        <div className="calc-error" role="alert">
          {error}
        </div>
      )}

      {/* Пустое состояние: подсказка до первого сравнения */}
      {!error && !loading && !(items && items.length >= 2) && (
        <div className="calc-empty">
          Добавьте минимум два варианта — сравним итог «под ключ» и покажем
          разницу в долларах.
        </div>
      )}

      {items && items.length >= 2 && (
        <div className="calc-result">
          {items.map((it, i) => (
            <div
              key={it.title}
              className={i === 0 ? "compare-item compare-item--best" : "compare-item"}
            >
              <div className="compare-item__head">
                <span>
                  {i === 0 ? "🥇 " : `${i + 1}. `}
                  {it.title}
                  {i === 0 && <span className="compare-badge">лучший итог</span>}
                </span>
                <b>
                  {fmt(it.total_local)} {it.currency}
                  <small> ≈ {fmt(it.total_usd)} $</small>
                </b>
              </div>
              <div className="compare-bar">
                <div
                  className="compare-bar__fill"
                  style={{ width: `${(it.total_usd / maxTotal) * 100}%` }}
                />
              </div>
              <div className="compare-item__sub">
                авто {fmt(it.price_usd)} $ · {it.age_group}
                {i > 0 && (
                  <span className="compare-delta">
                    {" "}(+{fmt(it.total_usd - items[0].total_usd)} $ к лучшему)
                  </span>
                )}
              </div>
            </div>
          ))}
          <div className="calc-note">
            {region === "by"
              ? "🚢 Море Бусан → Владивосток → перегон до Минска: сбор оформления, СБКТС/ЭПТС, пошлина и утильсбор РБ уже в итоге. Ставки РБ — ориентир, проверяйте на customs.gov.by."
              : "🚢 Море Бусан → Владивосток: брокер + СБКТС/ЭПТС + пошлина + утильсбор уже включены в итог."}
          </div>
        </div>
      )}
    </div>
  );
}
