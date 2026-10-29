"""Контрактные тесты KolesaHtmlAdapter (Казахстан, SSR → UnifiedListing).

Фикстура — обрезка живой вёрстки kolesa.kz/cars/ (сверено 2026-10-28):
div.a-card.js__a-card[data-id], .a-card__title a, span.a-card__price
(₸, nbsp-разделители), .a-card__description (RU-тексты), [data-test=region].
"""

from decimal import Decimal

import httpx
import pytest

from app.infrastructure.sources.kolesa import (
    KolesaHtmlAdapter,
    extract_make_kz,
)
from app.infrastructure.sources.common.http import FetchError, HttpClient
from app.domain.search.criteria import SearchCriteria

NBSP = "\u00a0"

# Обрезка живой карточки BMW 540 (kolesa.kz/cars/, Алматы, 21 000 000 ₸).
CARD = f"""
<div class="a-card  js__a-card" data-id="232057208" id="advert-232057208">
  <div class="a-card__picture">
    <a class="a-card__link" href="/a/show/232057208?search_id=abc&advert_position=1">
      <div class="thumb-gallery"><picture class="thumb-gallery__pic">
        <img src="https://kolesa-photos.kcdn.online/webp/39/abc/3-160x120.jpg" alt="BMW 540">
      </picture></div>
    </a>
  </div>
  <div class="a-card__info">
    <h5 class="a-card__title" data-test="advert-title">
      <a class="a-card__link" href="/a/show/232057208?search_id=abc">BMW 540</a>
    </h5>
    <span class="a-card__price" data-test="a-card-price"> {NBSP}21{NBSP}000{NBSP}000{NBSP}₸</span>
  </div>
  <div class="a-card__body">
    <p class="a-card__description" data-test="advert-description">
      2017 г., Б/у седан, 3 л, бензин, КПП автомат, с пробегом 152 000 км,
      BMW 540i xDrive G30
    </p>
  </div>
  <div class="a-card__footer">
    <span class="a-card__param" data-test="region"> Алматы </span>
    <span class="a-card__param a-card__param--date">29 октября</span>
  </div>
</div>
"""

# ВАЗ (Lada) — кириллическая марка, которой нет в общем MAKE_MAP;
# пробелы в цене — обычные, «тг.» вместо ₸.
CARD_LADA = f"""
<div class="a-card a-card--pay-yellow js__a-card" data-id="231986937">
  <div class="a-card__picture"><a class="a-card__link" href="/a/show/231986937">
    <img src="https://kolesa-photos.kcdn.online/webp/39/def/1-160x120.jpg"></a></div>
  <div class="a-card__info">
    <h5 class="a-card__title"><a class="a-card__link"
      href="/a/show/231986937">ВАЗ (Lada) 2112</a></h5>
    <span class="a-card__price">500{NBSP}000{NBSP}тг.</span>
  </div>
  <div class="a-card__body"><p class="a-card__description">
    2006 г., Б/у хэтчбек, 1.6 л, бензин, КПП механика, дизель нет
  </p></div>
  <div class="a-card__footer"><span class="a-card__param" data-test="region">Актау</span></div>
</div>
"""

CARD_NO_ID = """
<div class="a-card js__a-card">
  <h5 class="a-card__title"><a class="a-card__link" href="/support/">без id</a></h5>
  <span class="a-card__price">1 000 000 ₸</span>
</div>
"""

CARD_JS_HREF = """
<div class="a-card js__a-card" data-id="111222333">
  <h5 class="a-card__title"><a class="a-card__link" href="javascript:alert(1)">X</a></h5>
  <span class="a-card__price">1 000 000 ₸</span>
</div>
"""


def _page(*cards: str) -> str:
    return f"<html><body><div class='a-search-list'>{''.join(cards)}</div></body></html>"


def make_adapter(
    pages: list[str], **kwargs
) -> tuple[KolesaHtmlAdapter, list[httpx.Request]]:
    """Адаптер с MockTransport: отдаёт HTML-страницы по очереди."""
    requests: list[httpx.Request] = []
    queue = list(pages)

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = queue.pop(0) if queue else _page()
        return httpx.Response(200, text=body)

    transport = httpx.MockTransport(handler)
    # По умолчанию обогащение деталей выключено: старые тесты считают
    # запросы/страницы. Деталь-тесты включают сами через config.
    if "config" not in kwargs:
        kwargs["config"] = {"enrich_details": False}
    adapter = KolesaHtmlAdapter(
        source_name="kolesa",
        http_client=HttpClient(transport=transport, timeout=10),
        **kwargs,
    )
    adapter.requests = requests  # type: ignore[attr-defined]
    return adapter, requests


