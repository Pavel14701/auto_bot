"""KolesaHtmlAdapter — источник kolesa.kz (Казахстан, SSR-парсинг HTML).

kolesa.kz (секция легковых ``/cars/``) отдаёт серверный HTML со списком
объявлений на русском. Адаптер парсит его selectolax'ом и приводит
к UnifiedListing:

- цена «21 000 000 ₸» (``₸``/«тг.», nbsp-разделители) → 21000000 KZT;
- пробег «с пробегом 152 000 км» → 152000 км;
- год — первое «2017 г.» из описания;
- город — ``Алматы``/``Астана``… → ``location``;
- марка: заголовок на kolesa обычно латиницей («BMW 540») → общий
  MAKE_MAP; кириллические варианты («ВАЗ (Lada)», «Тойота») — через
  локальный словарь ``KZ_MAKE_MAP`` (общий MAKE_MAP не трогаем);
- ``country="KZ"``, валюта KZT — без конвертации (GEO-V1 §1).

Селекторы — константы класса (переопределяются конфигом ``sources`` в БД,
ТЗ п. 6.1). Селекторы сверены с живым HTML 2026-10-28
(GET ``https://kolesa.kz/cars/`` → 200, ~948 КБ, 20 стандартных карточек):
карточка ``div.a-card.js__a-card[data-id]``, заголовок ``.a-card__title a``,
цена ``span.a-card__price``, описание ``.a-card__description``, город
``[data-test=region]``, фото ``.a-card__picture img``. VIP-блоки
(``vip-card``) имеют другую вёрстку и не парсятся (см. TODO в конце модуля).

``fetch(criteria, cursor)`` **не применяет ``criteria``**: фильтрация
выполняется downstream (pipeline/FilterService), как у che168.

Поле ``country`` пока отсутствует в UnifiedListing (волна A GEO-V1 §2):
pydantic с ``extra="ignore"`` молча отбрасывает kwarg, поэтому значение
дублируется в ``raw["country"]`` — после добавления поля в модель kwarg
начнёт работать без правки адаптера.
"""

import asyncio
import logging
import re
from decimal import Decimal
from types import MappingProxyType
from typing import Any
from urllib.parse import urljoin, urlparse

from selectolax.lexbor import LexborHTMLParser as HTMLParser

from app.infrastructure.sources.base import BaseApiAdapter, FetchError
from app.infrastructure.sources.common.normalize import (
    MAKE_MAP,
    detect_fuel,
    detect_transmission,
    normalize_body,
    normalize_engine_volume,
)
from app.domain.search.criteria import SearchCriteria
from app.domain.listings.unified import FetchResult, UnifiedListing

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://kolesa.kz"
# Секция легковых автомобилей (легковые с пробегом).
DEFAULT_LIST_PATH = "/cars/"
DEFAULT_MAX_PAGES = 5

# Детальные страницы (v2, 2026-10-29): галерея -full.webp, словарные
# характеристики (кузов/привод/руль/цвет/коробка), опции-чипы. Ошибка
# отдельной карточки не роняет страницу — остаются данные списка.
DEFAULT_DETAIL_LIMIT = 8
DEFAULT_DETAIL_CONCURRENCY = 3
MAX_DETAIL_IMAGES = 10
_KZ_IMG_RE = re.compile(
    r"(https://kolesa-photos\.kcdn\.online/\w+/[0-9a-f]{2}/[0-9a-f-]{36})/(\d+)-"
)
_DRIVE_MAP = (
    ("передн", "front"), ("задн", "rear"), ("полн", "awd"),
)

# --- Селекторы (сверены с живым HTML kolesa.kz/cars/ 2026-10-28) -----------
# Стандартная карточка: <div class="a-card  js__a-card" data-id="232057208">.
# VIP-блоки <div class="vip-block__item vip-card js__a-card"> имеют другую
# внутреннюю разметку (нет .a-card__title) — селектором не покрываются.
DEFAULT_CARD_SELECTOR = "div.a-card.js__a-card"
# <h5 class="a-card__title"><a class="a-card__link" href="/a/show/<id>?…">
DEFAULT_TITLE_SELECTOR = ".a-card__title a"
DEFAULT_LINK_SELECTOR = "a.a-card__link"  # fallback, если title-узла нет
# <span class="a-card__price">21 000 000 ₸</span>
DEFAULT_PRICE_SELECTOR = "span.a-card__price"
# <p class="a-card__description">2017 г., Б/у седан, 3 л, бензин, …
DEFAULT_DESC_SELECTOR = ".a-card__description"
# <span class="a-card__param" data-test="region">Алматы</span>
DEFAULT_REGION_SELECTOR = "[data-test=region]"
# Основное фото — первый <img> внутри .a-card__picture (фото на CDN
# kolesa-photos.kcdn.online — внешнем домене, разрешён для картинок).
DEFAULT_IMG_SCOPE_SELECTOR = ".a-card__picture"
DEFAULT_IMG_SELECTOR = "img"

