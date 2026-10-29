/** Тесты кнопки «назад» на не-табовых экранах (калькулятор, сравнение). */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CalcScreen } from "./Calc";
import { CompareScreen } from "./Compare";
import { api } from "../api/client";

vi.mock("../api/client", () => ({ api: vi.fn(async () => ({ components: [] })) }));
vi.mock("../api/auth", () => ({ haptic: vi.fn() }));

/** Показывает текущий pathname — чтобы проверить navigate(-1). */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

const renderWithHistory = (ui: React.ReactNode) =>
  render(
    <MemoryRouter initialEntries={["/", "/calc"]} initialIndex={1}>
      <LocationProbe />
      {ui}
    </MemoryRouter>,
  );

afterEach(() => cleanup());

describe("BackButton на экранах расчётов", () => {
  it("Calc: кнопка «назад» есть и возвращает на предыдущий экран", () => {
    renderWithHistory(<CalcScreen />);
    const btn = document.querySelector(".screen-back");
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-label")).toBe("Назад");
    expect(screen.getByTestId("loc").textContent).toBe("/calc");
    fireEvent.click(btn!);
    expect(screen.getByTestId("loc").textContent).toBe("/");
  });

  it("Compare: кнопка «назад» есть и возвращает на предыдущий экран", () => {
    renderWithHistory(<CompareScreen />);
    const btn = document.querySelector(".screen-back");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(screen.getByTestId("loc").textContent).toBe("/");
  });
});

const apiMock = vi.mocked(api);

/** Полный мок-ответ бэка (region/currency/local — поля юрисдикции;
 *  country/route/freight_days_* — гео-контракт GEO-V1 §2). */
const byResult = {
  price_usd: 18000,
  engine_cc: 2000,
  year: 2022,
  age_years: 4,
  age_group: "3–5 лет",
  region: "by",
  currency: "Br",
  country: "KR",
  route: "Пусан → Владивосток",
  freight_days_min: 14,
  freight_days_max: 21,
  power_hp: null,
  util_category: "льготный",
  util_note: "",
  components: [{ label: "Авто по счёту", usd: 18000, rub: 54900, local: 54900 }],
  legal_refs: [{ label: "Пошлины", ref: "Решение Совета ЕЭК № 54" }],
  total_rub: 54900,
  total_usd: 18000,
  total_local: 54900,
};

describe("Calc: страна отправки (GEO-V1 §2–§3)", () => {
  const deliveryCalls = () => apiMock.mock.calls.filter(([p]) => p === "/calc/delivery");
  const lastBody = () =>
    JSON.parse(String(deliveryCalls()[deliveryCalls().length - 1]![1]!.body));

  const renderCalc = () =>
    render(
      <MemoryRouter initialEntries={["/calc"]} initialIndex={0}>
        <CalcScreen />
      </MemoryRouter>,
    );

  it("дефолт KR уходит в POST /calc/delivery без касания сегмента", async () => {
    apiMock.mockResolvedValueOnce(byResult);
    renderCalc();
    fireEvent.change(screen.getByPlaceholderText("18 000"), { target: { value: "18000" } });
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать" }));
    await screen.findByText(/Итого «под ключ»/);
    expect(lastBody().country).toBe("KR");
  });

  it("сегмент страны: выбор ОАЭ шлёт country=AE в расчёт", async () => {
    apiMock.mockResolvedValue(byResult);
    renderCalc();
    fireEvent.click(screen.getByRole("button", { name: "ОАЭ" }));
    fireEvent.change(screen.getByPlaceholderText("18 000"), { target: { value: "18000" } });
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать" }));
    await screen.findByText(/Итого «под ключ»/);
    expect(lastBody().country).toBe("AE");
  });

  it("маршрут и окно фрейта из DeliveryOut — под итогом расчёта", async () => {
    apiMock.mockResolvedValueOnce({
      ...byResult,
      region: "ru",
      currency: "₽",
      country: "AE",
      route: "Джебель-Али → Новороссийск",
      freight_days_min: 25,
      freight_days_max: 40,
    });
    renderCalc();
    fireEvent.click(screen.getByRole("button", { name: "ОАЭ" }));
    fireEvent.change(screen.getByPlaceholderText("18 000"), { target: { value: "18000" } });
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать" }));
    // маршрут есть и в заголовке-счётчике — подпись ищем в .calc-total__route
    await waitFor(() => {
      const note = document.querySelector(".calc-total__route");
      expect(note?.textContent ?? "").toContain("Джебель-Али → Новороссийск");
    });
    const route = document.querySelector(".calc-total__route");
    expect(route?.textContent).toContain("~25–40 дней");
  });
});

