# Источники, парсинг, S3-зеркало и перевод

Как объявления с внешних площадок (сейчас — Корея: **encar.com**; в коде
остались адаптеры kcar/che168) превращаются в строки `listings`, зеркала
фото в MinIO и русские тексты. Все файлы — в `app/infrastructure/sources/`
(адаптеры) и `app/infrastructure/workers/fetch.py` (воркер очереди).

```
sources (БД) ──▶ AdapterRegistry ──▶ EncarApiAdapter ──http(+ретраи,прокси)──▶ encar.com
                    │                                       │ FetchResult{UnifiedListing,…}
                    │                                       ▼
RabbitMQ "fetch" ──▶ fetch_source_task ──▶ save_listings (CTE-upsert + dedup Redis)
                    │                    ├──▶ S3 raw-payloads: raw/{source}/{yyyy}/{mm}/{id}_{hash}.json
                    │                    ├──▶ очередь "mirror_photos_task" ──▶ MinIO market-photos
                    │                    │       mirror/{source}/{source_id}/{NNN}.jpg
                    │                    ├──▶ очередь "send": notify_new_listings / listing_status_scan
                    │                    └──▶ очередь "translate_listings" (чанки) ──▶ NLLB-микросервис
                    ├── cron 04:00 stale_check_job  ──▶ is_active=false + чистка зеркал/raw
                    └── cron 03:30 raw_retention_job ──▶ raw старше 180 дней
```

История: до перехода на NLLB хангыль переводился модулем
`app/infrastructure/sources/korean.py` (карты слов + слоговая
транслитерация «dehangul») — файл удалён, доступен в git history
(коммит до `de3a89b`); его роль выполняют глоссарий + микросервис.

---

## 1. Контракт адаптера — `app/infrastructure/sources/base.py`

Принципы (ТЗ п. 6.1): один адаптер = один источник; код адаптера в Git,
конфиг — в БД (таблица `sources`); сырой ответ (`raw_payload`) сохраняется
в S3 для перепарсинга (`listings.raw_key`).

### 1.1. Protocol `SourceAdapter` (runtime_checkable)

| Член | Сигнатура | Назначение |
|---|---|---|
| атрибут | `source_name: str` | каноническое имя (`encar`, `kcar`, `che168`) |
| метод | `async fetch(self, criteria: SearchCriteria, cursor: str \| None = None) -> FetchResult` | страница объявлений по критериям; пустой `FetchResult` = валидное «ничего не найдено» |
| метод | `async healthcheck(self) -> bool` | источник жив и контракт цел (см. §3.6) |
| метод | `async close(self) -> None` | освободить ресурсы (HTTP-клиент) |

`FetchResult` (`app/domain/listings/unified.py`): `items:
list[UnifiedListing]`, `next_cursor: str | None`, `has_more: bool`,
`source_meta` (encar кладёт туда `total`/`page`).

### 1.2. База `BaseApiAdapter`

```python
BaseApiAdapter(
    *, source_name: str,
    config: dict | None = None,          # URLs/флаги из sources.config
    credentials: dict | str | None = None,  # НЕ строка: TypeError при str
    rate_limit: int = 60,                # запросов/мин; >0
    timeout: int = 30,                   # сек; >0; игнорится при http_client
    capabilities: dict | None = None,    # use_proxy, supports_cursor, …
    http_client: HttpClient | None = None,  # инъекция для тестов/прокси
    translator: Any = None,              # NLLB-клиент (см. §9)
)
```

- `fetch()`/`healthcheck()` в базе кидают `NotImplementedError`;
  `close()` закрывает `self.http` идемпотентно (ошибки — в лог).
- Адаптер — async-контекст-менеджер (`__aenter__`/`__aexit__` → close).
- `repr()` маскирует credentials (`***`) — секреты не утекают в логи.
- `rate_limit` самим адаптером **не применяется**: поле хранится для
  `AdapterRegistry`, который должен оборачивать `fetch` в лимитер. Сегодня
  registry лимитер не вешает — лимит не enforced (см. TECHDEBT.md).

### 1.3. HTTP-клиент — `common/http.py` (`HttpClient`)

Единая точка сетевых запросов всех адаптеров:

- **Ретраи** (по умолчанию 3): сетевые `httpx.TransportError` (включая
  `RemoteProtocolError`), `TimeoutException` и HTTP-коды
  408/425/429/500/502/503/504. Прочие 4xx не ретраятся — сразу `FetchError`.
- **Backoff**: `base * 2**attempt` с cap 30с + jitter до 50%
  (анти-thundering-herd). При 429 уважается `Retry-After` (секунды или
  HTTP-date, тоже с cap 30с).
- **Прокси-ротация**: если передан `ProxyPool`, каждая попытка берёт новый
  прокси; таймаут/сетевая ошибка помечает прокси «плохим»
  (`mark_bad`). Клиент на попытку создаётся заново — ровно один
  TLS-handshake (прокси меняется между попытками).
- API: `get_json/post_json` (невалидный JSON → `FetchError`),
  `get/post` → `httpx.Response`. `transport` — точка инъекции
  `MockTransport` в тестах.

### 1.4. Остальные common-модули