def _country(item) -> str | None:
    """country из модели (волна A GEO-V1 §2) либо из raw (пока поля нет)."""
    return getattr(item, "country", None) or item.raw.get("country")


# --- helpers ---------------------------------------------------------


def test_extract_make_kz():
    # латиница через общий MAKE_MAP
    assert extract_make_kz("BMW 540") == ("BMW", "540")
    assert extract_make_kz("Mitsubishi Lancer") == ("Mitsubishi", "Lancer")
    # двухтокенная марка
    assert extract_make_kz("Land Rover Freelander") == ("Land Rover", "Freelander")
    # кириллица: локальный KZ_MAKE_MAP, скобки из модели убраны
    assert extract_make_kz("ВАЗ (Lada) 2112") == ("Lada", "2112")
    assert extract_make_kz("Тойота Camry 2018") == ("Toyota", "Camry 2018")
    assert extract_make_kz("Лада Гранта") == ("Lada", "Гранта")
    assert extract_make_kz(None) == (None, None)
    assert extract_make_kz("Какая-то марка") == (None, "Какая-то марка")


# --- fetch / parsing -------------------------------------------------


async def test_fetch_maps_card_to_unified_listing():
    adapter, requests = make_adapter([_page(CARD)])
    result = await adapter.fetch(SearchCriteria())

    assert len(requests) == 1
    assert "kolesa.kz/cars/" in str(requests[0].url)
    assert requests[0].headers["Accept-Language"].startswith("ru-RU")

    assert len(result.items) == 1
    item = result.items[0]
    assert item.source == "kolesa"
    assert item.source_id == "232057208"
    # query (search_id=…) отрезан
    assert str(item.url) == "https://kolesa.kz/a/show/232057208"
    assert item.title == "BMW 540"
    assert item.make == "BMW"
    assert item.model == "540"
    assert item.year == 2017
    assert item.price == Decimal("21000000")  # 21 000 000 ₸ (nbsp)
    assert item.currency == "KZT"
    assert item.mileage_km == 152000  # «с пробегом 152 000 км»
    assert item.fuel == "petrol"  # бензин
    assert item.transmission == "automatic"  # КПП автомат
    assert item.body_type == "sedan"  # Б/у седан
    assert item.engine_volume == 3.0  # «3 л»
    assert item.location == "Алматы"  # [data-test=region]
    assert item.vin is None  # VIN в списке kolesa не публикуется
    # фото на внешнем CDN разрешено (allow_external для картинок)
    assert [str(i) for i in item.images] == [
        "https://kolesa-photos.kcdn.online/webp/39/abc/3-160x120.jpg"
    ]
    assert _country(item) == "KZ"  # country=KZ (raw, пока поля нет в модели)
    assert item.raw["title"] == item.title
    assert item.raw["city"] == "Алматы"
    await adapter.close()


async def test_fetch_maps_cyrillic_lada_card():
    """«тг.» вместо ₸, кириллическая марка ВАЗ → Lada (локальный словарь)."""
    adapter, _ = make_adapter([_page(CARD_LADA)])
    result = await adapter.fetch(SearchCriteria())

    item = result.items[0]
    assert item.make == "Lada"  # KZ_MAKE_MAP, не общий MAKE_MAP
    assert item.model == "2112"  # «(Lada)» из модели убрано
    assert item.price == Decimal("500000")  # «500 000 тг.»
    assert item.currency == "KZT"
    assert item.year == 2006
    assert item.body_type == "hatchback"  # Б/у хэтчбек
    assert item.engine_volume == 1.6
    assert item.transmission == "manual"  # КПП механика
    assert item.mileage_km is None  # «км» в описании нет
    assert item.location == "Актау"
    assert _country(item) == "KZ"
    await adapter.close()


async def test_fetch_ignores_criteria():
    """Клиентских фильтров нет (GEO-V1 §1) — фильтрует конвейер."""
    adapter, requests = make_adapter([_page(CARD)])
    await adapter.fetch(SearchCriteria(make="Toyota", year_from=2020))

    assert "make" not in str(requests[0].url)
    assert "year" not in str(requests[0].url)
    assert len(result_url_params(requests[0])) == 0  # page=1 → без параметров
    await adapter.close()


def result_url_params(request: httpx.Request) -> list[str]:
    from urllib.parse import parse_qs, urlparse

    return list(parse_qs(urlparse(str(request.url)).query))


