/**
 * Калькулятор доставки от страны отправки → РФ/РБ («под ключ»): авто + море +
 * брокер + СБКТС/ЭПТС + пошлина + сбор + утильсбор. Префилл из query
 * (?price=&cc=&year=&cur=&country=). Юрисдикция следует за валютой
 * объявления: BYN → РБ, RUB → РФ (можно переключить).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { api } from "../api/client";
import { haptic } from "../api/auth";
import { type Region, getRegion, setRegion } from "../lib/fx";
import { COUNTRY_BY_CODE, FEED_COUNTRIES, countryFlag, countryName } from "../lib/geo";
import { BackButton } from "../ui/BackButton";
import { SkeletonCard } from "../ui/Skeleton";
import { apiErrorText } from "./apiErrorText";

interface CalcComponent {
  label: string;
  usd: number;
  rub: number;
  local: number;
}

/** Кнопка перехода к сравнению (bot → webapp идея: продолжай в удобном UI). */
function CompareBtn({ price, cc, hp, year }: { price: string; cc: string; hp: string; year: string }) {
  const navigate = useNavigate();
  const ready = Boolean(price && year);
  return (
    <button
      type="button"
      className="chip calc-compare-btn"
      disabled={!ready}
      onClick={() => {
        haptic("light");
        navigate("/compare", { state: { seed: { price, cc, hp, year } } });
      }}
    >
      ⚖️ Сравнить с другим вариантом
    </button>
  );
}

interface LegalRef {
  label: string;
  ref: string;
}

interface CalcOut {
  price_usd: number;
  engine_cc: number;
  year: number;
  age_years: number;
  age_group: string;
  region: string;
  currency: string;
  power_hp?: number | null;
  util_category?: string;
  util_note?: string;
  components: CalcComponent[];
  legal_refs?: LegalRef[];
  total_rub: number;
  total_usd: number;
  total_local: number;
  /** Гео маршрута (GEO-V1 §2): страна отправки (эхо DeliveryIn.country),
   *  маршрут «Пусан → Владивосток» и окно сроков фрейта, дни. */
  country?: string;
  route?: string;
  freight_days_min?: number | null;
  freight_days_max?: number | null;
}

/** Регион из query ?cur= (валюта объявления) или сохранённый выбор пользователя. */
function regionFromParams(params: URLSearchParams): Region {
  const cur = (params.get("cur") ?? "").toUpperCase();
  if (cur === "BYN") return "by";
  if (cur === "RUB") return "ru";
  return getRegion();
}

/** Страна отправки из query ?country= (GEO-V1 §3, deep-link из PDP):
 *  ISO2-код из справочника (регистр не важен); нет/неизвестна → null. */
function countryParam(params: URLSearchParams): string | null {
  const co = (params.get("country") ?? "").trim().toUpperCase();
  return COUNTRY_BY_CODE[co] ? co : null;
}