- `common/normalize.py` — канонизация make/fuel/transmission/body/color/
  drive/engine_volume (KRW-ман → литры и т.п.) до записи в БД.
- `common/dedup.py` — кросс-дедуп между источниками (§6.2).
- `common/translate.py` — рекурсивный сбор/замена хангыля в структурах
  (`collect_hangul`/`replace_hangul`, потолок строки 500) — общий для
  адаптеров encar/kcar.
- `common/proxy.py` — пул прокси: DataImpulse-шлюз (если заданы креды) или
  статический список из Redis; sticky-TTL 1800с.
- `probe.py` — разовая проверка достижимости эндпоинта (диагностика).

---

## 2. Таблица `sources` и registry — `app/infrastructure/sources/registry.py`

Код в Git, конфиг в БД. Строка `sources`: `name`, `adapter_class` (ключ
`ADAPTER_CLASSES` из `sources/__init__.py`: `EncarApiAdapter`,
`KCarApiAdapter`, `Che168HtmlAdapter`), `kind` (api/parser/hybrid),
`enabled`, `priority`, `schedule_cron`, `rate_limit_per_min`,
`max_concurrency`, `timeout_sec`, `credentials_ref`, `config`,
`capabilities`. Секреты в БД не хранятся: `credentials_ref` — имя
env-переменной с JSON-объектом ключей.

### 2.1. `EnvSecretStore`

`credentials_ref` обязан начинаться с `ADAPTER_` / `SOURCE_` / `SECRET_` /
`CREDENTIALS_` (защита от чтения `PATH`, `AWS_SECRET_ACCESS_KEY` и т.п.).
Значение: JSON-объект; одиночная строка для обратной совместимости
оборачивается в `{"token": ...}`; не-dict JSON → `SecretError`.

### 2.2. `AdapterRegistry`

- `async load()` — собирает все `enabled` источники (ORDER BY priority),
  **атомарно** заменяет кеш `name -> адаптер` (читатели видят либо старый
  кеш целиком, либо новый); ошибка сборки одного источника не роняет
  остальные (лог + счётчик failed). Старые/заменённые адаптеры закрываются.
- `async _build(row)` — класс из `ADAPTER_CLASSES` (KeyError, если не
  зарегистрирован); credentials по ref (fail-fast, если ref не
  разрешился); config/capabilities не-dict → warning + `{}`;
  timeout/rate_limit валидируются `_positive_int` (>0, иначе дефолт);
  при `capabilities.use_proxy is True` (строго bool — truthy-строки
  «false» из БД не считаются) адаптеру собирается `HttpClient` с прокси-пулом.
- `async reload_source(name)` — пересборка одного адаптера под локом
  (используется ParserDoctor: repaired-конфиг подхватывается без
  рестарта воркера); выключенный/удалённый источник выпадает из кеша.
- `get(name)` / `all()` / `reload()` / `aclose()`.

### 2.3. Управление источниками из админки

`app/transport/http/routers/admin.py` (X-Internal-Token):

| Эндпоинт | Назначение |
|---|---|
| `GET /api/admin/adapters` | список доступных `adapter_class` (валидация при создании) |
| `GET /api/admin/sources` | все источники, включая выключенные |
| `PUT /api/admin/sources/{name}` | создать/обновить (`SourceConfigDTO`: name, adapter_class, kind, enabled, priority, schedule_cron, rate_limit_per_min, max_concurrency, timeout_sec, retry_policy, credentials_ref, capabilities, config); 422 при неизвестном классе |
| `GET /api/admin/sources/{name}/health` | последние успехи/ошибки, latency (таблица `source_health`) |
| `POST /api/admin/sources/{name}/fetch` | ручной парсинг: задача в очередь `fetch` (criteria + max_pages ≤50) |

Health/circuit-breaker — `infrastructure/services/source_health.py`:
`record_success`/`record_error` на каждый fetch; 5 ошибок подряд
(`SOURCE_CB_ERROR_STREAK`) → источник временно пропускается
(`should_skip_source`) — и парсингом, и stale-чисткой (объявления лежащего
источника не могли «видеться»).

---

## 3. Encar-адаптер — `app/infrastructure/sources/encar.py`

Основной источник. Все URL шаблонами перекрываются из `sources.config`.

### 3.1. Эндпоинты (окт 2026, все анонимные)