HEADERS = MappingProxyType(
    {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,kk-KZ,q=0.8",
        "Referer": DEFAULT_BASE_URL + "/",
    }
)

# Локальный словарь кириллических марок kolesa.kz → латиница.
# Общий MAKE_MAP НЕ трогаем (GEO-V1): часть ключей (тойота, киа) там уже
# есть, здесь — полный набор для KZ + то, чего в MAKE_MAP нет (Лада/ВАЗ,
# Дэу, SsangYong, Инфинити…). Проверяется ПЕРЕД MAKE_MAP.
KZ_MAKE_MAP: dict[str, str] = {
    "тойота": "Toyota",
    "киа": "Kia",
    "хендай": "Hyundai",
    "хёндай": "Hyundai",
    "хюндаи": "Hyundai",
    "лада": "Lada",
    "ваз": "Lada",
    "дэу": "Daewoo",
    "деу": "Daewoo",
    "равон": "Ravon",
    "газ": "GAZ",
    "уаз": "UAZ",
    "ссангйонг": "SsangYong",
    "санг ёнг": "SsangYong",
    "митсубиси": "Mitsubishi",
    "мітсубісі": "Mitsubishi",
    "субару": "Subaru",
    "сузуки": "Suzuki",
    "инфинити": "Infiniti",
    "лексус": "Lexus",
}

# Lookup-индекс: KZ_MAKE_MAP + MAKE_MAP (ключи И канонические значения,
# как в normalize._build_lookup). Собственный индекс вместо normalize_make,
# чтобы отличать «известную» марку от lenient title-case неизвестной.
def _collapse(value: str) -> str:
    return re.sub(r"[\s\-()]+", "", (value or "").lower())


_MAKE_LOOKUP: dict[str, str] = {}
for _raw, _canonical in (*KZ_MAKE_MAP.items(), *MAKE_MAP.items()):
    _MAKE_LOOKUP[_collapse(_raw)] = _canonical
    _MAKE_LOOKUP[_collapse(_canonical)] = _canonical

# Схемы, запрещённые в href/src из чужого HTML.
_FORBIDDEN_SCHEMES = frozenset({"javascript", "data", "vbscript", "file"})

# ID объявления: data-id карточки либо ссылка /a/show/232057208?…
_ID_RE = re.compile(r"/a/show/(\d+)")
# Цена: «21 000 000 ₸» / «12 500 000 тг.» — берём только цифры узла цены.
# Пробелы — обычные и nbsp (\xa0); знак ₸/«тг.» отбрасывается.
_DIGIT_RE = re.compile(r"\d")
# Пробег: «с пробегом 152 000 км» — первый цифроблок перед «км»
# («2017 г.» и «3 л» не матчатся — после них не стоит «км»).
_MILEAGE_RE = re.compile(r"([\d\u00a0\s]+?)\s*км")
# Год: «2017 г., …» — первое 4-значное 19xx/20xx как отдельное слово.
_YEAR_RE = re.compile(r"\b(19[89]\d|20\d{2})\b")
# Объём двигателя: «3 л,» / «1.6 л,» — «л» не внутри слова («лич…»).
_ENGINE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*л(?![а-яё])")
# Кузов: «Б/у седан» — первое знакомое слово тела из описания.
_BODY_WORDS = (
    "внедорожник", "минивэн", "универсал", "хэтчбек", "хетчбек",
    "кабриолет", "седан", "купе", "пикап",
)