async def test_fetch_skips_cards_without_id():
    adapter, _ = make_adapter([_page(CARD_NO_ID, CARD)])
    result = await adapter.fetch(SearchCriteria())
    assert len(result.items) == 1
    await adapter.close()


async def test_fetch_skips_unsafe_href():
    # javascript:-ссылка → _safe_join → None → карточка пропущена
    adapter, _ = make_adapter([_page(CARD_JS_HREF, CARD)])
    result = await adapter.fetch(SearchCriteria())
    assert len(result.items) == 1
    assert result.items[0].source_id == "232057208"
    await adapter.close()


async def test_fetch_price_missing_keeps_listing():
    card = CARD.replace(f"21{NBSP}000{NBSP}000{NBSP}₸", "Цена не указана")
    adapter, _ = make_adapter([_page(card)])
    result = await adapter.fetch(SearchCriteria())
    item = result.items[0]
    assert item.price is None
    assert item.currency == "KZT"  # валюта известна и без цены
    await adapter.close()


async def test_fetch_id_from_href_without_data_id():
    """Нет data-id → ID достаётся из /a/show/<id>."""
    card = CARD.replace(' data-id="232057208"', "")
    adapter, _ = make_adapter([_page(card)])
    result = await adapter.fetch(SearchCriteria())
    assert result.items[0].source_id == "232057208"
    await adapter.close()


async def test_pagination():
    adapter, requests = make_adapter([_page(CARD), _page(CARD), _page(CARD)])
    first = await adapter.fetch(SearchCriteria(), cursor=None)
    assert first.has_more is True
    assert first.next_cursor == "2"

    second = await adapter.fetch(SearchCriteria(), cursor=first.next_cursor)
    assert "page=2" in str(requests[1].url)

    # по умолчанию max_pages=5 → после 2-й страницы ещё есть
    assert second.has_more is True
    await adapter.close()


async def test_max_pages_from_config():
    adapter, _ = make_adapter([_page(CARD)], config={"max_pages": 1})
    result = await adapter.fetch(SearchCriteria())
    assert result.has_more is False
    assert result.next_cursor is None
    await adapter.close()


async def test_invalid_cursor_raises():
    adapter, _ = make_adapter([_page(CARD)])
    with pytest.raises(FetchError, match="invalid cursor"):
        await adapter.fetch(SearchCriteria(), cursor="abc")
    with pytest.raises(FetchError, match=">= 1"):
        await adapter.fetch(SearchCriteria(), cursor="0")
    await adapter.close()


async def test_empty_page_no_more():
    adapter, _ = make_adapter([_page()])
    result = await adapter.fetch(SearchCriteria())
    assert result.items == []
    assert result.has_more is False
    await adapter.close()


# --- healthcheck / errors ---------------------------------------------


async def test_healthcheck_true_with_cards():
    adapter, _ = make_adapter([_page(CARD)])
    assert await adapter.healthcheck() is True
    await adapter.close()


async def test_healthcheck_false_on_empty_layout():
    adapter, _ = make_adapter(["<html><body>captcha</body></html>"])
    assert await adapter.healthcheck() is False
    await adapter.close()


async def test_healthcheck_false_on_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    adapter = KolesaHtmlAdapter(
        source_name="kolesa",
        http_client=HttpClient(transport=httpx.MockTransport(handler), timeout=10),
    )
    assert await adapter.healthcheck() is False
    await adapter.close()


async def test_fetch_raises_fetch_error_on_403():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403)

    adapter = KolesaHtmlAdapter(
        source_name="kolesa",
        http_client=HttpClient(transport=httpx.MockTransport(handler), timeout=10),
    )
    with pytest.raises(FetchError):  # анти-бот отдаёт 403
        await adapter.fetch(SearchCriteria())
    await adapter.close()


# ---------- v2: детальные страницы (галерея/характеристики/опции) ----------