| Константа | URL | Что даёт |
|---|---|---|
| `DEFAULT_BASE_URL` | `https://api.encar.com/search/car/list/general` | search-выдача: `{"Count": N, "SearchResults": […]}` |
| `DEFAULT_DETAIL_API` | `https://api.encar.com/v1/readside/vehicle/{id}` | VIN (у заполненных), spec (объём в см³), ПОЛНЫЙ набор фото, diagnosisCar/осмотр/обременения. Удалённый лот → 404 |
| `DEFAULT_CLEAN_API` | `…/v1/readside/clean-encar/vehicle/{id}` | флаг безаварийности `{"cleaned": bool}` |
| `DEFAULT_INSPECTION_API` | `…/v1/readside/inspection/vehicle/{id}` | чек 성능점검기록부: master (ДТП/ремонт), inners (агрегаты), outers (зоны кузова), images (фото чека). Нет чека → 404 |
| `DEFAULT_INSPECTION_SUMMARY_API` | `…/inspection/vehicle/{id}/summary` | центр и инспектор (`inspName`) |
| `DEFAULT_RECORD_API` | `…/v1/readside/record/vehicle/{id}/summary` | страховая история: ДТП (своя/чужая вина), утопления, угоны, смены владельцев/номеров, залог/лизинг |
| `DEFAULT_ACCIDENT_OPEN_API` | `…/v1/readside/record/vehicle/{id}/open?vehicleNo=…` | история ДТП из ГОСданных: счётчики + полный список аварий с датами и выплатами (нужен госномер из карточки) |
| `DEFAULT_DIAGNOSIS_API` | `…/v1/readside/diagnosis/vehicle/{id}` | 엔카진단: зоны кузова NORMAL/дефект + комментарии (CHECKER_COMMENT «무사고») |
| `DEFAULT_MDSL_RECORD_API` | `https://www.encar.com/md/sl/mdsl_regcar.do?method=inspectionViewNew&carid={id}` | классическая страница чека (EUC-KR): серверный JS-блок `performanceCheck = {dataGroup: […]}` — ранки ВСЕХ панелей (외판 1/2, 주요골격 A/B/C), из которых рисуют «две машинки». JSON-чек `outers` у большинства пуст — карта повреждений живёт только здесь |
| `DEFAULT_PHOTO_PREFIX` | `https://ci.encar.com` | префикс фото (`{prefix}/{path}`) |
| `DEFAULT_DETAIL_TEMPLATE` | `https://fem.encar.com/car/detail/{id}` | карточка на источнике (кнопка «Открыть у источника») |

Важно: чек/диагностика/страховая живут под **внутренним** `vehicleId`
(например ad 43013519 → vehicle 43009007): по id объявления эти API отдают
404. Адаптер берёт `detail.vehicleId`, fallback — id объявления.

### 3.2. Пейджинг

- Курсор = номер страницы строкой (`"0"`, `"1"`, …; `None` → 0).
  Невалидный/отрицательный → `FetchError`.
- Обязательные параметры страницы (`_build_params`): `count=true`,
  `sr="|{sort}|{offset}|{limit}"`, `inav=|Metadata|Sort`, `cursor=""`.
  **Без `sr` эндпоинт отвечает 200 с `{"Count": N}` и ПУСТЫМ
  SearchResults** («сломанный контракт» осени 2026).
- `page_size` из конфига (дефолт 20, ≤0 → ValueError), сортировка —
  `sort` из конфига (дефолт `ModifiedDate`; допустимы PriceAsc/PriceDesc/
  MileageAsc/MileageDesc/Year).
- `has_more = bool(items) && (page+1)*page_size < min(Count,
  MAX_TOTAL_ITEMS=10_000)` — cap защищает от врутщего `Count=1M` и
  бесконечной пагинации.
- `Count > 0` при пустых items на странице 0 — warning
  `encar_broken_contract` (не ошибка).

### 3.3. Фильтры (`_build_q`)

Все условия — в ОДНОМ `(And …)`, разделитель `_.`:

```
(And.Hidden.N._.Manufacturer.현대._.ModelGroup.쏘나타._.Price.range(1000..3000).)
```

Старый синтаксис `(And.X.)(And Y.)` API принимает молча, но ИГНОРИРУЕТ
(возвращает весь каталог) — не используется.

| Критерий | Как накладывается |
|---|---|
| марка | словарь `ENCAR_MAKE_NAMES` (канон EN → корейский фасет: Hyundai→현대, Mercedes-Benz→벤츠…). Нет в словаре → `FetchError` (фильтр не отбрасывается молча — иначе вся выдача под видом отфильтрованной) |
| модель | `ENCAR_MODEL_GROUPS` (популярные EN → ModelGroup: sonata→쏘나타, k5→K5, 5 series→5시리즈…). Нет → `FetchError` |
| цена | `Price.range(lo..hi)` **в манах** (1 ман = 10 000 KRW); `criteria.currency`: None/KRW — как есть, USD — конвертация по `config.usd_krw` (дефолт 1400), прочая валюта → `FetchError`; price_min > price_max → `FetchError`; границы 0..99_999_999 |
| год | `Year.range(YYYYMM..YYYYMM)` (202201..202412); from > to → `FetchError` |
| пробег | `Mileage.range(0..{max})` |
| топливо | `ENCAR_FUEL_NAMES`: petrol→가솔린, diesel→디젤, hybrid→가솔린+전기, electric→전기, lpg→`LPG(일반인 구입_)` — символ `)` в значении фасета ломает синтаксис q, нужен escape-протокол (не проверено на живом API, см. TECHDEBT) |
| КПП | `ENCAR_TRANSMISSION_NAMES`: automatic→오토, manual→수동, cvt→CVT |

### 3.4. Маппинг search-элемента → `UnifiedListing` (`_map_item`)

Ошибки парсинга отдельного поля логируются и дают `None` для объявления
(страница не падает). `Id` непарсибельный → карточка пропущена.

