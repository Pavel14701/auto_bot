# Техдолг (актуально на 2026-10-28, вечер — после волн NAV-V2 / F-mini / F-partner)

Статусы: ✅ закрыто · 🟡 частично/принято с оговоркой · ⬜ открыто.
Каждый пункт сверен с кодом; у закрытых — где искать подтверждение.

## Продукт

- ⬜ **Vision-дефекты на фото** (царапины/перекрас по фотографиям лота) и
  **предиктивное время продажи** — следующая AI-волна; нужна vision-модель,
  в репозитории контура нет (`app/infrastructure/ai`, `docs/AI.md`).
- ⬜ **Encar-диаграммы тянутся с www.encar.com** — гео-блок РФ: фоновые
  картинки «двух машинок» не грузятся у части пользователей. Завендорить
  gif (img_inspection01.gif / img_inspection02_new.gif) в MinIO/public:
  `frontend/src/components/Inspection.tsx:22` (`DIAGRAM_BASE`) и
  `frontend/src/partner/PartnerInspections.tsx:150`.
- 🟡 **Мобильный UX-полиш (Фиттс/Хик)** — волна, прерванная лимитом
  агентов, в основном долита 2026-10-28: блок «Mobile UX 2026-10» в
  `frontend/src/index.css` (чипсы/тогглы/сортировка ≥44px, хит-зоны
  псевдоэлементами у мелких иконок, «Наверх» выше FAB, секции и «Ещё
  параметры» в шите фильтров) + регрессионные маркеры в
  `frontend/src/styles.test.ts`; партнёрка — тач-зоны ≥44px в
  `frontend/src/partner/partner.css`. Остаток: точечный аудит форм
  (визард продажи `/sell`, длинные формы партнёрки) на экранах <360px.
- 🟡 **jsdom-глитч aria-expanded** (шторка «Ещё» партнёрки): jsdom не
  воспроизводит смену атрибута — `partnerChats.test.tsx` структурный,
  живой клик проверен только browser-use (документировано в
  docs/NAV-V2.md §4.6). Перепроверять руками при рефакторинге Sheet.

## Платформа (бэкенд)

- ⬜ **typing-событие без user_id** — `{ type: "typing"; thread_id?:
  string; user_type: string }` (`frontend/src/lib/chatSocket.ts:46`):
  в мульти-юзерных переговорных имя печатающего неточно (только роль).
  Нужен user_id в событии от бэка + отображение в сторе.
- ⬜ **Осиротевшие фото-загрузки**: `POST /api/market/photos` кладёт
  `photos/{user_id}/{uuid4}.jpg` (`app/infrastructure/storage/photos.py`),
  а лот может не быть создан — cleanup нет (retention/чистка существует
  только для `mirror/*` внешних лотов и raw). Нужен cron по префиксу
  `photos/` без ссылки из listings.images.
- ⬜ **rate_limit адаптера не enforced**: `BaseApiAdapter.rate_limit`
  сохраняется «для AdapterRegistry, который оборачивает fetch в лимитер»
  (`app/infrastructure/sources/base.py`, докстринг), но registry лимитер
  не ставит — поле декоративное. Обернуть fetch в rate-limiter или
  убрать поле.
- ⬜ **LPG-фасет Encar**: значение фасета `LPG(일반인 구입)` содержит
  `)`, ломающий синтаксис q-фильтра; сейчас отправляется
  `LPG(일반인 구입_)` (`app/infrastructure/sources/encar.py`,
  `ENCAR_FUEL_NAMES`) — escape-протокол не проверен на живом API; фильтр
  по газу может молча возвращать весь каталог.
- ⬜ **price_outlier по avg, не медиане**: правило модерации «цена < 10%
  средней по той же модели (comps упрощённо)»
  (`app/application/market/moderation.py`) — на редких моделях шумит;
  перевести на медиану как в quality/анализе цены.
- ⬜ **Партнёрский сэмплинг без приоритизации**: 10% партнёрских лотов
  уходит в ручную очередь просто по `random < PARTNER_SAMPLING_RATE`
  (`app/application/market/moderation.py`) — очередь модерации не
  приоритизирована (новый партнёр/жалобы не двигаются вперёд).
- ✅ **LLM-двойной вызов в путях истории** — не воспроизводится:
  `BuildHistoryReport` делает ровно один `_llm_paragraph` + кэш Redis
  24ч (`app/application/listings/history_report.py`); снято с контроля.

## Фронтенд