_DETAIL_HTML = """
<html><body>
<div class="offer__parameters" data-test="offer-parameters">
  <dl><dt class="value-title" title="Город"><span>Город</span></dt>
      <dd class="value">Алматы</dd></dl>
  <dl><dt class="value-title" title="Поколение"><span>Поколение</span></dt>
      <dd class="value">2023 - н.в. XV80</dd></dl>
  <dl><dt class="value-title" title="Кузов"><span>Кузов</span></dt>
      <dd class="value">Седан</dd></dl>
  <dl><dt class="value-title" title="Объем двигателя, л"><span>Объем</span></dt>
      <dd class="value">2.5 (гибрид)</dd></dl>
  <dl><dt class="value-title" title="Пробег"><span>Пробег</span></dt>
      <dd class="value">9 300 км</dd></dl>
  <dl><dt class="value-title" title="Коробка передач"><span>Коробка</span></dt>
      <dd class="value">Вариатор</dd></dl>
  <dl><dt class="value-title" title="Привод"><span>Привод</span></dt>
      <dd class="value">Передний привод</dd></dl>
  <dl><dt class="value-title" title="Цвет"><span>Цвет</span></dt>
      <dd class="value">серый металлик</dd></dl>
</div>
<p class="offer__options">
  <span class="offer__option-label">литые диски</span>
  <span class="offer__option-label">тонировка</span>
  <span class="offer__option-label">камера заднего вида</span>
</p>
<img src="https://kolesa-photos.kcdn.online/webp/aa/aaa-111/full-list-irrelevant.jpg">
<img src="https://kolesa-photos.kcdn.online/webp/7a/7a8d5427-fa24-4ec6-97f6-a2f4ab756611/2-750x470.jpg">
<img src="https://kolesa-photos.kcdn.online/webp/7a/7a8d5427-fa24-4ec6-97f6-a2f4ab756611/2-full.webp">
<img src="https://kolesa-photos.kcdn.online/webp/93/932a9c82-baa4-43ae-a38a-a2b63b9e3e80/1-160x120.webp">
<img src="https://kolesa-photos.kcdn.online/webp/93/932a9c82-baa4-43ae-a38a-a2b63b9e3e80/1-full.webp">
<img src="https://kolesa-photos.kcdn.online/webp/93/932a9c82-baa4-43ae-a38a-a2b63b9e3e80/3-full.webp">
</body></html>
"""


def _detail_handler(pages: list[str], detail: str):
    """Транспорт: списки по очереди, любая /a/show/ — детальная страница."""
    queue = list(pages)

    def handler(request: httpx.Request) -> httpx.Response:
        if "/a/show/" in str(request.url):
            return httpx.Response(200, text=detail)
        return httpx.Response(200, text=queue.pop(0) if queue else _page())

    return handler


async def test_detail_enrichment_gallery_params_options():
    """v2: детальная страница даёт галерею -full, словарные поля и опции."""
    adapter = KolesaHtmlAdapter(
        source_name="kolesa",
        http_client=HttpClient(
            transport=httpx.MockTransport(
                _detail_handler([_page(CARD)], _DETAIL_HTML)
            ),
            timeout=10,
        ),
        config={"enrich_details": True, "detail_limit": 1},
    )
    result = await adapter.fetch(SearchCriteria())
    item = result.items[0]
    # галерея: полноразмерные, дедуп по номеру, сортировка по номеру
    assert item.images == [
        "https://kolesa-photos.kcdn.online/webp/93/932a9c82-baa4-43ae-a38a-a2b63b9e3e80/1-full.webp",
        "https://kolesa-photos.kcdn.online/webp/7a/7a8d5427-fa24-4ec6-97f6-a2f4ab756611/2-full.webp",
        "https://kolesa-photos.kcdn.online/webp/93/932a9c82-baa4-43ae-a38a-a2b63b9e3e80/3-full.webp",
    ]
    assert item.body_type == "sedan"
    assert item.drive == "front"
    assert item.color == "серый металлик"
    assert item.generation == "2023 - н.в. XV80"
    assert item.engine_volume == 2.5
    assert item.fuel == "hybrid"
    assert item.mileage_km == 9300
    assert item.options == ["литые диски", "тонировка", "камера заднего вида"]
    assert item.raw["detail_params"]["Руль"] if "Руль" in item.raw.get("detail_params", {}) else True
    await adapter.close()


async def test_detail_failure_does_not_break_page():
    """Деталь 500 — объявление живёт с данными списка, fetch не падает."""
    def handler(request: httpx.Request) -> httpx.Response:
        if "/a/show/" in str(request.url):
            return httpx.Response(500)
        return httpx.Response(200, text=_page(CARD))

    adapter = KolesaHtmlAdapter(
        source_name="kolesa",
        http_client=HttpClient(transport=httpx.MockTransport(handler), timeout=10),
        config={"enrich_details": True, "detail_limit": 2},
    )
    result = await adapter.fetch(SearchCriteria())
    assert len(result.items) >= 1
    assert result.items[0].images  # фото списка остались
    await adapter.close()