| Поле Encar (SearchResults) | Наше поле | Комментарий |
|---|---|---|
| `Id` | `source_id` | int → str |
| `Price` | `price` (KRW) | в API — **маны**: `price = Price * 10_000`; `currency="KRW"` |
| `Manufacturer` / `Model` | `make` / `model` | через `normalize_make`; raw — fallback |
| `Badge`/`BadgeDetail` | `generation` | |
| `FormYear` ('2022') / `Year` (202208.0) | `year` | приоритет FormYear; из YYYYMM → `//100` |
| `Mileage` | `mileage_km` | |
| `Vin` | `vin` | только если лёг (search его почти не отдаёт — 0/1902 в БД); enrichment ставит валидный |
| `Photos[]` (`{type,location}`) / `Photo` | `images` | dict-фотки разворачиваются по `location` (раньше `str(dict)` давал мусорные URL); полный набор — из detail |
| `BodyType`/`FuelType`/`Transmission`/`Color` | `body_type`/`fuel`/`transmission`/`color` | через normalize_*; raw — fallback |
| `OfficeCityState`/`OfficeCity` | `location` | |
| — | `seller_type="dealer"` |Encar — дилерская площадка |
| `PhotoDate` | `published_at` | |
| `Subject` (нет в новом контракте) | `title` | собирается из Manufacturer+Model |
| весь элемент | `raw` | уходит в S3 raw-payload (§6.3) |
| — | `url` | `detail_url_template.format(source_id=…)` |

### 3.5. Детальное обогащение (`_enrich_from_details`)

На каждую страницу выдачи (`enrich_details=True` по умолчанию):

1. Параллельно с `asyncio.Semaphore(5)` (`_DETAIL_CONCURRENCY`) для каждого
   лота: GET detail → при сбое warning `encar_detail_failed`, лот остаётся
   на данных search; GET clean-encar → `cleaned` (сбой некритичен).
2. `vid = detail.vehicleId or source_id` → optional-запросы inspection,
   inspection/summary, record/summary; если в карточке есть госномер
   (`detail.vehicleNo` / `manage.vehicleNo`) — record/open с
   `?vehicleNo=…`; diagnosis. Все optional: 404/таймаут → `None`.
3. Классический чек — `_fetch_legacy_marks(source_id)`: GET mdsl-страницы
   (EUC-KR, `errors="replace"`), regex `_MDSL_PANEL_RE` вытаскивает панели
   `code/name/value/lank` из блока `performanceCheck`.
   `_parse_mdsl_panels`: внешняя панель (`_MDSL_OUTER_ZONE`) с ранком «2»
   → mark `type="repair"`; панель скелета (`_MDSL_FRAME_ZONE`) с ранком
   B/C → `type="frame"` (note=C). Панели без дефектов пропускаются.
   Карта повреждений «двух машинок» живёт ТОЛЬКО здесь (JSON-outers у
   большинства авто пуст) — поэтому источник незаменим.
4. `_apply_detail` накладывает всё на UnifiedListing in-place:
   - VIN по ISO 3779 (`^[A-HJ-NPR-Z0-9]{17}$`, без I/O/Q) — мусор
     («수입차», госномер) в `listings.vin` не попадает;
   - `spec.displacement` (см³) → `engine_volume`;
   - фото: полный набор detail.photos; `DIAG`/`DIAG2` (сканы чека) — в
     отчёт осмотра, НЕ в галерею; фото чека = сканы + днище
     (`advertisement.underBodyPhotos` с готовым photoUrl) + images из
     JSON-чека; лимит 20 на отчёт;
   - комплектация `_extract_options`: коды `options.standard` →
     `_STANDARD_OPTION_RU` (010 люк, 009 вентиляция, 087 360°, 095 HUD…),
     `options.tuning` → `_TUNING_OPTION_RU`; неизвестные коды и `choice`
     (1xxx) молча пропускаются — сырые коды на фронте не показываем; ≤60.
5. `_build_inspection` собирает отчёт осмотра (формат
   `inspection_reports`, upsert только `WHERE source='encar'` — ручные
   отчёты не перетираются):
   - **facts** (summary ≤1000 символов): диагностика пройдена/нет (+дата и
     центр), доступность записи ТО, Clean Encar, обременения (залог/пледж),
     отчёт верификации, прямой осмотр Encar, фото днища, примечание
     продавца (oneLineText), первая регистрация, гарантия страховой, чек
     заполнен продавцом (DIRECT_INPUT), история ДТП из госданных
     (счётчики по вине + полный список аварий с датами и выплатами в 원,
     полная гибель, наводнение, угоны, смены владельцев/номера, залог,
     коммерческое/гос использование) либо fallback record/summary, вердикт
     엔카진단 («무사고» → «без ДТП»);
   - **marks** (карта повреждений): из inspection.outers (корейское
     название зоны → `_outer_zone` по ключевым словам: 범퍼/보닛/도어/펜더/
     쿼터/록커/루프/트렁크, 좌/앞/뒤 → сторона), статус 교환→replace,
     판금→dent, 도색→repaint, 부식/녹→rust, 균열→crack, 깨짐→glass,
     흠집→scratch (неизвестный → scratch); из diagnosis (EN-зоны
     `_DIAGNOSIS_ZONES`, resultCode≠NORMAL); плюс legacy mdsl-ранки без
     дублей зон. Каждой зоне — координаты метки `pos:[x,y]` на официальных
     диаграммах Encar (`_ZONE_POS`, сняты с JS страницы чека: диаграмма
     outer = img_inspection01.gif, frame = img_inspection02_new.gif);
   - **items** (чек-лист 12 агрегатов): inspection.inners, группы S01–S07 →
     engine/transmission/steering/brakes/electronics/leaks (S00 —
     самодиагностика продавца, не маппится); статус пункта по коду:
     1 양호→ok, 2→ok(допустимо), 3→ok(нет), 10 불량→defect, 4/6/8→warn,
     5/7→defect(подтекание); в группе берётся худший; порядок фиксирован
     `_ITEM_ORDER`;
   - `inspector` из inspName (≤120), `inspected_at` из registrationDate,
     `grade` не выдумывается (None; ручную оценку ставит админ через
     PUT /api/listings/{id}/inspection).