def _safe_join(base: str, href: str | None, *, allow_external: bool = False) -> str | None:
    """`urljoin` с валидацией схемы (и, опционально, домена).

    `urljoin("https://a/", "javascript:alert(1)")` возвращает
    `javascript:alert(1)` — XSS-вектор при рендере `<a href>`. Для ссылок
    на объявления дополнительно требуется домен kolesa.kz; для фото
    (`allow_external=True`) внешний CDN (kolesa-photos.kcdn.online)
    разрешён — проверяется только схема http(s).

    Args:
        base: Базовый URL (с trailing slash).
        href: Относительный или абсолютный URL из HTML.
        allow_external: Разрешить чужие домены (для картинок на CDN).

    Returns:
        Безопасный абсолютный http(s)-URL или `None`.
    """
    if not href:
        return None
    href = href.strip()
    scheme = urlparse(href).scheme.lower()
    if scheme in _FORBIDDEN_SCHEMES:
        return None
    joined = urljoin(base, href)
    parsed = urlparse(joined)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    if allow_external:
        return joined
    base_host = (urlparse(base).hostname or "").lower()
    host = (parsed.hostname or "").lower()
    root = ".".join(base_host.split(".")[-2:]) if base_host else ""
    if not root or not (host == root or host.endswith("." + root)):
        return None
    return joined


def extract_make_kz(title: str | None) -> tuple[str | None, str | None]:
    """Марка+модель из заголовка kolesa («BMW 540», «ВАЗ (Lada) 2112»).

    Пробует префикс из двух токенов («Land Rover»), затем один; сначала
    локальный KZ_MAKE_MAP, затем общий MAKE_MAP. Модель — остаток токенов
    после марки.

    Args:
        title: Текст заголовка объявления.

    Returns:
        `(make, model)`; оба могут быть `None`, марка без модели —
        `("Toyota", None)`.
    """
    if not title:
        return None, None
    tokens = title.split()
    for size in (2, 1):
        if len(tokens) < size:
            continue
        prefix = " ".join(tokens[:size])
        canonical = _MAKE_LOOKUP.get(_collapse(prefix))
        if canonical:
            # «ВАЗ (Lada) 2112» → make=Lada, model=2112 (скобки убираем)
            tail = re.sub(r"\([^)]*\)", "", " ".join(tokens[size:]))
            model = " ".join(tail.split()) or None
            return canonical, model
    return None, " ".join(tokens).strip() or None


def _digits_to_decimal(raw: str | None) -> Decimal | None:
    """«21 000 000 ₸» → Decimal('21000000'); None, если цифр нет.

    Args:
        raw: Текст узла цены (пробелы/nbsp/₸/«тг.» отбрасываются).

    Returns:
        Цена как `Decimal` или `None`.
    """
    digits = _DIGIT_RE.findall(raw or "")
    return Decimal("".join(digits)) if digits else None


def _digits_to_int(raw: str | None) -> int | None:
    """Цифроблок с разделителями → int («152 000 км» → 152000).

    Args:
        raw: Подходящая по regex группа (цифры, пробелы, nbsp).

    Returns:
        Целое число или `None`.
    """
    digits = _DIGIT_RE.findall(raw or "")
    return int("".join(digits)) if digits else None