export function CalcScreen() {
  const [params] = useSearchParams();
  const [region, setRegionState] = useState<Region>(() => regionFromParams(params));
  /** Страна отправки (GEO-V1 §2): DeliveryIn.country; дефолт KR — как
   *  раньше считали «Корея → Владивосток»; deep-link из PDP (?country=)
   *  подставляет страну лота (UX-003). Ставки логистики по странам
   *  выбирает бэк, фронт только шлёт код и показывает маршрут. */
  const [country, setCountryState] = useState(() => countryParam(params) ?? "KR");
  const [price, setPrice] = useState(params.get("price") ?? "");
  const [cc, setCc] = useState(params.get("cc") ?? "2000");
  const [hp, setHp] = useState(params.get("hp") ?? "");
  const [year, setYear] = useState(params.get("year") ?? String(new Date().getFullYear() - 3));
  const [result, setResult] = useState<CalcOut | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const calc = useCallback(
    async (p: string, c: string, h: string, y: string, r: Region, co: string) => {
      const priceNum = parseFloat(p.replace(/\s/g, ""));
      const ccNum = parseInt(c, 10);
      const hpNum = parseInt(h, 10);
      const yearNum = parseInt(y, 10);
      if (!priceNum || priceNum <= 0 || !yearNum || yearNum < 1980 || yearNum > new Date().getFullYear() + 1) {
        // Текст валидации — 03-content-a11y.md §2.10
        setError("Проверьте цену и год: цена — больше 0, год — от 1980 до следующего.");
        return;
      }
      setLoading(true);
      setError(null);
      haptic("light");
      try {
        const out = await api<CalcOut>("/calc/delivery", {
          method: "POST",
          body: JSON.stringify({
            price_usd: priceNum,
            engine_cc: ccNum || 2000,
            power_hp: hpNum || undefined,
            year: yearNum,
            region: r,
            country: co,
          }),
        });
        setResult(out);
        haptic("medium");
      } catch (e) {
        // Ошибки API — по маппингу 03 §3.2 (сырой detail не показываем)
        setError(apiErrorText(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Префилл из deep-link (кнопка «Доставка и растаможка» в PDP). Экран живёт
  // в keep-alive и не размонтируется между заходами: применяем параметры при
  // каждом РЕАЛЬНОМ изменении адреса (сравниваем строку search) — второй лот
  // из карточки считается с новой ценой. Смена страны/региона ВНУТРИ экрана
  // адрес не меняет: протухшие ?price=/?year= не перечитываются и не
  // откатывают ручной ввод вторым параллельным расчётом (BF-06).
  const appliedSearchRef = useRef<string | null>(null);
  const countryRef = useRef(country);
  countryRef.current = country;
  useEffect(() => {
    const key = params.toString();
    if (appliedSearchRef.current === key) return;
    appliedSearchRef.current = key;
    // страна лота (?country=, UX-003): выбирается чипсом даже без ?price=
    const coParam = countryParam(params);
    if (coParam) setCountryState(coParam);
    const priceParam = params.get("price");
    if (!priceParam) return;
    const ccParam = params.get("cc") ?? "2000";
    const hpParam = params.get("hp") ?? "";
    const yearParam = params.get("year") ?? String(new Date().getFullYear() - 3);
    const r = regionFromParams(params);
    const co = coParam ?? countryRef.current; // без ?country= — текущая страна
    setPrice(priceParam);
    setCc(ccParam);
    setHp(hpParam);
    setYear(yearParam);
    setRegionState(r);
    void calc(priceParam, ccParam, hpParam, yearParam, r, co);
  }, [params, calc]);

  const pickRegion = (r: Region) => {
    haptic("light");
    setRegionState(r);
    setRegion(r); // запоминаем выбор и для ленты/PDP
    if (result && result.region !== r) void calc(price, cc, hp, year, r, country);
  };

  /** Смена страны отправки (GEO-V1 §3): пересчёт, если результат уже есть. */
  const pickCountry = (co: string) => {
    haptic("light");
    setCountryState(co);
    if (result) void calc(price, cc, hp, year, region, co);
  };

  const fmt = (n: number) => n.toLocaleString("ru-RU");
  /** Группировка тысяч при вводе: 18400 → 18 400 */
  const grouped = (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    return digits ? Number(digits).toLocaleString("ru-RU") : "";
  };
  const CC_CHIPS = [1600, 2000, 2500, 3000];

  return (
    <div className="calc">
      <div className="feed-header feed-header--with-back">
        <BackButton />
        <div>
          <div className="feed-header__title">🚚 Доставка «под ключ»</div>
          {/* Маршрут — из ответа DeliveryOut.route (бэк знает порты страны
              отправки); пока расчёта нет — прочерк вместо хардкода портов */}
          <div className="feed-header__counter">
            {`${countryName(country) || "Корея"} → ${result?.route ?? "—"}`}
          </div>
        </div>
      </div>

      <div className="calc-form">
        <div className="chip-row" role="group" aria-label="Юрисдикция расчёта">
          <button
            type="button"
            className={region === "ru" ? "chip chip--active" : "chip"}
            onClick={() => pickRegion("ru")}
          >
            🇷🇺 Расчёт по РФ
          </button>
          <button
            type="button"
            className={region === "by" ? "chip chip--active" : "chip"}
            onClick={() => pickRegion("by")}
          >
            🇧🇾 Расчёт по РБ
          </button>
        </div>
        {/* Страна отправки (GEO-V1 §3): KR/CN/AE/US/KZ, дефолт KR — от неё
            зависят порт загрузки, фрейт и сроки (маршрут под результатом) */}
        <div className="chip-row" role="group" aria-label="Страна отправки">
          {FEED_COUNTRIES.map((c) => (
            <button
              key={c.code}
              type="button"
              className={country === c.code ? "chip chip--active" : "chip"}
              aria-pressed={country === c.code}
              onClick={() => pickCountry(c.code)}
            >
              <span aria-hidden="true">{c.flag}</span> {c.name}
            </button>
          ))}
        </div>
        <label className="calc-field">
          <span>Цена авто, $</span>
          <input
            inputMode="numeric"
            value={grouped(price)}
            onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))}
            placeholder="18 000"
          />
        </label>
        <label className="calc-field">
          <span>Объём двигателя, см³</span>
          <input
            inputMode="numeric"
            value={grouped(cc)}
            onChange={(e) => setCc(e.target.value.replace(/\D/g, ""))}
            placeholder="2 000"
          />
        </label>
        <div className="chip-row">
          {CC_CHIPS.map((v) => (
            <button
              key={v}
              type="button"
              className={cc === String(v) ? "chip chip--active" : "chip"}
              onClick={() => {
                haptic("light");
                setCc(String(v));
              }}
            >
              {v} см³
            </button>
          ))}
        </div>
        <label className="calc-field">
          <span>Мощность, л.с. (опционально)</span>
          <input
            inputMode="numeric"
            value={hp}
            onChange={(e) => setHp(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="150"
          />
        </label>
        <label className="calc-field">
          <span>Год выпуска</span>
          <input
            inputMode="numeric"
            value={year}
            onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="2022"
          />
        </label>
        <button
          className="btn btn--primary btn--block"
          disabled={loading}
          onClick={() => void calc(price, cc, hp, year, region, country)}
        >
          {loading ? "Считаю…" : "Рассчитать"}
        </button>
        <CompareBtn price={price} cc={cc} hp={hp} year={year} />
      </div>

      {error && (
        <div className="calc-error" role="alert">
          {error}
        </div>
      )}

      {loading && !result && (
        <div className="calc-result">
          <SkeletonCard />
        </div>
      )}

      {/* Пустое состояние: подсказка до первого расчёта */}
      {!error && !loading && !result && (
        <div className="calc-empty">
          Заполните цену и год — покажем итог «под ключ»: авто, море, брокер,
          пошлина и утильсбор.
        </div>
      )}

      {result && (
        <div className="calc-result">
          <div className="calc-total">
            <div className="calc-total__label">
              Итого «под ключ»{result.region === "by" ? " (РБ)" : ""}
            </div>
            <div className="calc-total__value">
              {fmt(Math.round(result.total_local))} {result.currency}
            </div>
            <div className="calc-total__sub">≈ {fmt(Math.round(result.total_usd))} $</div>
            <div className="calc-total__badge">
              {result.power_hp ? `${result.power_hp} л.с. · ` : ""}
              {result.year} г. · {result.engine_cc} см³ · {result.age_group}
            </div>
            {/* Маршрут и сроки фрейта (GEO-V1 §2): DeliveryOut.route +
                окно freight_days_min–max от страны отправки */}
            {(result.route ||
              (result.freight_days_min != null && result.freight_days_max != null)) && (
              <div className="calc-total__route">
                {result.country && (
                  <span aria-hidden="true">{countryFlag(result.country)}</span>
                )}{" "}
                {result.route}
                {result.freight_days_min != null && result.freight_days_max != null
                  ? ` · ~${result.freight_days_min}–${result.freight_days_max} дней`
                  : ""}
              </div>
            )}
          </div>

          <div className="calc-rows">
            {result.components.map((c) => (
              <div key={c.label} className="calc-row">
                <span>{c.label}</span>
                <b>
                  {fmt(c.local)} {result.currency}
                  <small>≈ {fmt(Math.round(c.usd))} $</small>
                </b>
              </div>
            ))}
          </div>

          {result.util_note && <div className="calc-warn">⚠️ {result.util_note}</div>}

          <div className="calc-note">
            {result.region === "by"
              ? "Оценка для физлица (личное пользование). Ставки РБ — ориентир: сбор за оформление и утильсбор проверяйте на customs.gov.by или у брокера на дату ввоза."
              : "Оценка для физлица (личное пользование, не более 1 авто в год), курс фиксированный. Льготный утильсбор действует при мощности до 160 л.с. и объёме до 3000 см³ (ставки сверены 16.10.2026)."}
            {" "}Точную смету даст менеджер.
          </div>

          <RegionNote region={result.region === "by" ? "by" : "ru"} />

          {result.legal_refs && result.legal_refs.length > 0 && (
            <div className="calc-legal">
              <div className="calc-legal__title">Основание расчёта</div>
              {result.legal_refs.map((r) => (
                <div key={r.label} className="calc-legal__row">
                  <span className="calc-legal__label">{r.label}</span>
                  <span className="calc-legal__ref">{r.ref}</span>
                </div>
              ))}
            </div>
          )}

          {/* Маршрут из DeliveryOut.route (UX-003): без хардкода портов —
              для ОАЭ бэк отдаёт «Дубай → Новороссийск», для Кореи — Пусан */}
          <div className="calc-note">
            {result.route
              ? result.region === "by"
                ? `🚢 ${result.route}, далее перегон/автовоз до Минска — менеджер подберёт маршрут и сроки.`
                : `🚢 ${result.route}, далее по РФ — менеджер подберёт маршрут и точные сроки.`
              : "🚢 Морской маршрут и перегон — точный путь подберёт менеджер."}
          </div>
        </div>
      )}
    </div>
  );
}

/** Заметка по региону расчёта: платежи ЕАЭС одинаковы, регистрация — разная. */
function RegionNote({ region }: { region: Region }) {
  if (region !== "by") return null;
  return (
    <div className="calc-note">
      🇧🇾 Беларусь: пошлины ЕАЭС едины с РФ, но сбор за оформление, утильсбор,
      СБКТС/ЭПТС и постановка на учёт в ГАИ — по законодательству РБ. Юрисдикция
      выбрана по валюте объявления; переключатель выше меняет расчёт.
    </div>
  );
}