6. `_translate_korean` переводит хангыль in-place (§9).

### 3.6. Healthcheck

`healthcheck()` делает page-0 запрос с «пустым» q `(And.Hidden.N.)` и
считает источник больным, если: сеть/5xx (любое исключение), в ответе нет
`Count`, или `Count > 0` при пустом `SearchResults` (сломанный контракт —
даже при HTTP 200). `Count=0` без SearchResults — здоров («нет данных»).

### 3.7. Анти-бот / ретраи

Специального анти-бота (капчи, подписи запросов) у Encar не требуется —
endpoints анонимны. Устойчивость обеспечивают: ретраи+backoff+Retry-After
в `HttpClient` (§1.3); вежливая параллельность detail-запросов (semaphore
5); прокси-пул для источников с `capabilities.use_proxy` (Encar в текущем
конфиге работает без прокси из контейнера); circuit-breaker источника
(5 ошибок подряд → пропуск) и ParserDoctor (`off/suggest/auto`): если
страницы есть, а карточек 0 (сменилась вёрстка) — fire-and-forget запуск
`repair_parser` (GLM предлагает/применяет ремонт конфига, затем
`registry.reload_source`).

---

## 4. Прочие адаптеры

- **kcar** (`kcar.py`, `KCarApiAdapter`): зашифрованный POST (AES-CBC,
  ключи из фронтового бандла kcar); пагинации в API нет — забирает top-N
  свежих одним запросом; перевод тех же полей; чеков осмотра у kcar нет
   (на фронте «у kcar чеков нет»).
- **che168** (`che168.py`, `Che168HtmlAdapter`, Китай): SSR-HTML-парсер
  (селекторы в config); источник засеян миграцией `0005` с `enabled=false`
   — включается владельцем после сверки селекторов и проверки
  гео-доступности (`use_proxy: true`).
- **korean.py** — удалён (см. шапку): transliteration заменена
  глоссарием + NLLB.
- Новые источники (mobile_de, copart, iaai) — этап 7+ ТЗ п. 14.3.

---

## 4a. Kolesa v2: детальные страницы (2026-10-29)

Списочный парсинг давал 1 фото и 5 полей; v2 добавила обогащение деталями
(`_enrich_from_details`, топ-8 карточек страницы, семафор 3):

- **Галерея**: все фото CDN нормализуются к полноразмеру `{N}-full.webp`
  (srcset-варианты схлопываются), дедуп по (bucket, номер), сортировка по
  номеру, лимит 10. Referer обязателен — без него деталь отдаёт 418.
- **Характеристики** `dt.value-title[title]`+`dd.value`: кузов, коробка,
  привод (передний/задний/полный → front/rear/awd), цвет, город, поколение,
  «Объем двигателя, л» («2.5 (гибрид)» → объём + fuel), «Пробег» (точнее
  списка). Всё — в `raw.detail_params` для перепарсинга.
- **Опции**: чипы `offer__option-label` → `options` (до 40, русские).
- Ошибка/418/500 карточки не роняет страницу — остаются данные списка.
  Конфиг: `enrich_details` (default true), `detail_limit`, `detail_concurrency`.

## 4b. Антибот-источники (dubizzle / cars_com / che168): включение

Imperva (dubizzle), Akamai (cars.com) и JS-челлендж EO_Bot_Ssid (che168)
закрывают и HTML, и публичные API с датацентровых IP (проверено 2026-10-29;
альтернативы yallamotor/ksl/guazi — тоже за стеной). Код готов к включению:

- `capabilities.use_proxy: true` (в сидах) → registry подставляет
  `ProxyPool` (Redis, ротация на запрос) в HttpClient;
- шлюз резидентных прокси: `PROXY_DATAIMPULSE_USER/PASS/HOST/PORT`
  (`app/config.py`; gw.dataimpulse.com:823 HTTPS) — fetch-воркер строит пул
  (`build_proxy_pool`); подойдёт любой резидентный провайдер;
- порядок включения: креды в .env → рестарт worker_fetch → PUT
  `/api/admin/sources/{name}` `enabled=true` → наблюдение healthcheck.

## 5. Fetch-воркер — `app/infrastructure/workers/fetch.py`