describe("Calc: юрисдикция расчёта по валюте (BYN → РБ)", () => {
  it("переключатель «Расчёт по РБ» отправляет region=by и показывает Br", async () => {
    apiMock.mockResolvedValueOnce(byResult);
    render(
      <MemoryRouter initialEntries={["/calc"]} initialIndex={0}>
        <CalcScreen />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "🇧🇾 Расчёт по РБ" }));
    fireEvent.change(screen.getByPlaceholderText("18 000"), { target: { value: "18000" } });
    fireEvent.click(screen.getByRole("button", { name: "Рассчитать" }));
    await screen.findByText(/Итого «под ключ» \(РБ\)/);
    const call = apiMock.mock.calls.at(-1)!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.region).toBe("by");
    // итог и строка компонента — в BYN
    expect(screen.getAllByText(/54 900/).length).toBeGreaterThanOrEqual(2);
    const total = document.querySelector(".calc-total__value");
    // toLocaleString("ru-RU") даёт NBSP-разделитель тысяч
    expect(total?.textContent?.replace(/\u00A0/g, " ")).toBe("54 900 Br");
  });

  it("deep-link ?cur=BYN сразу считает по РБ", async () => {
    apiMock.mockResolvedValueOnce(byResult);
    render(
      <MemoryRouter initialEntries={["/calc?price=18000&year=2022&cur=BYN"]} initialIndex={0}>
        <CalcScreen />
      </MemoryRouter>,
    );
    await screen.findByText(/Итого «под ключ» \(РБ\)/);
    // вызовы накапливаются между тестами файла — берём последний расчёт
    const calls = apiMock.mock.calls.filter(([p]) => p === "/calc/delivery");
    const body = JSON.parse(String((calls[calls.length - 1]![1] as RequestInit).body));
    expect(body.region).toBe("by");
  });

  it("keep-alive: повторный заход с новым ?price= пересчитывает (префилл не застревает)", async () => {
    apiMock.mockResolvedValue(byResult);
    // Калькулятор в keep-alive: второй переход из PDP с другой ценой
    // должен обновить поля и пересчитать, а не показать старый результат.
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate("/calc?price=22000&year=2021&cur=BYN")}>
            из PDP
          </button>
          <CalcScreen />
        </>
      );
    }
    render(
      <MemoryRouter initialEntries={["/calc"]} initialIndex={0}>
        <Harness />
      </MemoryRouter>,
    );
    // форма уже смонтирована, автозапуска без ?price= нет
    expect(screen.getByRole("button", { name: "Рассчитать" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "из PDP" }));
    await waitFor(() => {
      // последний вызов расчёта (mock-вызовы накапливаются между тестами файла)
      const calls = apiMock.mock.calls.filter(([p]) => p === "/calc/delivery");
      const call = calls[calls.length - 1];
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.price_usd).toBe(22000);
      expect(body.year).toBe(2021);
      expect(body.region).toBe("by");
    });
  });
});

// ---------- BF-06: префилл deep-link не гонится с ручным вводом ----------

describe("Calc: смена страны не откатывает ввод к ?price= (BF-06)", () => {
  const deliveryCalls = () => apiMock.mock.calls.filter(([p]) => p === "/calc/delivery");
  const lastBody = () =>
    JSON.parse(String(deliveryCalls()[deliveryCalls().length - 1]![1]!.body));

  const renderCalc = (initial: string) =>
    render(
      <MemoryRouter initialEntries={[initial]} initialIndex={0}>
        <CalcScreen />
      </MemoryRouter>,
    );

  it("до расчёта заголовок маршрута — прочерк (route придёт с ответом)", () => {
    renderCalc("/calc");
    expect(document.querySelector(".feed-header__counter")?.textContent).toBe(
      "Корея → —",
    );
  });

  it("ручная цена + тап страны: поле не сбрасывается к ?price=, расчёт один и от новой цены", async () => {
    apiMock.mockResolvedValue({ ...byResult, region: "ru", currency: "₽", country: "CN" });
    renderCalc("/calc?price=18000&year=2022");
    await screen.findByText(/Итого «под ключ»/);
    // юзер поменял цену руками
    fireEvent.change(screen.getByPlaceholderText("18 000"), { target: { value: "25000" } });
    const postsBefore = deliveryCalls().length;
    fireEvent.click(screen.getByRole("button", { name: "Китай" }));
    await waitFor(() => expect(lastBody().country).toBe("CN"));
    // последний расчёт — от введённой цены, не от протухшего ?price=18000
    expect(lastBody().price_usd).toBe(25000);
    // поле ввода не откатилось к deep-link-значению
    const input = screen.getByPlaceholderText("18 000") as HTMLInputElement;
    expect(input.value.replace(/\s/g, "")).toBe("25000");
    // смену страны считаем один раз: дубля от префилл-эффекта нет (BF-06)
    expect(deliveryCalls().length).toBe(postsBefore + 1);
  });

  it("?country=AE из PDP предвыбирает ОАЭ и уходит в расчёт страной лота (UX-003)", async () => {
    apiMock.mockResolvedValueOnce({
      ...byResult,
      region: "ru",
      currency: "₽",
      country: "AE",
      route: "Джебель-Али → Новороссийск",
      freight_days_min: 25,
      freight_days_max: 40,
    });
    renderCalc("/calc?price=18000&year=2022&country=ae");
    await screen.findByText(/Итого «под ключ»/);
    expect(lastBody().country).toBe("AE");
    // чипс ОАЭ активен, KR — нет
    expect(screen.getByRole("button", { name: "ОАЭ" }).className).toContain("chip--active");
    expect(screen.getByRole("button", { name: /Корея/ }).className).not.toContain("chip--active");
    // заголовок маршрута строится от ответа бэка, без хардкода Владивостока
    expect(document.querySelector(".feed-header__counter")?.textContent).toContain(
      "Джебель-Али → Новороссийск",
    );
  });
});