class KolesaHtmlAdapter(BaseApiAdapter):
    """SSR-парсер kolesa.kz (kind='parser' в таблице `sources`).

    Особенности:
    - `fetch` не применяет `criteria` — фильтрация downstream (GEO-V1 §1);
    - `_max_pages` ограничивает пагинацию (клампится к >= 1);
    - URL из HTML валидируются: ссылки — только kolesa.kz, фото —
      любой http(s) CDN; query у ссылок отрезается (трекинг-мусор);
    - `country="KZ"` и `currency="KZT"` без конвертации.

    Attributes:
        source_name: `"kolesa"`.
    """

    source_name = "kolesa"
    # ISO-3166 alpha-2 (GEO-V1 §2); KZT — исходная валюта без конвертации.
    COUNTRY_CODE = "KZ"
    CURRENCY = "KZT"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._base_url = self.config.get("base_url", DEFAULT_BASE_URL).rstrip("/")
        self._list_path = self.config.get("list_path", DEFAULT_LIST_PATH)
        self._card_selector = self.config.get("card_selector", DEFAULT_CARD_SELECTOR)
        self._title_selector = self.config.get("title_selector", DEFAULT_TITLE_SELECTOR)
        self._link_selector = self.config.get("link_selector", DEFAULT_LINK_SELECTOR)
        self._price_selector = self.config.get("price_selector", DEFAULT_PRICE_SELECTOR)
        self._desc_selector = self.config.get("desc_selector", DEFAULT_DESC_SELECTOR)
        self._region_selector = self.config.get("region_selector", DEFAULT_REGION_SELECTOR)
        self._img_scope = self.config.get("img_scope_selector", DEFAULT_IMG_SCOPE_SELECTOR)
        self._img_selector = self.config.get("img_selector", DEFAULT_IMG_SELECTOR)
        self._enrich_details = bool(self.config.get("enrich_details", True))
        try:
            self._detail_limit = max(0, int(self.config.get("detail_limit", DEFAULT_DETAIL_LIMIT)))
            self._detail_conc = max(1, int(self.config.get("detail_concurrency", DEFAULT_DETAIL_CONCURRENCY)))
        except (TypeError, ValueError):
            self._detail_limit, self._detail_conc = DEFAULT_DETAIL_LIMIT, DEFAULT_DETAIL_CONCURRENCY
        try:
            self._max_pages = max(1, int(self.config.get("max_pages", DEFAULT_MAX_PAGES)))
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"kolesa: invalid max_pages={self.config.get('max_pages')!r}"
            ) from exc

    # --- fetch ---------------------------------------------------------

    async def fetch(
        self, criteria: SearchCriteria, cursor: str | None = None
    ) -> FetchResult:
        """Забирает страницу объявлений kolesa.kz.

        `criteria` не применяется: фильтрация — downstream. См. докстринг
        модуля.

        Args:
            criteria: Критерии поиска (игнорируются).
            cursor: Номер страницы строкой (`"1"`, `"2"`, …) или `None`.

        Returns:
            `FetchResult` с объявлениями и `next_cursor` (или `None`).

        Raises:
            FetchError: При невалидном `cursor` или ошибке HTTP.
        """
        page = self._parse_cursor(cursor)
        params = {"page": str(page)} if page > 1 else None
        resp = await self.http.get(
            self._base_url + self._list_path, params=params, headers=dict(HEADERS)
        )
        items = self._parse(resp.text)
        # v2: детальные карточки — галерея/характеристики/опции (лучшие N
        # страницы; ошибка карточки не роняет страницу).
        if items and self._enrich_details and self._detail_limit:
            await self._enrich_from_details(items)

        if page > 1 and not items:
            # Либо конец пагинации, либо страница за пределами выдачи.
            logger.warning(
                "kolesa_empty_page page=%d url=%s", page, resp.url
            )

        has_more = bool(items) and page < self._max_pages
        return FetchResult(
            items=items,
            next_cursor=str(page + 1) if has_more else None,
            has_more=has_more,
            source_meta={"page": page, "parsed": len(items)},
        )

    @staticmethod
    def _parse_cursor(cursor: str | None) -> int:
        """Валидирует курсор и возвращает номер страницы.

        Args:
            cursor: Строка курсора или `None` (первая страница).

        Returns:
            Номер страницы (>= 1).

        Raises:
            FetchError: Если курсор не целое положительное число.
        """
        if not cursor:
            return 1
        try:
            page = int(cursor)
        except (TypeError, ValueError) as exc:
            raise FetchError(f"kolesa: invalid cursor {cursor!r}") from exc
        if page < 1:
            raise FetchError(f"kolesa: cursor must be >= 1, got {page}")
        return page

    async def healthcheck(self) -> bool:
        """200 + контейнер списка = источник жив (вёрстка не сломана).

        Returns:
            `True`, если в ответе есть хотя бы одна карточка по текущему
            `card_selector`; `False` при ошибке HTTP или пустом списке.
        """
        try:
            resp = await self.http.get(
                self._base_url + self._list_path, headers=dict(HEADERS)
            )
        except Exception:  # noqa: BLE001 — healthcheck не должен ронять вызывающего
            return False
        return bool(HTMLParser(resp.text).css(self._card_selector))

    # --- parsing -------------------------------------------------------

    def _parse(self, html: str) -> list[UnifiedListing]:
        """Парсит HTML списка; битые карточки пропускаются с warning.

        Args:
            html: HTML страницы списка.

        Returns:
            Список `UnifiedListing`.
        """
        tree = HTMLParser(html)
        items: list[UnifiedListing] = []
        for card in tree.css(self._card_selector):
            try:
                listing = self._map_card(card)
            except Exception:  # noqa: BLE001 — битая карточка не роняет страницу
                logger.warning(
                    "kolesa_card_parse_error source=%s data-id=%s",
                    self.source_name,
                    card.attributes.get("data-id"),
                    exc_info=True,
                )
                continue
            if listing is not None:
                items.append(listing)
        return items

    def _map_card(self, card) -> UnifiedListing | None:
        """Преобразует одну карточку в `UnifiedListing` или `None`.

        Args:
            card: `selectolax`-узел карточки.

        Returns:
            `UnifiedListing` или `None`, если нет `source_id`/валидной ссылки.
        """
        data_id = card.attributes.get("data-id")
        if not (isinstance(data_id, str) and data_id.strip().isdigit()):
            data_id = None

        link = card.css_first(self._title_selector) or card.css_first(self._link_selector)
        href = (link.attributes.get("href") if link else None) or ""
        if data_id:
            source_id = data_id
        else:
            match = _ID_RE.search(href)
            source_id = match.group(1) if match else None
        if source_id is None:
            return None

        title = link.text(strip=True) if link else None
        make, model = extract_make_kz(title)

        desc_node = card.css_first(self._desc_selector)
        text = desc_node.text(separator=" ", strip=True) if desc_node else ""

        price_node = card.css_first(self._price_selector)
        price_text = price_node.text(strip=True) if price_node else None
        price = _digits_to_decimal(price_text)

        # Ссылка без трекинг-query: /a/show/<id>?search_id=… → /a/show/<id>
        url = _safe_join(self._base_url + "/", href.split("?", 1)[0])
        if url is None:
            # Без ссылки объявление бесполезно, а listings.url — NOT NULL.
            logger.warning("kolesa_unsafe_href href=%r source_id=%s", href, source_id)
            return None

        year_match = _YEAR_RE.search(text)
        mileage = self._extract_mileage(text)
        engine = self._extract_engine(text)

        region_node = card.css_first(self._region_selector)
        city = region_node.text(strip=True) if region_node else None

        return UnifiedListing(
            source=self.source_name,
            source_id=source_id,
            url=url,
            title=title,
            make=make,
            model=model,
            year=int(year_match.group(1)) if year_match else None,
            price=price,
            currency=self.CURRENCY,
            mileage_km=mileage,
            body_type=self._extract_body(text),
            fuel=detect_fuel(text) if text else None,
            transmission=detect_transmission(text) if text else None,
            engine_volume=engine,
            vin=None,  # kolesa не публикует VIN в списке
            location=city,  # Алматы / Астана / Актау…
            seller_type=None,  # в списке нет маркера «частник/дилер»
            images=self._extract_images(card),
            # country появится в модели в волне A (GEO-V1 §2); до этого
            # kwarg молча отбрасывается (extra="ignore") — дублируем в raw.
            country=self.COUNTRY_CODE,
            raw={
                "country": self.COUNTRY_CODE,
                "title": title,
                "price_text": price_text,
                "description": text,
                "city": city,
                "html": card.html[:2000],
                "html_truncated": len(card.html) > 2000,
            },
        )

    # --- детальные страницы (v2) ---------------------------------------

    async def _enrich_from_details(self, items: list[UnifiedListing]) -> None:
        """Догружает топ-N карточек страницы: галерея, словарные поля, опции.

        Referer обязателен (без него детальная страница отдаёт 418);
        concurrency ограничен семафором — вежливость к источнику.
        """
        headers = dict(HEADERS)
        headers["Referer"] = self._base_url + self._list_path
        sem = asyncio.Semaphore(self._detail_conc)

        async def _one(item: UnifiedListing) -> None:
            async with sem:
                try:
                    resp = await self.http.get(str(item.url), headers=headers)
                except Exception:  # noqa: BLE001 — карточка не роняет страницу
                    logger.warning(
                        "kolesa_detail_failed source_id=%s", item.source_id, exc_info=True
                    )
                    return
                try:
                    self._apply_detail(item, resp.text)
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "kolesa_detail_parse_error source_id=%s",
                        item.source_id,
                        exc_info=True,
                    )

        await asyncio.gather(*(_one(x) for x in items[: self._detail_limit]))

    def _apply_detail(self, item: UnifiedListing, html: str) -> None:
        """Накладывает данные детальной страницы на объявление (in-place).

        Галерея: все фото CDN приводятся к полноразмеру ``{N}-full.webp``,
        дедуп по (bucket, номер), сортировка по номеру. Характеристики —
        ``dt.value-title[title]`` + ``dd.value``. Опции — чипы
        ``.offer__option-label``.
        """
        # Галерея: regex над html — srcset-варианты схлопываются в -full
        seen: dict[tuple[str, int], str] = {}
        for base, num in _KZ_IMG_RE.findall(html):
            key = (base, int(num))
            if key not in seen:
                seen[key] = f"{base}/{num}-full.webp"
        if seen:
            gallery = [
                seen[k] for k in sorted(seen, key=lambda x: x[1])
            ][:MAX_DETAIL_IMAGES]
            # Списочное фото первым: сохраняем порядок галереи источника
            item.images = gallery  # type: ignore[assignment]

        # Словарные характеристики dt/dd
        params: dict[str, str] = {}
        tree = HTMLParser(html)
        for dl in tree.css("div.offer__parameters dl"):
            dt = dl.css_first("dt.value-title")
            dd = dl.css_first("dd.value")
            if dt is None or dd is None:
                continue
            name = (dt.attributes.get("title") or dt.text(strip=True)).strip()
            value = dd.text(strip=True)
            if name and value:
                params[name] = value
        if params:
            item.body_type = (
                normalize_body(params.get("Кузов")) or item.body_type
            )
            # «Объем двигателя, л»: «2.5 (гибрид)» → объём + топливо
            eng = params.get("Объем двигателя, л", "")
            # «2.5 (гибрид)» — литры без суффикса «л» (в отличие от списка)
            vol = re.search(r"(\d+(?:[.,]\d+)?)", eng)
            if vol:
                item.engine_volume = normalize_engine_volume(vol.group(1)) or item.engine_volume
                item.fuel = detect_fuel(eng) or item.fuel
            # «Пробег»: «201 000 км» — точнее списка
            km = _digits_to_int(params.get("Пробег", ""))
            if km and km < 5_000_000:
                item.mileage_km = km
            item.generation = params.get("Поколение") or item.generation
            item.transmission = (
                detect_transmission(params.get("Коробка передач"))
                or item.transmission
            )
            drive = params.get("Привод", "").lower()
            item.drive = next(
                (code for token, code in _DRIVE_MAP if token in drive),
                item.drive,
            )
            item.color = params.get("Цвет") or item.color
            item.location = params.get("Город") or item.location
            item.raw = {**item.raw, "detail_params": params}

        # Опции-чипы (русскоязычные — как у encar options)
        options = [
            chip.text(strip=True)
            for chip in tree.css("span.offer__option-label")
        ]
        options = [o for o in options if o][:40]
        if options:
            item.options = options

    @staticmethod
    def _extract_mileage(text: str) -> int | None:
        """Извлекает пробег «с пробегом 152 000 км» → 152000 км.

        Args:
            text: Текст описания карточки.

        Returns:
            Пробег в км или `None`.
        """
        match = _MILEAGE_RE.search(text or "")
        if not match:
            return None
        return _digits_to_int(match.group(1))

    @staticmethod
    def _extract_engine(text: str) -> float | None:
        """Извлекает объём двигателя «3 л,» / «1.6 л,» → литры.

        Args:
            text: Текст описания карточки.

        Returns:
            Объём в литрах или `None`.
        """
        match = _ENGINE_RE.search(text or "")
        if not match:
            return None
        return normalize_engine_volume(match.group(1))

    @staticmethod
    def _extract_body(text: str) -> str | None:
        """Извлекает кузов «Б/у седан» → 'sedan' (первое знакомое слово).

        Args:
            text: Текст описания карточки.

        Returns:
            Канонический код кузова или `None`.
        """
        for word in _BODY_WORDS:
            if word in (text or ""):
                return normalize_body(word)
        return None

    def _extract_images(self, card) -> list[str]:
        """Фото карточки: `img` внутри блока картинки (CDN — внешний домен).

        Args:
            card: Узел карточки.

        Returns:
            Список абсолютных http(s)-URL без дублей (основное фото первым).
        """
        scope = card.css_first(self._img_scope)
        if scope is None:
            return []
        urls: list[str] = []
        for img in scope.css(self._img_selector):
            src = img.attributes.get("data-src") or img.attributes.get("src") or ""
            if src.startswith("data:"):  # пропускаем lazy-placeholder
                continue
            url = _safe_join(self._base_url + "/", src, allow_external=True)
            if url and url not in urls:
                urls.append(url)
        return urls