Запуск: `uv run python -m app.infrastructure.workers.fetch`. Очередь
RabbitMQ `fetch`; `TaskWorker` (legacy aio-pika) c `concurrency=3` и
**`job_timeout=360`** (encar с чеками+переводом не влезал в 120с — DLQ);
heartbeat для healthcheck. `HANDLERS`: `fetch_source_task`,
`mirror_photos_task`, `stale_check_job`, `translate_listings`,
`raw_retention_job`; интервальная `schedule_fetch_due` (60с) и кроны
03:30/04:00 UTC.

### 5.1. `schedule_fetch_due` (каждую минуту)

Источники `enabled` с `schedule_cron`, совпадающим с текущей минутой UTC
(`cron_matches`) → `enqueue_task("fetch_source_task", name)`. Дубли между
воркерами и повторные прогоны в ту же минуту отсечены Redis-локом
`sched:{source}:{YYYYMMDDHHMM}` (SET NX EX 120).

### 5.2. `fetch_source_task` по шагам

1. **Circuit breaker**: `should_skip_source` (5 ошибок подряд) →
   `{"skipped": true}` без похода наружу.
2. `registry.get(source)` (KeyError → ошибка в результате, не эксепшн).
3. Цикл по страницам (`max_pages`, из очереди по умолчанию 3):
   `adapter.fetch(criteria, cursor)` → `save_listings` (§6) →
   `record_success(source, latency_ms, fetched)`; если есть new/updated →
   `publisher.enqueue("mirror_photos_task", source)` — зеркалирование
   уходит фоновой задачей, чтобы не удлинять fetch; следующий курсор из
   `next_cursor` (нет `has_more`/курсора → стоп).
4. Исключение цикла → `record_error` (питает CB) и результат с ошибкой.
5. После цикла: new/price_changed/reactivated > 0 → очередь `send`
   (`notify_new_listings`); id списками → `listing_status_scan`
   (`price_drop` / `returned`); translate_ids → `translate_listings`
   (чанки, §9.3).
6. Страницы были, а карточек 0 → `_fire_doctor` (ParserDoctor,
   fire-and-forget; ошибки — только в лог).
7. Результат: счётчики `{new, updated, unchanged, price_changed,
   reactivated, cross_dup}` + pages.

### 5.3. `mirror_photos_task` — S3-зеркало фото (фон)

1. Берёт `MARKET_MIRROR_BATCH=40` свежих активных внешних лотов источника
   (`parsed_at DESC`, `owner_type IS NULL` — owner-лоты не трогаем).
2. Для каждого: если `photos.has_mirror(source, source_id)` → skip
   (head-префикс list_objects_v2, MaxKeys=1).
3. Качает первые `MARKET_PHOTO_MIRROR_LIMIT=5` фото (httpx, follow
   redirects, таймаут 10с); ext по content-type (png/webp/jpg);
   `mirror_photo` кладёт с индексом в ключе (§7).
4. **Полный успех** (все `min(len(urls), limit)` фото) → новые S3-URL
   пишутся в `listings.images` (после цикла, одним commit).
   **Частичный сбой** → `delete_lot_mirror` (откат зеркала: порядок не
   ломаем, следующий прогон повторит). Любая ошибка задачи — warning,
   задача не роняет воркер.

### 5.4. `stale_check_job` (cron 04:00 UTC) — см. §8.

### 5.5. `raw_retention_job` (cron 03:30 UTC)

Удаляет S3-объекты raw старше `RAW_RETENTION_DAYS=180`
(`storage.delete_older_than`) и обнуляет `listings.raw_key` точных
совпадений ключей — иначе админка генерит presigned URL на несуществующие
объекты. Гонка с fetch невозможна: ключ содержит yyyy/mm парсинга.

### 5.6. Startup/shutdown

Собирает ctx: Redis; translate-клиент (§9); `AdapterRegistry`
(session_factory, proxy_pool из DataImpulse/Redis, translator) + `load()`;
`S3Storage` raw (ensure_bucket — сбой не роняет старт: raw деградирует в
NULL); `PhotosStorage`; `TaskPublisher`. Shutdown: `registry.aclose()`,
redis close.

---

## 6. Инжест: `save_listings` → listings

Фасад `app/infrastructure/services/fetch.py`; логика по слоям:
`domain/listings/ingestion.py` (правила), `infrastructure/db/repositories/
listings_writer.py` (SQL), `application/listings/ingest.py` (сценарий).

### 6.1. Дедупликация (`common/dedup.py`)

- Внутри источника: уникальный индекс `(source, source_id)`.
- Между источниками: Redis-ключи по VIN или fuzzy-хэшу (TTL 48ч, версия
  `v3`; пробег в fuzzy-ключе округляется до 1000 км). Атомарный claim
  Lua-скриптом: если ЛЮБОЙ ключ существует — дубликат; иначе выставляются
  ВСЕ ключи (частичный SET не «отравляет» ключи).

### 6.2. Upsert

CTE-upsert одним запросом (§ writer): `existing` (FOR UPDATE) даёт
старые значения → классификация new/updated/unchanged/price_changed/
reactivated; конфликт `(source, source_id)` обновляет поля и
`last_seen_at`. Точка цены пишется в `listing_price_history` при смене
пары (price, currency) и первой записи. Отчёты осмотра — upsert в
`inspection_reports` c `WHERE source='encar'` в SAVEPOINT.