- 🟡 **Зеркало фото не обновляется при смене состава фото лота**:
  `mirror_photos_task` делает skip по `has_mirror` — если источник
  обновил набор фото, `save_listings` перезапишет `listings.images`
  внешними URL (гео-блок), а повторного зеркалирования не случится
  (старое зеркало остаётся). Вариант: сверка количества/etag или сброс
  зеркала при смене content_hash.
- 🟡 **Док-дрейф комментариев после NAV-V2**: шапка
  `frontend/src/screens/Chats.tsx` всё ещё описывает меню v3 («Маршрут
  /chats НЕ входит в NAV_ITEMS, вход — конверт-кнопка») — почистить при
  ближайшем касании файла.
- ⬜ **Бейдж «Чаты» партнёрки — poll 60с** (`PartnerApp.tsx`
  `fetchPartnerChats`), тогда как мини-апп живёт событиями личного
  канала; подписать партнёрский кабинет на `partner:{id}` Centrifugo.

## Тесты и инфраструктура

- 🟡 **Флэйк `tests/dialog/test_rag.py::test_answer_question_without_rag…`**
  — живой RAG вместо стаба; изолированно зелёный (см.
  [docs/RUNBOOK.md](docs/RUNBOOK.md), PROGRESS #96).
- 🟡 **vitest требует `threads=2` с `minThreads=1`** (tinypool
  конфликтует с дефолтной min и зависает) — заклинание закреплено в
  конфиге, но запуск с дефолтами CI сломает; помнить при миграции
  vitest/tinypool.

## Аудит 2026-10-29 — осознанно отложенное (полный реестр: docs/audits/2026-10-29-TRIAGE.md)

Безопасность:
- ⬜ **AUTH-02 (P2)**: refresh-JWT без ротации/version — утёкший refresh
  живёт 30д. Нужен `refresh_token_version` + ротация с детекцией re-use.
- ⬜ **AUTH-03 (P2)**: rate-limit на `/api/auth/login` и internal-ручки
  (Redis INCR + алерт в ADMIN_CHAT_ID).
- ⬜ **TOK-01/02 (P2)**: access+refresh в localStorage мини-аппа и
  партнёрский ключ в localStorage — структурный перенос refresh в
  httpOnly-cookie (решение владельца).
- ⬜ **PRIV-02 (P3)**: telegram_id в публичных ключах фото
  `photos/{uid}/…` — миграция ключей на uuid.
- ⬜ **PRIV-03 (P3)**: `/api/chats/online` — presence-оракул по
  произвольным id; ограничить участниками общих тредов.
- ⬜ **WS-01 (P3)**: ws-JWT 12ч без ревокации → TTL 1–2ч с авто-refresh.
- ⬜ **PHOT-01 (P3)**: внешние фото лотов = трекинг-пиксели владельца
  лота; рендер только S3-зеркал.
- ⬜ **CFG-01/CI-01/DEP-01 (P3)**: длинные плейсхолдеры секретов в
  bootstrap, пин CI-экшенов по SHA, npm-аудит в CI.
- ⬜ **INFRA-03/05 (P3)**: dev-порты хранилищ наружу (бинд на 127.0.0.1),
  centrifugo `allowed_origins` → домен миниаппа в проде.
- 👤 **Владельцу**: ротация MinIO-пароля на живом проде (после деплоя
  INFRA-01-фикса); SSO/отдельный ADMIN_TOKEN для админки вместо
  INTERNAL_TOKEN (ADM-01); подтвердить осознанную публичность ленты/
  фасетов (CHK-01); firewall для 8101–8107 в staging (CHK-02); отдельный
  RAG_JWT_SECRET (CHK-03).

Баги:
- ⬜ **B-12…B-18 (P3 бэка)**: по docs/audits/2026-10-29-bugs-backend.md
  (dañгрейд 0031 теряет country/city, naive-datetime в extend и др.).

UX:
- ⬜ **UX-008/010/017/018/020**: второй ряд чипсов-стран, пустая страна
  с «Сбросить страну», disabled-чипсы по фасету, гео в превью SellCar,
  подписи «Куда/Откуда везём» в Calc.
- ⬜ **UX-023/032/033**: единый <GeoBadge/> на три экрана, гео-фильтр и
  поля страны в партнёрских Рынке/Витрине/Объявлениях.
- ⬜ **UX-030/031**: семантика «Сбросить» в шите; чипс «Все» не должен
  скидывать страну.
- ⬜ Прочие UX-P3 — по таблице docs/audits/2026-10-29-uiux.md.