### 6.3. raw-payload в S3

`content_hash = sha256(title|price|currency|mileage|sorted(images))` —
без дат (меняются каждый парсинг). NEW или смена хэша → JSON
`UnifiedListing.raw` кладётся в bucket `raw-payloads` по ключу
`raw/{source}/{yyyy}/{mm}/{listing_id}_{hash}.json`; в БД — только
`raw_key`. Хэш не изменился → объект не перезаписываем. Ошибка S3 →
raw_key NULL, инжест не ломается. retention — §5.5.

`translate_ids` = NEW + смена content_hash (триггер повторного перевода).

---

## 7. PhotosStorage — `app/infrastructure/storage/photos.py`

Bucket `market-photos` (public-read policy, ставится при создании;
креды/endpoint — общие `S3_*`, но жизненный цикл отдельный от raw).
Отдаёт ПУБЛИЧНЫЕ URL `{S3_PUBLIC_URL}/{bucket}/{key}` — фронт грузит
`<img>` напрямую, presign не нужен.

| Метод | Сигнатура | Что делает |
|---|---|---|
| `mirror_photo` | `(source: str, source_id: str, index: int, content: bytes, ext: str) -> str` | ключ `mirror/{source}/{source_id}/{index:03d}.{ext}` — **индекс в ключе = порядок фото**; лексикографическая сортировка ключей = порядок источника; content-type по ext |
| `has_mirror` | `(source, source_id) -> bool` | list_objects_v2 по префиксу, MaxKeys=1 |
| `delete_lot_mirror` | `(source, source_id) -> int` | пагинированное удаление всех объектов префикса (лот исчез) |
| `upload` | `(user_id: int, content: bytes, ext: str) -> str` | пользовательские фото рынка: `photos/{user_id}/{uuid4}.{ext}` (uuid, не hash: повтор = новый объект; лимит 10 фото/лот держит фронт) |
| `ensure_bucket` | `() -> bool` | создать bucket + идемпотентно повесить public-read policy (lazy, один раз на процесс — `_ensure_once` под локом) |

Зеркала касаются ТОЛЬКО внешних лотов; пользовательские фото рынка —
контент владельца, cleanup'ом stale не затрагиваются.

---

## 8. Удаление исчезнувших лотов — `stale_check_job` + `_purge_gone_storage`

1. `mark_stale` (writer): активные строки с `last_seen_at` старше
   `STALE_MAX_AGE_DAYS=3` → `is_active=false, disappeared_at=now()`;
   источники в circuit breaker пропускаются (лежащий источник не мог
   видеть лоты). Возвращает id «пропавших».
2. `enqueue_status_scan(ctx, "gone", ids)` — очередь `send`
   (`listing_status_scan`) — уведомления аудитории sent_log.
3. `_purge_gone_storage(ids)`: `gone_external_rows` (только ВНЕШНИЕ лоты:
   source + source_id + raw_key; owner-лоты не трогаем) → для каждого
   `photos.delete_lot_mirror(source, source_id)` и `raw_store.delete(
   raw_key)`. Всё best-effort: ошибки — warning, stale-check не роняют.

---

## 9. Перевод (хангыль → русский)

### 9.1. Микросервис `services/translate/translate_api`

FastAPI + `facebook/nllb-200-distilled-600M` (CPU, инференс в threadpool;
`TRANSLATE_MODEL` перекрывается). `POST /translate {texts[], source_lang,
target_lang}` → `{translations: [...]}` (null = не перевелось);
`source_lang="auto"` — детект по письменности. Модель грузится и
прогревается на старте (иначе первый батч ушёл бы в fallback). Bearer
`API_TOKEN` (если задан). Сторож памяти: при RSS >
`TRANSLATE_MAX_RSS_MB=2800` процесс завершается — docker поднимает
заново с прогревом; плюс mem_limit в compose (двойная страховка OOM).

### 9.2. Клиент и глоссарий

- Клиент (`infrastructure/services/translate_client.py`, слои
  `application/translation` + `infrastructure/translation/client.py`):
  кэш Redis `tr:{target}:{src}:{sha1(text)}` TTL 30 дней (корейские
  заголовки повторяются массово — экономия 90%+ CPU), retry с backoff на
  сетевые ошибки, circuit breaker (N ошибок подряд → пауза + алерт);
  перевод НЕкритичен: любая ошибка → None → UI показывает оригинал.
- Глоссарий `domain/translation/glossary.py` (`apply_glossary`):
  канонизация брендов/моделей/цветов/терминов чека (교환→замена,
  도색→окрас…) ДО модели — иначе NLLB переводит «현대» как «современный».
- Включение: `TRANSLATE_ENABLED` + `TRANSLATE_SERVICE_URL`;
  `TRANSLATE_SOURCE_LANGS` — карта источник→NLLB-код (дефолт auto).

### 9.3. Где переводится

- **Адаптер encar** (`_translate_korean`): in-place перевод полей
  make/model/generation/color и структур отчёта осмотра (inspector,
  summary, notes) — строки с хангылем собираются рекурсивно, глоссарий,
  срез 500 символов, единый батч; ошибки не роняют fetch.
- **Тайтлы** — задача `translate_listings` (fetch-воркер): читает
  `title_raw`, батчами `TRANSLATE_BATCH_SIZE=32`, глоссарий до NLLB,
  bulk-UPDATE `title_ru/source_language/translated_at` (Core UPDATE по
  bindparam, без ORM). Enqueue дробит id на чанки `min(16, max(8,
  batch_size))` — CPU-инференс большую пачку не укладывал в job-timeout
  120с очереди. 0 из N переведённых при непустых тайтлах →
  `RuntimeError` → воркер ретраит задачу (attempt 3/3).
- **Обогащение спеков на PDP** (`enrich_listing_specs`): остатки хангыля
  (цвет «진주색» и пр.) через тот же клиент; одна попытка на лот
  (`specs_enriched_at`).
- Чаты дополнительно маскируют контакты (`domain/shared/contacts`) —
  в seller/deal/group.

---

## 10. Как добавить новый источник (пошагово)

1. **Адаптер** — `app/infrastructure/sources/<name>.py`, класс
   `XxxAdapter(BaseApiAdapter)`: реализуйте `async fetch(criteria, cursor)
   -> FetchResult` (маппинг в `UnifiedListing`, пагинация курсором или
   `has_more=False` для top-N) и `async healthcheck() -> bool`. Все сетевые
   вызовы — через `self.http` (`get_json`/`post_json`), никаких прямых
   httpx. Конфигурируемое (URL, page_size, селекторы) — из
   `self.config`, таймауты/лимиты валидируйте в `__init__` с явными
   ValueError. Хангыль — через `translator` (§9.1).
2. **Регистрация класса** — `app/infrastructure/sources/__init__.py`:
   добавьте класс в `ADAPTER_CLASSES` (ключ = `sources.adapter_class`).
3. **Конфиг в БД** — через админку `PUT /api/admin/sources/<name>`
   (`SourceConfigDTO`): adapter_class, kind, enabled, schedule_cron,
   rate_limit_per_min, timeout_sec, config (ваши ключи), capabilities
   (`use_proxy: true` — если источник гео-блокирован), credentials_ref
   (если нужны ключи: env `SOURCE_..._CREDENTIALS='{"api_key":…}'`).
   Либо alembic-миграция с INSERT (по образцу `0005_add_che168_source`).
4. **Тесты** — `tests/infrastructure/`: мок `httpx.MockTransport` через
   `http_client=`, кейсы: маппинг полей, пустая выдача, сломанный JSON,
   429/ретраи, healthcheck. Примеры: существующие сьюты encar/kcar.
5. **Проверка**: `POST /api/admin/sources/<name>/fetch` (max_pages=1) →
   логи воркера (`fetch_failed`/`adapters_loaded`) → `GET /sources/
   <name>/health` → лента/`listings` в БД. Наполнение — само через
   schedule_cron; stale/mirror/translate подхватываются автоматически
   (общий конвейер §5-§9, отдельных правок не нужно).

---

## 11. Сводная таблица «эндпоинт Encar → наши поля»

| Эндпоинт (readside) | Наши данные |
|---|---|
| `search/car/list/general` | `listings`: source_id, url, title, make, model, generation, year, price (ман×10⁴ KRW), mileage_km, body_type, fuel, transmission, color, location, images (частично), published_at; raw → S3 |
| `vehicle/{id}` | vin (ISO 3779), engine_volume (см³→л), images (полный набор), options→`listings.options` (RU), advertisement/condition/view → facts отчёта |
| `clean-encar/vehicle/{id}` | fact «Clean Encar: безаварийная/не подтверждён» |
| `inspection/vehicle/{vid}` | `inspection_reports`: master→facts (ДТП/ремонт/первая регистрация/гарантия), outers→marks (зоны+тип дефекта), inners→items (12 агрегатов), images→фото чека |
| `inspection/…/summary` | `inspector` (центр+инспектор) |
| `record/vehicle/{vid}/summary` | facts: страховые случаи, утопления, угоны, смены владельцев/номера, залог (fallback) |
| `record/vehicle/{vid}/open` | facts: полный список ДТП с датами и выплатами, полная гибель, наводнение, коммерческое/гос использование, первая регистрация |
| `diagnosis/vehicle/{vid}` | marks (EN-зоны, resultCode≠NORMAL), facts: вердикт диагностики + дата/центр |
| `mdsl_regcar.do` (www) | marks «две машинки»: внешние панели ранк 2 → repair, скелет B/C → frame; координаты `pos` из `_ZONE_POS` |
| `ci.encar.com/{path}` | фото → галерея/зеркало S3 `mirror/encar/{id}/NNN.jpg` |

---

Смежные доки: [ARCHITECTURE.md](ARCHITECTURE.md) (слои/очереди/S3),
[OPERATIONS.md](OPERATIONS.md) (env парсинга: PROXY_*, TRANSLATE_*,
S3_*, MARKET_PHOTO_MIRROR_LIMIT; ступени compose workers/storage),
[RUNBOOK.md](RUNBOOK.md) (DLQ, circuit breaker, job-timeout 360),
[TESTING.md](TESTING.md) (suite инфраструктуры: воркеры, S3-зеркало,
источники).
