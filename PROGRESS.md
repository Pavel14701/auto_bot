

## 97. Документация и чистка репозитория (2026-10-28)

- **Запрос:** переписать доки/README на актуальные, удалить временные
  ТЗ и мусор; документация должна быть максимально актуальной.
- **Удалено:** 30 tracked-мусорных файлов (логи парс-расследований
  _mdsl/_insp/_res/_fem, shots/), untracked-остатки; PLAN.md,
  REVIEW.md (устарели), docs/UIUX_TZ.md, docs/REDESIGN/ (12 рабочих
  спеки волн — суть перенесена в актуальные доки), docs/REFACTOR/,
  .zwork/, скрипты-пробы. .gitignore закрепил паттерны (_*.log и пр.).
- **README.md** — переписан: актуальные возможности (Mini App/рынок/
  чаты/переговорные/AI-контур/партнёрский кабинет/админка), ASCII-
  схема архитектуры с Centrifugo/S3, поэтапный быстрый старт,
  таблица документации.
- **docs/ переписаны (9):** ARCHITECTURE (слои, личный канал, данные,
  degradation, frontend), API (полный актуальный реестр эндпоинтов
  юзер/партнёр/админ), SOURCES (адаптеры, S3-зеркало с порядком,
  stale-cleanup, перевод), AI (анализ/история/описания/quality/
  summary/RAG-бот), MONETIZATION (таблица тарифов, размещения+пакеты,
  lifecycle-модерация, CPL, идемпотентность Stars), TESTING (структура
  ~1470 тестов, флэйк-RAG), SECURITY (гейты/маскировка/SSRF/uploads),
  RUNBOOK (DLQ/circuit breaker/centrifugo/stale-образы), ADR (реестр
  12 решений). OPERATIONS дополнен (ступенчатые профили, актуальные
  env-ключи рынка/centrifugo/S3; фикс пути бота app.transport.bot).
- **TECHDEBT.md** — сжат до актуальных долгов (мобильный UX, vision-
  дефекты, гео-блок диаграмм, typing-user_id и пр.).
- **Проверка:** pytest 1473/7skip (test_rag — известный живой-RAG
  флэйк, изолированно 27/27), vitest 547/547; git-status чист от
  мусора (286 позиций — только легитимные правки волн 5-12).


## 96. ИИ доверия: отчёт истории, генерация описаний, качество, выжимки (2026-10-28)

- **Запрос (приоритеты):** MVP = суммаризатор истории из Кореи (лот →
  отчёт на русском) — калькулятор «под ключ» и диалоговый поиск УЖЕ в
  проде; далее генерация описаний + «Качество объявления»; суммаризация
  диалогов для менеджеров. Спека: docs/REDESIGN/12-ai-trust.md.
- **B12:** GET /api/listings/{id}/history-report — факт-парсер ДТП по
  РЕАЛЬНЫМ данным 271 отчёта БД (два семейства: канонический русский
  адаптера + машиннопереведённые «accident history/DTA/DTS»; счётчик,
  вина, последнее ДТП+выплата, владельцы, регистрация, Clean-флаг) +
  LLM-вывод (сбой → только факты), кэш 24ч. POST /api/market/
  description — генерация описания из полей (гварды: только факты,
  RU, 400-800 зн.; free 5/день → 429). listing_quality — чистая функция
  (фото/описание/цена±20% медианы → score+tips) в my-lots/create.
  SummarizeThread — выжимка ≤600 зн. последних 50 сообщений, кэш 1ч;
  админ + партнёрские роуты. Тесты: history 5, description 4, quality
  7, summary 4 (итого pytest 1473/7skip, test_rag — живой RAG вместо
  стаба — экологический флейк).
- **F12 (547 vitest):** PDP «🤖 Отчёт истории» (кнопка → факты +
  «Вывод» + Обновить; 404-строка; гость скрыт); SellCar шаг 3 —
  «✨ Сгенерировать описание» (photos_count по done-фото, confirm при
  повторе, 429-тост) + live «Качество объявления» чек-лист; Profile
  my-lots — пилюля «Качество: N/100» (deal/warn/danger) + tip;
  «📄 Выжимка» в AdminChatRoom и PartnerChatRoom (обновляемая).
- **Живой смоук:** history-report 200 (факты: машина, ДТП-блок,
  mileage_confirmed, owner_history; LLM-вывод «Palisade 2023,
  пробег 15 000 км подтверждён...»); description 200 («Продаётся Kia
  Sorento 2022...»); quality {score 50, tips}; summary 200 после
  пересборки admin (образ был стейл — routes без summary).
- Деплой: catalog/chat/partners/miniapp/admin пересобраны.


## 95. Резильентность: поэтапный деплой + S3-зеркалирование фото (2026-10-28)

- **Запрос:** graceful degradation, ядро независимо от периферии,
  постепенное развёртывание; фото/инфо объявлений при парсинге — в S3
  с гарантией порядка; при удалении с источника — чистить хранилища.
  Спека: docs/REDESIGN/11-resilience-s3-ingest.md.
- **Ступени compose** (OPERATIONS.md «Поэтапное развёртывание»):
  base(postgres+redis) → core(backend-монолит+bot+miniapp) →
  storage(minio) → workers(rabbitmq+fetch/send+translate) →
  realtime(centrifugo+chat) → ai(dialog+qdrant+rag) → micro(gateway+8).
  depends_on rabbitmq/minio → required:false (ядро стартует без них).
  Деградация уже в коде: centrifugo fire-and-forget + поллинг-фоллбэк,
  translate → оригинал, RAG→LLM→фолбэк, S3 → 503 photos_unavailable.
- **Зеркалирование фото (11 §3):** PhotosStorage.mirror_photo/has_mirror/
  delete_lot_mirror — ключ mirror/{source}/{source_id}/{NNN}.jpg
  (индекс = порядок); фоновая задача mirror_photos_task (батч 40 лотов,
  первые 5 фото; частичный сбой → откат зеркала, порядок не мешаем;
  успех → listings.images = наши S3-URL). Триггер из fetch при
  new|updated. job_timeout очереди 120→360 (encar с чеками+NLLB не
  влезал — DLQ 96 задач, вычищен). Живой прогон: kcar mirrored=29,
  images заменены на market-photos/mirror/kcar/{id}/NNN.jpg.
- **Очистка (11 §4):** stale_check_job → gone_external_rows (только
  внешние, owner-лоты не трогаем) → delete_lot_mirror + raw_key
  delete (best-effort, ошибки не роняют stale).
- **Тесты:** test_s3_mirror.py (4: полный флоу/skip/disabled/stale-
  purge); тесты фронт-зеркал? нет — бэк. pytest 1451/7skip.
- **Осталось (R3, прервано usage-лимитом агентов):** мобильный
  UX-полиш мини-аппа и партнёрки (Фиттс/Хик/формы) — агенты упали на
  лимите, задача переоткрыта; frontend витесты 525/525 на текущем.


## 94. Жизненный цикл объявления: автомат статусов + модерация + версии (2026-10-28)

- **Запрос:** полный lifecycle от черновика до архива: конечный автомат,
  гибридная модерация (авто-правила + risk score + ручная очередь),
  версия-на-модерации при редактировании (старая видна), real-time
  статусы через личный канал, UX со статусами/причинами/исправлением.
  Спека: docs/REDESIGN/10-listing-lifecycle.md.
- **B:** миграция 0030 (status CHECK 6 состояний + backfill: внешние/
  живые owner → accepted, needs_payment → draft; rejected_reason,
  moderation_payload, pending_patch + индексы очередей). Общий модуль
  contact-детекта app/domain/shared/contacts.py (chat/privacy
  переиспользует). Модерация screen_lot: contacts/forbidden_words
  (hard reject), price_outlier/short_desc/new_user/duplicate (risk),
  пороги reject≥80|hard / manual≥30; партнёры авто-accept + 10% sampling.
  Use-cases: Create(draft|submit) → SubmitLot (синхронный скрининг →
  accepted/manual/rejected; placement-решение общее с create —
  needs_payment не блокирует модерацию), UpdateLot (draft/rejected
  прямые правки; accepted → pending_patch; прочие 409), админ-очереди
  moderate/patch (approve/reject/patch_accept/patch_reject) с
  применением патча и причинами. События {type:'listing_status'} в
  личный канал owner'а/партнёра после commit. Лента/PDP: только
  accepted; экспиратор → status='expired' (+оплата возвращает);
  снятие → archived. Словарь forbidden слов в конфиге (17 RU/EN).
- **F:** SellCar — «Сохранить черновик»/«Отправить на публикацию»,
  ветки accepted/needs_payment/moderation/rejected; edit-режим
  ?edit={id} (предзаполнение, PATCH для accepted с баннером старой
  версии, PATCH+submit для draft/rejected); «Мои объявления»:
  lifecycle-пилюли (Черновик/На проверке/Одобрено—оплата/Опубликовано/
  Отклонено+причина+violations/Правки на проверке/Снято/Истёк),
  CTA Продолжить/Исправить/Редактировать/Оплатить/Восстановить;
  live: chatStore-ветка listing_status → тосты + refresh my-lots
  (useListingStatus).
- **Живой смоук:** draft создан (в my-lots, в ленте нет) → submit →
  accepted (needs_payment из-за included-лота — «Одобрено, ждёт
  оплаты», монетизация не блокирует модерацию) → лот с телефоном в
  описании → rejected contacts_in_text с причиной. Backfill: 382 лота
  accepted.
- **Итог:** pytest 1447/7skip (test_rag — преждесуществующий флак),
  vitest 525/525, ruff чист; chat/catalog/admin/miniapp/partners/
  worker_send пересобраны. Долги: выборочная проверка (sampling) не
  имеет админ-приоритизации; price_outlier по avg (не медиане) для
  редких моделей шумноват; патчи фото: новые грузятся сразу (могут
  осиротеть при reject патча).


## 93. Личный канал Centrifugo + единый стор + двухколоночный UI (2026-10-28)

- **Запрос:** эталонный паттерн Centrifugo (GrandChat): один личный
  канал на пользователя вместо «канал на диалог», бэк — дирижёр, UI —
  виджеты над единым состоянием. Спека: docs/REDESIGN/09.
- **B (бэк):** ParticipantEventPublisher.publish_to_participants —
  единая точка: событие (message/read/typing/system/claim) уходит в
  личные каналы ВСЕХ участников (user:{tg}/partner:{id}, уникально,
  exclude отправителя); все прежние thread:{id}-публикации заменены;
  message-пейлоад = полный MessageView; POST typing (user+partner,
  rate 1/2с, 429 typing_rate_limit); GET online?ids= — presence
  личных каналов через Centrifugo HTTP API (параллельно, ≤50).
- **F (фронт):** lib/chatStore — единый стор (треды/unread/typing
  TTL/lot_expired, авто-read открытого, pendingUnread+throttle 10с на
  неизвестный тред) + транспорт подписывается ТОЛЬКО на user:{uid};
  поллинг-фоллбэк: раз в 5с список + after_id открытого; typing-отправка
  debounce 1.5с; двухколоночный десктоп ≥900px (сайдбар 340px + комната,
  выбор без ухода, активная строка, «Выберите диалог»); онлайн-точки
  (полл 30с, 1:1 в шапке, group в чипах); ChatBadge live-unread.
- **P0-находка при смоук-тесте:** ws-подписка на user:{id} падала
  «unknown channel» — namespace user/partner/thread не был объявлен в
  конфиге Centrifugo (v6: без namespace-опций каналы с двоеточием
  запрещены; ФРОНТ ВСЁ ВРЕМЯ ЖИЛ НА ПОЛЛИНГ-ФОЛЛБЭКЕ). Фикс конфига:
  namespaces user/partner/thread {subscribe_proxy_enabled, presence}.
- **Живой смоук (ws):** подписка user:111111 → сообщение от u2
  (send 201) пришло в личный канал {type:message, thread_id, body}
  < 1с; typing 200 пришёл {type:typing}; повтор typing 429;
  online?ids=111111 при подключённом клиенте → [111111] (presence).
- **Итог:** pytest 1435/7skip, vitest 504/504, ruff чист;
  chat/partners/miniapp/worker_send пересобраны. NOTE: v6-синтаксис
  namespace: флаг subscribe_proxy_enabled + presence, вложенный
  proxy-ключ невалиден (warn unknown key) — зафиксировано.


## 92. Говернананс переговорных: роли, приватность, антифрод, аудит (2026-10-28)

- **Решение владельца:** переговорная до 5 — норм, если привязана к
  сделке и с говернансом (роли, приватность, антифрод, аудит,
  уведомления/выход). Спека: docs/REDESIGN/08-group-governance.md.
- **B1:** миграция 0029 (participants role/muted, threads.closed_at,
  chat_events, chat_reports + partial unique). Привязка: group только
  по листингу (409 group_needs_listing), title-автоген. Роли: owner/
  member; приглашает только owner (403), кик owner→member, owner-leave
  только последним (409 owner_must_archive), пустая комната закрывается;
  архив → read-only (403 thread_archived), идемпотентен. Приватность:
  mask_contacts (телефоны ≥9 цифр с +/8; wa.me/whatsapp; t.me кроме
  нашего бота и share) в seller/deal/group (support не трогаем) —
  до валидации длины; 16 юнит-тестов паттерна. Антифрод: rate-limit
  20/мин (user+partner), жалобы (4 причины, идемпотент partial-unique),
  админ: список/PATCH/kick любого. Аудит: chat_events на все операции,
  GET admin events; retention 90д — скрытие фильтром (без cron).
  Mute: свои уведомления, ThreadOut.muted/role + participants[].role
  (три коррелированных подзапроса в списке тредов).
- **F1:** создание переговорной — лот обязателен (заглушка без истории
  просмотров); комната: меню ⋯ (mute/жалоба/покинуть/архивировать,
  owner-подсказка), чипы участников с короной, кик по тапу (confirm),
  панель жалобы с reason-чипами, confirm-диалоги, плашка «Архив»
  вместо композера; список: секция «Архив», muted 🔕 без счётчика;
  бейдж конверта не считает muted; партнёрский минимум (mute/leave).
- **Живой смоук:** 409 без лота; group по Palisade → title-автоген в
  БД; сообщение «+7 999… wa.me/…» → оба замаскированы; join вторым →
  роли [owner, member]; mute 200; жалоба 201/повтор 200; кик 200;
  архив 200; сообщение после → 403.
- **Итог:** pytest 1422/7skip, vitest 470/470, ruff чист; chat/miniapp/
  partners пересобраны. Долги: POST-ответ создания group не отдаёт
  title (косметика), typing-событие без user_id (наследие), маска
  может зацепить длинные заказ-номера с 8-префиксом (задокументировано
  в тестах).


## 91. Волна 07: продажа v2, переговорные, партнёрские чеки «как в Корее» (2026-10-27)

- **Запрос:** переработать добавление машины в продажу и чаты («ущербные»);
  UI/UX чатов (меню: диалоги + переговорные до 5 человек); партнёрам —
  создавать чеки осмотра и историю машины как в Корее.
- **Спека:** docs/REDESIGN/07-sell-chats-partner-inspection.md (оркестратор).
- **B1:** миграция 0028 (type+'group', chat title, listings.owner_history);
  POST /api/market/photos — multipart → MinIO bucket market-photos
  (public-read policy, сниф магики, 8MB, uuid-ключи); group-чаты
  (create/invite-код redis 7д/join с advisory-lock и лимитом 5,
  participants с именами в ThreadOut — только для group); партнёрские
  GET/PUT inspection (InspectionReportIn reuse, source='partner',
  bypass тариф-гейта только владельцу) + PUT history (≤50 событий).
- **F1:** SellCar v2 — визард 3 шага (Авто→Фото→Цена), drag&drop с
  мгновенной загрузкой и прогрессом, черновик в sessionStorage, счётчик
  n/10; чаты v2 — сегмент «Диалоги | Переговорные», создание переговорной
  (title + лот из истории просмотров), инвайт-код с копированием, join по
  коду (409 «заполнена»), group-шапка с участниками «Вы, Имя · 3/5»,
  имя автора над пузырями; UX: скелетоны, дата-разделители, inline-ошибки
  с «Повторить», safe-area композера, typing с именем.
- **F2:** раздел «Чеки и история» в кабинете — диаграммы Encar с
  hotspot-зонами (карта координат из encar.py), пины повреждений
  (тип+заметка), чек-лист 12 агрегатов × статусы, шапка чека
  (центр/дата/оценка), история-таймлайн CRUD; индикатор «чек есть/нет»
  на списке лотов.
- **Деплой-фиксы оркестратора (живые):** MinIO policy без Version →
  MalformedPolicy (добавлена), gateway /api/partner/listings → chat
  (404 в partners), marker_subquery без correlate → декартов JOIN в
  GET /api/chats (more than one row) — correlate(ChatThread).
- **Ревизор:** 503 photos_unavailable вместо 500 при лежащем S3, ранний
  отсев размера по UploadFile.size, идемпотентный двойной join под
  advisory-lock, PDP-блок «История машины» (таймлайн из owner_history),
  снос мёртвой копии policy.
- **Живой смоук:** фото PNG → 201 → public-URL 200; group create →
  invite CSJ9CD → join юзером 222222 → 2 участника в GET /api/chats;
  partner inspection PUT 200, history PUT 200 → ListingOut 2 события.
- **Итог:** pytest 1393/7skip, vitest 444/444, ruff чист; chat/catalog/
  partners/miniapp пересобраны, стек healthy. Долги: encar-диаграммы
  тянутся с encar.com (гео-блок РФ — завендорить в MinIO/assets),
  осиротевшие фото без cleanup, typing-событие без user_id.


## 90. Разворот рынка: владельцы, размещения, чаты user-user (2026-10-27)

- **Запрос владельца:** чаты только после входа; «сообщения к источнику
  парсера» не имеют экономического смысла; рынок = единая абстракция лотов
  партнёров; размещения объявлений пользователями (free-период → символика
  20★/нед; включённый лот на платных; пакеты партнёрам); чаты user↔user и
  user↔partner.
- **Спека:** docs/REDESIGN/06-market-user-listings.md (писал оркестратор;
  агент падал по DNS-сбоям — дважды перезапуск, частичные правки
  подхватывались).
- **B1 (бэк):** миграция 0027 (owner-колонки listings + слоты партнёра +
  закрытие старых операторских seller-тредов); POST /api/market/lots
  (free 7д → needs_payment, включённый для платных, квота 3 доп.),
  my-lots/extend (Stars kind='placement', вебхук идемпотентен),
  пакеты партнёров со баланса (атомарные UPDATE…WHERE инварианты),
  partner/market/lots со слотами; лента source=market → owner-based
  (JOIN витрины убран); чаты: гость 403 на всех /api/chats* (вкл.
  ws-token), seller-chat: внешний лот 409 market_lot_required,
  owner=user → тред двух юзеров (participant владельца);
  экспиратор cron 03:40 (деактивация + publish lot_expired,
  included-даунгрейд +7д).
- **F1 (фронт):** экран «Продать авто» (+FAB на ленте), «Мои объявления»
  в профиле (пилюли статусов, продление 1/4 нед через openInvoice,
  снятие), бейджи «🏪 Салон»/«👤 Частник», PDP «От владельца» и кнопка
  продавца только для owner-лотов, партнёрский раздел «Объявления»
  (пакеты/размещение/снятие), конверт чатов скрыт гостю. 383 vitest.
- **Ревизор (P0!):** 1) оплата размещений была СЛОМАНА — pre_checkout
  бота принимал только sub:, plc: отклонялся (Telegram не давал платить);
  whitelist+сообщение «Объявление продлено»; 2) дыра бесконечных
  free-недель ротацией (снять→новый лот→новые 7д) — кулдаун 30д
  (market_free_cooldown_days по first_seen_at owner-лотов); 3)
  контракт-дрейв фронта (id/photos vs listing_id/images и т.п.) —
  нормализовано; 4) гонка openInvoice vs вебхук — bounded-поллинг PDP.
- **Живой смоук:** юзер business создал лот (included, feed owner=user),
  seller-chat self-тред 201, гость ws-token 403; партнёр: пакеты 10/50/
  200 (500/1800/5000₽), покупка со баланса (slots_free=10), размещение
  Palisade (slot), market feed = [partner Palisade, user Sportage];
  внешний encar seller-chat 409 market_lot_required.
- **Итог:** pytest 1360 passed / 7 skipped (test_rag — флейк под
  нагрузкой, изолированно зелёный), vitest 383/383, ruff чист;
  chat/gateway/catalog/partners/bot/miniapp/worker_send пересобраны.
  Риски ревизора — ЗАКРЫТЫ (2026-10-27, вечер): условный mark_paid
  (UPDATE…WHERE status!='paid', rowcount=0 → replay-ответ; подписки и
  размещения), advisory-lock pg_advisory_xact_lock на создание user-лота
  (гонка двойного POST), слоты партнёра в /me (проброс PartnerAccountState
  → Overview → /me; попутно найдено: ORM-модель PartnerAccount не имела
  колонок-слотов — добавлены), «included»-пилюля для живого лота платного
  тарифа (free_until от даунгрейда не показывает «истёк»); оживление
  снятого лота оплатой — осознанно оставлено (юзер заплатил).
- **Операторский контур (субагент):** POST /api/chats/{id}/summon-operator
  («Позвать человека» теперь реален: bot_paused + system-msg + publish;
  кнопка ChatRoom зовёт бэк, подтверждение по сокету); операторские API
  /api/admin/chats* (X-Internal-Token): список support-тредов (paused-
  фильтр, сниппеты юзера), unread-count, сообщения от operator (repo сам
  ставит/снимает bot_paused); админ-фронт «Поддержка» (поллинг 30с,
  AdminChatRoom с markdown, поллинг 10с). Живой смоук: summon 200 →
  оператор ответил → юзер увидел «Оператор на связи!» → unread 0.
- **Итог:** pytest 1370 passed / 7 skipped (test_rag — флейк живого RAG,
  изолированно зелёный), vitest 392/392; chat/gateway/admin/partners/bot/
  miniapp/worker_send пересобраны, 21 контейнер healthy.


## 89. Чаты, поддержка и внутренний рынок: Centrifugo-контур (2026-10-26)

- **Запрос:** меню поддержки (RAG+чаты), чаты с продавцами, внутренний
  рынок с услугой «агент на сделку» в чатах, стек Centrifugo, Markdown
  и превью ссылок (внутр./внешн.), встроить в оба контура.
- **Спека:** docs/REDESIGN/05-chats-marketplace.md (написана
  оркестратором — агенты дважды падали по сети на генерации).
- **B1 (инфра+API):** модели ChatThread/ChatMessage/ChatParticipant/
  PartnerOffer (миграция 0026, применена); REST: треды support/seller/
  deal, сообщения (before/after-пагинация), read-маркеры, ws-token,
  subscribe-proxy (по sub из JWT centrifugo), link-preview (internal
  карточка + OG с SSRF: приватные IP/редиректы/лимит 512KB/кэш 24ч);
  партнёрские зеркала + витрина offers CRUD; сервис chat (8107) +
  gateway-маршруты; centrifugo v6 (compose, конфиг-шаблон с подстановкой
  env — JSON env не умеет; тег v6, т.к. v6.12.0 блокирован зеркалом
  registry). Seller-chat: POST /api/chats/seller/{listing_id}.
  Мои доводки B1: func.literal→sqlalchemy literal, семантика пагинации
  «ближайшие к курсору», unread включает system, фикс тестов.
- **B2 (интеграции):** RAG-бот поддержки (SessionSupportBotRunner —
  собственная сессия, RAG→LLM-фолбэк с историей треда, bot_paused,
  free 15/24ч → апселл-сообщение, typing→publish до генерации);
  POST /agent создаёт deal-тред + system-msg (reuse по lead_id);
  ClaimLead привязывает partner_id треда + «агент подключился»;
  лента: source=market (JOIN partner_offers) + has_market в карточках.
- **F1/F2 (фронты):** ядро — transport (centrifuge-js + поллинг-fallback
  5с, единые payload'ы), markdown (marked+DOMPurify), internal-карточки
  ссылок /listing/N, OG-превью внешних; экран «Чаты» (список+комната,
  ✓/✓✓, typing), конверт-бейдж (сайдбар/моб-флоат, poll 60с + личный
  канал), PDP «Спросить продавца» и «Агент» ведут в треды, чипс
  «🏪 Рынок» в ленте; партнёрский кабинет: разделы «Чаты» (seller/deal,
  партнёр справа) и «Витрина» (добавить/убрать лот). Мои доводки F2:
  тернарник api.ts, мок-дефолты списков, ассерты витрины/OG.
- **Ревизор (P0-находки):** мини-апп-чат был неработоспособен против
  реального бэка (плоские centrifugo-payload и REST-ответы vs ожидание
  конвертов — нормализаторы добавлены); ChatBadge-эффект перевзводится
  по autobot:auth; prod-guard секретов centrifugo (change-me запрещён);
  агент-кнопка ведёт в deal-тред; smoke: RequestAgent в catalog-профиле
  получает chat-репозиторий (общий DI-контейнер).
- **Деплой-доводка:** Dockerfile + services/chat (контейнер падал
  ModuleNotFound); конфиг-шаблон centrifugo (env-подстановка, слушает
  8000, публикация 8008→8000, subscribe-proxy→gateway); CENTRIFUGO_
  PUBLIC_URL для браузера (ws-token отдаёт публичный, publish ходит на
  внутренний); rag_api force-recreate (API_TOKEN не подхватился после
  docker start); healthcheck «любой HTTP-ответ = жив» (GET /health в
  v6.10 нет).
- **Живые смоуки:** ws-token (sub=user:111111), support-тред: бот
  отвечает (RAG-пусто → LLM по делу: «топ корейских моделей»), RAG-ask
  OK после рекреации; GET /api/chats отдаёт тред с unread; centrifugo
  /api info OK; все контейнеры healthy.
- **Итог:** pytest 1338 passed / 7 skipped; vitest 345/345; ruff чист.
  Долги (от ревизора): TOCTOU DNS-rebinding в OG, гость может писать в
  support через API (15/день на сессию), контур операторов (вклинивание
  человека) без HTTP-путей — ОСТАЮТСЯ. Закрыто на следующий день:
  «Отметить сделкой» из deal-треда партнёра (lead_id/lead_status в
  ThreadOut + CTA → feedback deal), идемпотентность POST /messages
  (Idempotency-Key, Redis SETNX 24ч, replay 200 без publish; фронт
  шлёт uuid-ключ), бейдж «🏪 Рынок» на карточках ленты.
- **Browser-use визуальный проход (26.10):** гость-заглушка Чатов;
  юзер: конверт-бейдж «4», список с сниппетом бота, комната поддержки
  с отрендеренным Markdown (strong/списки) и ✓; лента: чипс Рынка
  (после оффера партнёра — 1 авто Santa Fe MX5); PDP витринного лота:
  галерея 40 фото «1/40 +34», правая колонка, все кнопки; живой
  end-to-end: «Спросить продавца» → тред создан → сообщение ✓ →
  партнёр видит unread=2 в кабинете.


## 88. Сведение контуров: контакт партнёра в мини-аппе + карусели + полиш (2026-10-25)

- **Запрос:** «свести пользовательский и партнёрский контуры — нет
  механик взаимодействия/монетизации»; «анализ вправо на PDP как было»;
  отдельные субагенты на правки вёрстки и на галерею/карточки (скролл
  только на ПК, индикаторы, лимит 5 фото в ленте).
- **Контакт партнёра (монетизация CPL):** POST /api/listings/{id}/contact
  — любой тариф: лид source='web' падает в пул партнёров; rate-гейт 24ч
  (sent_log kind='contact', ON CONFLICT DO UPDATE — окно скользит);
  идемпотентность contact:{user}:{listing}:{date} (partial unique ловит
  гонки: второй получает 201 с тем же lead_id); гость → 403. Фронт:
  primary «Связаться с менеджером» в CTA-панели PDP, инлайн-форма с
  опц. комментарием (макс 500), тосты, localStorage-флаг отправленного,
  гость → логин-промпт. Ревизор: контракт/гонки/пул проверены + 2 фикса
  (дубль дефолт-комментария — теперь null с бэка; maxLength на textarea).
  Смоук живьём: 201 → лид #3 в пуле, повтор → 409 duplicate_contact.
- **PDP-колонка (фидбек «анализ вправо»):** desktop ≥768 — grid
  minmax(0,1fr) + clamp(340px,32vw,380px): слева контент, справа sticky
  `<aside>`: карточка AI-анализа + CTA-карточка (цена/статус → Связаться
  primary → Источник + hint → Избранное/Поделиться → Агент(business) →
  Доставка). Мобайл — одна колонка (анализ сразу после цены). Дублей
  CTA нет; sticky-mobile-bar не тронут.
- **Карусель карточек ленты (только ≥768):** scroll-snap + скрытый
  скроллбар, drag-to-scroll мышью (смещение >6px подавляет переход в
  PDP), точки-индикаторы (кликабельные, синхрон со скроллом, aria),
  ЛИМИТ 5 фото + «+N фото» градиент на последнем слайде; мобайл —
  одно фото как раньше. Галерея PDP: точки 2–10 фото (синхрон с
  треком/превью/лайтбоксом), >10 — счётчик «N / M»; snap-превью,
  автоскролл к активной миниатюре. prefers-reduced-motion respected.
- **Полиш вёрстки (19 артефактов):** inline-flex .btn (иконки/высоты),
  кнопки на 320px (nowrap→wrap), AiSearch композер под таб-баром,
  ai-chat__head wrap, двойные гаттеры .filter-pair в редакторе сигналов,
  Calc max-width/отступы/hero-wrap, пустые состояния центрированы
  (state--page/--panel), z-index плашки возврата в шкалу, партнёр:
  pa-quick/kpi/sheet-footer/toolbar переполнения на 320–360px.
- **Проверки:** бэкенд 1278 passed / 7 skipped; фронт 272/272 (30
  файлов, +12 карусель, +8 контакт); ruff чист; catalog+miniapp
  пересобраны; browser-use: PDP-колонка скрин, карусели рендер (20 шт),
  галерея 38 фото → счётчик; контакт live 201/409.


## 87. Фидбек-волна 2026-10-25: меню v3, история просмотров, «продано из избранного», лендинг, партнёрский кабинет (в работе)

- **Запрос:** меню-перегруппировка не зашла; карточка сбрасывается при
  смене вкладки (гость); хранить историю просмотров; проданные из
  избранного → уведомление с похожими и удаление; лента без границ и
  пагинации; типографика; фильтры криво; + редизайн партнёрского
  контура и лендинг-вход; процесс «исполнитель → ревизор → проверка».
- **Меню v3 (Shell):** Лента, AI, Избранное, История, Профиль —
  «Сигналы» ушли из таб-бара (секция «Мои сигналы» в Профиле + чипсы
  ленты). «История» = Просмотры + Разборы (сегменты).
- **История просмотров:** lib/viewHistory (localStorage по sub JWT,
  cap 50, дедуп; гостю тоже), запись событием listing:view из карточки;
  «Очистить историю»; deep-link ?similar= жив.
- **Keep-alive карточки:** ListingKeepAlive — карточка не размонтируется
  при переключении вкладок (hidden классом), новый id = новый key;
  плашка «← Вернуться к карточке» на табе-источнике; попутно найден и
  починен БАГ feedCache (POP-эвристика воскресала протухшим кэшем в
  новых сессиях — первый монтаж теперь никогда не восстанавливает).
- **Ревизор B (5 фиксов):** /filters отвечает массивом (Profile читал
  .items — всегда пусто), stale-гость в Истории (событие autobot:auth),
  deep-link ?similar раз за монтаж, плашка ниже фолда, width:fit-content.
- **Продано из избранного (бэкенд):** favorites_sold_job cron 04:30 —
  одним SQL выборка неактивных+неотправлявшихся, сообщение со списком
  до 5 машин + web_app-кнопки /analyses?similar=, favorite удаляется в
  ЛЮБОМ случае, антидубль kind='sold_fav'. Тесты 21, полный прогон 1271.
- **Лендинг-вход:** браузер + «/» без выбора → Landing (пользователи /
  партнёры → /partner); в Telegram и по deep-link — сразу приложение;
  выбор в localStorage autobot.surface (без перезагрузки).
- **Партнёрский редизайн:** дока docs/REDESIGN/04 (35 находок, IA:
  Обзор/Пул/Мои/Рынок/Биллинг, таб-бар на мобиле) → имплементация.
- **Лента (C, субагент + ревизор):** ограниченная область прокрутки
  (.feed-viewport + .feed-scroll с внутренним скроллом и body.feed-locked
  только на активной ленте), IO подгрузки с root=контейнер, шит фильтров
  через portal (фикс: шит позиционировался от колонки, пары селектов
  сжимались, двойной скролл, футер уезжал), ListingCard-пасс (бейджи
  поверх фото, clamp-2 модели, hover/focus, равная высота ряда),
  eyebrow-счётчик CAPS, tabular-nums. Ревизор C+L+P2: +7 фиксов
  (шит переживал уход с ленты, гонка logout в партнёрке, лендинг на
  пути query-deep-link, nowrap второй цены, мёртвый font-shorthand,
  focus карточек лендинга, favicon+viewport-fit).
- **Browser-use визуальный проход (web-gui-tester):** лендинг → приложение;
  лента desktop 1280 (3 колонки, две цены, чек-бейдж); PDP (перевод,
  цены, пейволл чеков, один primary, hint про блокировку); История
  (просмотры записались у гостя, сегменты); тёмная тема; мобайл 390
  (таб-бар, bounded-область); кабинет партнёра (KPI, квота, лоты дня,
  dual-links). НАЙДЕНЫ И ПОЧИНЕНЫ: 1) P0-баг keep-alive карточки —
  ListingScreen без Route-обёртки читал useParams → undefined →
  /api/listings/undefined 422 (фикс: Routes с location-подменой +
  регрессионный тест с 422-моком); 2) регрессия переводов — ночной
  fetch ловил 422 батчами >64 строк (лимит микросервиса) → чанкование
  по 48 в kcar-адаптере; база дочищена (хангыль 0, мусор 0, VIN 276+).
- **Итог:** бэкенд 1271 passed / 7 skipped; фронт 252/252 (29 файлов);
  ruff чист; miniapp+worker_fetch+worker_send пересобраны и живы.


## 86. Редизайн: имплементация волнами + red team + деплой (2026-10-24, ночь)

- **Волны имплементации (субагенты, параллельно по файловым зонам):**
  I1 — Shell (5 табов: Лента/AI/Сигналы/Избранное/Профиль, aria-current,
  тач ≥44), Tooltip (portal+fixed, flip/clamp, Esc), токены §9 (z-шкала
  toast>modal фикс, --text-primary алиас), onboarding 1 шаг, motion
  (fade-in-up, skeleton-pulse, prefers-reduced-motion). I2 — ListingCard
  (.lcard: 2 цены $+₽ tabular-nums, источник текстом без ссылки, 3 спека,
  бейджи чек/⬇️/🔴) и PDP по P1–P9 (один primary, тултипы вместо
  hint-строк, инлайн «Похожие», один hint про блокировку, осмотр
  свёрнут до сводки) и Feed (F1–F4/F10: суббар, bottom-sheet фильтров с
  живым счётчиком «N авто», чипсы «Мои сигналы»). I3 — AiSearch
  («Понял так», пост-финал «Показать в ленте»), Сигналы (карточки,
  inline-валидация, подтверждение удаления, тарифный гейт «⚡ Сразу»),
  Favorites/Analyses (verdict-бейджи, пустые состояния, квота-апселл),
  Profile/Calc/Compare на токены; apiErrorText — маппинг detail→русский.
- **Red team (11 фиксов):** P0×3 — deep-links/префиллы игнорировались
  на смонтированных keep-alive экранах (лента A2, Calc ?price=, Compare
  сид) → эффекты по location.search; P1×3 — ScrollManager (стек от
  верха, позиции табов сохраняются), Esc в LoginPrompt, скелетоны на
  .lcard (тёмная тема); P2×5 — catch удаления избранного, дедуп тостов,
  «Сигнал #N» везде, мёртвый CSS/классы снесены.
- **has_inspection (F7):** EXISTS в запросе страницы (инвариант одного
  SELECT для keyset сохранён); смоук: encar=True.
- **Чистка NLLB-склеек:** «K5ko»/«W167ko» (токен языка приклеен) —
  чистилка + regexp-чистка 53 строк в БД; кэш tr:* сброшен.
- **Деплой (минимальный docker):** miniapp+catalog+translate (3 сборки),
  бандл index-OEoJj03N.js (редизайн), has_inspection в API живой.
- **Итог проверок:** бэкенд pytest 1265 passed / 7 skipped; фронт
  `npm run build` OK + vitest 192/192 (25 файлов); ruff чист (app+tests).


## 85. Редизайн Mini App: дизайн-фаза + волны имплементации (2026-10-24, вечер)

- **Запрос владельца:** «фронт говно, переделывай всё»: пропали карты
  чеков, сброс состояния вкладок, «Поделиться» не работает, сессия
  умирает при F5, тултипы ломают вёрстку; + полный дизайн-бриф
  (senior product designer) с требованием декомпозиции на субагентов.
- **Дизайн-фаза (docs/REDESIGN/):** 01-ux-audit-ia.md (49 находок с
  файл:строка, IA: таб-бар 6→5 — Лента/AI/Сигналы/Избранное/Профиль,
  «Анализы» расформированы, фильтры+сигналы = один bottom-sheet,
  онбординг 3→1 шаг, deep-links filter_<id>), 02-design-system.md
  (метафора «закрытый автосалон»: монохром + деньги-акцент, «тик» 3×18
  у цены, табличные токены light/dark с проверкой контраста WCAG,
  --surface/--deal/--warn/--danger/--accent-soft/--dur-*/z-шкала),
  03-content-a11y.md (~180 строк микрокопии, маппинг detail→русский
  для 23 ошибок, WCAG-чеклист, реестр 14 иконочных кнопок с aria).
- **Волна фиксов:** сессия — access/refresh/гость в localStorage,
  авто-refresh 401 (single-flight) с тихим уходом в гостя, выход —
  только кнопкой; keep-alive всех таб-экранов (display:none, лента
  держит фильтры, AI-чат историю); «Поделиться» — t.me/share/url с
  карточкой (в браузере navigator.share/clipboard); блок чеков всегда
  виден (403 пейволл, 404 «у kcar чеков нет», пустые marks = «не
  зафиксировано» + фото чека в галерее).
- **Волна оболочки (I1):** Shell (5 табов, aria-current, тач ≥44px,
  sidebar-кнопки), Tooltip (portal+fixed, flip/clamp, 240px, Esc),
  токены §9 в index.css (+ z-toast>z-modal фикс), onboarding 1 шаг,
  motion (fade-in-up 200ms, skeleton-pulse, prefers-reduced-motion).
- **Бэкенд-минимум из аудита (F7):** has_inspection в ListingOut —
  EXISTS в том же запросе страницы (инвариант «1 SELECT на keyset-
  страницу» сохранён, тест пройден).
- **NLLB-циклы («Tesla yko model yko…»):** no_repeat_ngram_size=4 +
  repetition_penalty + _clean_translation (срез токена языка/дублей);
  глоссарий +45 терминов чека (교환→замена, 도색→окрас…) и слитные
  올뉴/더뉴; чистка базы scripts/fix_data_quality.py + точечные UPDATE:
  299 лотов, хангыль 0, циклы 0, VIN 276/299, чеки 270 у encar
  (102 с отметками). kcar search-API игнорирует фильтр марки (тот же
  top-100 на любой запрос — все дубли) — объём kcar ограничен самим
  источником (~19-100 в выдаче).


## 84. Прод-ревизия: экономика 4 моделей, «Мои анализы», агент на сделку, партнёрский рынок, темы UI, пересбор базы (2026-10-24)

- **Запрос:** доработать до прода: бизнес-логика/экономика (баг «бизнесу
  предлагают про»), 4 модели пользователя, скрытость партнёрского
  инструментария, вкладка «мои анализы» с историей и поиском похожих
  через RAG/LLM, UI/UX (темы, карточки, путь), баг ссылок на источники,
  перевод/данные kcar — снести и перепарсить.
- **Экономика (policies.py, полная переделка):** Free — 1 AI-разбор в
  НЕДЕЛЮ на все машины (квота окна стала глобальной, ок week), дайджест
  раз в неделю (утренний слот понедельника), чеки осмотра закрыты (403
  inspection_locked). Pro (500★) — 30 разборов/день, чеки, дайджест
  ежедневно (утро) + вечер. Business (2500★) — безлимит, instant при
  публикации, «агент на сделку», «глубокий» разбор (в LLM-контекст
  подмешивается выжимка чека осмотра — `_inspection_digest`). Partner —
  не тариф, а роль: `PartnerAccount.owner_telegram_id` (миграция 0024),
  create/update счёта выдаёт владельцу БЕССРОЧНЫЙ business
  (`grant_partner_business`: until IS NULL; suspended → free),
  `effective_tier` считает NULL-until бизнесом вечным, subscription_check
  его не трогает. Квота: `rules.py` — `ANALYSES_LIMITS {free:1/wk, pro:30/d}`,
  `count_recent_user` (все машины юзера) вместо per-listing.
- **Апселл-баг:** Profile.tsx и бот `_send_subscribe_options` строили
  кнопки по иерархии рангов (free→pro/business, pro→business,
  business→ничего/«бессрочная партнёрская»); везде `can_upgrade/tier_rank`.
- **Нотификации по тарифам:** `notify.effective_channel(filter_mode, tier)`
  — instant реально уходит только business (Pro с instant-фильтром →
  дайджест); `collect_for_filters` собирает по ЭФФЕКТИВНОМУ каналу;
  digest_job → `_digest_run(slot)`: утро (все, free только пн) / вечер
  (pro+business); instant-фильтр создать/включить можно только business
  (filters + notify settings, 403 с апселлом).
- **«Мои анализы» + похожие:** GET `/api/me/analyses` (история разборов с
  карточкой машины, `list_for_user` в репо + AnalysisHistoryItem),
  POST `/api/listings/{id}/similar` — SQL-кандидаты (та же марка/модель,
  ±3 года, цена ±35%, сортировка по близости) + LLM-реранк топ-5 с
  reason/score (сбой модели → фолбэк по цене, source=stats). Фронт:
  вкладка «Анализы» (BarChart3): история с verdict-бейджами, «Найти
  похожие», история поиска из фильтров, гостю — заглушка.
- **Агент на сделку:** POST `/api/listings/{id}/agent` (business-only,
  `RequestAgent` → CreateLead source=agent, идемпотентен
  agent:{user}:{listing}) — лид падает в пул партнёров/менеджмента.
  Кнопка на PDP только при sub.agent.
- **Партнёрский контур (отдельная поверхность /partner, API-ключ):**
  GET `/api/partner/market?make=&model=` — сводка (count/min/median/max)
  + выгодные лоты (price < 0.93×median, discount_pct) — инструмент
  сотрудников партнёров; фронт-экран «Рынок» (TrendingUp). Владелец
  счёта — в админ-API create/PATCH.
- **UI/UX:** система тем lib/theme.ts (system/light/dark, localStorage,
  dataset.theme + color-scheme, подписка на ОС) + полная тёмная палитра
  `:root[data-theme="dark"]` (переведены хардкоды, грейды осмотра);
  переключатель в профиле; карточки сравнения тарифов (3 колонки);
  6-й таб «Анализы» с короткими подписями на мобиле.
- **Ссылки на источники (баг):** URL в БД валидны и отвечают 200, но
  encar/kcar гео-блокированы в РФ (парсим через прокси, у юзера — нет) →
  UX-фикс: тост после «Открыть у источника» + подсказка «источник может
  быть недоступен в РФ — все фото и данные уже здесь».
- **kcar:** адаптер переводит make/model/generation/color/title батчем
  через NLLB (`_translate_items`, общий модуль common/translate.py);
  `enrich_listing_specs` переводит остатки хангыля (цвет «진주색» и пр.).
  **Пересбор базы:** scripts/reparse_listings.py — снос listings (каскад)
  → повторный fetch encar+kcar (перевод на лету, чеки при enrichment) →
  батч-обогащение спеков (VIN/привод/объём) → перевод остатков →
  бэкфилл чеков. Запуск в worker_fetch (docker cp, MSYS_NO_PATHCONV).
- **Миграции:** 0024 (owner_telegram_id) и 0025 (leads.idempotency_key —
  схема-дрейф: колонка жила в ORM без миграции, POST /agent на живой БД
  падал ProgrammingError; аудит остальных таблиц — дрейфа нет).
- **Микро-профиль:** deals-роутер смонтирован в services/catalog (gateway
  проксирует /api/listings/* в catalog — без этого /agent давал 404);
  SubscriptionOut дополнен новыми полями (digest/inspection/agent/
  analyses_limit — response_model их отфильтровывал).
- **NLLB-фикс:** смешанный латиница+хангыль вход гонял модель в повтор
  n-грамм и утечку токена языка («ru Allko New Tusan», inspector
  «ru tokkaservis…») — no_repeat_ngram_size=4, repetition_penalty=1.15,
  max_new_tokens=96 + _clean_translation (срез токена языка/дублей);
  кэш tr:* в Redis сброшен, залитые строки почищены (UPDATE 79+79).
- **Проверка:** полный pytest **1261+ passed** (новые: партнёры 22,
  похожие/анализы 19, темы 11; известный флейк test_rag в изоляции
  зелёный), ruff app+tests чист, фронт `npm run build` ОК + vitest
  107/107; все образы пересобраны, контейнеры перезапущены, gateway
  /health ok; смоук новых эндпоинтов — см. ниже.


- **Запрос:** «избавляемся от транслитерации в korean.py — есть микросервис
  переводчик, юзаем его; машинка всё равно говно; взять данные с
  fem.encar.com/cars/report/{inspect,accident,diagnosis}/{id} и сделать чётко».
- **Развивка fem-страниц:** SPA-оболочки → XHR пойманы headless-браузером:
  inspect = `/v1/readside/inspection/vehicle/{id}` (уже юзали), diagnosis =
  `.../diagnosis/vehicle/{id}` (тоже), accident = НОВЫЙ
  `.../record/vehicle/{id}/open?vehicleNo=…` — история ДТП из госданных
  (госномер в detail.manage.vehicleNo): счётчики + полный список аварий
  с датами/выплатами, гибель/наводнение/угон/владельцы/залог/первая регистрация.
- **Перевод:** korean.py УДАЛЁН. `BaseApiAdapter` получил `translator`
  (объект с async translate(texts, source, target) → list[str|None] — это
  `TranslateClient`, NLLB-микросервис с Redis-кэшем и breaker). AdapterRegistry
  пробрасывает его адаптерам (воркер собирает до registry); encar.py —
  `_translate_korean()`: сбор хангыль-строк (make/model/generation/color +
  inspector/summary/notes отчёта) → глоссарий (`domain/translation/glossary`,
  уже существующий) → батч в микросервис → подстановка in-place. Ошибки/выключенный
  сервис → остаётся оригинал (как тайтлы).
- **Карта повреждений — официальные диаграммы Encar:** в JS классического
  mdsl-чека найден fnStats с координатами всех 38 панелей
  (`pos:'left:X;top:Y'`) и картинки-диаграммы (вид сверху, 254x282):
  `www.encar.com/images/pop/check/img_inspection01.gif` (внешние) и
  `img_inspection02_new.gif` (силовая структура). В адаптере — таблица
  `_ZONE_POS` (zone → diagram,x,y; frame-метки сняты с общей канвы x-340),
  каждый mark несёт `pos` (схема InspectionMark + lib/inspection.ts дополнены).
  Фронт `Inspection.tsx` переписан: вместо самодельных SVG-«машинок» — эти
  диаграммы-картинки с кликабельными маркерами (номер отметок в зоне, цвет =
  тип повреждения, ПЕРЕД/ЗАД подписи); CSS `.inspection__diagram/__pin/__dir`.
- **БД:** `scripts/backfill_inspection.py` (теперь с переводчиком) перегнал
  все 100 отчётов: pos в marks, история ДТП в summary, корейские тексты →
  русский через микросервис. `scripts/translate_db_russian.py` переписан с
  транслитерации на микросервис (идемпотентный, батчи по 48, глоссарий).
- **Проверка:** pytest adapter 23/23 (+тесты: record/open-факты, FakeTranslator
  подставляет перевод, без translator остаётся оригинал), ruff чист; tsc +
  vitest Inspection 3/3; miniapp и worker_fetch пересобраны.

## 82. Хангыль → русский + нормальные «машинки» осмотра (2026-10-24)

- **Запрос:** «переводить всё корейское в объяве на русский; схемы кузова
  вообще не похожи на машину и кривые».
- **Аудит утечек:** скан API (listings+inspection, 100 лотов) — хангыль в
  `listing.make/model/color` (도요타, 더 뉴 그랜저 IG, 진주색…),
  `inspection.inspector` (названия центров + имена), `marks[].note`
  (교환/도색), `summary` (теги 엔카진단/성능기록부 + названия центров);
  `title_raw` корейский by design, в UI не показывается (title_ru чистый).
- **Модуль** `app/infrastructure/sources/korean.py`: слоговая транслитерация
  хангыль→кириллица (упрощ. Концевич: финаль ㅇ→н, пробел на стыках
  ㅇ+vowel и ㅁ+шумная) + карты фраз/слов (марки, модели/тримы, цвета,
  центры осмотра, примечания дефектов) + `dehangul()` (карты → транслит
  остатка, чистка пробелов/скобок, капитализация первого слова) +
  обёртки `ru_make/ru_model/ru_color`.
- **Адаптер** (`encar.py`): make/model/generation/color через RU-функции;
  в `_build_inspection` переведены summary-шаблоны (без корейских тегов),
  центр диагностики, инспектор, notes из JSON-чека, mdsl-merge и чек-листа.
- **БД:** разовый идемпотентный `scripts/translate_db_russian.py` — переведено
  89 листингов (make/model/color) и все 100 отчётов (summary/inspector/
  notes); повторный запуск ничего не меняет. Образ worker_fetch пересобран
  (новые fetch-и пишут сразу по-русски).
- **Схемы** (`Inspection.tsx`): вместо набора трапеций — полноценный силуэт
  седана (BODY_D: профиль капот→лобовое→крыша→C-стойка→багажник, вырезы
  арок дугами A26), остекление (GLASS_D), B-стойка+ручки (SEAM_D), колёса
  с дисками (hub r10); панели — слэбы внутри силуэта (капот над крылом,
  порог под дверями, стойки по углам наклона); viewBox 420×176; стили
  `.inspection__body/__glass/__seam/__hub`. Геометрия проверена численно
  (bbox всех панелей внутри силуэта), тап по зоне работает.
- **Проверка:** pytest adapter+korean 37/37, ruff чист; npm build + vitest
  Inspection 3/3; API-скан после перевода — хангыля в листингах/отчётах
  нет (кроме title_raw); мобайл 390 — без overflow, ПК-скриншот осмотра —
  `shots/inspection_new.png`.

## 81. ПК-вёрстка PDP: sticky-фикс + фото чека в галерее + база под MVP (2026-10-23)

- **Запрос:** «допы заезжают на ПК на карточку справа с кнопками и анализом;
  фото осмотра должны быть в галерее; очисти базу — ровно 100 объявлений под MVP».
- **Причина наезда:** замеры playwright — sticky `.listing-page__side` при
  прокрутке уезжает вниз КОНТЕЙНЕРА (Chromium не ограничивает sticky-grid-item
  его grid--area), а «Комплектация»/«Осмотр» были отдельными full-width рядами
  НИЖЕ ряда side → карточка с кнопками/анализом ложилась поверх панелей
  (пересечение прямоугольников подтверждено на 1024/1280/1366/1440/1920).
- **Фикс:** «Комплектация» и «Осмотр» перенесены ВНУТРЬ `.listing-page__main`
  (левая колонка, под спеками); мёртвое правило `.listing-page > .panel
  {grid-column: 1/-1}` убрано. Теперь всё, что ниже ряда side, отсутствует —
  sticky ограничен фактически высотой левой колонки; оверлапов нет ни на
  одной ширине (проверено скроллом до дна на 1024 и 1440).
- **Фото осмотра в галерее:** `Listing.tsx` — `galleryImages = [...listing.images,
  ...(inspection?.images ?? [])]` (useMemo), `Gallery` рендерит общий массив
  (чек-фото в конце, лайтбокс/счётчик работают как прежде); блок «Фото
  осмотра» из `Inspection.tsx` и стили `.inspection__photos*` удалены
  (тест легенды обновлён: 9 типов с repair/frame).
- **База под MVP:** из 2966 листингов оставлены ровно **100** — самые свежие
  из 205 лотов, у которых чек содержит отметки (`marks > 0`); остальные
  удалены каскадом (favorites/leads/price_analyses/listing_price_history/
  inspection_reports — ON DELETE CASCADE), VACUUM ANALYZE выполнен. Итог:
  listings=100, reports=100 (все с отметками), price_hist=100. Celery beat
  (расписаний добавления) в проекте нет — база сама не вырастет.
- **Проверка:** `npm run build` ОК, vitest Inspection 3/3, полный pytest
  **1216 passed, 7 skipped** (1 флейк `test_rag.py` без RAG — изолированно
  зелёный); образ miniapp пересобран, E2E playwright: ПК 1440 — 2 схемы,
  легенда 9, галерея 12 фото (10 + 2 чека), оверлапа нет; мобайл 390 —
  без overflow-x, CTA на месте; лента отдаёт карточки из 100 лотов.

## 80. Классический чек mdsl_regcar + карта повреждений «две машинки» (2026-10-23)

- **Открытие:** JSON-чек (`outers`) у большинства авто пуст — карта повреждений
  живёт ТОЛЬКО в серверном JS-блоке `performanceCheck = {dataGroup: [...]}`
  классической страницы `www.encar.com/md/sl/mdsl_regcar.do?method=inspectionViewNew&carid=...`
  (EUC-KR); carid здесь = `source_id` объявления, а не vehicleId.
- **Адаптер** (`encar.py`): `DEFAULT_MDSL_RECORD_API`, маппинги
  `_MDSL_OUTER_ZONE` (13 панелей) / `_MDSL_FRAME_ZONE` (24), regex
  `_MDSL_PANEL_RE` (оба формата панелей — с `value_old` и без),
  `_parse_mdsl_panels()` (lank «2» → `repair`, B/C → `frame` + note при C),
  `_fetch_legacy_marks()` (best-effort, EUC-KR); мерж в `_build_inspection`
  без дублей по зоне, зоны JSON-чека приоритетны.
- **Схемы/фронт:** BODY_ZONES +16 зон скелета, MARK_TYPES + `repair`/`frame`;
  `Inspection.tsx` переписан на две схемы сбоку (OUTER/FRAME, клики по панелям,
  колёса, подписи ПЕРЕД/ЗАД); стили `.inspection__schemes*` в `index.css`.
- **Тесты:** фикстура `MDSL_HTML`, `test_parse_mdsl_panels_ranks`,
  `test_fetch_merges_legacy_mdsl_marks` (carid в URL, без дублей) — зелёные.
- **Бэкфилл:** `scripts/backfill_mdsl_marks.py`; www.encar.com жёстко троттлит
  контейнерный IP (2 потока максимум, паузы), полный проход не завершён —
  снято с повестки: база урезана до 100 лотов (№81), среди них 100 отчётов
  с отметками уже есть.

## 78. Комплектация сквозь стек + осмотр/чеки на всю ширину PDP (2026-10-23)

- **Запрос:** «чеки состояния пропали? мы же получаем данные — рендерим;
  отдельно ниже, а не сбоку; и комплектация тоже — отдельно». Осмотр
  действительно жил в узкой side-колонке грида (≥1024px), а комплектации
  в продукте не было вовсе, хотя Encar отдаёт её в detail-карточке.
- **Источник опций:** `detail.options` = `{standard, choice, tuning, etc}`
  — списки **кодов** («010», «095», «1xxx»). Словарь имён нашёл в SPA-бандле
  fem и API `/v1/readside/vehicles/car/options/standard` (45 кодов) +
  `.../tuning` (30). Коды 1xxx (choice) анонимным словарём не резолвятся —
  пропускаем; коды 001–008 коллизируют между классической таблицей и новым
  fem-чеклистом — в адаптере зафиксированы осмысленные значения
  (007=подогрев сидений, а не «ЭСП»; сверено с oneLineText продавцов).
- **Цепочка (миграция 0023):**
  - `0023_listing_options.py`: `listings.options JSONB NOT NULL
    DEFAULT '[]'`;
  - `unified.py`: `UnifiedListing.options: list[str]`;
  - `encar.py`: `_STANDARD_OPTION_RU` (45) + `_TUNING_OPTION_RU` (24),
    `_extract_options()` — коды → русифицированные названия, неизвестные
    коды молча скипаются (сырые коды на фронте не показываем), ≤60;
  - `ingestion.row_values` / `listings_writer._UPSERT_SQL` (+bindparam
    JSONB) / `listings_read._to_card` / `ListingCard.options` /
    `ListingOut.options`;
  - фронт: `Listing.options?`, секция «🧰 Комплектация» — чипы
    (`.options-chips`), **отдельная секция ниже грида**, не сбоку;
  - «🔍 Осмотр» перенесён из side-колонки в такую же full-width секцию;
    факты чека — сетка карточек `.inspection__facts` (auto-fill ≥160px)
    вместо плоского списка; `grid-column: 1/-1` для `.listing-page > .panel`.
- **Проверка:** encar 18/18 (новый тест `test_fetch_extracts_options_russian`),
  полная суита **1214 passed, 7 skipped** (1 фейл `test_rag.py` —
  средозависимый, стучится в живой RAG :8100, к правкам не относится),
  `npm run build` ОК; миграция 0022→0023 применена; образы catalog/admin/
  worker_fetch/miniapp пересобраны; E2E через боевой writer: 20 NEW,
  Mustang 2840 → 27 опций, K7 → 30; live `GET /api/listings/2840` отдаёт
  `options`; регресс `GET /api/listings/1423/inspection` → 200.

## 77. Фото чека осмотра: БД → API → фронт (2026-10-23)

- **Симптом:** «картинок чеков нет, данных на фронте тоже нет». Причина —
  фото чека из JSON-API обрезались на первом же слое: адаптер клал их в
  **галерею объявления** (`item.images`), а не в отчёт; в
  `inspection_reports` колонки `images` не было; `_INSPECTION_SQL` не
  писал даже существующие `inspector`/`inspected_at` (терялись при
  каждом upsert); в API-схемах и на фронте поля не существовало.
- **Fix (вся цепочка):**
  - миграция **0022**: `inspection_reports.images JSONB NOT NULL
    DEFAULT '[]'`;
  - `listings_writer`: `_INSPECTION_SQL` + params пишут
    `inspector`/`inspected_at`/`images`; `_coerce_dt` — строка чека
    `'2026-08-21'` → aware datetime (asyncpg требует datetime);
  - `encar.py`: фото чека (path/location, ≤20) → `report["images"]`
    с префиксом CDN, в галерею больше не подмешиваются;
  - схемы `InspectionReportIn/Out` + `InspectionUpdate/View` +
    admin PUT: `images: list[str]` (≤40);
  - фронт: `Inspection.tsx` — блок «Фото осмотра» (сетка 3 колонки,
    тап → полное фото в новой вкладке), тип `images?` в
    `lib/inspection.ts`, стили `.inspection__photos*`.
- **Проверка:** encar 17/17, полная суита **1190 passed, 7 skipped**,
  `npm run build` (tsc+vite) ОК; миграция 0021→0022 применена; образы
  catalog/admin/worker_fetch/miniapp пересобраны; live
  `GET /api/listings/1423/inspection` отдаёт `images: []` (новое поле);
  roundtrip-тест в контейнере: отчёт с
  inspector=`엠파크오토서비스…`/`inspected_at=2026-08-21`/2 фото —
  записался и прочитался из БД, транзитный листинг удалён каскадом;
  фетч 25 стр — 214 отчётов перезаписаны без `inspection_upsert_failed`.
- **Оговорка:** фото и структурированные marks/items появляются только
  у авто, для которых чек нового формата реально есть у источника
  (редкость — см. №76); у остальных отчёт честно показывает факты.


## 76. Обогащение отчётов осмотра Encar: анонимные readside-API (чек, страховка, 엔카진단) (2026-10-23)

- **Открытие:** в JS-бандле fem.encar.com найдены анонимные JSON-API (все
  отвечают 200 без авторизации, 404 — если данных нет):
  `/v1/readside/inspection/vehicle/{id}` (чек 성능점검기록부),
  `.../summary`, `/v1/readside/record/vehicle/{id}/summary` (страховая
  история) и `/v1/readside/diagnosis/vehicle/{id}` (엔ка진단).
- **Адаптер `encar.py`:** 4 эндпоинта + конфиг-ключи; маппинги
  `_DIAGNOSIS_ZONES`, `_ITEM_GROUP_KEYS` (S00–S07), `_ITEM_STATUSES`
  (коды 1/2/3/10/4-8…), `_MARK_TYPES_KR`; `_fetch_optional` (404→None);
  `_enrich_from_details` фетчит чек+summary+record+diagnosis;
  `_build_inspection` переписан: outers→marks, inners→items (худший
  статус группы), record→факты (ДТП, гибель, угоны, владельцы, залог),
  diagnosis→marks+вердикт, inspector/inspected_at; фото чека → images.
  Note ≤300, summary ≤1000 (лимиты схемы). `guarantyType` читается из
  `master.detail` (не `master`); `master.accdient` — реальное имя поля
  (опечатка Encar).
- **Тесты:** роутинг URL в mock, фикстуры INSPECTION/RECORD/DIAGNOSIS,
  `test_fetch_builds_full_inspection_report`,
  `test_fetch_report_without_extra_apis`; encar 17/17, полная суита
  **1214 passed**. Реальный payload 41339509 → валидный
  InspectionReportIn (marks/items/inspector заполнены).
- **Прод:**
  - Образ worker_fetch пересобран; batch `_enrich_from_details` и полный
    `adapter.fetch()` в контейнере работают (new_format=0/20 на свежей
    странице — у источника данных нет, не регрессия).
  - Сквозная запись: обогащение 42757015 → `SqlAlchemyListingsWriter.
    upsert_many` → БД → `GET /api/listings/1423/inspection` → **200**,
    summary с диагнозом/записью техосмотра/Clean Encar/примечанием
    продавца ( hangul без моджибейка).
  - Метрики после фетчей: 1474 отчётов encar, у 1148 упомянута запись
    техосмотра, у 1468 — диагностика; marks/items/inspector — только у
    авто с реальными данными.
- **Ограничение источника:** структурированные marks/items есть только у
  авто, для которых чек/диагностика реально проводились в новом формате
  (41339509 — есть; 5 свежих и 3 старых ID 2014–2018 — 404). У остальных
  чек живёт в legacy `mdsl_regcar.do`, который из контейнера
  недостижим (ConnectTimeout на `www.encar.com`; из локальной сети
  открывается). Обогащение срабатывает автоматически, когда такой авто
  попадает в фетч (cron).
- **DLQ (depth=12):** разобрана — задачи `fetch_source_task encar` пали
  сетевыми таймаутами search-API (деградация прокси ~08:21), не багом
  сериализации. Повторная постановка (`year_from:2014, year_to:2017`)
  отработала: +37 объявлений, ошибок нет.
- **Убрано:** временные `_debug_encar_detail.py`, `_probe*.txt`.


## 75. Чек Encar «без данных»: факты в summary + компактный список на фронте (2026-10-23)

- **Симптом:** «чеки кривые — данных нет» — отчёты осмотра encar в БД с
  пустыми `marks: []`/`items: []`/`grade: null`, а summary — 2-3 общие
  фразы. На PDP при этом рендерилась пустая SVG-карта кузова + пустой
  чек-лист — выглядело сломанным.
- **Диагноз по живым detail-ответам** (2 карточки сняты через проектный
  HttpClient — прямой curl анонимно блокируется): в анонимном
  `condition` реально только флаги (accident.recordView/resumeView,
  inspection.formats, seizing), зонных оценок нет — они в закрытой
  엔ка진단-таблице. НО в `advertisement`/`view` лежат неиспользуемые
  факты: `verification.reportExists` (V3), `directInspected`,
  `hasUnderBodyPhoto`, `oneLineText` (примечание продавца, напр.
  «No,paint/TAX100%/MADE2025-12»), `view.encarDiagnosis`.
- **Адаптер encar.py** (`_build_inspection`): summary дополнен фактами —
  верификация, «осмотрена напрямую», фото днища, примечание продавца;
  диагностика теперь из `diagnosisCar OR view.encarDiagnosis`; формулировка
  «запись техосмотра (성능기록부)». marks/items остаются пустыми честно —
  зонных данных анонимный API не отдаёт.
- **Фронт Inspection.tsx**: при пустых marks+items карта кузова/легенда/
  подсказка не рендерятся — вместо них список фактов (summary бьётся по
  « · »), стили `.inspection__facts/.inspection__fact` в index.css.
  При ручном отчёте админа (marks/items есть) вид прежний.
- **Проверка:** encar-тесты 15/15 (фикстура дополнена реальными полями,
  ассерты на новые факты + отсутствие «осмотрена напрямую» при false),
  transport+catalog 80/80, `npm run build` и `vite` в контейнере ОК.
  Образы worker_fetch/miniapp пересобраны, fetch encar 50 стр запущен —
  отчёты перезаписываются upsert'ом: через ~40с уже 412 отчётов, из них
  109 с фактом верификации, 36 с примечаниями продавца. Живой пример
  `GET /api/listings/1423/inspection`: «...отчёт верификации Encar: есть ·
  примечание продавца: 키2개-선루프-HUD-360뷰-뒷자석모니터-통풍-마사지-전자서스펜션».
- **Открыто (как и в №74):** полноценные marks/items/grade — только с
  encar-аккаунтом (diagnosis API); cron */30 дотянет обогащённые отчёты
  по всему каталогу.


## 68. Gateway: маршрут /api/calc → catalog (анализ цен «анализ цен» ожил) (2026-10-22)

- **Симптом:** миниапп/сайт на экран калькулятора — `no route for
  /api/calc/delivery`. В микропрофиле gateway не знал префикс `/api/calc`:
  в монолите роутер `app/transport/http/routers/calc.py` монтируется
  целиком, а при разъезде на сервисы про него забыли (ни в одном
  доменном сервисе не смонтирован, в ROUTE_RULES правила нет).
- **Фикс:** `/api/calc` → catalog-service (калькулятор — чистая логика
  `app.application.calc.use_cases.calc_delivery` без БД, к авто-домену
  и относится: расчёт «под ключ» для машины). `calc.router` смонтирован
  в `services/catalog/main.py`, `RouteRule("/api/calc", "catalog")` — в
  gateway. Бот ходит на тот же путь через `backend:8000` (= gateway) —
  починилось и для него.
- **Проверка:** `POST /api/calc/delivery` (8000$, 2000cc, 2019, ru) → 200
  с полным разбором (утильсбор «льготный» + note про 160 л.с.);
  `POST /api/calc/compare` (2 варианта) → 200, сортировка по итоговой.
  Образы catalog+gateway пересобраны.
- **Напоминание про туннель:** «no tunnel» в Telegram при живых пробах —
  это старые inline-кнопки web_app в старых сообщениях бота (URL
  запекается в кнопку на момент отправки; после ротации адреса старые
  сообщения навсегда мертвы). Живой адрес — только в кнопке МЕНЮ бота
  (обновляется при старте бота) или после /start. Лечится стабильным
  поддоменом (аккаунт localhost.run).


## 69. Туннель: SSH_USER в ps1; 502 «no tunnel» — flaky edge localhost.run (2026-10-22)

- **Наблюдение:** при живом ssh пробы петли (Invoke-WebRequest) дают
  200, а curl с той же машины и телефон пользователя — 502 «no tunnel»
  на один и тот же URL. Прокси/IPv6 исключены (ProxyEnable=0, только
  A-записи: 3 IP AWS ELB). Похоже, edge-кластер отдаёт туннель
  нестабильно: сессия видна не со всех нод; кратно .NET-клиенту везёт
  с «хорошей» нодой — health-probe в таком раскладе может НЕ замечать
  проблему, которую видит телефон. Это уже не лечится с нашей стороны.
- **Фикс (подготовка к аккаунту):** в `scripts/miniapp_tunnel.ps1`
  ssh-пользователь теперь берётся из env `SSH_USER` (по умолчанию
  `nokey`). FAQ localhost.run: бесплатный АККАУНТ + SSH-ключ
  (admin.localhost.run) = стабильный поддомен между реконнектами;
  платный план нужен только под кастомный домен. Переключение:
  регистрация, ключ в админке, `SSH_USER=<логин>` в окружении
  планировщика, рестарт задачи.


## 70. Миниапп: лента/анализ цены = мёртвый туннель; вёрстка ПК = box-sizing; ps1: mutex + таймстампы (2026-10-22)

- **«Лента не грузится» и «анализ цены не работает»** — обе жалобы были
  одним: туннель умирал, а диагностике мешали ДВА параллельных
  экземпляра петли (планировщик + ручной запуск): второй затирал
  `.miniapp_tunnel.log` первого, «probe -> 200» был мусором из чужой
  итерации, а `.env` гонял три разных URL за час. «Расщепление
  IWR-200/curl-502» не подтвердилось: замер в одну секунду даёт
  одинаковые ответы — это была иллюзия от несинхронных логов.
- **ps1:** named-mutex (второй экземпляр завершается сразу) + все
  события через `Log` с `[yyyy-MM-dd HH:mm:ss]`. Теперь цикл виден:
  детект 2×fail → kill ssh → новый URL → .env → бот ≈ 50с.
- **Вёрстка ПК («едет вправо»):** глобального box-sizing не было —
  `.guest-banner` (`flex: 1 1 100%` + паддинги + бордер, content-box)
  переполнял flex-строку `.app-shell--desktop`, страницу вело вправо.
  Фикс: `*, *::before, *::after { box-sizing: border-box }` в начале
  index.css. 93/93 тестов зелёные; в собранном бандле правило есть.
- **Статус туннеля:** edge сегодня выбрасывает анонимные сессии за
  40с–2мин (probe→0/502 на свежем туннеле) — петля успевает за ним,
  но URL меняется каждый раз, телефон за ним не поспевает. Единственное
  стабильное решение — аккаунт localhost.run (free): ключ в
  admin.localhost.run + `SSH_USER=<логин>` (уже поддержан в ps1) →
  поддомен постоянный, реконнекты становятся невидимы.


## 71. Анализ цены: analysis.router не смонтирован ни в одном сервисе (2026-10-22)

- **Симптом:** «анализ цены не работает» в миниаппе (и в боте).
- **Причина — близнец calc-бага (#68):** монолит монтирует 17 роутеров
  (app/main_api.py:155-172), при разъезде на сервисы про
  `analysis.router` (GET/POST `/api/listings/{id}/analysis`) забыли:
  gateway шлёт `/api/listings/*` в catalog, а там роута нет →
  `404 Not Found`. Ботский канал `POST /api/bot/listings/{id}/analysis`
  (app/transport/bot/client.py:243, X-Internal-Token) вдобавок не имел
  правила в ROUTE_RULES → «no route for /api/bot/...».
- **Фикс:** `analysis.router` + `analysis.bot_router` смонтированы в
  catalog (общий префикс /api/listings, полный DI-контейнер общий —
  create_domain_service/make_container); в ROUTE_RULES добавлено
  `RouteRule("/api/bot", "catalog")`. Тесты routing: +2 кейса (52/52).
- **Проверка:** web без токена 404→401 «Missing bearer token»;
  бот-канал «no route»→422 (валидация тела); гость (реальный JWT из
  /api/auth/guest): GET кэша 200, POST → 403 `guest_forbidden: AI-анализ
  цены доступен только после входа` — вся цепочка gateway→catalog→DI→
  use case жива. Для вошедшего POST запускает LLM-разбор (квота free:
  1 разбор/нед). NB: в гостевом режиме анализ закрыт by design
  (баннер «Войти — для AI-анализа цены»).


## 72. Анализ: gateway рвал запросы через 15с; ПК: грид карточки «вывернут» кнопкой «Назад» (2026-10-22)

- **«Не всегда в тайминги попадаем»** — `gateway_timeout_sec` имел
  дефолт **15с**, а LLM-разбор длится до 120с (лимит bot-клиента).
  Быстрый ответ LLM успевал, долгий — рвался gateway-ем (httpx
  ReadTimeout). Дефолт → **150с**, gateway пересобран. (В .env
  переопределений не было.)
- **ПК-вёрстка страницы карточки «вывернута»** — найдено замерами
  playwright (1280×900): первый ребёнок `.listing-page` — кнопка
  «Назад» — в гриде (min-width:1024, `grid-template-columns: 1.6fr 1fr`)
  занимала ячейку (1,1); main с галереей уезжал в правую узкую колонку
  (418px), side — в левую широкую (670px). Ровно «уход вправо первой
  части карточки с картинками». Фикс: `.listing-back { grid-column:
  1 / -1 }` в том же media-блоке. После: main 670px слева, side 418px
  справа, кнопка отдельной строкой.
- **Метод:** headless chromium (playwright в tmp, npmmirror-зеркало) —
  скриншоты + программные замеры rect всех элементов, sticking-поиск
  (right>viewport / left<0). Лента: переполнения нет; экран
  «Уведомления»: sticking пуст. 93/93 фронт-тестов зелёные.


## 73. Туннель: probe слеп — IWR залипал на «хорошей» ноде ELB (2026-10-22)

- **Механика падений выяснена окончательно.** Edge localhost.run — ELB
  из ≥3 нод, регистрация анонимной сессии доступна НЕ на всех нодах.
  Длинноживущий PS-процесс петли кэширует DNS + держит keep-alive и
  потому видит вечный 200 от «своей» ноды, тогда как новые соединения
  (телефон, curl) круглым-robin попадают на ноды без регистрации →
  502 «no tunnel». Замер: curl 8/8 = 502 и IWR 5/5 = 502 (новые
  соединения) при «probe -> 200» в петле в ту же минуту. Вчерашняя
  «иллюзия старых логов» — неверный вывод; расщепление реальное.
- **Фикс пробы:** Invoke-WebRequest → git-curl (новое соединение на
  каждую пробу) — петля теперь видит то же, что телефон: 502×2 →
  реконнект. Старая петля убита по .miniapp_tunnel.pid, задача
  перезапущена; mutex от двойного запуска отработал штатно.
- **Статус:** новая сессия отвечает 200 на свежих соединениях (6/6,
  curl-проба 200). Но вероятностная деградация edge никуда не делась:
  при каждой смене URL телефон должен брать свежий из кнопки меню.
  Стабильное решение — аккаунт localhost.run (SSH_USER в ps1 готов):
  постоянный поддомен + авторизованные сессии.


## 74. Encar: VIN + чек состояния в парсере (2026-10-22)

- **Разведка API живыми запросами.** Search-выдача Encar не содержит Vin
  (0 из 1902 записей в БД) и отдаёт только часть фото. Анонимно работают:
  `/v1/readside/vehicle/{id}` (VIN у заполненных, spec.displacement,
  полный набор фото 20-35, `advertisement.diagnosisCar`,
  `condition.inspection.formats`, `condition.seizing`) и
  `/v1/readside/clean-encar/vehicle/{id}` (`{"cleaned": bool}`).
  Пути diagnosis/inspection вытащены из JS-бандла fem.encar.com
  (`app-*.js`), но полный чек (엔카진단, таблица зон) требует
  encar-авторизации — анонимно 404. Сторонние API-обёртки (encarapi и
  пр. из подсказки) не проверял — прямые эндпоинты уже работали.
- **Адаптер encar.py**: после parse страницы — обогащение детальными
  карточками (semaphore 5, ошибки отдельной карточки не роняют страницу,
  у 404 удалённых просто остаются search-данные): VIN по маске ISO 3779
  (17 знаков без I/O/Q — мусор вида «812루7127» не проходит), объём из
  см³, замена фото на полный набор, отчёт осмотра из анонимных фактов
  (diagnosisCar, запись осмотра, Clean Encar, залоги) → `summary`.
- **UnifiedListing.inspection** (Optional[dict]) — новый необязательный
  контракт; writer (listings_writer.py) пишет отчёты в
  `inspection_reports` (INSERT ON CONFLICT (listing_id) DO UPDATE ...
  WHERE source='encar' — ручные отчёты админа не перетираются), в
  SAVEPOINT: сбой пачки отчётов не роняет сохранение объявлений.
- **Живая проверка end-to-end**: fetch страницы → ingest → API:
  5/5 с VIN, `GET /api/listings/{id}` отдаёт vin/объём/33 фото,
  `GET /api/listings/{id}/inspection` — отчёт с фактом «Диагностика
  пройдена · Clean Encar: безаварийная». Тесты: +3 (enrichment,
  деградация, мусорный VIN), encar-сьют 48/48.
- **Открыто**: полная диагностическая таблица (оценки зон) — только с
  encar-аккаунтом (Bearer в `/v1/readside/diagnosis/vehicle/{id}`); слот
  готов — ложится в marks/items. VIN у части объявлений NULL — продавцы
  не заполнили. Существующие 1902 записи подтянут VIN при повторном
  fetch источника (admin trigger).


## 67. Miniapp: туннель с health-probe — самоисцеление после потери сессии edge (2026-10-22)

- **Симптом после фикса логина (#66):** вход через сайт работает, миниапп в
  Telegram не открывается. Кнопка бота вела на мёртвый URL: туннель
  localhost.run за сессию переподключался 4 раза, каждый раз получая новый
  случайный поддомен (анонимные сессии), а `.env`/кнопка оставались на
  первом.
- **Диагностика сети (ZTE-роутер, жёсткий DPI):** trycloudflare — заблокирован
  (знали), pinggy.io — режется по SNI на TLS-хендшейке, ssh localhost.run:443
  — провайдер не принимает. Жив только ssh :22, но edge localhost.run стал
  терять РЕГИСТРАЦИЮ туннеля через ~40-60с: ssh-сессия формально жива
  (keepalive отвечают), а URL уже отдаёт 502 «no tunnel» — клиент об этом
  не узнаёт и не переподключается. Стабильный поддомен без аккаунта
  недоступен (ключ → «Permission denied», нужна регистрация).
- **Фикс `miniapp_tunnel.ps1` (переписан):**
  1) ssh в фоне через `Start-Process`, лог стримится в файл, URL парсится
     из лога (батник парсит тот же файл — первый URL);
  2) при каждом коннекте URL сверяется с `.env` и при смене обновляет
     `MINIAPP_URL` + пересоздаёт бота (`--no-deps`) — кнопка всегда ведёт
     на живой адрес;
  3) **health-probe**: HEAD-запрос к URL раз в 25с; два не-200 подряд —
     kill ssh и принудительный реконнект (лечит «полумёртвые» сессии);
  4) keepalive ужат до 10с — после этого сессии перестали умирать на ~40й
     секунде (живут минуты, пробы 200);
  5) PID пишется самим ps1 — любой запуск (bat/планировщик/вручную)
     корректно перезапускается поверх.
- **Разделены логи:** stdout петли → `.miniapp_tunnel_loop.log` (события,
  пробы), stdout ssh → `.miniapp_tunnel.log` (баннер с URL; его парсит
  батник). Раньше оба писали в один файл и затирали друг друга.
- **`scripts/tunnel_task.bat` (новый):** обёртка для Планировщика задач —
  туннель вне сессии терминала. Задача `auto_bot_miniapp_tunnel`
  (`schtasks /create /run`), переживает закрытие консоли/сессии агента.
  После перезагрузки ПК — по-прежнему двойной клик `miniapp-url.bat`.
- **Проверка:** URL `6ed74060493bd7.lhr.life` → 200, `.env`/бот/лог
  синхронны; keepalive-сессии живут минутами; при потере — реконнект с
  новым URL и автообновлением кнопки. Для СТАБИЛЬНОГО адреса без ротации —
  бесплатный аккаунт localhost.run (GitHub/Google) + ключ в дашборде.


## 66. Auth: «Ссылка входа устарела» — миграция 0021 users.source (2026-10-22)

- **Корень бага:** коммит 4d42fde (dishka-рефакторинг) добавил в модель User
  колонку `source` + индексы `idx_users_source_created` /
  `uq_users_email_lower` **без миграции**. Любой `SELECT *` ORM-модели User
  падал с `column users.source does not exist` → identity не мог ни создать
  юзера, ни подтвердить код логина → фронт показывал «Ссылка входа устарела»
  (ссылка была живая — под капотом identity отдавал 500).
- **Фикс:** `0021_users_source_and_email_lower.py` — `users.source String(16)`
  + оба индекса (функциональный `uq_users_email_lower` с
  `WHERE email IS NOT NULL`). Косметический дрейф TEXT→VARCHAR из
  autogenerate-диффа сознательно не включён (риск NOT NULL на грязных
  данных); мёртвая таблица `outbox` (наследие 0019, из моделей удалена) в БД
  сохранена — дропать не стали.
- **Нюанс деплоя:** alembic гонится из контейнера gateway (`build: .` без
  volume) → после новой миграции нужен `docker compose build gateway`,
  иначе контейнерный alembic упадёт с «Can't locate revision 0021».
  На живую БД применяется с хоста: `.venv/Scripts/alembic.exe upgrade head`
  (postgres проброшен на localhost:5432).
- **Проверка:** `alembic current` = 0021; ORM `select(User)` — OK;
  `POST /api/auth/telegram` через gateway → 422 (валидация) вместо 500;
  ошибок `column source` в логах identity больше нет.

## 65. Инфра: healthcheck всем контейнерам + OOM-защита translate + лок ParserDoctor + PDP «все данные» (2026-10-17)

- **Запуск рантайма (перевод + RAG + постоянный скрининг):** подняты qdrant,
  minio, translate, rag_migrate/rag_worker/rag_api рядом с backend/bot/miniapp.
- **Утечки памяти NLLB (фидбек «следите за контейнером translate»):** тройная
  защита — (1) чанкинг батчей (TRANSLATE_CHUNK=16) + `gc.collect()` после чанка
  в `nllb.py`; (2) RSS-сторож `_rss_watchdog` в `main.py` (раз в 60с меряет
  VmRSS, при > TRANSLATE_MAX_RSS_MB=2600 делает `os._exit(1)` → рестарт с
  прогревом ~30с, бэкенд тем временем fallback'ом отдаёт оригинальные тайтлы);
  (3) жёсткий `mem_limit: 3g` / `memswap_limit: 3g` в compose (иначе oom-killer
  может убить соседей). Плюс `OMP_NUM_THREADS=2`, `TOKENIZERS_PARALLELISM=false`.
- **ParserDoctor: лок на источник (фидбек «не жечь LLM-токены дублями»):**
  к cooldown 6ч добавлен running-лок `doctor:running:{src}` (TTL 30 мин,
  ставится перед LLM-запросом, снимается в finally; падение процесса чистит
  TTL). Параллельный воркер получает `already_running` и второй GLM-запрос
  не шлёт. `redis=None` теперь логируется предупреждением. Тело ремонта
  вынесено в `_repair_with_llm`. Тесты +2 (already_running блокирует LLM,
  лок снимается после ремонта, cooldown остаётся).
- **Healthcheck у каждого контейнера:** добавлены недостающие — bot,
  worker_fetch, worker_send (long-polling/консюмеры без HTTP-порта → новый
  `app/services/heartbeat.py`: фоновая задача пишет heartbeat-файл каждые 15с,
  `python -m app.services.heartbeat <name>` в healthcheck считает живым файл
  не старше 90с — зависший event loop → unhealthy), qdrant и minio
  (TCP-проба через bash /dev/tcp — wget/curl в образах нет), miniapp (nginx
  busybox wget), rag_api (`/health`). one-shot rag_migrate* — healthcheck не
  применим (exit 0 по дизайну).
- **RAM-лимиты:** qdrant 2g, rag_worker 1500m (embedding + шифрованные чанки),
  translate 3g — «сколько дадут» заменено фиксированными потолками.
- **PDP «все данные, что есть»:** `ListingOut` + updated_at/last_seen_at/
  price_changed_at (source_language уже был); карточка Listing.tsx — блок
  «Характеристики» (кузов/год/объём/топливо/КПП/привод/пробег/цвет/VIN,
  каждая строка с пояснением `info-row__hint`, пустые не рендерим) и блок
  «Данные объявления» (статус «в продаже/снято», источник+ID, в базе с,
  обновлено источником, цена менялась, последняя проверка); название с
  источника — заголовком, оригинал + язык под переводом. CSS: `.info-row--stacked`,
  `.info-row__main/__hint`, `.spec-group__title`.
- **Докерфайлы:** rag — `COPY pyproject.toml uv.lock` (uv.lock не копировался —
  билд падал), torch переведён на CPU-индекс (`[[tool.uv.index]] pytorch-cpu` +
  `tool.uv.sources` + torch как прямая deps: иначе тянулись ~3-5ГБ nvidia-*),
  uv.lock перегенерирован (nvidia-пакетов 0); translate/rag — retry-циклы
  (5 попыток) + BuildKit cache-маунты pip/uv (сеть рвёт большие колёса).
  **MinIO:** образ `minio/minio` удалён из Docker Hub (2025) — compose
  `MINIO_IMAGE` (по умолчанию `bitnamilegacy/minio:latest`); qdrant:latest
  скачан.
- **Проверки:** сьют 618 passed (+4: heartbeat ×2, doctor-лок ×2), vitest
  88/88, tsc чист, ruff чист. `docker compose config` валиден.
- **Запуск и живые правки (стек поднят, все сервисы healthy):** translate —
  transformers v5 убрал pipeline «translation» → пин `transformers>=4.44,<5`;
  rag — `migrations/env.py` импортировал несуществующий top-level
  `infrastructure` → `rag_core.infrastructure.repositories`; в рантайм-стейдж
  докерфайла добавлены COPY rag_core/rag_worker/rag_api (editable-установка
  ссылается на /app). rag_worker/rag_api/translate healthcheck —
  `start_period: 300s` (первая загрузка весов e5/NLLB с HF занимает минуты,
  иначе контейнер помечается unhealthy). miniapp — `wget http://127.0.0.1/`
  (localhost резолвится в ::1, nginx слушает только IPv4). MinIO: quay-зеркало
  официального образа закрыто (401) — остались на bitnamilegacy, named-volume
  `auto_bot_minio_data` разово chown на 1001:1001 (bitnami run-as non-root).
  `.env`: `RAG_LLM_PROVIDER=glm-5-turbo` → `glm` (pydantic-валидация провайдера;
  модель осталась `glm-5-turbo`). `ListingOut` + `source_language` (колонка
  была в ORM, забыли в схеме — фронт ждёт её для показа языка тайтла).
  Итог: 14/14 контейнеров healthy, one-shot миграции exit 0; смоук
  `POST /translate` → 200 с переводом; openapi отдаёт updated_at/
  last_seen_at/price_changed_at/source_language. Полный pytest 618 passed.
  HF-токен (опционально): без HF_TOKEN загрузка моделей медленная и
  rate-limited — можно добавить `HF_TOKEN` в .env и пробросить в
  translate/rag_worker.
- **Инцидент «вебапп не открывается»:** широкий `docker compose up -d` без
  `--profile` поднял gateway (micro), а у него сетевой алиас `backend` — DNS
  сети стал отдавать два IP на имя `backend` round-robin, и половина запросов
  nginx→API уходила в шлюз без каталога (`service 'catalog' unavailable` →
  502). Правило из №60 подтверждено: строго один профиль; gateway погашен
  (`docker compose stop gateway`), `/api/listings` стабильно 200.

## 64. Квота AI «за выдачу результата» вместо «за сообщение» (2026-10-17)

- **Фидбек юзера:** «сейчас нормируется 1 сообщение как 1 AI-поиск — на демо
  человек не может пообщаться; мерить надо не сообщением, а выдачей результата».
- **Метрика изменена:** `ai_daily_limit` (free 3 / pro 200 / business ∞) теперь
  списывается только когда агент **реально выдал результат**: preview_search
  показал варианты или finalize_search запустил полный поиск. Уточняющие
  вопросы, правки критериев, пустые выдачи — бесплатны. Реализация:
  `app/services/ai_quota.py` (Redis-счётчик `ai_quota:{uid}:{YYYYMMDD}`,
  TTL сутки); `ToolContext.quota_limit` → `run_agent(quota_limit=...)`;
  исчерпанный лимит → вежливый отказ с апселлом Pro, но диалог продолжается.
- **Обвязка:** `/api/dialog/message` берёт тариф юзера из БД, `/api/ai/message`
  — из JWT-юзера; analytics-событие `ai_search` (kind=preview/finalize, relaxed,
  count) для воронки. Тексты тарифов: «AI-сообщений/день» → «AI-поисков/день»
  (payments, бот-подписка, Profile.tsx), MENU_AI_HINT дополнен «диалог
  бесплатный».
- **Тесты:** +3 (сообщения не списывают, списание за preview-выдачу, блокировка
  без списания; finalize списывает; None = безлимит без записи). Сьют 614
  passed, vitest 88/88, tsc чист; контейнеры пересобраны, gateway погашен.
  Живая проверка на Redis: consume/allow/reset работают.

## 63. AI-подбор: контекст диалога + цвета + «мягкий» поиск + состояния ленты (2026-10-17)

- **Фидбек юзера:** «цвета не находит; ИИ-подбор жёстко завязан — "найди бричку
  до 30к для семьи чёрную" → пусто, "плохо ищешь" → опять та же заготовка;
  инфо-окна ломают вёрстку; пустое/ошибку в ленте рендерит карточкой без
  центрирования».
- **Цвета (фикс):** фильтр `color` вообще отсутствовал в `build_listing_query` —
  добавлен (ilike по канону). `normalize_color` подключён к `apply_patch`
  («чёрный»→black), справочник цветов в `FIELD_OPTIONS` + enum в tool-схемах —
  LLM выбирает из списка, а не выдумывает. В БД цвет пока только у свежих лотов
  (detail-enrichment) — старые добьёт backfill из MinIO (бэклог).
- **Контекст диалога:** ранний выход «Всё главное собрал» срабатывал на ЛЮБОЕ
  сообщение при заполненных критериях — теперь только на короткие подтверждения
  (`_is_confirmation`: «всё», «давай», «ок»…). Содержательные реплики («плохо
  ищешь», «подешевле») уходят в LLM. System-промпт дополнен блоком «ДИАЛОГ —
  ЭТО ОДИН НЕПРЕРЫВНЫЙ ПОИСК»: короткие реплики = правка текущих критериев +
  повторный preview_search, жаргон («бричка/тачка», «для семьи» → внедорожник/
  минивэн), критика = сигнал ослабить критерии.
- **«Мягкий» поиск:** `search_with_relaxation` в `search.py` — при пустом точном
  запросе progressive-relax: цвет → пробег → кузов/топливо/КПП/привод → годы ±3 →
  бюджет +20%; возвращает близкие варианты с пометкой «ослабил: …» (критерии
  пользователя не меняются). Совсем пусто → предложение ослабить параметры или
  запустить полный поиск (finalize), вместо голой заготовки.
- **Лента (вёрстка):** EmptyState/ErrorState вынесены из `.feed-grid` (на десктопе
  грид сжимал их в узкую карточку одной колонки). `.state` — full-width, центри-
  рование, max-width 480px, `grid-column: 1/-1` страховка для любых грид.
- **Тесты:** +7 (цвет-нормализация, enum в схеме, `_is_confirmation`, критика →
  LLM, relaxation на fake-сессии, пусто → предложение ослабить). Сьют 611
  passed, vitest 88/88, tsc чист; контейнеры backend/bot/miniapp пересобраны,
  gateway погашен. Живая проверка: relaxation на реальной БД отрабатывает
  (strict пусто → «цвет», «бюджет +20%»).

## 62. Спеки в listings + ИИ без выдумок + карточки/лента + сохранение диалогов (2026-10-17)

- **Фидбек юзера:** «нет данных о типе кузова вообще; непонятно как работает ИИ-подбор
  и есть ли данные в сессии; должен работать как MCP — брать инструментарий, а не
  выдумывать; вместо списка — пара карточек, если их мало, если много — переход в
  ленту с сохранённым фильтром; сессии должны сохраняться (посмотреть диалог спустя
  время), диалоги сносить через сутки с разговора».
- **Спеки в listings (этап 5):** миграция `0016_listing_specs_dialog_ttl.py` —
  listings.body_type/fuel/transmission/drive + dialog_sessions.updated_at. Адаптеры
  уже отдавали спеки в UnifiedListing, но `_to_row`/UPSERT их выбрасывали — потому
  «типа кузова нет вообще». Теперь: нормализация в `_to_row` (нераспознанное — как
  есть), UPSERT с `COALESCE(EXCLUDED.x, listings.x)` (не затирать), фильтры по спекам
  в `search.py` и `/api/listings` (ilike), спеки в ListingOut. История заполнится
  при следующих парсингах (raw лежит в MinIO, backfill позже).
- **ИИ как MCP, без выдумок:** справочники `FIELD_OPTIONS` в `app/ai/tools.py`
  (body_type/fuel/transmission/drive/seller_type — значения совпадают с ключами
  normalize_*); enum подставляются прямо в tool-схемы (update_criteria/preview_search/
  finalize_search) — LLM видит допустимые значения; `apply_patch` нормализует значения
  («седан»→sedan, «бензин»→petrol); опции `ask_clarification` для справочных полей
  заменяются справочными (лог `clarification_options_replaced`). preview_search и так
  показывает только реальные объявления из БД.
- **Формат выдачи (finalize):** count через новый `search_listings_page` (items+total):
  0 → «фильтр сохранён, пришлю уведомления»; ≤5 → фото-карточки в чат (с формами
  «вариант/варианта/вариантов»); >5 → кнопка «📱 Смотреть все (N)» — deep-link
  `/feed?make=...&year_from=...&price_max=...`. Feed принимает URL-параметры
  (`deepLinkQuery()`, цены в $, URL чистится replaceState). Параметры прокидываются
  и по спекам (body_type/fuel/transmission/drive).
- **Сессии диалогов:** архив в PG на **каждом** ходу (`dialog_message` →
  archive_session), не только при финализации; `updated_at` — время последнего
  сообщения. `POST /api/dialog/restore` + `restore_dialog()` — поднять последний
  диалог из архива в Redis (новый session_id, критерии+история переносятся; активный
  не трогаем). Бот: кнопка «🕘 Продолжить прошлый диалог» в меню AI + callback
  `dlg:restore` (показывает историю `_format_history`, дальше обычная панель).
  Чистка: cron `dialog_cleanup_job` (04:00 UTC, workers/send.py) сносит архивы
  старше `dialog_ttl_sec` (24ч) от updated_at; Redis-state и так TTL 24ч.
- **589 pytest (+10: нормализация патчей, enum в схеме, справочные опции
  ask_clarification, restore×3, cleanup, UPSERT-спеки; CRON_JOBS-тест обновлён),
  85+ vitest, ruff/tsc чисто.**
- **Живая проверка спеков (прод):** разовый fetch kcar (1 стр.) → 100 объявлений
  с body_type. Корейские категории carctgrNm (중형차/경차/승합차/화물차…)
  замаплены в канон во втором коммите (`fix(normalize)`): итого suv 46, sedan 41,
  hatchback 8, pickup 4, van 1. Encar list-API BodyType/transmission/drive не
  отдаёт (fuel отдаёт) — обогащение из detail-страниц в бэклог. Дедуп-кэш
  (dedup:*, TTL 48ч) при разовом рефетче чистится: `redis-cli --scan --pattern
  "dedup:*" | xargs -r redis-cli del`. Грабля-продолжение: `docker compose up`
  после упавшего recreate оставляет контейнеры-сироты вида
  `1b11f34f9fae_auto_bot-backend-1` — снимать `docker rm -f` и поднимать поимённо.

# Auto Selection — PROGRESS

## 60. Фикс входа через Telegram (диагностика + окно забора JWT)

- **Симптомы:** (а) в миниаппе «вход через ТГ» → бот отвечает «✅ подтверждён», но аппка снова показывает форму; (б) на сайте после возврата из бота — «⌛ Ссылка входа устарела».
- **Диагностика:** цепочка код→бот→JWT проверена curl'ом end-to-end на проде (200 на `/telegram/link` → `/link/confirm` → `/link/{code}` — JWT отдаётся). Бот коды подтверждал (логи, 200). Найдено в логах: `POST /api/auth/telegram` (initData-логин миниаппа) — **стабильно 401**; причина 401 в лог не писалась.
- **Фиксы:**
  - `app/api/auth.py`: `logger.warning("initData login rejected: %s", exc)` в `_authenticate_via_init_data` — точная причина (hash mismatch / expired / user missing) теперь видна в логах.
  - `_LOGIN_CONFIRM_TTL_SEC` 120 → **600** (= TTL кода): юзер может сидеть в боте дольше 2 минут.
  - `frontend/src/screens/Login.tsx`: `TG_POLL_MAX_TRIES` 72 → **240** (~10 мин, синхронно с бэком).
- **Деплой:** прод `backend`+`miniapp` пересобраны и подняты поимённо (`docker compose -p auto_bot --profile mono build/up --no-deps`; бот/воркер не тронуты), тест-стенд `-p auto_bot_test` с оверрайдом аналогично. Проверено в контейнере: TTL600 + warn-лог на месте; 8443 и `/auth/telegram/link` живые.
- **Тесты:** `test_auth_api.py` 9 passed в новом образе; vitest `Login.test.tsx` 3 passed.
- **⏳ Открытый вопрос:** почему initData-логин 401. `BOT_TOKEN` подтверждён через getMe (`@ftadasd_bot`/7048715401 — тот же бот, что подписывает initData), алгоритм `validate_init_data` покрыт тестами. Следующий шаг: повторить вход в аппке и прочитать `docker logs auto_bot-backend-1 | grep 'initData login rejected'`.

## 61. КОРЕНЬ ВХОДА НАЙДЕН: Telegram Desktop подписывает initData по раскодированным значениям

- **Диагноз (доказано вычислением):** временно залогировали полный raw initData юзера в проде и пересчитали HMAC в контейнере с токеном из `.env`. `hash` юзера НЕ совпал с канонической схемой (подпись по URL-encoded значениям), но **ТОЧНО совпал** (`bb5c8623...`) при подписи по **раскодированным** (`unquote`) значениям — Telegram Desktop (2026) считает data_check_string по декодированным данным, вопреки доке («data_check_string is built exactly as received, with url-encoded values»).
- **Фикс `app/core/security.py::validate_init_data`:** каноническая проверка → при `hash mismatch` fallback на dcs из `unquote`-значений. Оба варианта покрыты тестами.
- **Тесты `tests/test_security_initdata.py` (новый, 4):** канон-подпись ок; **desktop decoded-подпись ок**; битая подпись → `hash mismatch`; старый `auth_date` → `expired`. Полный suite: **579 passed** (575+4).
- **Проверка на реальных данных:** прод-контейнер принял живой initData юзера (`ACCEPTED: 809464979 PashtetMedved`) до всякого клика — авто-вход в миниаппе теперь работает.
- **Деплой:** прод backend (build+up --no-deps) и тест-стенд `-p auto_bot_test` с оверрайдом. Временный raw-лог убран, оставлен компактный `initData login rejected: <reason>`; скрипт разбора — `shots/analyze_initdata.py`.
- **Грабли (запомнить):** 401 при валидном токене — не спешить менять токен; посчитать HMAC по обоим вариантам dcs (encoded/decoded) на реальном initData из лога. В изолированном прогоне pytest в контейнере копировать `pyproject.toml` — иначе `asyncio_mode` не применится и все async-тесты падают (ложные «152 failed»).

## 32. raw_payload → S3/MinIO (фаза 6)

- **boto3 vs aioboto3 решено: aioboto3** — fetch/send воркеры асинхронные,
  синхронный boto3 блокировал бы event loop. **Миграция `0012_raw_payload_s3`**:
  колонка `listings.raw_payload` (JSONB, раздувала БД/бэкапы) выпилена, вместо
  неё `raw_key` (TEXT) — ключ S3-объекта; NULL = не загружен (MinIO лежал /
  флаг выключен).
- **`S3Storage`** (`app/services/storage.py`): ленивый импорт aioboto3,
  botocore `Config` (retries=3, connect 5s / read 30s), MinIO через
  `endpoint_url`; ключ `raw/{source}/{yyyy}/{mm}/{listing_id}_{content_hash}.json`
  (retention по префиксу + бесплатная дедупликация: хэш не менялся — объект
  не перезаписываем); S3 Metadata (source/listing_id/content_hash/fetched_at);
  `put_raw`/`presign_raw`/`delete_older_than`/`ensure_bucket` — все с
  fallback: ошибка → warning в лог, объявления сохраняются.
- **`save_listings(..., storage=)`**: NEW/смена `content_hash` → параллельная
  загрузка (`asyncio.gather`, `return_exceptions`) + executemany
  `UPDATE listings SET raw_key`; без изменений → загрузки нет.
  Fetch-воркер создаёт storage в startup-ctx (`ensure_bucket`).
- **Retention-крон** `raw_retention_job` 03:30 UTC: list_objects_v2 пагинацией
  → пакетный delete_objects (≤1000), объекты старше `RAW_RETENTION_DAYS=180`.
- **Админ-endpoint `GET /api/admin/listings/{id}/raw`** (internal token):
  presigned GET на 10 мин (`RAW_PRESIGN_TTL_SEC`), прямого доступа к MinIO
  у админки нет; raw_key NULL → 404, storage недоступен → 502.
- Конфиг: `RAW_PAYLOAD_ENABLED` (по умолчанию false), `S3_ENDPOINT_URL`/
  `S3_BUCKET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_REGION` (через `env_file: .env`
  в compose; в docker-сети endpoint `http://minio:9000`). PLAN: открытый
  вопрос закрыт; фаза 7 — добавлен план (RANGE по `recorded_at`, PK обязан
  включать ключ, pg_partman, связка «горячее/холодное» с MinIO).
- **Edge-кейсы (rev. 2)**: retention-крон возвращает ключи удалённых объектов
  и обнуляет `listings.raw_key` (`UPDATE ... WHERE raw_key = ANY(:keys)`,
  чанки по 1000) — иначе через 180 дней админка генерит presigned URL в
  никуда. `ensure_bucket` различает `AccessDenied` (токен без CreateBucket →
  warning «создайте вручную», не stack trace). Гонка retention × fetch
  проанализирована и исключена: raw_key ставится только для NEW/смены хэша,
  ключ содержит yyyy/mm парсинга — совпасть с удаляемым (≥180 дней) не может;
  обнуление только по точному совпадению ключа. `downgrade()` 0012 возвращает
  только схему, данные — нет (зафиксировано в миграции).
- Тесты: **314 passed** (+14: формат ключа, загрузка NEW/raw_key-UPDATE,
  unchanged без загрузки, fallback при ошибке S3, disabled, retention
  (удаление + обнуление raw_key, no-op без БД), ensure_bucket
  (создание / AccessDenied), admin presigned URL / 404), ruff чист,
  `alembic heads` → `0012`, `docker compose config` ОК.
- **⏳ Статус: код готов, e2e с живым MinIO НЕ проверен** (главный техдолг
  фазы): реальный fetch → объект по ключу → presigned URL открывается →
  повторный fetch не перезаписывает → retention с RAW_RETENTION_DAYS=0/1
  удаляет и обнуляет raw_key → сценарий с токеном без CreateBucket.
  Проверить на копии БД: `alembic downgrade -1` → `upgrade head`.

## 33. Подготовка `listing_price_history` к партиционированию (фаза 7, без включения)

- Партиционирование в PG не выключается флагом: `PARTITION BY RANGE` — сразу
  партиционированная таблица. Поэтому схема готовится заранее (вариант «B»),
  включение — строго по триггеру (1–2 млн строк).
- **Миграция `0013_price_history_partition_ready`**: PK `(id)` →
  `(id, recorded_at)` (ключ RANGE обязан входить в PK; `id` оставлен как
  tiebreaker `ORDER BY recorded_at, id`) + `recorded_at` NOT NULL. Данные не
  переносятся, таблица не партиционируется. Индекс
  `idx_price_history_listing (listing_id, recorded_at)` уже содержал ключ.
- **Аудит запросов** (PLAN §6): favorites first_price / listings график —
  полная история по `listing_id` (границы по `recorded_at` не добавлены —
  сломали бы семантику; при триггере — опциональный `since`), send
  `_old_price` — `LIMIT 2` по индексу. Все запросы — через
  `idx(listing_id, recorded_at)` → per-partition index scans.
- ORM: `ListingPriceHistory.recorded_at` — `primary_key=True, nullable=False`
  (композит с `id`); вставка идёт raw SQL — поведение не меняется.
- Тесты: 314 passed, `alembic heads` → `0013`.

## 31. Перевод тайтлов: NLLB-микросервис (фаза 5)

- **Размещение NLLB (открытый вопрос PLAN) решено**: отдельный optional-сервис
  `services/translate` (FastAPI + `nllb-200-distilled-600M`, CPU-образ, порт
  8200), не в RAG: изоляция отказа (перевод некритичен) и памяти
  (~2 ГБ RSS), независимый деплой/своп модели. Bearer `API_TOKEN` (опционально),
  `GET /health`, warmup при старте, детект языка по письменности
  (`kor_Hang`/`zho_Hans`/`rus_Cyrl`/`eng_Latn`) для `source_lang=auto`,
  in-process кэш, батчи через transformers pipeline.
- **Миграция `0011_translations`**: `listings.title_raw` (оригинал — до фазы 5
  title вообще не персистился, только content_hash), `title_ru`,
  `source_language`, `translated_at`. Upsert пишет `title_raw`.
- **Триггер перевода — тот же `content_hash`**: `save_listings` возвращает
  `translate_ids` (NEW + смена хэша) → fetch-воркер ставит задачу
  `translate_listings` (та же очередь `fetch`), которая батчами
  (TRANSLATE_BATCH_SIZE) зовёт сервис и пишет `title_ru/source_language/
  translated_at` (executemany). Ошибка сервиса → title_ru остаётся NULL,
  UI показывает оригинал.
- **`TranslateClient`** (`app/services/translate_client.py`): батчевый
  POST /translate, Redis-кэш `tr:{tgt}:{src}:{sha1}` TTL 30 дней,
  retry с backoff (5xx не ретраим), circuit breaker (3 ошибки → пауза 5 мин +
  алерт), `TRANSLATE_ENABLED` + `TRANSLATE_SERVICE_URL` (пусто = выключен),
  `TRANSLATE_SOURCE_LANGS` (JSON: encar/kcar → kor_Hang, che168 → zho_Hans).
- **UI**: `ListingOut` + `title_raw`/`title_ru`; Mini App — подзаголовок
  с переводом на карточке, «Название» на экране объявления; карточка бота
  предпочитает `title_ru`.
- Тесты: **300 passed** (+15: клиент — кэш/batch/fallback/CB, задача
  `translate_listings`, `translate_ids`, карточка с title_ru), ruff чист,
  `alembic heads` → `0011`, `tsc`/`vite build` ОК.

## 30. Отслеживание объявлений: наличие, история цен, статусные уведомления (фазы 1-4)

- **Миграция `0009_listing_tracking`**: `content_hash`, `is_active`,
  `first_seen_at`/`last_seen_at` (бэкфилл из `parsed_at`), `disappeared_at`/
  `price_changed_at`, таблица `listing_price_history`, partial-индекс активных,
  индекс по `last_seen_at`, BRIN по `first_seen_at`, индекс истории цен.
- **Upsert переписан на CTE** (1 запрос): `old_price`/`old_currency`/`old_hash`/
  `was_active` из `existing` (FOR UPDATE) + RETURNING; `first_seen_at` не
  сбрасывается, `disappeared_at = NULL` при реактивации; дедуп: cross-source
  Redis до записи, in-source — `ON CONFLICT` (source, source_id).
- **`compute_content_hash`** = sha256(title|price|currency|mileage|sorted images);
  смена хэша — единый триггер «объявление изменилось» (в фазе 5 — повторный
  перевод тайтла). Точки цены пишутся при NEW и смене пары (price, currency).
- **Фаза 3**: `0010_sent_log_kind` (PK → user_id+listing_id+kind), `mark_stale`
  (CB-aware, RETURNING id), cron `stale_check_job` 04:00 UTC, статусные
  уведомления `listing_status_scan` → `send_listing_status`
  (price_drop/gone/returned; аудитория — получатели из sent_log; rate limit,
  тихие часы, антидубль по kind).
- **Фаза 4**: история цен в UI — `PricePointOut`, в `ListingOut` добавлены
  `is_active`/`first_seen_at`/`first_price`/`price_history`; карточка
  `GET /api/listings/{id}` отдаёт `price_history` (ASC; в ленте — нет, иначе N+1),
  `GET /api/favorites` — `first_price` одним батч-запросом. Mini App: секция
  «История цен» на экране объявления, бейджи «⬇️ −N%» / «🔴 Исчезло» на карточке
  и «⬇️ (было X)» / «🔴» в избранном.
- Тесты: **285 passed** (+1 к 284), ruff чист, `alembic heads` → `0010`.

## 29. OpenAI выпилен + ParserDoctor: триаж причин падения источника

- **LLM только за Китай**: провайдер OpenAI удалён из фабрики
  (`glm | anthropic | ollama | mock`), `OpenAICompatibleClient` →
  `ChatCompletionsClient` (GLM/DeepSeek/Ollama), `openai_api_key` из
  config/.env/.env.example убран, модели `gpt-4o*` → `glm-4.6`,
  неизвестный провайдер → явный `LLMError`. Обновлены README/PROGRESS/тесты.
- **ParserDoctor — триаж** (`classify_page` / `classify_fetch_error`):
  - `banned` — HTTP 401/403/406/429 или 2xx-страница с маркерами антибота
    (`captcha`, `安全验证`, `滑动验证`, `punish`, `waf`, …) или пустышка
    < 300 символов → алерт «🚫 бан/геоблок — ротация прокси», LLM не зовём;
  - `server_down` — 5xx, таймауты, ошибки коннекта (HttpClient заворачивает
    их в `FetchError`, код парсится regex) → алерт «🛑 источник недоступен»;
  - `http_error` — прочие 4xx (404/410: страница списка переехала) →
    подсказка проверить `base_url/list_path`;
  - `markup_change` — страница живая, карточек 0: только тут зовём GLM.
- **Cooldown переставлен**: ключ `doctor:{source}` ставится только перед
  LLM-ремонтом — бан и падение сервера триажатся при каждом запуске врача
  (раньше cooldown 6 ч глотал бы повторные диагнозы).
- Тесты: **264 passed** (+5: 403/5xx/капча-200/c cooldown/unit-классификаторы);
  ruff чист.


## 28. Фаза 5 — deferred [бэкенд] items (UI/UX roadmap wrap-up)

- **Batch-claim**: `POST /api/partner/leads/batch` `{"limit":1..10}` — атомарно
  забирает до N доступных лидов с учётом дневной квоты (исчерпание → 429,
  как у одиночного claim). Сервис `partners.claim_batch`, аналитика
  `lead_sold` c `batch: true`, кнопка «⚡ Взять 3» в пуле ЛК.
- **Биллинг**: каталог тарифов `PLAN_CATALOG` (starter 5/$49, pro 15/$149,
  salon 40/$399), `GET /api/partner/billing` (план, квота, расход), экран
  «Биллинг» в ЛК вместо заглушки (прогресс-бар квоты + таблица тарифов).
- **Тихие часы**: применялись в send worker (фильтр → `NOTIFY_QUIET_HOURS_DEFAULT`);
  добавлены настройка из бота (меню «Уведомления → 🌙 Тихие часы», пресеты
  23:00–08:00 / 22:00–10:00 / выкл через `BackendClient.quiet_hours`) и
  поддержка в `POST /api/notifications/settings` (notify_mode опционален,
  `quiet_hours_clear` для сброса).
- **AI-помощник админа**: `app/services/admin_assistant.py` — tool-loop
  (до 3 итераций) поверх `build_llm_client` (GLM, `LLM_PROVIDER=glm`);
  tools: `leads_stats`, `partners_list`, `sources_health` (только чтение);
  `POST /api/admin/assistant/chat` (X-Internal-Token; LLM недоступен → 503);
  `ChatWidget.tsx` подключён к эндпоинту (история, 503-подсказка про ключ).
- Тесты: **259 passed** (+15: batch-claim сервис/API, биллинг, ассистент);
  ruff чист; фронт `tsc + vite build` — ок.
- Напоминание владельцу: `alembic upgrade head` (0004–0008) и вписать
  `GLM_API_KEY` в `.env` (иначе ассистент отвечает 503 с подсказкой).

> Экосистема подбора автомобилей из-за рубежа (Корея, Китай, ОАЭ и др.) для
> пользователей из РБ / РФ / СНГ: Telegram-бот + WebApp (Mini App) + сайт
> с AI-диалогом, парсингом источников, RAG-базой знаний и монетизацией.
> Реализация ТЗ (`TZ.md`). Обновлено: 11.10.2026 · **208 тестов backend** ·
> дерево чистое.

**Легенда статусов:**

| Метка | Значение |
|---|---|
| ✅ | Готово, покрыто тестами, в кодовой базе |
| ⏳ | Код готов — **ждёт действия владельца** (миграция, creds, живая проверка) |
| 📋 | Бэклог, не начато |

---

## 0. Статус-дашборд

| # | Блок | Статус | Что осталось |
|---|---|---|---|
| 1 | Этапы ТЗ 0–7: бот, backend, AI-агент, RAG, Mini App | ✅ | — |
| 2 | Этап 8: мониторинг, алерты, `/health/detailed`, `/metrics` | ✅ | — |
| 3 | Планировщик: `schedule_cron` + интервальные задачи | ✅ | — |
| 4 | Продуктовая аналитика (P1-7): `analytics_events`, хуки | ✅ | — |
| 5 | Лиды: `POST /api/leads`, `PATCH /api/leads/{id}` | ✅ | — |
| 6 | Адаптер Che168 (P2-10) | ⏳ | `alembic upgrade head`, сверка живого HTML/гео, `enabled=true` |
| 7 | ParserDoctor (ИИ-ремонтник селекторов) | ⏳ | код готов, `doctor_mode=off`; включается в БД |
| 8 | Прокси-шлюз DataImpulse (антибан) | ✅ | включается переменными `.env` при банах |
| 9 | Миграции `0004`–`0006` (аналитика, che168, партнёры) | ⏳ | `alembic upgrade head` |
| 10 | Telegram Stars монетизация | ⏳ | код-путь полный; живой тестовый платёж |
| 11 | Живой E2E RAG-стека (GLM + ingest + запрос) | ⏳ | creds + `ingest_kb.py --force` |
| 12 | Token Bucket Telegram ~30 msg/s (P2-9) | 📋 | кандидат №1 следующего спринта |
| 13 | SQL-дашборды воронок (retention D1/D7, конверсии) | 📋 | кандидат №2 |
| 14 | LLM cost tracking (P3) | 📋 | — |
| 15 | Ротация PQ-ключей (P3) | 📋 | — |
| 16 | Push `refactor/monorepo` (rag_service) | 📋 | ветка готова локально |
| 17 | HTTPS `MINIAPP_URL` для прода | 📋 | домен/TLS |
| 18 | Рефакторинг веб-авторизации (nullable telegram_id) | 📋 | порог ~30k веб-юзеров |
| 19 | Партнёрский контур (P2-11): API ключей, claim лидов, CPL | ✅ | накатить `0006`, создать первого партнёра, веб-ЛК |

### Действия владельца (единственное, что мешает «зелёному» статусу)

- [ ] `uv run alembic upgrade head` — накатить `0004` + `0005` (пп. 6, 9).
- [ ] Che168: сверить селекторы с живым HTML и гео-доступность (403 из РБ →
      включить DataImpulse с `PROXY_DATAIMPULSE_GEO=cn`), затем
      `UPDATE sources SET enabled=true WHERE name='che168'` (п. 6).
- [ ] Опционально: `"doctor_mode": "suggest"` в `sources.config` che168 (п. 7).
- [ ] Партнёрский контур: после миграции создать партнёра
  `POST /api/admin/partners` — ключ показывается один раз;
  договориться с 2–3 салонами/брокерами о пилоте (п. 19).
- [ ] Telegram Stars: тестовый платёж XTR (п. 10).
- [ ] RAG E2E: `GLM_API_KEY`, PQ-ключи, `ingest_kb.py --force`, контрольный
      запрос к `rag-api` (п. 11).

---

# Часть I — обзор проекта

## 1. Что это и для кого

Пользователь заходит в Telegram-бота или Mini App и на естественном языке
описывает, какой автомобиль хочет (марка/модель, бюджет, год, город).
AI-агент собирает критерии, ищет варианты по агрегаторам (Encar, KCar,
Che168), показывает карточки, отвечает на вопросы о доставке/растаможке через
RAG по базе знаний, считает экономику «под ключ» в USD и подписывает
пользователя на уведомления о новых вариантах. Монетизация — Pro-подписка
через Telegram Stars; лиды из диалога отдаются менеджерам.

## 2. Технологический стек

| Слой | Технологии |
|---|---|
| Backend | Python 3.13, FastAPI, uvicorn, Pydantic v2 / pydantic-settings |
| Бот | aiogram 3 (FSM в Redis), long polling |
| БД | PostgreSQL + SQLAlchemy 2 (async) + Alembic (0001–0005) |
| Очереди | RabbitMQ (aio-pika), producer/TaskWorker/DLQ/cron |
| Кэш/состояние | Redis (FSM, DialogState, кэши, прокси-пул, антидубли, cooldown'ы) |
| Парсеры | httpx + selectolax/lexbor (SSR), общий HttpClient (ретраи, 429, прокси) |
| Frontend | React 18 + Vite + TypeScript, @telegram-apps/telegram-ui, React Router |
| RAG-сервис | FastAPI + RabbitMQ worker, Qdrant (гибрид vector+BM25/RRF), MinIO, multilingual-e5 |
| LLM | GLM (Zhipu, основной), fallback: DeepSeek / Anthropic / Ollama / mock (OpenAI выпилен) |
| Криптография | PyJWT, PBKDF2-SHA256 (пароли сайта), гибрид ML-KEM-768 + X25519 + AES-256-GCM (документы) |
| Инфра | Docker Compose (postgres, redis, rabbitmq, qdrant, minio, backend, bot, workers, miniapp, rag_*) |
| Тесты | pytest + pytest-asyncio (**208 тестов** backend), контрактные тесты адаптеров, mypy, ruff |

## 3. Архитектура

```
Пользователь ── Telegram ──► Бот (aiogram3) ─┐
Пользователь ── WebApp/сайт ─► Backend (FastAPI) ── PostgreSQL
                                  │  ▲
                    AI-агент ─────┤  └─ RAG API (:8100) ─► RabbitMQ ─► RAG Worker (:8101)
                    (tool loop)   │                          │
                                  ▼                          ├─ Qdrant (гибридный поиск)
                  Scheduler (schedule_cron) ─► Fetch Worker ─► адаптеры ─► listings
                                                     │  ▲
                                                     │  └─ ParserDoctor (GLM чинит селекторы)
                                                     └─ ProxyPool / DataImpulse (антибан)
                                  ▲
                          Send Worker ─► уведомления в Telegram
```

Потоки:
- **Диалог**: пользователь → агент (LLM + tools) → поиск/вопрос → ответ;
  заинтересованность → `POST /api/leads` → менеджер.
- **Парсинг**: cron/ручной запуск → очередь fetch → адаптеры
  (Encar API / KCar API / Che168 HTML) → нормализация → кросс-дедуп →
  `listings`; при смене вёрстки — ParserDoctor, при банах — прокси-шлюз.
- **Уведомления**: новые листинги → матчинг активных фильтров → Send Worker →
  instant или digest (тихие часы, антидубли).
- **RAG**: `POST /api/v1/ask` (rag_api) → JWT → RPC `query_queue` → worker →
  гибридный поиск Qdrant + LLM-генерация → ответ с источниками и confidence.
- **Аналитика**: хуки в API/боте → `analytics_events` → SQL-агрегаты,
  `events_24h` в `/metrics`.

## 4. Структура репозитория

```
auto_bot/
├── app/                      # Backend
│   ├── api/                  # HTTP-роутеры (см. §6)
│   ├── ai/                   # агент, LLM-клиенты, RAG-клиент, промпты, tools
│   ├── adapters/             # encar, kcar, che168, registry, прокси, дедуп
│   ├── bot/                  # aiogram: handlers, button_flow, __main__
│   ├── core/                 # config, security (initData/JWT), deps, pq_crypto
│   ├── db/                   # models, session, migrations 0001–0005 (alembic)
│   ├── queue/                # RabbitMQ: producer, TaskWorker, DLQ, cron
│   ├── schemas/              # Pydantic-контракты (UnifiedListing, Lead…)
│   ├── services/             # users, dialog, search, notify, subscription,
│   │                         # fetch, analytics, alerting, source_health,
│   │                         # cron, parser_doctor
│   ├── workers/              # fetch, send
│   └── main.py               # FastAPI app (uvicorn app.main:app)
├── frontend/                 # Mini App + сайт (React/Vite/TS)
├── services/rag/             # RAG-микросервис (rag_core/rag_worker/rag_api + kb/)
├── tests/                    # pytest (208 тестов)
├── docker-compose.yml        # весь стек
├── pyproject.toml            # uv-проект backend
├── TZ.md                     # техническое задание
├── PROGRESS.md               # этот файл
└── .env.example              # шаблон конфигурации
```

## 5. Модели данных (основные)

- **User** — telegram_id (PK), username, tier (free/pro), notification_mode,
  **email (unique)** + password_hash (сайт), синтетические отрицательные
  telegram_id для веб-пользователей (PK/FK сквозной).
- **Filter** — SearchCriteria пользователя (марка/модель/цена/год/источники/город).
- **Listing (UnifiedListing)** — нормализованное объявление: VIN (у Che168
  скрыт → None), источник, цена (валюта источника), год/пробег/объём, страна.
- **Favorite** — избранное (миграция `0002_favorites`).
- **Subscription/Payment** — Pro через Telegram Stars.
- **DialogSession** — архивация DialogState из Redis.
- **Lead** — обращение из диалога: user_id, listing_id?, статус
  new/in_progress/closed/rejected, manager_id (таблица в `0001`).
- **AnalyticsEvent** — сырые события воронки (`0004_analytics_events`).
- **Source (админ)** — реестр источников: adapter_class, kind (api/parser),
  приоритеты, rate limits, `schedule_cron`, capabilities, `enabled`,
  `credentials_ref`; миграция `0005` добавляет `che168` (enabled=false).
- Миграции: `0001_initial`, `0002_favorites`, `0003_web_auth` (email unique),
  `0004_analytics_events`, `0005_add_che168_source`.

---

# Часть II — подсистемы

## 6. HTTP API (FastAPI, prefix `/api`)

| Роутер | Эндпоинты |
|---|---|
| `auth` | `POST /auth/telegram` (initData→JWT), `POST /auth/register`, `POST /auth/login`, `POST /auth/magic-link` |
| `users` | upsert профиля |
| `me` | `GET /me` — профиль + tier |
| `filters` | CRUD: `GET/POST /filters`, `PATCH/DELETE /filters/{id}` |
| `listings` | `GET /listings` (поиск/пагинация), `GET /listings/{id}` |
| `favorites` | `GET/POST/DELETE /favorites…` |
| `leads` | `POST /leads` (internal), `PATCH /leads/{id}` (internal: статус, manager) |
| `payments` | `POST /payments/stars` (Telegram Stars), `POST /payments/success` |
| `admin` | `GET/PUT /admin/sources…`, `POST /admin/sources/{name}/fetch`, health источников (X-Internal-Token) |
| `dialog` | `POST /dialog/message`, `POST /dialog/reset` (+ хуки аналитики) |
| `ai_search` | `POST /ai/message`, `POST /ai/reset`, `POST /ai/finalize` (JWT) |
| `notifications` | `POST /notifications/settings` (instant/digest/off), `POST /notifications/scan` |
| system | `GET /health`, `GET /health/detailed` (postgres/redis/rabbitmq, 503 при недоступной БД), `GET /metrics` (агрегаты + `events_24h`; **X-Internal-Token**) |

## 7. Telegram-бот ✅

- Команды (`set_my_commands`, личные чаты): `/start`, `/menu`, `/reset`,
  `/help`, `/stop`.
- **Кнопка-меню с WebApp**: «🚗 Поиск авто» открывает Mini App (`MINIAPP_URL`,
  HTTPS в проде).
- Inline-меню `/menu`: AI-подбор, «📱 Открыть приложение» (WebAppInfo),
  уведомления (мгновенно/дайджест/выкл), подписка, сброс диалога.
- FSM в Redis (`fsm:{user_id}`), кнопочный fallback (`button_flow.py`) при
  недоступности LLM.
- Уведомления: instant (rate-limit) или digest (3–5 карточек, тихие часы,
  антидубли `notified:{uid}:{lid}` TTL 7д).

## 8. AI-агент ✅

- LLM-клиенты (`app/ai/llm_client.py`): `OpenAICompatibleClient` (GLM —
  основной, DeepSeek, OpenAI, Ollama), `AnthropicClient`, `MockLLMClient`
  (тесты/dev), фабрика по `LLM_PROVIDER`.
- Tool loop с подтверждением фильтров; лимит шагов, ранний выход при
  заполненных критичных полях, история 8 сообщений; `DialogState` в Redis
  (`dialog:{user_id}`, TTL 24ч), архивация в `dialog_sessions`.
- Финализация = фильтр в БД (для уведомлений) + задачи парсинга по источникам.
- RAG (`app/ai/rag_client.py`): таймаут 5с, кэш Redis 1ч, circuit breaker
  (5 ошибок → пауза 5 мин), confidence ≥ 0.6 → ответ из БЗ, иначе fallback
  на LLM, затем честное «уточните у менеджера». Промпт-защита от инъекций.

## 9. RAG-микросервис (services/rag) ✅

- `rag_core/` — hexagonal-ядро: domain / application / infrastructure.
- `rag_worker/` — консьюмеры RabbitMQ: `query_queue`, `ingest_queue`,
  `delete_queue`, `reindex_queue`; health/metrics :8101; DLQ/retry.
- `rag_api/` — HTTP-шлюз `POST /api/v1/ask` (internal token → JWT → RPC), :8100.
- Поиск: гибрид vector (multilingual-e5) + BM25/RRF в Qdrant; embedding-кэши;
  опционально query rewriting, semantic cache, parent-child chunking.
- LLM-слой: мультипровайдерный роутер (GLM основной), кэш ответов,
  circuit breaker, лимит `max_tokens`, per-request routing с allowlist.
- Инфра: Qdrant, MinIO (документы), Postgres (реестр документов), Alembic.
- Заливка БЗ: `scripts/ingest_kb.py --force` (поддерживает PQ-шифрование).

## 10. База знаний (services/rag/kb) — РБ / РФ / СНГ + источники ✅

| Файл | Содержание |
|---|---|
| `customs.md` | Единые ставки пошлин ЕАЭС по возрастам (Решение ЕЭК № 107, прил. 6), коммерческий ввоз, РБ (утильсбор, ГАИ), КЗ/Армения/Кыргызстан, порядок действий |
| `fees.md` | Утильсбор РФ (ПП 1291), платежи РБ, СБКТС/ЭПТС, ОСАГО, налоги; **правила конверсии KRW/CNY/EUR/BYN/RUB → USD** (запас ±3–5%) |
| `countries.md` | Источники: Корея (аукционы, Ro-Ro Пусан→Владивосток), Китай (NEV, лицензированный экспортёр, Хоргос/Маньчжурия), ОАЭ, Европа/США, Япония; методика расчёта «под ключ» |
| `delivery.md` | Таблица маршрутов/сроков, что входит во фрахт, фотофиксация, трекинг |
| `risks.md` | Юридические, технические, финансовые риски; чек-лист сделки |
| `legal.md` | Правовая база РФ/РБ/ЕАЭС, экспортные ограничения стран-источников, compliance: обход санкций не поддерживается |
| `faq.md` | FAQ: регистрация, валюты, растаможка по возрастам, уведомления, документы |

Все ставки помечены «проверять на дату ввоза» — зафиксированы только
устойчивые нормы, летучие цифры — с явными оговорками.

## 11. Frontend (Mini App + сайт) ✅

Дополнительно (фазы 1–4 UI/UX ТЗ): полировка Mini App (фото, skeleton, тосты,
динамические чипсы, бесконечный скролл, галерея, онбординг 3 шага + миграция
0007 `users.onboarded_at`), партнёрский ЛК `/partner/*`, админка `/admin/*`
(источники/партнёры/лиды, вход по internal-токену), audit log (миграция 0008
`admin_actions`, логируются create/rotate партнёра), скелет AI-виджета в админке.

UI/UX-ТЗ для всех поверхностей: `docs/UIUX_TZ.md` (v1.0 — дизайн-токены,
Mini App, админка, партнёрский ЛК, бот, тон голоса, чеклист внедрения).

- Экраны: `Onboarding`, `Feed` (лента с чипсами-фильтрами), `Filters`,
  `Listing`, `Favorites`, `Profile`, `AiSearch`, `Login` (email+пароль).
- `api/`: `client.ts` (JWT, base `/api`), `auth.ts`, `ai.ts`, `types.ts`.
- Telegram-интеграция: `telegram-web-app.js`, initData → JWT, тема
  `--tg-theme-*`; в проде — HTTPS `MINIAPP_URL`.
- Вне Telegram — read-only лента + Login для полного доступа.

## 12. Безопасность ✅

- **Telegram initData**: HMAC-SHA256-валидация, max age 24ч.
- **JWT**: access 1ч + refresh 30д (`APP_SECRET_KEY`, HS256).
- **Пароли сайта**: PBKDF2-SHA256, 240k итераций; email — regex-валидация.
- **Веб-пользователи**: синтетические отрицательные telegram_id (PK/FK),
  ретрай 5× при коллизии (долг: отдельный PK, см. бэклог).
- **Внутренние эндпоинты**: `X-Internal-Token` (`INTERNAL_TOKEN`; пустое —
  обратная совместимость с `APP_SECRET_KEY`).
- **RAG**: internal token backend↔rag_api, JWT rag_api↔worker, ротация
  ключей HS/RS/ES, PII-редакция перед записью диалогов.
- **Постквантовое шифрование документов**: гибрид ML-KEM-768 (FIPS 203) +
  X25519 → HKDF-SHA256 → AES-256-GCM, контейнер `AUPQ1`, AAD = ключ объекта.
  `EncryptedFileStorage` над MinIO; включение `ENCRYPT_DOCUMENTS=true` +
  PQ-ключи. Устойчиво к «harvest now, decrypt later».

## 13. Конфигурация (.env)

Основные переменные (полный список — `.env.example`):
`APP_ENV`, `APP_SECRET_KEY`, `INTERNAL_TOKEN`, `APP_BASE_URL`, `MINIAPP_URL`,
`BOT_TOKEN`, `ADMIN_CHAT_ID`, `MANAGER_CHAT_ID`, `DATABASE_URL`, `REDIS_URL`,
`RABBITMQ_URL`; LLM: `LLM_PROVIDER=glm`, `GLM_API_KEY`, `GLM_BASE_URL`,
`LLM_DEFAULT_MODEL=glm-4.6`; RAG: `RAG_SERVICE_URL`, `RAG_API_TOKEN`,
`RAG_JWT_SECRET`, `RAG_CONFIDENCE_THRESHOLD`; алерты: `ALERTS_ENABLED`,
`DLQ_ALERT_THRESHOLD`, `SOURCE_CB_ERROR_STREAK`; PQ: `ENCRYPT_DOCUMENTS`,
`PQ_ENCRYPTION_PUBLIC_KEY/PRIVATE_KEY`; прокси: `PROXY_DATAIMPULSE_USER`,
`PROXY_DATAIMPULSE_PASS`, `PROXY_DATAIMPULSE_GEO`, `PROXY_DATAIMPULSE_PORT`
(823 HTTPS / 824 SOCKS5), `PROXY_DATAIMPULSE_STICKY_TTL_SEC`.

## 14. Docker Compose — сервисы

`postgres`, `redis`, `rabbitmq`, `qdrant`, `minio`, `rag_migrate` (Alembic
rag), `rag_worker` (:8101), `rag_api` (:8100), backend, bot, `worker_fetch`,
`worker_send`, `miniapp` (:8080). Тома: pg_data, redis_data, qdrant_storage,
minio_data.

## 15. Запуск и деплой

Локально:
```bash
uv sync && cp .env.example .env   # заполнить BOT_TOKEN, APP_SECRET_KEY, GLM_API_KEY
docker compose up -d postgres redis rabbitmq
uv run alembic upgrade head
uv run uvicorn app.main:app --reload        # :8000
uv run python -m app.bot                    # бот (команды + меню-кнопка)
uv run python -m app.workers.fetch          # cron-планировщик + парсинг
uv run python -m app.workers.send
cd frontend && npm install && npm run dev   # :8080
```

RAG-стек:
```bash
docker compose up -d qdrant minio rag_worker rag_api
uv run --project services/rag python scripts/ingest_kb.py --force
```

Прод-деплой: `docker compose build` → `up -d` → `alembic upgrade head`
(основная + rag БД) → ingest KB → секреты (GLM_API_KEY, RAG_API_TOKEN,
RAG_JWT_SECRET, PQ-ключи) → HTTPS для MINIAPP_URL.

---

# Часть III — журнал реализации (что наворотили)

Все крупные изменения спринтов «ревью → сейчас». Метки: ✅ закрыто и
протестировано; ⏳ код готов, ждёт владельца.

## 16. ✅ Этап 8 — мониторинг и алерты

- `app/services/alerting.py`: алерты в Telegram на `ADMIN_CHAT_ID`, дедуп
  Redis `alert:{key}` с **эскалацией** (повторы глушатся экспоненциально:
  30 мин → 1 ч → 2 ч, cap 2 ч), `ALERTS_ENABLED`.
- DLQ-монитор в `TaskWorker` (глубина `dead_letter` ≥ `DLQ_ALERT_THRESHOLD` →
  алерт, период `HEALTH_CHECK_INTERVAL_SEC`).
- Алерты на открытие/восстановление circuit breaker'а источников и RAG-CB.
- `GET /health/detailed` (postgres/redis/rabbitmq, 503 при недоступной БД),
  `GET /metrics` (пользователи по tier, объявления, уведомления, latency
  источников, `events_24h`) — закрыт `X-Internal-Token`.
- Попутно исправлен латентный баг: `error_streak`/`total_fetched` в
  `source_health` были `None` до первого flush → `TypeError` на первом
  инциденте нового источника (SQLAlchemy column `default=` срабатывает только
  на flush — инстанцировать с явными значениями).

## 17. ✅ Планировщик (schedule_cron)

- `app/services/cron.py` — матчер 5-полей (*/n, диапазоны, списки; dom+dow —
  OR по стандарту cron).
- `IntervalSpec` в `TaskWorker` (интервальные задачи с Redis-локом
  `interval:{name}:{slot}`).
- Fetch-воркер каждую минуту: `schedule_fetch_due` → источники `enabled` с
  подходящим `schedule_cron` ставятся в очередь (лок
  `sched:{source}:{YYYYMMDDHHMM}` от дублей; CB проверяется внутри задачи).

## 18. ✅ Закрытые пункты ревью (факты по коду)

- Fuzzy-дедуп: `app/adapters/common/dedup.py` — VIN + fuzzy-хэш
  (make|model|year|mileage|price), TTL 48 ч, Redis SET NX.
- Circuit breaker источников: `source_health.py` + проверка в fetch-воркере;
  порог `SOURCE_CB_ERROR_STREAK=5` вынесен в env.
- Callback'и уведомлений бот↔backend совпадают (`instant/digest/off`).
- `INTERNAL_TOKEN` выделен из `APP_SECRET_KEY` (обратная совместимость).
- `Dockerfile`, `alembic.ini`, `frontend/*` закоммичены.

## 19. ✅ Продуктовая аналитика (P1-7)

- Таблица `analytics_events` (миграция `0004`) + `app/services/analytics.py` —
  `track()` по принципу alerting: ошибка записи не ломает бизнес-поток.
- Хуки: `user_registered` (первый upsert, `source: bot|miniapp`),
  `search_completed` (только поиск с фильтрами, не просмотр ленты;
  results/filters), `dialog_message` (`/dialog/message`),
  `subscription_activated` (`/payments/success`, tier/days/stars, только
  первая активация — идемпотентность сохранена).
- `lead_created` → воронка search → dialog → lead замкнута.
- `events_24h` по именам — в `/metrics`. Тесты: `tests/test_analytics.py`.

## 20. ✅ Лиды (воронка диалог → обращение)

- `POST /api/leads` (internal, из бота/Mini App: user_id, listing_id?,
  source?, comment) → событие `lead_created`.
- `PATCH /api/leads/{id}` (internal): статус new/in_progress/closed/rejected
  + manager_id — менеджерский процесс.
- Таблица `leads` была в `0001`. Явный `status="new"` при создании
  (тот же класс бага с column `default=`, что и у `SourceHealth`).
  `Literal`-валидация статуса. Тесты: `tests/test_leads.py`.

### 20.1. ✅ Партнёрский контур (P2-11): CPL-продажа лидов

- `partner_accounts` + `partner_api_keys` (миграция `0006`): план/квота,
  статус; ключ хранится только SHA-256 хэшем, сырой `pi_…` показывается один раз.
- Admin API (`X-Internal-Token`): `POST/GET /api/admin/partners`,
  `POST /{id}/rotate` (мгновенная инвалидация старого ключа), `/{id}/revoke`, `PATCH /{id}`.
- Partner API (`X-API-Key`): `GET /me` (ЛК-состояние), `GET /leads` (пул
  квалифицированных лидов без ПД), `POST /leads/{id}/claim` (эксклюзивный
  захват, 409 если занят, 429 по квоте), `POST /leads/{id}/feedback`
  (accepted/returned/junk/deal — доказательство качества лида). Rate limit
  fixed window в Redis (`PARTNER_RATE_LIMIT_PER_MIN`), fail-open при недоступном Redis.
- События воронки: `partner_lead_claimed`, `partner_lead_feedback`.
- `leads`: `partner_id`, `partner_status`, `claimed_at`, `qualification` (JSONB).
- Тесты: `tests/test_partners.py` (28). Веб-ЛК партнёра — следующий шаг (бэкенд готов).

## 21. ⏳ Адаптер Китая Che168 (P2-10) — код готов, ждёт включения

- `Che168HtmlAdapter` (kind='parser') — SSR-парсинг selectolax/lexbor через
  общий `HttpClient` (ретраи, 429, прокси-ротация, MockTransport-инъекция).
- Нормализация: «23.80万» → 238000 CNY, «5.2万公里» → 52000 км, марка
  иероглифами (丰田 → Toyota) — ~50 CJK-марок в `MAKE_MAP`; топливо/КПП
  поиском подстроки (`detect_fuel`/`detect_transmission` — точный
  `normalize_*` на тексте карточки не работает).
- Селекторы/путь списка — в `sources.config` (смена вёрстки правится в БД
  без деплоя); `raw_payload` хранит HTML карточки; VIN=None (скрыт) → общий
  fuzzy-дедуп. Healthcheck = 200 + контейнер списка (капча/вёрстка → False).
- Миграция `0005` вставляет источник `che168` (cron `*/30 * * * *`,
  **enabled=false**), capabilities содержат `use_proxy=true`.
- Зависимость `selectolax` (в venv 1.0.0 — импорт из `selectolax.lexbor`,
  Modest deprecated). Тесты: `tests/test_che168_adapter.py` (13).
- **Для включения:** `alembic upgrade head` → сверить селекторы с живым HTML
  и гео (403 из РБ → DataImpulse, `PROXY_DATAIMPULSE_GEO=cn`) →
  `UPDATE sources SET enabled=true WHERE name='che168'`.

## 22. ⏳ ParserDoctor — ИИ-ремонтник парсеров

Когда источник отвечает, но парсер отдал 0 карточек (смена вёрстки),
fetch-воркер (fire-and-forget) зовёт `app/services/parser_doctor.py`:
живой HTML → GLM предлагает CSS-селекторы (card/title/price/link) →
**локальная валидация** на том же HTML (≥3 карточек, уникальные ID, цены у
половины+) → режим `doctor_mode` в `sources.config`:

| Режим | Поведение |
|---|---|
| `auto` | применить к БД + `AdapterRegistry.reload_source` + алерт «было/стало» |
| `suggest` | только алерт владельцу с проверенным предложением |
| `off` (default) | выключен |

Cooldown Redis 6 ч (`doctor:{source}`, LLM платный). Любой сбой (LLM
недоступен, мусорный JSON, невалидные селекторы, геоблок) не ломает фетч и
не меняет конфиг. Тесты: `tests/test_parser_doctor.py` (12).
**Включение:** `"doctor_mode": "auto"` (или `suggest`) в `sources.config`.

## 23. ✅ Прокси-шлюз DataImpulse (антибан, опционально)

- Формат по официальным докам: `http://login__cr.cn;sessid.X:pass@gw.dataimpulse.com:823`
  (823 HTTPS / 824 SOCKS5; `cr.*` — страна выхода, `sessid.*` — sticky ~30 мин).
- `GatewayProxyPool` (`app/adapters/common/proxy.py`): ротацию IP делает
  провайдер (per request или детерминированное sessid-окно
  `PROXY_DATAIMPULSE_STICKY_TTL_SEC`, 0 = ротация на каждый запрос);
  `mark_bad` не выбрасывает шлюз навсегда — N ошибок соединения подряд
  усыпляют его на cooldown, `get()` возвращает None → HttpClient ходит
  напрямую (обрыв шлюза не убивает парсинг).
- Фабрика `build_proxy_pool(settings, redis)`: user+pass заданы → шлюз,
  иначе статический `ProxyPool` из Redis.
- Подключается в `AdapterRegistry` только к источникам с
  `capabilities.use_proxy=true` (che168 — да, encar API — нет: платный
  трафик не жжётся).
- **Включение:** `PROXY_DATAIMPULSE_USER` + `PROXY_DATAIMPULSE_PASS`
  (+ `PROXY_DATAIMPULSE_GEO=cn` при геоблоке) в `.env`, рестарт воркера.
  Тесты: `tests/test_proxy.py` (11) + 2 в `tests/test_registry.py`.

---

# Часть IV — долги и планы

## 24. ⏳ Ожидает действий владельца

| # | Действие | Зачем |
|---|---|---|
| 1 | `alembic upgrade head` (0004+0005) | аналитика + источник che168 |
| 2 | Сверка che168 с живым HTML + гео | перед `enabled=true`; 403 → DataImpulse `GEO=cn` |
| 3 | Stars: тестовый платёж XTR | код-путь готов, живой оплаты не было |
| 4 | RAG E2E: GLM/PQ-ключи, `ingest_kb.py --force`, контрольный запрос | живой контур ответов |
| 5 | Опционально: `doctor_mode=suggest` | наблюдать за предложениями «врача» без авто-применения |
| 6 | `alembic upgrade head` (+0006) и создание первого партнёра | партнёрский контур: ключ один раз через admin API |

Уже сделано владельцем: **BOT_TOKEN отозван** через @BotFather (перевыпустить
и обновить `.env` перед продом).

## 25. 📋 Бэклог (приоритизирован)

### P2 — кандидаты следующего спринта

1. **Token Bucket Telegram** ✅ реализован (п. 12.6 ТЗ): Redis-бакеты
   (Lua, атомарно) ~30 msg/s глобально + ~1 msg/s на чат, hook в
   `send_telegram_message`; fail-open при недоступном Redis (429 —
   страховка); `TELEGRAM_RATE_*_PER_SEC` (0 = выкл).
2. **SQL-дашборды воронок** ✅ реализованы: `app/services/funnels.py` +
   `GET /api/admin/analytics/funnel` (search→dialog→lead→subscription,
   conv_prev/conv_first %) и `GET /api/admin/analytics/retention`
   (когорты по дню `user_registered`, D1/D7).
3. **Веб-ЛК партнёра** ✅ реализован (`/partner/*` во фронтенде): вход по
   ключу, дашборд, пул + claim (409/429), мои лиды + фидбек, API-ключ;
   ротация ключа — через менеджера/админку. Бэкенд: `?mine=1` в `/api/partner/leads`.
4. **Биллинг партнёров** ✅ реализован (миграция `0014`): CPL-списание
   при claim (индивидуальный `cpl_rate` или тариф плана
   `PARTNER_CPL_RATES`), журнал `partner_transactions` (+topup /
   −charge_lead, balance_after), при исчерпании — suspended + алерт
   (дедуп 24ч), пополнение `POST /api/admin/partners/{id}/billing`
   снимает suspended; claim без денег → 402. Баланс и цена лида — в
   `/api/partner/me` и `/api/partner/billing`.

### P3 — стратегическое

3. LLM cost tracking: токены/стоимость GLM в `DialogSession` или отдельной
   таблице, сводка в `/metrics` (unit-экономика).
4. Ротация PQ-ключей и разделение доступа к приватному ключу.
5. Push ветки `refactor/monorepo` (rag_service: uv-workspace, 361 тест —
   ветка готова локально).
6. Публичный HTTPS `MINIAPP_URL` для прода + проверка кнопки меню.
7. Рефакторинг веб-авторизации: `telegram_id` → nullable, отдельный PK
   (синтетические отрицательные id — коллизии после ~30k веб-юзеров).

## 26. Тесты и качество

- `uv run pytest` → **504 passed** (vitest: +9): LLM-клиенты, RAG-клиент (fallback, CB,
  кэш), агент, уведомления, адаптеры (контракты, дедуп, che168), auth,
  PQ-крипто, мониторинг/алерты, cron/планировщик, аналитика, лиды,
  ParserDoctor, прокси (GatewayProxyPool, фабрика), партнёрский контур
  (ключи/ротация, эксклюзивный claim, квоты, rate limit, фидбек),
  S3/MinIO storage, token bucket, воронки (funnel/retention),
  партнёрский биллинг (CPL-списания, topup, suspended/reactivate).
- `ruff check` — чисто; mypy настроен. Frontend: `tsc --noEmit` + `vite build`.
- Тест-хелперы: `FakeSession` (строковые PK, `rollback()`, `get`),
  `FakeRedis` (`ttls`), `MockLLMClient` (`script`, `.calls`).

## 27. История коммитов (последние)

| Commit | Что вошло |
|---|---|
| `1c898e4` | ТЗ (TZ.md) |
| `b448c76` | RAG-микросервис, /api/ai, AI-поиск в Mini App, inline-меню, compose |
| `a1d39c7` | Регистрация/логин сайта, Login-экран, миграция 0003 |
| `46a7eb4` | GLM основной, БЗ РБ/РФ/СНГ, TG-кнопка WebApp, PQ-шифрование |
| `7489aec`, `7a29eb3` | Аналитика (P1-7) + лиды: хуки, `POST/PATCH /api/leads`, `events_24h` |
| `3dbe08e` | Che168-адаптер (P2-10): парсер, нормализация 万, миграция 0005 |
| `6a3f934` | ParserDoctor: GLM-ремонт селекторов, doctor_mode, reload_source |
| `ffb50dd` | Прокси-шлюз DataImpulse (GatewayProxyPool, use_proxy) |
| `ffe4a0e` | Партнёрский контур (P2-11): ключи с ротацией, claim лидов, квоты, rate limit |
| `8dc790f` | Token Bucket Telegram (P2-12): 30 msg/s глобально + 1 msg/s на чат, Redis/Lua |
| `c987714` | SQL-дашборды воронок (P2-13): funnel + retention D1/D7 admin-эндпоинты |
| (см. git) | Биллинг партнёров (P2-14): CPL-списания, баланс, suspended/reactivate, миграция 0014 |
| (отд. репо) | rag_service monorepo: 361 тест, ветка `refactor/monorepo` (не запушена) |
| `15400e9` | Encar: новый API-контракт (sr/inav/cursor, q с `_.`, корейские фасеты, FormYear/Year, USD→KRW) |
| `10dcceb` (PR #1) | Микросервисы: gateway + 6 доменных сервисов (профили mono/micro), auth refresh, багфиксы (`max→le`, `user.telegram_id`, html.escape) |
| (этот merge) | Мерж PR #1 + правки: env-оверрайды DATABASE_URL/REDIS_URL/RABBITMQ у 6 svc, `depends_on required:false` (bot/miniapp в micro), mvp.sh `--profile mono`, `/metrics` вынесен в `app/api/metrics.py` (admin + gateway-прокси), ParserDoctor: инъекция redis в send_alert + изоляция Telegram в тестах (442 теста, ruff clean) |
| (этот коммит) | KCar: живой API (`/bc/search/list`, AES-enc из бандла фронта, wr_-фильтры, top-N) + персистентность доктора: admin PUT сливает config/capabilities/retry_policy, mvp.sh создаёт источник только при отсутствии; MAKE_MAP + корейские марки (447 тестов, ruff clean) |

## 28. Ревью PR #1 (feat/microservices) — найденные и исправленные проблемы

1. **compose**: у 6 доменных сервисов (identity/catalog/billing/partners/dialog/admin)
   не было `environment:`-оверрайдов `DATABASE_URL/REDIS_URL/RABBITMQ_URL` — при
   `localhost` в `.env` они не связывались бы с инфраструктурой (тот же баг, что
   ранее исправлен для backend/workers).
2. **compose**: `bot` и `miniapp` зависели от `backend` (профиль mono) — в профиле
   `micro` не стартовали; заменено на `depends_on ... required: false` для
   backend+gateway (Compose ≥2.20).
3. **mvp.sh**: переведён на `--profile mono` (иначе сервисы с профилями не поднимутся).
4. **`GET /metrics`** (ТЗ п.10) жил только в `app/main.py` — в режиме micro gateway
   (только `/api/*`) отдавал 404: роут вынесен в `app/api/metrics.py`, подключён
   монолитом и admin-сервисом, gateway проксирует `/metrics` → admin.
5. **ParserDoctor**: `send_alert` ходил в реальный Redis через `_get_redis()` —
   тесты падали при остановленном Docker (9 падений); добавлена инъекция
   `redis=` в `send_alert`, проброс через `_repair`/`_triage_result`, в тестах
   изолирован реальный Telegram (`_send_telegram` → stub).

Конфликт мержа (docker-compose.yml) разрулен: профили PR + env-оверрайды локальных
коммитов сохранены.

## 29. KCar: живой API + фикс персистентности ParserDoctor

1. **kcar.com — источник снова рабочий.** Старый контракт
   (`api.kcar.com/dst/...`, GET `?page=&count=`) мёртв (404). Восстановлен
   актуальный: `POST https://api.kcar.com/bc/search/list`, тело
   `{"enc": base64(AES-CBC(JSON))}` — ключ `SKFJ2424DasfaJRI`, iv
   `sfq241sf3dscs321` (воспроизведено из фронтового бандла `_nuxt/*.js`,
   `setEncDef`), PKCS7. Ответ `{"data": {"totalCnt", "rows": [...]}}`.
   Пагинации в API нет (page/pageNo/... игнорируются — проверено запросами):
   адаптер берёт top-N (`limit`, по умолчанию 100) свежих объявлений,
   `has_more=False`. Фильтры `wr_*` (make/model/годы YYYYMM/цена в манах/
   пробег/топливо — код «001»=가솔린 подтверждён живым ответом; остальные
   коды не шлём). Карта полей: carCd/prc(ман)/milg/prdcnYr/mnuftrNm/
   modelNm/grdNm+grdDtlNm/carWhlNm/fuelNm/trnsmsnNm/cntrRgnNm/lsizeImgPath;
   карточка: `/bc/detail/CarInfoDtl?carCd=<carCd>`. Live-check: 100 items,
   Hyundai с 2018 → total 7480.
   `HttpClient` получил `post/post_json` (общий `_request` с ретраями/429).
2. **Персистентность ParserDoctor.** Корень бага «ремонт слетает после
   рестарта»: `PUT /api/admin/sources/{name}` замещал `config` целиком, а
   `mvp.sh up --parse` при каждом старте перезаписывал конфиг
   `{"page_size": 20}`. Исправлено дважды:
   - admin PUT теперь СЛИВАЕТ словари `config/capabilities/retry_policy`
     (ключи из body перекрывают, остальные сохраняются); скалярные поля —
     как раньше;
   - `mvp.sh` создаёт источник только если его ещё нет (GET `/sources`
     → PUT при 404), существующий конфиг не трогает.
   Регресс-тесты: `test_upsert_source_merges_config`,
   `test_upsert_source_new_creates_with_body_config`.
3. **normalize**: MAKE_MAP дополнен корейскими именами марок из живых API
   (벤츠→Mercedes-Benz, 포르쉐→Porsche и т.д. — иначе kcar/encar значения
   не нормализовались).
4. **che168** (вне этого коммита): desktop за Ali WAF + EdgeOne captcha;
   обход уровня 1 (acw_tc + solve-куки, Baidu-referer) даёт живой HTML
   нестабильно (вероятностный WAF), уровень 2 — капча. Нужны прокси
   (DataImpulse creds пустые) или headless-браузер; адаптер триажит
   капчу как ban-исход.

**447 тестов зелёные, ruff clean.**

### 30. E2E-валидация персистентности + живой синк kcar в стеке (коммит «fix: e2e hardening…»)
1. **E2E e2e-проверка фикса персистентности пройдена**: сломанный→«отремонтированный»
   конфиг encar (`doctor_note` в config) + включённый kcar пережили
   рестарт `mvp.sh up --parse` — ни PUT-reseeding, ни перезапись конфига.
2. **Фикс найден по ходу e2e**: строки источников с NULL `retry_policy`/
   `capabilities`/`config` в БД роняли `GET /api/admin/sources` целиком
   (500, ValidationError в SourceConfig) — добавлен `field_validator`,
   None → дефолты. Тест `test_source_config_null_db_fields_to_defaults`.
3. **`HttpClient._request`: таймауты теперь ретраятся** — kcar отдаёт тело
   списка медленно (httpx.ReadTimeout после 200), раньше не ловился вовсе.
   Добавлены `httpx.TimeoutException` в retryable с backoff 2^attempt.
   Тесты: `tests/test_http_client.py` (успех после ретрая; исчерпание →
   FetchError).
4. **kcar введён в бой в стеке**: источник включён (enabled, cron */15,
   timeout 60s, page_size 100), образ worker_fetch пересобран (в старом
   был мёртвый эндпоинт `/dst/...`), circuit breaker сброшен.
   Live: `POST /bc/search/list` → **100 новых объявлений сохранено**
   (в БД kcar=102, encar=44).
   Нюансы эксплуатации: circuit breaker (5 ошибок подряд + cooldown 10м)
   сбрасывается `UPDATE source_health SET error_streak=0 ...`; воркер
   читает список источников на старте — после включения источника нужен
   `docker compose restart worker_fetch`.

**450 тестов зелёные, ruff clean.**



### 31. UX-ремонт бота: панель диалога, мини-апп, Китай, кнопочный фоллбэк
1. **Вал сообщений → «живая» панель**: каждый ход ассистента (и каждый шаг
   кнопочного фоллбэка) редактирует предыдущее сообщение на месте
   (`panel_msg_id` в FSM), новые сообщения — только при первом шаге.
2. **JSON-критерии → человекочитаемый список**: `format_criteria` с
   русскими лейблами, ценами с пробелами и странами-флагами
   (`{'country': 'CN'}` → «Страна: 🇨🇳 Китай»). Убран `json.dumps` из текста.
3. **Китай вернулся**: опции стран генерировал LLM без ограничений —
   в SYSTEM_PROMPT добавлен канонический список (Корея/Китай/Германия/
   США/Япония) и требование давать опции строго из него.
4. **Мультивыбор больше не ломает ход**: кнопки опций несут токен хода
   (`dlg:opt:{turn}:{idx}`), клик по устаревшей кнопке отвечается
   «устарела» и игнорируется.
5. **Кнопки всегда при активном ассистенте**: «🔎 Запустить поиск»
   появляется и по эвристике заполненности (make/model + цена + страна),
   а не только когда LLM решил; плюс «📱 Мини-приложение» и «🔄 Сбросить».
6. **Мини-апп доступен и на http**: `MINIAPP_URL` без https (локальная
   демка) раньше давала пустую клавиатуру — теперь url-кнопка
   (браузер); web_app-кнопка — только для https.
7. **Багфиксы**: (а) клик по опции слал в диалог `user_id` **бота**
   (id брали из `cb.message.from_user`) — ход диалога шёл в чужую
   сессию, «после выбора страны ничего не происходило»; теперь
   `user_id` передаётся явно из `cb.from_user`. (б) в кнопочном
   фоллбэке вообще не было обработчика `btn:`-колбэков — инлайн-кнопки
   не работали; добавлен `btn_click` с маршрутизацией по полю.

Тесты: `tests/test_bot_dialog_ui.py` — 7 шт (формат, эвристика,
токены хода, кнопка поиска по эвристике, http/https мини-апп).
**457 тестов зелёные, ruff clean.** Бот пересобран и задеплоен в стек.

### 32. Инцидент: AI-режим 502 + кнопка мини-аппа не появлялась
1. **502 на /api/dialog/message**: в mono-стеке одновременно с backend был
   поднят gateway (micro-профиль) с DNS-алиасом `backend` — имя `backend`
   резолвилось в два контейнера (round-robin), запросы бота случайным
   образом уходили в gateway и зацикливались → 502. Фикс: gateway
   остановлен (`docker compose rm -sf gateway`); в mono он не нужен.
   ПРАВИЛО: gateway и backend одновременно не поднимать — алиас конфликтует.
2. **Кнопка мини-аппа**: `_miniapp_url()` фильтровал не-https в пустоту,
   из-за чего fallback на url-кнопку в `_miniapp_button` был недостижим.
   Теперь `_miniapp_url` возвращает сырой URL, схема проверяется в
   `_miniapp_button` (https → web_app, http → url-кнопка).

### 33. Исследование CarAPIS (проверено вживую, не интегрировано)
Источник: https://carapis.com/ru/developers/ — каталог 2.8M объявлений
(~80 площадок, единая JSON-схема + оценка относительно рынка).
- **MCP-сервер (ключевая находка)**: `https://mcp.carapis.com/mcp/` —
  бесплатно, БЕЗ ключа и без дневного лимита. Инструменты: search
  (бренд/модель/годы/цена USD/пробег/площадка, limit≤25), get по UUID,
  facets, market_summary (min/медиана/max по срезу).
- **Покрытие (facets по source)**: encar 113 633, kcar 8 780.
  **che168 и китайских площадок НЕТ.**
- **Качество данных**: поля id/source/brand/model/trim/year/mileage/
  fuel_type/transmission/body_type/color/price_usd + valuation
  {estimated_usd, low/high, confidence_0_1, percentile_rank,
  comparable_count, is_undervalued}. Пример: Palisade 2022, 48.8k км,
  $18 394 при оценке рынка $24 842 (undervalued, 170 компарабелей).
- **Ограничения**: в бесплатном MCP нет URL и ID исходного объявления
  (только внутренний UUID) → для синхронизации непригоден; поиск
  медленный (~30 с на запрос) — не годится в реальном времени;
  REST-тариф: 100 запросов/день бесплатно (с URL объявлений),
  Production 5k/день — цена в кабинете.
- **Вывод**: парсеры encar/kcar не заменять. Ценность — фича «оценка
  рынка» (undervalued-лоты, медианные цены при финализации критериев)
  или инструмент AI-агента. Решение по интеграции отложено.

## 34. MVP-разворот: Корея-only, менеджер Артём, фото-карточки, калькулятор, nginx+SSL

Разворот прототипа под главную идею: бот → WebApp (пользователь выбирает
понравившийся UI/UX). Всё не-корейское выпилено.

### Backend
- **Калькулятор доставки Корея → РФ** (`app/services/delivery.py`,
  `app/api/calc.py`): POST /api/calc/delivery {price_usd, engine_cc, year} →
  смета «под ключ» (авто, море, брокер, СБКТС/ЭПТС, пошлина по возрастной
  группе и €/см³, сбор, утильсбор); POST /api/calc/compare — сравнение
  вариантов с сортировкой по итогу. Ставки — константы модуля (курс 92 ₽/$,
  1.08 $/€, море 1800 $, брокер 250 $, СБКТС 350 $; льготный утильсбор
  3400/5200 ₽, >3000 см³ — полная 136 200 ₽).
- **Лента только Корея**: GET /api/listings без `source` → encar+kcar.
- **AI-агент**: новый промпт — «Артём, менеджер по авто из Кореи»
  (проактивный, Корея-only, расчёты — только через инструмент); новый tool
  `calc_delivery` (schema в tools.py, исполнение в agent.py).

### Бот
- **Фото-карточки**: после «Поиск запущен» (dlg:finalize) — топ-5 объявлений
  фото-хотлинками (sendPhoto по URL источника, ничего не храним), caption +
  кнопки «🔗 Открыть объявление» / «🚚 Доставка и растаможка» / «📱 Приложение».
  Фолбэк на текстовую карточку, если фото источника недоступно.
- **Калькулятор в боте**: /calc [цена $ объём год], кнопка «🧮 Калькулятор» в
  меню, callback calc:{id} прямо с фото-карточки (KRW/EUR → USD по фикс-курсу).
- **Кнопочный fallback**: шаг «страна» удалён (4 шага, всегда KR).
- /start: приветствие менеджера, Корея-only.

### Mini App (frontend)
- Новый экран **/calc** (screens/Calc.tsx): форма (цена/объём/год) → градиентная
  карточка «Итого под ключ» + разбивка + дисклеймер; преилл из query
  (?price=&cc=&year=). Кнопка «Доставка и растаможка» в карточке объявления.

### nginx + самоподписанный SSL
- frontend/nginx.conf: 80 + 443 ssl (прокси /api → backend:8000);
  frontend/entrypoint-ssl.sh — генерация self-signed при старте
  (SAN = DNS:localhost + IP:$NG_HOST_IP); compose: 8443:443,
  NG_HOST_IP=${LAN_IP}. .env: MINIAPP_URL=https://10.132.137.38:8443,
  LAN_IP=10.132.137.38.
- ⚠️ **Ограничение Telegram**: web_app-кнопка требует ДОВЕРЕННЫЙ сертификат —
  с self-signed нативный WebApp в клиентах Telegram может не открыться
  (url-кнопки работают всегда). Для полноценного web_app нужен домен +
  Let's Encrypt (следующий шаг).

### Проверки
- 463 теста зелёные (включая новые tests/test_delivery.py), ruff чист.
- Живьём: https://localhost:8443 → 200; /api/listings → только encar/kcar;
  /api/calc/delivery и /api/calc/compare считают; бот с MINIAPP_URL=https.
- Грабли: CRLF в entrypoint-ssl.sh (Windows) → «no such file or directory»;
  лечится `sed -i 's/\r$//'` перед сборкой.

## 35. Полное тест-покрытие MVP-калькулятора (+26 тестов → 489)

- **tests/test_calc_api.py** (9): /api/calc/delivery (200 + числа: пошлина
  5832 $, 7 компонентов, тотал > цены, ₽/$ согласованы; default engine_cc;
  4×валидация 422), /api/calc/compare (сортировка по итогу, пропуск битых
  items, автотайтл, пустой список → 422).
- **tests/test_bot_calc.py** (14): _price_usd (KRW/EUR/USD/мусор),
  _format_calc_out (7 строк, группировка «18 000 $»), _miniapp_button с path
  (https → web_app с query, http → url-фолбэк), _miniapp_kb,
  _car_card_kb (🔗/🚚/calc:{id}, без url/miniapp), build_listing_caption
  (KRW-цена, отсутствие цены, лимит 1024).
- **tests/test_agent.py** (+3): tool calc_delivery — полная разбивка 7 строк
  (агент не выдумывает цифры), битые аргументы → просьба уточнить,
  схема tool для LLM (required price_usd+year).
- **Найденные тестами баги (исправлены)**: «18,000 $» вместо «18 000 $»
  в сметах бота (_format_calc_out) и format_breakdown — запятые десятичного
  разделителя локали f-string не заменялись на пробелы.

## 36. Сравнение «под ключ» end-to-end + тестовая база фронтенда (+15 тестов → 504 py + 9 vitest)

**Фича сравнения ( ранее только API):**
- бот: `/calc A vs B` (разделители `vs`/`;`/`|`/перенос) → `POST /api/calc/compare`, медали + дельта; `client.compare_delivery`
- бот: меню «⚖️ Сравнить» → хинт + миниапп `/compare`; команда `/calc` добавлена в set_my_commands
- вебапп: экран `/compare` (2–4 варианта, бары, «лучший итог»), кнопка из калькулятора с сид-параметрами, deep-link `?v=18000x2000x2022,...`

**Тесты:**
- `tests/test_bot_calc.py` +9: интеграция `cmd_calc` (один вариант, 2 числа, «18 000», vs-сравнение, фоллбэк при недоступном бэкенде, мусор→help), `menu:compare`/`menu:ai`; фейки `FakeMsg`/`FakeCb`
- фронтенд: vitest (`npm test`), `src/lib/fx.ts` — общие чистые хелперы (`toUsd`, `digits`, `parseQueryVariants`); Listing/Compare переведены на него; `fx.test.ts` 9 тестов
- пойманные тестами баги: regex `\d[\d ]*` склеивал числа в одно (парсер вариантов переписан + склейка тысяч «18 000»); `parseQueryVariants` терял год в коротком формате `18000x2022`

Итог: `pytest` → **504 passed**, `vitest` → **9 passed**, ruff/mypy clean, bot+miniapp пересобраны.

## 37. Бот «идеал»: ссылка → карточка, антифлуд, error-handler (+16 тестов → 520)

- **Ссылка на объяву → карточка**: `GET /api/listings/by-url` (нормализация: схема/www/m./слеш), `client.get_listing_by_url`; `fallback_text`: URL → фото-карточка с кнопками (расчёт/миниапп), не найдено → AI. `/help` с примерами `/calc` и «скиньте ссылку»
- **Антифлуд**: `app/bot/throttle.py` — `FloodGate` (скользящее окно 15 событий/10 с, чистая функция времени) + `FloodMiddleware` на message/callback_query (дроп, варн раз в окно)
- **`@dp.errors`**: лог + «😔 Что-то пошло не так…» вместо тишины; polling не падает
- Тесты +16: throttle (8: лимит, окно, независимость юзеров, миддлварь), by-url (4), fallback-ссылки (4); test-найденный баг: первый `should_warn` блокировался дефолтом 0.0
- Живая проверка: `by-url?url=https://encar.com/e2e-1` → 200 BMW 520i; 404 для отсутствующих

## 38. AI-анализ стоимости: LLM-разбор + график, монетизация 1/нед (+33 теста → 553)

- **Сервис** `app/services/price_analysis.py`: comps (та же make+model, год ±2, до 30 шт, медиана/min/max), история цен, промпт на строгий JSON; `parse_llm_json` терпит ```-заборы; LLM упал/мусор → статфолбэк (вердикт по медиане ±7%, диапазон 0.93–1.07 median). Кэш разбора общий на листинг (LLM дорогой)
- **Модель + миграция 0015**: `price_analyses` (listing_id, user_id, verdict, fair_min/max, summary, payload JSONB, created_at; 2 индекса). Монетизация: free = 1 разбор (user, listing) в 7 дней, pro/business = безлимит (`quota_left`, `QuotaExceeded` → 403 `quota_exceeded`)
- **API** `app/api/analysis.py`: `POST /api/listings/{id}/analysis` (JWT, LLM+сохранение), `GET` (кэш, без LLM), `POST /api/bot/listings/{id}/analysis` (X-Internal-Token, body user_id) — оба роутера в main.py
- **Бот**: кнопка «🤖 Анализ цены» на фото-карточке (`analyze:{id}`, рядом с 🚚), хендлер: «Анализирую…» → вердикт (🟢/🟡/🔴), диапазон, отклонение %, факторы, медиана рынка + кнопка миниапп `/listing/{id}` (график). 403 → апселл Pro + миниапп; backend down → вежливое. `client.analyze_price` — своя реализация (120 с, 403 ≠ ошибка). `/help` дополнен
- **WebApp/сайт**: секция «🤖 AI-анализ цены» в Listing.tsx: GET кэша при открытии → сразу график; иначе кнопка «Анализировать (1 бесплатно в неделю)» → POST; 403 → замок + «⚡ Безлимит в Pro» → /profile. `lib/analysis.ts` (типы, `deltaPct`, `buildChartData` — чистые), `ui/PriceChart.tsx` — SVG-график: линия истории, точка текущей цены, зелёная зона рыночного диапазона (без chart-библиотек). CSS-блок `.analysis*`, `.price-chart*`
- **Тесты**: `tests/test_price_analysis.py` (10: парсинг JSON, пороги вердикта, квоты, LLM/статфолбэк), `tests/test_analysis_api.py` (6: POST 200/403/404, pro безлимит, GET кэш/None; FakeSession.get + `.first()` в conftest), `tests/test_bot_analysis.py` (7: формат, кнопка карточки, хендлер ок/квота/down/мусор), `frontend/src/lib/analysis.test.ts` (9: deltaPct, buildChartData, VERDICT_LABEL). **Итог: 543 pytest, 18 vitest; ruff чисто; mypy не хуже базы; фронт собирается**

## 39. Шлифовка UI/UX анализа (график, состояния, формат в боте) (+1 тест → 544)

- **График** (`PriceChart.tsx`): градиентная заливка под линией, подпись текущей цены у точки, даты первой/последней точки (дд.мм), компактные подписи шкалы (`formatCompact`: 18,4 млн / 950 тыс), пульс точки; иначе — подсказка «истории цены пока мало» (не прятать блок молча)
- **Секция анализа** (Listing.tsx): состояние загрузки — спиннер + скелетоны («Сравниваю с рынком…»), pill-бейдж отклонения (▼/▲ с цветом), шкала справедливого диапазона с анимированным маркером цены (`fairPosition`), строка меты «разбор от {дата} · нейросеть/статистика» (+`created_at` в payload/API) и «🔄 Пересчитать»; при квоте — «доступен снова через несколько дней»; fade-in секции
- **Бот**: `_format_analysis` реструктурирован — цена (💵), рынок (📊 count+медиана), год в заголовке, стрелка 📉/📈 у отклонения, футер с квотой и Pro
- **Тесты**: +formatCompact/fairPosition (analysis.test.ts 22 vitest), +test_format_analysis_title_with_year_and_money_lines; пойман баг formatCompact (18,4 млн → «18 млн»). **544 pytest / 22 vitest, ruff+mypy чисто, бандл на 8443 обновлён**

## 40. Боевое развёртывание MVP: секреты, fail-fast, deploy-кит (+4 теста → 548)

Цель — полный prod-контур: VPS + docker compose (mono) + Caddy (авто-Let's Encrypt).

- **Ротация секретов (INC-001, INC-002 ЗАКРЫТЫ)**: `APP_SECRET_KEY` был длиной 9 символов
  (= подпись JWT + fallback internal-токена). Сгенерированы: 64-hex `APP_SECRET_KEY`,
  отдельный 64-hex `INTERNAL_TOKEN`, сильный `DB_PASSWORD` (+`ALTER USER` в живой БД —
  volume уже инициализирован). backend/bot пересобраны и перезапущены; внутренний API:
  неверный токен → 401, верный → 200. Старые JWT инвалидированы (перелогин через initData).
- **Fail-fast (INC-004 ЗАКРЫТ)**: `Settings._prod_secrets_required` — при `APP_ENV=prod`
  падаем на старте, если ключ = дев-дефолт или короче 32 символов (`tests/test_prod_secrets.py`).
- **INC-005 (прод)**: в боевом оверрае TLS терминирует Caddy (авто-LE по `$DOMAIN`),
  self-signed 8443 остаётся только в dev.
- **Deploy-кит `deploy/`**:
  - `docker-compose.prod.yml` — оверрайд: Caddy на 80/443 → miniapp → /api; порты инфры
    (postgres/redis/rabbitmq) и backend сняты с публикации (`!reset []`); `restart: always`;
    ротация логов json-file 10 MB × 3; `APP_ENV=prod`, публичный `MINIAPP_URL=https://$DOMAIN`.
  - `Caddyfile` — авто-сертификат, gzip, `/health`.
  - `bootstrap.sh` — VPS одной командой: Docker, генерация `.env` с боевыми секретами,
    UFW (наружу только 22/80/443), подъём, миграции, cron бэкапа.
  - `backup.sh` / `restore.sh` — pg_dump daily (14 копий) + восстановление.
  - `DEPLOY.md` — ранбук: DNS → bootstrap → проверка LE → обновления → бэкапы → мониторинг.
- **Тесты**: тесты internal-API переведены с `get_settings().app_secret_key` на
  `deps_internal.internal_token()` (единый источник истины — теперь ротация INTERNAL_TOKEN
  не ломает их). **548 pytest (+4), ruff чисто, mypy = база**
- **Live**: стек на новой машине поднят с нуля после рестарта Docker — backend healthy,
  бот поллит, miniapp 200. Для выхода в прод: VPS + домен + `bootstrap.sh` (DEPLOY.md).

## 41. Скрипты запуска + гостевой режим сайта (+2 pytest → 550, +18 vitest → 40)

- **Скрипты запуска**: `start.bat` (Windows) / `start.sh` (Linux) — инфраструктура →
  `--profile mono up -d --build` → миграции → ожидание /health → подсказка URL.
  Для VPS остаётся `deploy/bootstrap.sh`.
- **Гостевой режим (незалогиненный посетитель может всё потрогать)**:
  - Бэк: `POST /api/auth/guest` — временный юзер («Гость», синтетический id < 0,
    без email/пароля, явно role=buyer/tier=free/is_active) → обычная JWT-пара.
    Гость = free-юзер: лента, фильтры, карточка, **AI-разбор цены 1/нед**,
    калькулятор, избранное. Нет только Telegram-уведомлений и Pro.
  - Фронт: вне Telegram `authorize()` → null → тихий `guestLogin()` → полный UI
    без формы входа; скип онбординга; дисмиссабельный баннер «Демо без регистрации»
    со ссылкой /login; роут `/login` (только для гостя) — LoginScreen, после входа
    гостевые токены заменяются (`clearGuest`); в Профиле — гостевой блок
    «Войти / Регистрация».
  - Публичные GET и так открыты: лента/карточка/кэш разбора/калькулятор.
- **Тесты сайта (vitest)**: `vitest.config.ts` (jsdom + react-плагин);
  dev-deps jsdom + @testing-library/react. Новое: `api/client.test.ts` (токены,
  Bearer, 204, ApiError/detail/statusText), `api/auth.test.ts` (Telegram-контекст,
  гостевой вход/выход, webLogin/webRegister, 409), `App.guest.test.tsx`
  (компонентные: гость→лента+баннер, крестик баннера, гостевой /login,
  у TG-юзера гостя нет). Стабы matchMedia/IntersectionObserver. **40 vitest / 550 pytest**

## 42. Ставки 2026 по НПА (мощность >160 л.с., сбор ПП № 1637) + полировка вёрстки

- **Проверка НПА на 16.10.2026** (первоисточники: alta.ru, ПРАЙМ, Живая статья
  auto.ru/mag/article/utilizacionnyy-sbor с действующими таблицами):
  - **Утильсбор**: с 01.12.2025 (ПП № 1291, действующая ред.) коэффициент —
    прогрессивная шкала по **мощности** (л.с.) в сочетании с объёмом; база
    20 000 ₽. Льгота физлица (3400/5200 ₽) — только объём ≤3000 см³ **и
    мощность ≤160 л.с. включительно**. Индексация коэффициентов с 01.01.2026
    учтена (шкала до 01.01.2027, дальше +10–20% по Минпромторгу). Контрольный
    пример из статьи сходится: 2,5 л / 235 л.с. / <3 лет → 120,12 × 20 000 =
    2 402 400 ₽.
  - **Сбор за таможенные операции**: ПП № 342 мёртв; с 2025 — ПП № 1637
    (28.11.2024), с 01.01.2026 — ред. ПП № 1638 (23.10.2025): 1231 / 2462 /
    4924 / 13 541 / 18 465 / 21 344 / 49 240 / 73 860 ₽ (порог партии 10 млн ₽).
  - Пошлины ЕТТ физлиц (Решение ЕЭК № 54) — без изменений.
- **Код**: `delivery.py` — `power_hp` в `calc_delivery` (+ `util_category`,
  `util_note` при неизвестной мощности), шкалы `_UTIL_SCALE_*` (границы
  диапазонов = конец полосы, офф-бай-ван выловлен тестом с примером auto.ru),
  `CLEARANCE_FEE_BRACKETS` 2026. API `power_hp` (+валидация 10..2000), бот
  (`/calc`, tool LLM), миниапп — поле «Мощность, л.с.» + плашка-предупреждение.
- **Вёрстка**: инлайн-`opacity` у чипа сравнения убран → `.chip:disabled`;
  новая `.calc-warn` (янтарная плашка) с dark-темой; guard-тесты в
  `styles.test.ts`. Починен Docker-сборк миниаппа: `tsconfig.json` теперь
  исключает `*.test.*` (в контейнере нет `@types/node`, tsc падал на
  `node:fs` в styles.test.ts).
- **Тесты**: `test_delivery` (шкала по мощности: 120,12/177,60/45,00; >3000 см³
  129,20/197,81/222,84; сбор 2026 по 8 брэкетам; legal_refs — 5 позиций),
  `test_calc_api` (полный утиль при 235 л.с., валидация power_hp, ПП 1637),
  `test_agent` (power_hp в tool-схеме). **559 pytest / 62 vitest, ruff чисто.**
- **Live на стенде**: backend+miniapp пересобраны; POST /calc/delivery
  235 л.с. → «полный» 2 402 400 ₽; без мощности → льготный 5200 ₽ + note;
  сбор 13 541 ₽; в бандле миниаппа есть `.calc-warn`.

## 43. Редизайн миниаппа + лимит Free 3 AI/день + регион РБ/РФ

- **Лимиты**: Free `ai_daily_limit` 20 → **3** (`subscription.py`), Pro 200 — без
  изменений. Тесты не завязаны на 20 — 559 pytest зелёные.
- **Галерея карточки**: слайды 16/10 «под ключ», клик по фото/кнопке ⤢ →
  **лайтбокс** (тёмный фон 94%, `object-fit: contain` — фото целиком без обрезки,
  стрелки, Esc/←→ с клавиатуры, счётчик, клик мимо — закрыть, лента миниатюр
  до 6 + «+N»). Раньше фуллскрина вообще не было.
- **Вёрстка**: единый контейнер `.screen` (760px, авто-центр), секции со
  скруглением 16px и явной тенью, ПК-раскладка карточки 2 колонки (галерея+инфо |
  sticky-действия), лента 2→3 колонки на ≥1280px, доопределён отсутствовавший
  `@keyframes fadeIn`. Дедуп старого блока `.gallery`.
- **AI-чат** (`AiSearch.tsx`): переписан на пузыри (юзер справа акцентный, агент
  слева карточкой), typing-анимация, чипсы быстрых ответов, sticky-композер
  (textarea + Enter=отправить), интро-карточка.
- **Фильтры**: кроме марки — модель, год от/до, цена $ от/до, пробег, топливо,
  КПП, кузов, привод (`SearchCriteria` бэка всё поддерживает); пары инпутов
  `.filter-pair`, нативные селекты, понятная подпись критериев, обработка
  ошибок (пустая форма, лимит тарифа).
- **Оплата подписки**: обработаны все статусы `openInvoice` (paid/failed/
  **cancelled**/pending) + ошибки API (503 «платежи недоступны», 401/403
  «сессия истекла»), вне Telegram — понятное сообщение, что Stars оплачиваются
  только в TG. Сообщения — стилизованные плашки `.profile-msg`.
- **Регион РБ/РФ** (`fx.ts`): `getRegion/setRegion` (localStorage + авто по
  локали), курсы USD→₽/Br (фикс MVP), `priceChain()` — **$ → локальная валюта →
  цена источника** в карточках и на странице объявления; переключатель региона
  в Профиле; в калькуляторе для РБ — отдельная заметка (платежи ЕАЭС одинаковы,
  регистрация в ГАИ РБ — свои правила). **62 vitest / 559 pytest, tsc чисто.**


## 44. Лейаут-фиксы и пагинация ленты (2026-10-17, `d195c33`, `16c2607`)
- **Гигантские фото**: `.gallery__slide` `min-width:0` — img во flex не сжимался
  ниже натуральной ширины (1080px) и вылезал за трек; лайтбоксу — страховка
  `min-width/height:0`.
- **Сжатая лента на ПК**: гостевой баннер сжимал `.app-content` до ~430px;
  `flex-wrap` на shell + баннер `flex-basis:100%`, контенту `min-width:0`.
- **Пагинация**: при ошибке догрузки лента молча останавливалась — добавлены
  инлайн-ошибка с «Повторить» и кнопка «Показать ещё» (`.feed-more`) как
  фолбэк к IntersectionObserver; тесты `Feed.test.tsx`.
- Проверено Playwright-аудитом стенда (мобайл 390 / ПК 1440): слайд=ширине
  трека, лента 3×381px, скролл до 207/207.
- **Стенд**: лишний `gateway` (compose-алиас `backend`) давал 502 через
  round-robin DNS — остановлен; миниапп обновляется только `build miniapp`
  (образ, не `restart`).

## 45. Расширенные фильтры ленты (2026-10-17)
- Чипсы-пресеты: 3 → 9 (диапазоны $10–30k, годы, пробеги).
- Панель фильтров в ленте (`.feed-panel`, кнопка «Фильтры» со счётчиком
  активных): марка, модель, год от/до, **цена $ от/до**, пробег до, источник
  (encar/kcar). Цены в $ конвертируются в воны запроса (`usdToKrw`) — раньше
  `price_max=20000` фильтровал вопы как доллары и молча отдавал пустоту.
- Сохранённые фильтры в чипсах теперь несут все критерии (было 3).
- Спеки (топливо/КПП/кузов/привод) в `listings` не хранятся (этап 5) —
  в ленте не фильтруются, только в сохранённых фильтрах на парсинге.
- **68 vitest (было 62), tsc чисто.**

## 46. Гостевой гейт избранного + модалка входа (2026-10-17)
- `ui/LoginPrompt.tsx`: провайдер + `useLoginPrompt().show(reason)` — модалка
  «🔒 Нужен вход» (кнопки «Войти» → `/login`, «Позже»), стили `.modal__*`.
- `FavoritesScreen`: гостю раздел закрыт — экран-гейт `.state` («Нужен вход» +
  кнопка «Войти»), модалка показывается сразу, API `/favorites` не дёргается.
- `ListingCard`: клик гостя по ❤ показывает модалку вместо API-запроса.
- Провайдер смонтирован в `MiniApp` внутри `BrowserRouter` (нужен `useNavigate`).
- Проверено Playwright на стенде: гейт, авто-модалка, «Позже», ❤ → модалка,
  «Войти» → `/login`. Скриншоты `shots/guest_*.png`.
- **Стенд**: `gateway` возвращался при каждом `up` (он в `depends_on` miniapp) —
  в `docker-compose.test.yml` `depends_on: !override` только на backend;
  контейнер остановлен и удалён, nginx перезапущен (кэш DNS).
- **72 vitest (было 68; +4: гейт гостя, ❤ гостя/юзера, список избранного),
  tsc чисто.**

## 47. E-commerce аудит вёрстки: сортировка, CTA, sticky-бар (2026-10-17)
- Аудит по PLP/PDP-стандартам (`shots/audit_ecom.py`, мобайл 390 / ПК 1440):
  галерея/цены/бейджи/фильтры/пагинация/пустые состояния — были ок; не хватало
  сортировки, иерархии CTA и sticky-кнопки.
- **Сортировка ленты** (PLP): бэк `sort` = new | price_asc | price_desc |
  mileage_asc | year_desc (`ORDER BY` с `nulls_last` — объявления без цены
  внизу); цены нормализуются в $ через `CASE currency='KRW' THEN price/1350` —
  иначе 4 USD-объявления ломали порядок. Селект `.feed-sort` в саббаре ленты,
  счётчик «207 авто · дешёвые сверху» отражает выбор.
- **Иерархия CTA на PDP**: primary один — «Открыть у источника» (`filled`),
  калькулятор/избранное — `outline` (сердце подсвечивается акцентом),
  «Назад» — `plain`.
- **Sticky CTA-бар на мобиле** (`.listing-cta-bar`): цена + «Открыть у
  источника» над таббаром (`bottom: 64px + safe-area`), на ПК скрыт;
  `padding-bottom` листинга зарезервирован, чтобы «Назад» не перекрывался.
- Спеки PDP дополнены «Обновлено» (дата `parsed_at`).
- Тесты: `Feed.test.tsx` (смена sort → `sort=price_asc&offset=0`), бэк
  `test_list_sort_param` (валидный/невалидный ключ).
- Проверено на стенде: sort=price_asc начинается с ₩5 600 000 (≈$4.1k),
  price_desc — ₩149.9M; sticky-бар только на мобиле, overflow нет.
- **73 vitest, 560 pytest, tsc чисто.**

## 48. UI/UX-полировка: возврат в ленту, навигация, доступность (2026-10-17)
- **Возврат из карточки с сохранением ленты** (главная боль каталога): кэш
  `feedCache` (фильтры, сортировка, items, offset, scrollY) пишется на unmount,
  восстанавливается только на POP-навигации («Назад») — без повторного запроса
  к API; скролл возвращается после отрисовки карточек. `resetFeedCache()` для
  тестов (beforeEach в `Feed.test.tsx`).
- **Кнопка «Назад» поверх галереи** на PDP (`.listing-back`, круглая, blur) —
  раньше выход был только кнопкой внизу страницы.
- **Кнопка «Наверх»** в ленте (`.to-top`) после 1600px прокрутки, плавный
  скролл, на мобиле над таббаром.
- **❤ в sticky-CTA-баре** PDP: цена + избранное + «Открыть у источника» —
  всё в зоне пальца; тап-таргеты 44px.
- **`:focus-visible`** глобально (акцентная обводка) — навигация с клавиатуры.
- Проверено Playwright: лента после «Назад» — 20 карточек, та же якорная
  карточка, scrollY=2400 восстановлен; «Наверх» → 0; полный аудит 9 экранов ×
  2 вьюпорта — ALL CLEAN, JS-ошибок нет.
- **74 vitest (+1: восстановление ленты без повторного запроса), tsc чисто.**

## 52. Цены в ленте — только валюта региона (2026-10-17)
- **Жалоба:** «кнопка цен в профиле вообще никак не влияет на выдачу — как было
  $ и KRW, так и осталось». Диагностика на стенде: переключатель региона работал,
  но менял лишь мелкую вторичную цену в строке «$15 185 · 1 397 000 ₽», а главная
  цена ($ и KRW источника) оставалась неизменной — эффект незаметен.
- **Решение (выбор пользователя):** в ленте и избранном главная цена — только
  валюта региона (₽/Br). $ и цена источника (KRW) из карточек ленты убраны —
  полная цепочка «$ · локальная · источник» остаётся на PDP.
- **ListingCard:** рендер `chain.local ?? chain.original` одной строкой; классы
  `.listing-card__local`/`.listing-card__orig` удалены (CSS + разметка).
- **Favorites:** цены (текущая и «было») тоже конвертируются в валюту региона
  вместо сырых KRW.
- **Profile:** подсказка региона переписана — «В ленте цены — в валюте региона;
  $ и цена источника остаются в карточке объявления».
- **73 vitest, tsc чисто.** Playwright: ru → «1 397 000 ₽», by → «46 300 Br»,
  KRW/$ в карточках ленты отсутствуют, на PDP цепочка полная; JS-ошибок нет.

## 51. Ремонт вёрстки: тени/границы, PDP и Favorites без telegram-ui, контраст кнопок, AI-колонка (2026-10-17)
- **Жалоба:** внутри карточек нет затенений, блок описания квадратный, AI-функционал
  рендерится слева, кнопки не контрастные, вёрстка «поехала».
- **Причины:** тени-токены были почти невидимы (shadow-sm = 0.05 alpha); PDP и
  Favorites всё ещё на telegram-ui Section/Cell/Placeholder — хэшированные классы
  `tgui-*` не матчатся селектором `.Section`, блоки рендерились квадратными без
  рамок; outline-кнопки имели границу цвета `--bg-secondary` (#f4f4f5) на белом —
  невидимую.
- **Токены:** тени усилены до двухслойных (16,24,40); новые `--border`
  (tg section-separator-color, адаптируется тёмной темой) и `--border-strong`;
  все 14 рамок `var(--bg-secondary)` → `var(--border)`; `.panel`, карточки —
  рамка + тень.
- **Listing (PDP):** telegram-ui удалён полностью — характеристики теперь карточка
  `.panel.spec-card` (заголовок, крупная цена `.spec-card__price`, строки
  `.info-row`), «Название с источника» и «История цен» — панели с `.info-row`,
  AI-блок — `.panel` с заголовком, состояния — `.state`, CTA — `.btn`/`.btn--primary
  .btn--block` с иконками lucide.
- **Favorites:** список — `.panel` + строки `.filter-item` (клик → карточка,
  ✕ `.btn--danger`), состояния — `.state` (+ кнопки «Войти»/«К ленте»),
  загрузка — `.skeleton`. telegram-ui удалён.
- **Кнопки:** `.btn` — граница `--border-strong` + font-weight 600 + hover;
  telegram-ui Button заменён на `.btn` в AiSearch («Запустить поиск», «Отправить»,
  «Сброс», ссылка `.ai-chat__link`), Calc, Compare, Onboarding (loading →
  текст «Считаю…»/«Сравниваю…»/«Запускаю…»).
- **AI-чат:** колонка сужена 760 → 640px (по центру контентной области), интро —
  полноценная карточка (рамка + тень md).
- **73 vitest, tsc чисто.** Playwright: тени/рамки/радиусы/контраст подтверждены
  computed-стилями на стенде; telegram-ui секций на PDP — 0; полный аудит
  9 экранов × 2 вьюпорта — ALL CLEAN, JS-ошибок нет.

## 50. Пагинация «как в Instagram» + липкая боковая панель (2026-10-17)
- **Лента:** кнопка «Показать ещё» убрана — лента сама догружает страницы
  при приближении к концу (rootMargin 800px у сентинела + фолбэк-триггер
  «близко к низу документа» по скроллу). Подгрузка не спамит API: busy/error
  ref-флаги, после конца списка запросов нет; при ошибке — плашка «Повторить».
  Кэш ленты (возврат по «Назад») работает как раньше — восстанавливает всё
  загруженное и позицию скролла.
- **Десктоп:** боковая панель с вкладками теперь `position: sticky; top: 0;
  height: 100vh` — остаётся на экране при любом скролле ленты (раньше уезжала
  вверх вместе со страницей). Мобильный таббар и так фиксирован.
- Тесты пагинации переведены на триггер `scroll` (jsdom не умеет ни IO, ни
  скролл): авто-догрузка до конца списка, отсутствие запросов после конца,
  ретрай после ошибки.
- Проверено Playwright на стенде: ПК — 20 → 80 карточек за 6 прокруток,
  сайдбар top=0/sticky после глубокого скролла; мобайл — 20 → 60, таббар
  прижат к низу; полный аудит 9 экранов × 2 вьюпорта — ALL CLEAN.
- **73 vitest, tsc чисто.**


## 49. Единый дизайн на всех экранах: Login, Filters, Profile (2026-10-17)
- Проблема: дизайн-система была только на основных экранах (лента, карточка,
  калькулятор, сравнение, AI-чат), а Login (0 классов), Filters и Profile
  оставались на дефолтных Section/Cell/Input/Placeholder telegram-ui с inline-
  стилями — визуально «чужие» страницы.
- **Login**: свой хиро (🔐 + заголовок), сегмент-табы «Вход/Регистрация»
  (`.auth__tabs`), поля `.calc-field`, кнопка `.btn--primary .btn--block`,
  форма на `<form onSubmit>` (Enter = отправка), ошибки `.form-error`.
- **Filters**: обе секции — карточки `.panel`; все поля `.calc-field`/`.filter-select`
  в парах `.filter-pair`; Instant-свитч → тумблер-чип `.feed-toggle`; список
  фильтров — строки `.filter-item` с описанием критериев и ✕ `.btn--danger`;
  пустое состояние и загрузка — `.state`/`.skeleton`.
- **Profile**: карточки `.profile-card` (гостевой режим с CTA-ссылкой-кнопкой,
  регион с чипами, профиль, подписка); строки «label → значение» `.info-row`;
  тариф — акцентный блок `.sub-tier` + лимиты + кнопки покупки `.btn`;
  «Выйти» — `.btn--danger .btn--block`; авторизация/загрузка — `.state`.
- telegram-ui на этих экранах больше не используется (нули импортов).
- Новые стили: `.btn--block`, `.auth__*`, `.filters-form*`, `.filter-item*`,
  `.info-row*`, `.sub-*`, `.profile-card*`.
- Проверено Playwright: `/login`, `/filters`, `/profile` × mob/PC — без
  overflow-x, без JS-ошибок, табы логина переключаются; полный аудит 9 экранов —
  ALL CLEAN.




## 53. Вход через Telegram с сайта: ссылка на бота из env (2026-10-17)
- Флоу: кнопка «Войти через Telegram» на Login → POST /api/auth/telegram/link
  (одноразовый код, Redis tglogin:{code}, TTL 600 с) → открытие
  https://t.me/{BOT_USERNAME}?start=login_{code} → пользователь жмёт Start →
  бот зовёт internal POST /api/auth/telegram/link/confirm (профиль из
  from_user, статус ok, TTL 120 с) → фронт опрашивает каждые 2,5 с (до 3 мин)
  GET /api/auth/telegram/link/{code} и получает JWT-пару + upsert пользователя
  (source=telegram_link). Код одноразовый, без токена confirm отдаёт 401.
- **Ссылка на бота строится из env**: новая переменная BOT_USERNAME (без @)
  в Settings (.env/.env.example); пусто → 503, фронт показывает «вход через
  Telegram недоступен». Текущее значение: ftadasd_bot (получено getMe).
- Bot: BackendClient.confirm_login_link + handle_deep_link ветка login_
  («✅ Вход подтверждён…» / «⌛ Ссылка устарела»). Bot-хендлер смок-тестить на
  стенде нельзя (поллинг токена в проде) — юнит-тесты в test_bot_calc.py.
- Frontend: createTelegramLoginLink/pollTelegramLogin в api/auth.ts (токены
  пишет setTokens), Login.tsx — кнопка с иконкой Send, разделитель «или»,
  карточка ожидания `.tg-login` («Открыть бота снова» / «Отменить»),
  автосброс по expired/таймауту, cleanup при размонтировании. Стили:
  `.auth__divider`, `.tg-login*` (границы var(--border), обе темы).
- Проверено на стенде curl-циклом: link → pending → confirm ok → JWT-пара →
  повторный GET expired. Образы miniapp/backend пересобраны
  (-p auto_bot_test, реcтарт miniapp после force-recreate, .Image совпадает).
- **567 pytest (+6), 76 vitest (+3), ruff чисто.** Прод-стек (backend+bot)
  redeployить отдельно — иначе прод-бот не подтвердит login_-коды.
## 54. Лента: убран сырой корейский title_raw с карточек (2026-10-17)
- Жалоба «надписи на карточках кривые»: замеры Playwright (overflow/wrap/clip)
  чистые — проблема была в контенте. На стенде у всех 207 listings title_ru
  пуст (translate-сервис не запущен), поэтому второй строкой карточка показывала
  сырой корейский title_raw («현대 더 뉴 그랜저 가솔린…») — визуальный мусор.
- **ListingCard**: .listing-card__sub рендерится только при наличии title_ru
  (переведённый тайтл). Без перевода — одна строка тайтла; title_raw остаётся
  на PDP (там он уместен как «название у источника»). Проверено на стенде:
  sub=null на всех карточках, переносов/обрезаний нет.
- Корейская модель в самом тайтле («Hyundai 더 뉴 그랜저») — данные kcar
  (modelNm с источника), обратного KR→EN словаря нет; лечится переводом
  (этап 5, services/translate + бэкфилл title_ru).
- **78 vitest (+2: sub без title_ru скрыт; с title_ru — перевод).**
## 55. Кнопки «назад» на экранах расчётов (2026-10-17)
- Проблема: «Доставка и растаможка» с карточки ведёт на /calc (и дальше
  «Сравнить» → /compare), но на этих экранах не было возврата — только таббар,
  который теряет контекст объявления.
- Новый ui/BackButton (круглая «‹» по токенам: --border/--bg-secondary,
  обе темы) в sticky-заголовке Calc и Compare (`.feed-header--with-back`),
  navigate(-1) → возврат на PDP.
- Проверено Playwright на стенде: PDP → CTA → /calc (кнопка есть) → назад
  вернулись на /listing/1; /compare → назад → лента. Скриншот back_calc.png.
- **80 vitest (+2: BackButton в Calc и Compare реально делает navigate(-1)).**
## 56. AI-анализ цены закрыт для гостей (2026-10-17)
- Требование: аналитика — только авторизированным. Раньше гость мог 1 раз/нед.
- **Backend** (POST /listings/{id}/analysis): гость = telegram_id < 0 И email
  пуст (email-регистрация тоже с id < 0, но с email; TG-юзеры с реальными id).
  403 guest_forbidden до вызова LLM — денег не тратим. Маркер — 
  _is_web_guest() в analysis.py (SimpleNamespace-юзеры тестов совместимы).
- **Frontend** (Listing): GET /analysis гость не запрашивает вовсе; клик по
  «Анализировать» → модалка входа (LoginPrompt). Кнопка для гостя —
  «🤖 Анализировать — по входу», подсказка с 🔒.
- Тексты синхронизированы: гест-баннер App, карточка гостя Profile,
  докстринги /auth/guest и guestLogin.
- Проверено на стенде: гостевой JWT → POST 403 guest_forbidden; Playwright:
  гость видит «по входу», клик открывает модалку входа, кэша разбора нет.
- **569 pytest (+2: гость 403 без LLM; email-юзер с id < 0 проходит).**
## 57. Контраст в карточке товара (PDP) — тёмная тема чинила белый текст на белом (2026-10-17)
- **Корень:** стили использовали var(--tgui--*) telegram-ui, но либа задаёт
  их только внутри своего appearance-класса; вне его всегда светят фолбэки
  (#fff фон, #222 текст). В тёмном Telegram: CTA-бар белый + цена наследует
  белый --text → «не видно». Заменены все 27 вхождений на свои токены
  (--bg/--text/--bg-secondary/--border/--border-strong/--link).
- **AppRoot appearance:** tgAppearance() (Telegram colorScheme) передаётся во
  все 4 AppRoot — Tabbar и компоненты либы следуют теме.
- **Таббар:** .app-tabbar переопределяет --tgui--secondary_hint_color →
  --text-secondary (2.32:1 → 4.7:1 светлая / 6.9:1 тёмная).
- **Галерея:** чип «⤢» 0.45 → 0.75 black (≥3:1 на любом фото).
- **Фолбэк акцента** (браузер без TG): #2481cc → #1e73b8 (4.13 → 5.0:1
  с белым). В Telegram остаётся парный цвет темы.
- **Аудит:** shots/contrast_audit.py — WCAG-контраст всех текстов/кнопок PDP
  в обеих темах; к финалу в light только иконка ✕ 4.24 (≥3:1 для графики).
- 80 vitest, tsc — чисто; деплой miniapp, гостевой флоу п.56 не задет.
## 58. Контраст ленты и Calc + юрисдикция растаможки по валюте (2026-10-17)
- **Жалоба** «белое на белом в ленте и на растаможке» на стенде не
  воспроизводится: shots/contrast_audit_feed.py (лента) и новый
  contrast_audit_calc.py (/calc, обе темы) чистые — после фиксов п.57
  (токены вместо --tgui--*) осталось только 3.72:1 на активных чипах/кнопке —
  артефакт эмуляции (браузерный шим без парного акцента TG; в клиенте
  акцент парный теме). Аудиты в shots/ для повторных прогонов.
- **Юрисдикция по валюте объявления:** BYN → расчёт привоза по РБ (Маршрут
  Корея → Владивосток → Минск, сбор за оформление и утильсбор РБ, итог в BYN),
  RUB → РФ (как было). Пошлины ЕАЭС (Решение Совета ЕЭК № 54) общие.
- **Backend** (delivery.py): параметр region="ru"|"by" в calc_delivery;
  LOGISTICS_BY_USD=3600 (море+перегон до Минска), BROKER_BY_USD=150,
  LAB_BY_USD=250 (СБКТС/ЭПТС РБ), сбор оформления РБ 48 BYN (ориентир),
  утильсбор РБ 544,5 BYN × коэф. (льготный 0.5 при ≤3000 см³ ≈ 272 BYN,
  полный ×2.0); LEGAL_REFS_BY со ссылками на НПА РБ + «проверять актуальную
  редакцию» и customs.gov.by. В компонентах появилось поле local (местная
  валюта), итоги total_local + currency («₽»/«Br»); total_rub для РФ = local
  (совместимость бота/агента). API /calc/delivery: region в in/out;
  /calc/compare: region прокидывается per-item.
- **Frontend:** fx.ts — toUsd теперь умеет RUB ÷92 и BYN ÷3.05 (раньше
  объявление в ₽/Br считалось как USD — фикс бага цены!), regionFromCurrency();
  Listing CTA добавляет &cur= в deep-link; Calc — чипы 🇷🇺/🇧🇾 (выбор
  запоминается setRegion), region из ?cur=, итог/строки в местной валюте,
  route-заметки и дисклеймер по региону.
- Ставки РБ — честные «ориентиры MVP» (в UI и legal_refs помечены
  «проверять»): точные редакции постановлений Совмина РБ сверять перед
  продом.
- **575 pytest (+6: BY-расчёт, НПА РБ, полный утильсбор >3000 см³, дефолт ru,
  422 region=kz, compare-прокидка), 83 vitest (+3: RUB/BYN в toUsd,
  переключатель РБ шлёт region=by и рисует Br, deep-link ?cur=BYN), ruff/tsc
  чисто.** Деплой miniapp+backend на тестовый стенд; /api/calc/delivery
  region=by отвечает Br живьём.
## 59. Ховер кнопок + Compare по региону + redeploy прода (2026-10-17)
- **Ховер (жалоба «на кнопках при ховере хуёво видно»):** корень —
  `.btn:hover:not(:disabled) { background: var(--bg-secondary) }` перебивал
  `.btn--primary` (специфичность 0,3,0 против 0,1,0): при наведении primary
  теряла акцентный фон, оставая белый текст на светло-сером. Фикс: hover
  смены фона только для не-primary (`:not(.btn--primary)`), для primary —
  `filter: brightness(0.88)` (затемнение, контраст accent-text только растёт,
  обе темы). Новый shots/contrast_hover.py — WCAG-контраст кнопок под ховером
  в light/dark.
- **Compare по юрисдикции** (хвост п.58): чипы 🇷🇺/🇧🇾 (как в Calc, выбор
  синхронизируется через setRegion), region в каждом item запроса, итоги в
  местной валюте (`total_local` + currency, $ вторым числом), route-заметка
  по региону. CompareItem: total_local/currency. **85 vitest (+2: чип РБ →
  region=by и Br в итоге; дефолт ru).**
- **Грабли стендов:** поднимал тестовый проект (`-p auto_bot_test`) без
  оверрайда `deploy/docker-compose.test.yml` → контейнеры пересоздались на
  боевых портах 8080/8443. Восстановлено правильной командой (тест: 8081/8444,
  LLM mock). Запомнить: тест-стенд поднимать только через
  `docker compose -p auto_bot_test -f docker-compose.yml -f
  deploy/docker-compose.test.yml --profile mono up -d ...` (или teststand.sh).
- **Redeploy прода** (п.4 бэклога): боевой стек (default project, prod
  override) пересобран и поднят — backend+bot с новым кодом (login_-коды и
  регион-расчёт в проде), п.56–58 в проде.


## 60. Фильтры и карточки как на avtokorea.by + обогащение encar detail (2026-10-17)

**Референс:** фильтры avtokorea.by/search (марка→модель→поколение, топливо,
объём от/до, КПП, цвет, год/цена/пробег от-до) и карточки (цена $ + BYN,
спек-строка «топливо · объём · КПП»). Осмотры (карта повреждений + чек-лист)
у них — ручные WP-репорты; решили тянуть только из encar, показывать только
в вебаппе.

- **Карточка (ListingCard):** спек-строка `⛽ топливо · 🔋 2.0 · ⚙️ автомат ·
  🚙 кузов · 🔧 привод · 🎨 цвет` (labelOf — канон + сырое значение источника
  как есть); мета — «N км · 🇰🇷 Корея · дата»; ссылка на источник (encar.com ↗
  / kcar.com ↗, stopPropagation — не открывает PDP).
- **Лента (Feed):** в панель фильтров добавлены кузов/топливо/КПП/привод
  (API 0016 уже принимал — фронт не передавал), пробег «от», объём от/до (л),
  цвет. Марка/модель — зависимые селекты из нового `GET /api/listings/facets`
  (DISTINCT make / model WHERE make, как есть в БД). FeedQuery расширен,
  deep-link + sameQuery учат новые поля. Справочники вынесены в lib/specs.ts
  (Feed/Filters без дублей), COLORS — 16 цветов (канон англ., подписи рус.).
- **API:** `mileage_min`, `engine_volume_min/max` (ge=0/le=20), `color`
  (ilike), `/facets` (до `/{listing_id}` — порядок роутов).
- **Обогащение encar detail (миграция 0017: listings.engine_volume Float,
  listings.color Text):** `api.encar.com/v1/readside/vehicle/{source_id}`
  отдаёт spec: bodyName/displacement(см³)/colorName(кор.)/fuelName/
  transmissionName — всего, чего нет в list-API. `enrich_listing_specs()`
  (services/fetch.py): только encar, только если поля NULL (повторные PDP
  бесплатны), normalize_body/fuel/transmission + новые normalize_color
  (COLOR_MAP кор/рус/англ) и normalize_engine_volume (см³→л, 1 знак).
  Подключено лениво в GET /api/listings/{id}; сбой encar не ломает PDP.
- **Осмотры (карта повреждений/чек-лист):** прямой inspection-эндпоинт encar
  не найден (перебор /v1/readside/... 404, fem-SPA без данных в HTML);
  condition.inspection.formats=["TABLE"] — осмотр рендерится на детальной
  странице, данные надо копать дальше (БД-чёрный список из detail API пока
  только спеки). Перенесено в бэклог.
- **Счётчики: 598 pytest (+9: color/volume normalize, enrichment ×3, API
  mileage_min/facets×2/volume+color), 85 vitest.**
- **Деплой:** прод (коммит 0d493d0): build+up backend/miniapp, alembic 0017.
  Живая проверка: лот 231 (encar 42935199) → sedan/diesel/automatic/2.0/blue;
  `?engine_volume_min=2.0&engine_volume_max=2.0` → total=1. Тест-стенд —
  то же, миграция прошла.

## 61. Осмотр: карта повреждений + чек-лист на PDP (миграция 0018) (2026-10-17)

- **Исследование encar (доделано):** в бандле fem.encar.com найдены реальные
  пути — `readside/diagnosis/vehicle/{id}`, `readside/inspection/vehicle/{id}`,
  `readside/record/vehicle/{id}/open?vehicleNo=...` (базовый URL пустой =
  same-origin, fem отдаёт SPA-fallback; api.encar.io мёртв). Все отдают 404 —
  диагностика encar (`view.encarDiagnosis`) закрыта авторизацией (withAllToken,
  гостевого токена в бандле нет). Вывод: structured-парсинг заблокирован.
- **Решение — свои отчёты осмотра (как у avtokorea.by, где осмотры тоже
  ручные):** таблица `inspection_reports` (миграция 0018, применена на стенд):
  listing_id unique FK, source (manual|encar — слот под будущий парсинг),
  inspector, inspected_at, grade (excellent/good/fair/poor), summary,
  marks JSONB [{zone,type,note}], items JSONB [{key,status,note}].
- **Справочники** в `app/schemas/listing.py`: 14 зон кузова (BODY_ZONES),
  7 типов дефектов (MARK_TYPES), 12 агрегатов чек-листа (ITEM_KEYS),
  4 статуса (ok/warn/defect/na). Ключи синхронизированы с фронтовым
  `frontend/src/lib/inspection.ts` (там же русские лейблы, цвета, severity).
- **API** (app/api/listings.py): `GET /api/listings/{id}/inspection` (404 если
  нет — фронт молча скрывает блок), `PUT` — только role=admin (upsert).
  ⚠️ Искали по PK session.get → фикс: select по listing_id (PK у таблицы id).
- **UI** (frontend/src/components/Inspection.tsx): SVG-схема кузова вид
  сверху (14 зон), зоны с дефектами залиты цветом по типу (replace > crack >
  dent > rust > repaint > glass > scratch), тап по зоне — детали; легенда;
  чек-лист с ✅⚠️❌➖ и заметками; бейдж грейда; summary. Секция «🔍 Осмотр»
  на PDP (Listing.tsx) после блока анализа. CSS — `.inspection__*` в index.css.
- **Демо:** отчёт осмотра вставлен для лота 231 (проверено GET 200 в API).
- **Счётчики: 602 pytest (+4 inspection), 88 vitest (+3 InspectionSection),
  tsc/ruff чисто.**
- **Дальше:** деплой прода (build miniapp + backend, миграция 0018); по
  желанию — форма ручного ввода осмотра для админа (сейчас только PUT API).

## 2026-10-17: фикс «Ссылка входа устарела» (site login через бота)

- **Симптом:** вход на сайте через Telegram-бота падал с «⌛ Ссылка входа
  устарела — запросите новую на сайте»; вход в Mini App (initData) работал.
- **Причина:** одновременно были подняты СЕРВИСЫ ОБОИХ профилей compose —
  mono `backend` (:8000) и micro `gateway`. У обоих сетевой алиас `backend`,
  Docker DNS отвечал двумя IP (round-robin): сайт создавал `tglogin:{code}`
  в Redis на одном инстансе, а confirm от бота прилетал на другой (там ключа
  нет → 404 → бот отвечает «устарела»). Плюс у gateway REDIS_URL был
  `redis://localhost:6379/0` (из .env, без compose-оверрайда) — внутри
  контейнера localhost это он сам, Redis'а там нет.
- **Фикс:** `docker compose stop gateway` (микросервисы и mono не должны
  работать одновременно — это взаимоисключающие профили), restart bot +
  miniapp (сброс DNS-кэша nginx/контейнера).
- **Проверено E2E:** link → confirm (200 ok, X-Internal-Token) →
  GET status = JWT-пара + user → повторный GET = expired (одноразовость).
  Тестовый юзер из БД удалён.
- **Правило на будущее:** поднимать строго один профиль
  (`--profile mono` ИЛИ `--profile micro`); если нужен micro — погасить mono
  и прописать микросервисам REDIS_URL через compose environment.

## 2026-10-18: launch: RSS-порог translate, hf_cache, fp16, DNS/137-инцидент, парсеры

### translate: kill-loop по RSS → порог + память + fp16
- **Симптом:** 30 рестартов translate за 3 часа; вечная перекачка NLLB с HF.
- **Причина 1:** RSS-сторож `TRANSLATE_MAX_RSS_MB=2600` был НИЖЕ легитимного
  пика модель+инференс (~2.9ГБ fp32) → kill после каждой загрузки модели.
  Фикс: `TRANSLATE_MAX_RSS_MB=2950`, `mem_limit/memswap_limit: 3500m`.
- **Причина 2 (главная):** на хосте всего **5.8ГБ RAM** (WSL2 VM) — translate
  fp32 + qdrant(2g) + rag_worker(1.5g) не сходятся в бюджет → контейнеры
  получали 137/SIGKILL (в т.ч. весь стек разом ~18:00). Фикс: NLLB грузится
  в **float16** (`torch_dtype=torch.float16` в nllb.py) — весов вдвое меньше
  (~1.2ГБ), инференс на CPU всё равно считается во fp32, качество то же.
- **Перекачка весов:** добавлен volume `hf_cache:/srv/.hf` (top-level volumes)
  + `HF_HUB_DISABLE_XET=1` (xet-протокол HF зависал на 0 байт через
  us.aws.cdn.hf.co — обычный HTTP-CDN работает стабильно).
- **Dockerfile translate:** retry-цикл ×5 + `--mount=type=cache,pip` +
  `PIP_RETRIES=10/TIMEOUT=300`; transformers пин `<5` (v5 убрал pipeline
  «translation»); `translate_client_from_settings`: `max_retries=4`
  (Docker-embedded DNS флапает после массовых пересозданий).
- **Корневой Dockerfile** переведён на ту же схему (cache-маунт + retry ×5):
  зависимости больше не перекачиваются при пересборке из-за изменения кода.

### DNS/сеть Docker Desktop
- Встроенный DNS периодически отдаёт `Temporary failure in name resolution`
  на внешние хосты (us.aws.cdn.hf.co) → зависшие закачки, обрывы pip, билдов.
  Правило: любые сетевые операции в контейнерах/билдах — с ретраями; при
  каскадных 137 — перезапуск Docker Desktop.
- **Инцидент «вебапп не открывается»:** gateway (micro) имел алиас `backend`
  → DNS round-robin с mono-backend → 502. Погашен `docker compose stop
  gateway`; правило: строго один профиль (`--profile mono` сейчас).

### Парсеры не работали
- У encar/kcar в БД был пустой `schedule_cron` → планировщик их не тикал.
  Проставлено `*/30 * * * *` — после этого encar спарсил 50 лотов.

### Инфра фиксы запуска
- miniapp healthcheck на `127.0.0.1` (localhost→::1, nginx IPv4-only);
- minio на `bitnamilegacy` + разовый chown 1001:1001 volume;
- `migrations/env.py` → `rag_core.infrastructure.repositories`;
- рантайм-стейдж rag: COPY rag_core/rag_worker/rag_api;
- `.env`: `RAG_LLM_PROVIDER=glm`, `TRANSLATE_ENABLED=true`,
  `TRANSLATE_SERVICE_URL=http://translate:8200`.

### Статус
- Стек `--profile mono` поднят (gateway погашен осознанно); translate —
  первая закачка NLLB в hf_cache volume идёт, далее смоук и очередь
  translate_listings. Смоуки миграций/перевода до fp16 — 200; pytest 618 green.
- Выводы: (1) порог RSS-сторожа обязан быть выше пика модель+инференс;
  (2) fp16 для CPU-инференса — способ уложить LLM в 6ГБ VM;
  (3) кэш-маунты в Dockerfile обязательны на плохом канале;
  (4) опционально — `HF_TOKEN` в .env для быстрых зеркал.

### Перевод тайтлов в проде (translate_listings)
- Первые прогоны падали: (1) 147 лотов одной задачей не влезали в
  `job_timeout=120` очереди → `enqueue_translate` теперь дробит на чанки по
  `translate_batch_size` (32); (2) bulk UPDATE с доп. WHERE в ORM падал
  (`InvalidRequestError`) → переведён на Core-апдейт `update(Listing.__table__)`.
- Итог: **encar 147/147 translated, pending=0** ('제네시스 GV60' →
  'Генезис GV60'); смоук fetch encar вручную — новые лоты перевелись
  автоматически (fetch→translate конвейер жив, cron */30 в БД).
- NLLB в fp16: RSS translate ~1.9ГБ (было ~2.9ГБ), рестартов 0.

## 2026-10-18 (вечер): картинки encar + UI-фиксы PDP, парсер по cron
- **Картинки не открывались**: encar-адаптер делал `str(dict)` для элементов
  `Photos` → URL вида `https://ci.encar.com/%7B'type':…%7D`. Фикс адаптера
  (разворачиваем `location`); 185/185 существующих записей починены из их же
  URL-ов (unquote + literal_eval). HEAD-проверка: 200 image/webp. kcar — ок.
- **«Назад» перекрывал контент**: `.listing-back` absolute поверх галереи →
  переведён в поток страницы (align-self: flex-start).
- **CTA-бар перекрывал таббар**: `.listing-cta-bar` fixed c bottom 64px →
  `position: sticky; bottom: calc(var(--tabbar-h) + safe-area)` — в потоке,
  физически не перекрывает навигацию; резерв 150px у .listing-page убран.
  miniapp пересобран; vitest 88/88, tsc 0.
- **cron-планировщик**: `cron_matches` проверен на '*/30 * * * *' — корректен;
  добавлена поддержка шортката '*/n' (одно поле) в app/services/cron.py.
  Тики 20:00/19:30 попадали в окна пересоздания worker_fetch — контрольный
  тик 20:30 UTC подтверждён логом `schedule_fetch_due` (см. далее).

## 2026-10-19: починен планировщик парсера (asyncio.Event.wait bug)
- **Парсер не тикал по cron**: TaskWorker._interval_loop/_cron_loop/_monitor_loop
  вызывали `self._stop.wait(timeout=…)` — у asyncio.Event НЕТ параметра
  timeout (это API threading.Event) → TypeError → таска умирала молча
  (create_task без ретрива), interval_job_done никогда не логировался.
  Фикс: helper `_sleep_until_stop(timeout)` на asyncio.wait_for.
- **Подтверждено продой**: `interval_job_done: schedule_fetch_due` каждую
  минуту; в 04:00 UTC `schedule_fetch_due: scheduled=2` → encar `new=15`,
  kcar пошёл; `cron_job_done: stale_check_job` в 04:00. За ночь 185→809
  encar, 203 kcar — парсер+перевод работают постоянно.
- kcar-батчи 32 в 22:36 вернули 0 переводов (разовый сбой на warmup
  translate) — перевыставлены; далее 32/32 ок. 200 kcar-тайтлов дозакрыты.
- Тесты: 616 passed + 2 FAILED tests/test_security_initdata.py — падают и на
  чистом HEAD (существующая регрессия, не из этой сессии; проверить отдельно).

## 2026-10-19 (позже): translate-ретраи + глоссарий hangul-тайтлов + openLink миниаппа

### Ссылки «источник» не работали из миниаппа
- Причина: Telegram WebView блокирует `<a target="_blank">` и `window.open()` —
  в коде не было ни одного `Telegram.WebApp.openLink()`.
- Фикс: `openExternal()` (frontend/src/lib/external.ts): telegram-контекст →
  `WebApp.openLink(url, {try_instant_view:false})`, браузер → `window.open`.
  Задействовано в ListingCard (ссылка-источник) и Listing.tsx (2 CTA-кнопки).
  `TelegramWebApp` дополнен `openLink` (api/auth.ts).
- Формат URL проверен живьём: kcar 200 OK; encar `fem.encar.com/car/detail/{id}` —
  актуальный мобильный веб-хвост (SPA-шелл; полный рендер только с корейских IP —
  ограничение энкара, не ссылки). `car.encar.com/cars/car/{id}` 404 даже с US IP.
- vitest 90/90 (+2 теста openExternal), tsc 0; miniapp пересобран.

### Кринжовые переводы: глоссарий перед NLLB
- Причина: NLLB переводит hangul-бренды как нарицательные: 현대→«Современный»,
  기아→«Голод», 폭스바겐→«Фоксбаген», 인스퍼레이션 (trim Inspiration)→«вдохновение».
- Фикс: `app/services/translate_glossary.py` — словарь hangul→канон
  (бренды латиницей, модели в русской транслитерации, термины/комплектации),
  longest-match замена с hangul-границами; применяется в `translate_listings`
  к тексту перед `client.translate` (title_raw в БД не меняется).
- Частоты сняты с базы: 현대 422, 기아 295, 그랜저 109, 싼타페 74, 인스퍼레이션 8 …
- Примеры после: `기아 더 뉴 K7`→«Kia The New K7», `기아 카니발 4세대`→
  «Kia Карнивал 4 поколение», `현대 팰리세이드`→«Hyundai Palisade».
- Ретранслируются ВСЕ лоты (1172+, задача идемпотентна); кэш translate-клиента
  ключуется исходным текстом — старые записи не совпадают, пересчёт чистый.
- Также: `translate_timeout_sec` 30→180 (инференс сериализован локом от
  «Already borrowed» в tokenizers; 3 параллельных чанка могли не влезть в 30 с);
  0/N переводов теперь RuntimeError → воркер ретраит задачу (attempt 3/3) —
  DNS-флапы и таймауты больше не «успешно» теряют батчи.
- Тесты: test_translate.py 16/16 (6 новых на глоссарий); ruff ok.

## 2026-10-20: «Поделиться» лотом из миниаппа (inline-режим бота)

- Кнопка «Поделиться» на PDP (CTA-блок + иконка в sticky-баре): вызывает
  `WebApp.switchInlineQuery("listing:<id>")` → выбор чата → бот отвечает
  карточкой. Хелпер `shareListing()` (lib/external.ts); вне Telegram/без
  inline — тост «Поделиться можно из Telegram».
- Бот: `@router.inline_query()` в handlers.py — парсит `listing:<id>`,
  карточка = `build_listing_caption` + кнопки `build_share_kb`: «📱 Открыть
  в приложении» (`https://t.me/<bot>?startapp=listing_<id>`) + «🔗 Открыть
  у источника». Thumb — только JPEG (webp источника пропускаем).
- Фронт: `StartParamRedirect` (App.tsx) читает `initDataUnsafe.start_param`
  `listing_<id>` → `navigate(/listing/<id>)` — карточка из чата открывается
  в лот вебаппа. (Бот-хендлер `/start listing_{id}` работал и раньше.)
- Ловушка aiogram 3.13: `thumb_url` в InlineQueryResultArticle молча
  игнорируется — только `thumbnail_url` (иначе миниатюра не уходит).
- Тесты: test_bot_inline_share.py 8/8 (карточка, кнопки, regex, пустой
  запрос, missing listing); vitest 93/93 (+3: shareListing/openLink), tsc 0;
  ruff ok. bot/miniapp пересобраны, polling запущен.
- Ручной шаг: inline-режим бота должен быть включён в BotFather (`/setinline`),
  иначе switchInlineQuery из вебаппа ничего не откроет.

## 2026-10-21: Clean Architecture — домен/сценарии/инфраструктура + Dishka + FastStream

- `app/` переложен по слоям: `domain/` (чистая логика) → `application/`
  (сценарии) → `infrastructure/` (db, cache, security, sources, storage,
  workers, messaging) → `transport/` (http, bot, messaging) + `di/`
  (dishka-контейнер: settings/database/redis/broker/security/adapters/
  repositories/use_cases). Правила зависимостей закреплены тестом
  `tests/architecture/test_layers.py`; `domain` не импортирует `app/*`.
- DI: все сценарии и зависимости — через dishka; HTTP-роутеры принимают
  зависимости в сигнатурах.
- Очереди: добавлен FastStream-контур — строгие контракты команд
  (`extra="forbid"` + обязательный `idempotency_key`), обработчик `enrich`
  (догрузка спеков лота), publisher + outbox-релей с идемпотентностью
  доставки; legacy aio-pika TaskWorker/CronSpec остался в fetch/send.
- Пакет проектных документов — `docs/REFACTOR/` (аудит, blueprint, миграция,
  финал). Suite на момент фиксации: 1119 passed, 3 skipped.

## 2026-10-22: HTTP-слой на dishka — FastAPI Depends выпилен

- `deps/providers.py`: HttpDepsProvider строит `CurrentUser` (Bearer → порт
  `AccessTokenVerifier` → `GetCurrentUser`) и `PartnerAuthState` (X-API-Key →
  `AuthenticateApiKey`); HTTP-маппинг ошибок (401/403) и audit-лог сохранены
  1:1.
- `InternalDishkaRoute` заменяет router-level `Depends(check_internal_token)`:
  X-Internal-Token — Header-параметр сигнатуры (OpenAPI-паритет), проверка до
  dishka-резолва сценариев; константное сравнение сохранено.
- Удалён мёртвый юзкейс `VerifyAccessToken` (+ биндинги DI) — его роль играет
  порт `AccessTokenVerifier` в провайдере.
- Suite: 908 passed, 257 skipped (Postgres-скипы), ruff clean.

## 2026-10-22 (позже): application → 6 микросервисов (ports/dto) + тесты и документация

### Прикладной слой: контракты по сервисам
- Внутри `identity / catalog / billing / partners / dialog / admin` — явные
  `ports.py` (Protocol) и `dto.py` (DTO/команды); все порты вытащены из
  use_cases/queries/settings ~22 модулей, команды/результаты сценариев
  переехали из use_cases в `<service>/dto.py`.
- Старые общие каталоги `app/application/dto/` (18 файлов) и
  `app/application/ports/` расформированы; кросс-сервисные порты
  (CachePort, LLMPort, ClockPort) — в `shared/ports.py`.
- Коллизии имён: `users.ports.UserRepository` → `UserUpsertRepository`;
  партнёрский `LeadView` → `PartnerLeadView` (не путать с CRM-`LeadView`).
- Порты и inline-DTO вырезаны скриптами (`.zwork/refactor_phase*`), глобальный
  рерайт импортов — 66 файлов (app/ services/ tests/). Suite: 908 passed,
  257 skipped, ruff по `app/application` чист.

### Тесты: раскладка по сервисам
- Плоские тесты разложены зеркально архитектуре: `tests/identity/`,
  `catalog/`, `billing/`, `partners/` (+ `helpers.py` вместо
  `partners_helpers.py`), `dialog/`, `admin/`, `bot/`, `security/`,
  `transport/`; инфра-тесты — в `tests/infrastructure/`, смоук
  микросервисов — в `tests/architecture/`. Описание — `docs/TESTING.md`.

### Документация: README → пакет docs/
- `README.md` сокращён до обзора + карты документации; по разделам собраны
  `docs/ARCHITECTURE.md` (слои, 6 сервисов, DI, очередь, micro-профиль, БД),
  `API.md`, `SOURCES.md`, `AI.md`, `MONETIZATION.md`, `OPERATIONS.md`,
  `TESTING.md`, `SECURITY.md` (модель + свод угроз).
- Неактуальное ТЗ (`TZ.md`, 112 КБ: бот/сайт/архитектура до рефакторинга)
  удалено; `docs/REFACTOR/README.md` помечен баннером «зафиксировано» со
  ссылкой на актуальную архитектуру.
- `INCIDENTS.md`: заведён свод из 23 устранённых угроз (initData, секреты,
  SSRF, IDOR, инъекции, rate limits, ПД, ключи партнёров, PQ-шифрование…)
  с контрмерами и тестами; дата аудита актуализирована.

### Дожим техдолга (серия 22.10, вторая волна)
- Закрыто **43 пункта** TECHDEBT с фиксами и тестами: безопасность
  (1.3 prompt-injection лимиты строк, 1.4 guest rate limit по IP,
  1.6 запрет дев-дефолтов URL в prod), данные (2.4 unique списаний за
  лид, 3.6 UUID-дефолт DialogSession, 3.7 specs_enriched_at — миграция
  0020), AI (4.5/4.8/4.9/4.10, 5.1/5.2/5.6/5.7), бот (6.1/6.4/6.9/6.12,
  7.2-7.6, 2.9 ретраи активации оплаты + эскалация админу, 2.10 анти-
  даблклик), воркеры (8.8, 9.1 SCAN, 9.2 mark_sent_many, 9.3, 9.7, 9.8),
  health (12.15), PQ-крипта (12.18 версия в info), очереди (13.3 replay-
  CLI, 13.8 enqueue_many с семафором), CI (14.9: GitHub Actions pytest +
  ruff + pip-audit + bandit), доки (14.7 ADR.md, 14.8 RUNBOOK.md).
- `[tool.ruff]` в pyproject зафиксирован (E4/E7/E9/F; ignores — устоявшийся
  стиль); ruff по app+tests — чисто.
- Новый счётчик TECHDEBT: ✅ 107 / 🟡 27 / ⬜ 22 из 156.

## 2026-10-28: NAV-V2 — лендинг всегда на «/», меню v4 (мини-апп 4 таба + партнёрка 5+«Ещё»)

Решения владельца (AskUserQuestion): «Всегда на «/» + быстрый вход»,
«4 таба: Главная/Авто/Чаты/Профиль», «5 табов + «Ещё»». Спека — docs/NAV-V2.md.

### Мини-апп
- **Лендинг** (screens/Landing.tsx): в браузере на «/» без query показывается
  ВСЕГДА; последний выбор (autobot.surface) только сортирует карточки и
  ставит метку «● последний вход» — ничего не запирает. chooseSurface
  принимает user|partner; resetSurface + кнопка «Сменить поверхность» в
  Профиле ведут на «/» (полная загрузка → лендинг). Telegram и deep-links
  с query — сразу приложение, как раньше.
- **4 таба** (components/Shell.tsx): Главная /, Авто /auto, Чаты /chats,
  Профиль /profile. Бейдж непрочитанных — на табе «Чаты» (useChatUnread,
  гостю скрыт); ChatEnvelopeFloat и ChatBadge из сайдбара удалены
  (компонент + CSS + тест). Чаты активны и на /chats/:id (оверлей).
- **Главная** (screens/Home.tsx): сегмент «Лента | AI-поиск» (пилюли
  .hist-seg), обе панели в keep-alive (сменяются .keepalive-hidden);
  FeedScreen получил проп inactive — на AI-сегменте сам снимает
  body.feed-locked (скролл страницы). FAB «+ Продать» остался только на
  «/» (SellFab самоскрывается на остальных путях).
- **Авто** (screens/Auto.tsx): сегменты Избранное | История | Мои
  объявления, активный — в ?tab= (deep-link/редиректы); гостю сегмента
  «Мои объявления» нет. Панель «Мои объявления» вынесена из Профиля в
  screens/MyLotsPanel.tsx (placement/lifecycle-пилюли, extend/remove/
  restore, live listing_status — без изменений логики).
- **Редиректы-совместимость** (App.tsx OverlayRoutes): /ai → /,
  /favorites → /auto?tab=favorites, /analyses → /auto?tab=history
  (query ?similar= сохраняется). KEEPALIVE_TABS: /, /auto, /filters,
  /calc, /compare, /profile, /chats.
- **Фикс вёрстки** (найден browser-use): body.feed-locked превращает
  .app-content во флекс, а его margin:0 auto отключает cross-stretch —
  контент растягивался до ~987px (гор. скролл, карточки 951px). Лечение:
  width:100% на body.feed-locked .app-content + min-width:0 в
  .home-screen/.home-screen__panel цепочке.

### Партнёрский кабинет (волна F-partner, агент + ревизия)
- PartnerApp.tsx: TAB_ITEMS (Обзор/Пул/Мои/Чаты) + кнопка «Ещё»
  (aria-haspopup=dialog, aria-expanded) → bottom-sheet (Sheet) с Рынок/
  Витрина/Объявления/Чеки/Биллинг; шторка закрывается при смене пути,
  активный раздел группы подсвечивает таб «Ещё» (.pa-tab__dot);
  десктоп-сайдбар — все 9 пунктов. Тест partnerChats.test.tsx
  переписан структурно (jsdom не воспроизводит aria-expanded; живой
  клик проверен browser-use — работает).

### Деплой и проверки
- npm run build зелёный; vitest **552/552** (44 файла, threads=2:
  minThreads=1 обязателен — tinypool конфликтует с дефолтной min).
- miniapp пересобран и задеплоен (compose --profile micro).
- browser-use (IAB 390x844): лендинг → вход без перезагрузки; 4 таба;
  сегменты Главная/Авто; редиректы /favorites,/ai; «Сменить поверхность»
  → лендинг; метка «● последний вход» после перезагрузки; партнёрка:
  вход по ключу (тест-партнёр «NavV2 Check» id=2, plan=starter, создан
  через /api/admin/partners — можно удалить из БД), «Ещё»-шторка живым
  кликом открывается/закрывается, переход «Рынок» подсвечивает «Ещё».

## 2026-10-28 (позже): документация «максимум подробности» — 13 файлов, ~6.6k строк

Волна 5 субагентов (непересекающиеся файлы; факты — только из кода, без Docker/тестов),
затем ревизия: точечные сверки с кодом (advisory-lock 9106, пороги 0.93/1.07, порты
8101–8107, DLQ/очереди, 30 миграций, Python 3.13, mirror-ключ {NNN:03d}) — расхождений
не найдено; секретов в доках нет (плейсхолдеры).

- docs/API.md — 1615 строк: все ~150 ручек (19 роутеров + сервисы): auth-режимы,
  параметры/ответы/ошибки (33 machine-кода), пагинация, curl-примеры, Centrifugo-каналы.
- docs/ARCHITECTURE.md — 773: карта системы, слои/dishka, сервисы+маршрутизация gateway,
  реестр 30 миграций + схема таблиц, очереди (ретраи/DLQ/cron), realtime, фронт,
  ~150 env-переменных, матрица деградации профилей.
- docs/ADR.md — 535: 12 старых ADR в едином формате + 6 новых (dishka, экономика Stars,
  лендинг всегда на «/», keep-alive роутинг, NLLB+глоссарий, outbox+relay).
- docs/MONETIZATION.md — 608 (тарифы/Stars/lifecycle/рынок/партнёры: флоу, гонки, локи);
  docs/AI.md — 518 (7 AI-фич: пайплайны, квоты, RAG, GLM-провайдер).
- docs/OPERATIONS.md — 598 (env-таблицы ~120, health-свод, ступени, бэкапы);
  RUNBOOK.md — 473 (9 инцидент-рецептов + 5 регулярок); TESTING.md — 216 (команды,
  флейки, CI); SECURITY.md — 265 (auth-флоу, IDOR, rate-limits, SSRF, платежи).
- docs/SOURCES.md — 584 (контракт адаптера, encar/kcar/che168, зеркало S3, воркеры,
  «как добавить источник»); README.md — 140 (карта доков); NAV-V2.md — §4 «Как
  реализовано»; TECHDEBT.md — перепроверен (закрыто: UX-полиш, LLM-двойной-вызов;
  новые долги: rate_limit адаптеров не enforced, LPG-фасет, зеркало при смене фото).

## 2026-10-29: GEO-V1 — источники AE/US/KZ + гео в фильтрах и рынке + UI/UX

Спека docs/GEO-V1.md; волна 5 агентов (A умер на 5ч-лимите — бэк доделан
руками по его наработкам; B/C/D/E завершились). Прогон browser-use живой.

### Бэкенд
- Миграция 0031: listings.country (ISO2) + city; бэкфилл по source-мапе
  (394 лота → KR); индекс ix_listings_country. РЕВИЗОРСКИЙ ФИКС: агент
  оставил `#`-комментарии Пайтона внутри SQL listings_writer — Postgres
  падал синтаксисом; заменены на `--`. Ещё фикс: alembic env.py
  fileConfig(disable_existing_loggers=False) — программный прогон
  миграций в тестах глушил caplog соседям (4 флейка).
- Лента: query country=; фасеты v2 с countries (сейчас [KR,KZ]).
- Рынок: country/city в create/update/MyLotOut + фильтр GET /market/lots.
- Калькулятор: DeliveryIn.country (KR/CN/AE/US/KZ), домен
  app/domain/logistics/routes.py (порт/фрейт/сроки), DeliveryOut.route
  («Джебель-Али → Новороссийск») + freight_days_*.
- UnifiedListing.country → writer (COALESCE — не сбрасывает бэкфилл).

### Источники (ADAPTER_CLASSES: 6 классов)
- kolesa (KZ): ВКЛЮЧЁН, живой HTML сверен (20/20 карточек), прод-fetch
  принёс 40 лотов KZ (Hongqi HS5, Ferrari F8, Lada…). KZ_MAKE_MAP
  кириллицы в адаптере.
- dubizzle (AE) / cars_com (US): написаны на фикстурах двух поколений
  вёрстки (31 тест), ВЫКЛЮЧЕНЫ — Imperva/Akamai антибот, включение
  только с use_proxy + резидентными прокси, селекторы — сверить.
- che168 (CN): не включён (JS-антибот EO_Bot_Ssid) — TODO headless/прокси.
- Сид источников через PUT /api/admin/sources (kolesa вкл, dubizzle/
  cars_com выкл с use_proxy). Гочворо: registry кеш адаптеров греется
  на старте воркера — после сида нового источника нужен рестарт
  worker_fetch.

### Фронтенд (vitest 568→572, tsc чисто)
- lib/geo.ts (COUNTRIES/flags); чипсы-страны в ленте + секция «Страна»
  в шите; deep-link ?country=; бейджи «🇰🇿 KZ · kolesa»/«🇷🇺 Москва» на
  карточках; PDP «Страна»; SellCar страна (дефолт RU, без импортных) +
  город; MyLots «📍»; калькулятор: сегмент стран + маршрут/сроки.
- РЕВИЗОРСКИЙ ФИКС: цены KZT рисовались «$12 200 000» — lib/fx не знал
  KZT (фолбэк USD). Добавлены фикс-курсы KZT÷480/CNY÷7.1/AED÷3.6725
  (тесты). Теперь Hongqi HS5 = $25 417.

### Деплой и проверки
- Пересобран весь micro-профиль + workers + bot + miniapp; миграция
  через gateway (alembic). Полный pytest: infra 433/433, фулл-ран в фоне
  дал 23 errors на рестарте Docker (артефакт параллельности; изолированно
  все файлы зелёные). vitest 572/572.
- browser-use: /?country=KZ → 40 авто, чипс [pressed], «Фильтры · 1»,
  бейджи на карточках, цены KZT→$ корректны, калькулятор со странами.

## 2026-10-29 (вечер): аудит безопасности + багхантинг + UX — 5 отчётов, волна фиксов

Аудит-волна (5 агентов, отчёты docs/audits/: security-backend, security-frontend-infra,
bugs-backend, bugs-frontend, uiux + TRIAGE-реестр): ~95 находок
(0×P0-sec, 4×P1-sec; 1×P0-баг, 10×P1; UX 1×P0, 6×P1; оценка UX 7/10).
Волна фиксов (5 агентов) прервана OOM машины в 00:33 — агенты погибли,
но успели записать правки; хвосты и тест-склейка доделаны ревизором.

### Починено — бэкенд (pytest 1182/1182)
- B-01 (P0): mark_stale не трогает owner-лоты (owner_type IS NULL) —
  ночной stale_check больше не убивает оплаченные размещения (тест).
- B-02: PaymentRepository.rollback() (порт+SQLA) — гонка двойного вебхука
  без 500 (тест). B-05: rollback перед record_error — CB ожил на DB-ошибках.
- B-03: app/domain/pricing/rates.py — единые курсы (KRW/KZT/CNY/AED/RUB/
  BYN/EUR), _usd_price_expr CASE для всех валют; NULL-валюта вне ценовых
  фильтров (тесты). B-11: фрейт/маршрут по стране из ROUTES (KZ сухопутно).
- B-04: дедуп known_pairs — повторный фетч известной пары доходит до upsert
  (update цены/translate), кросс-дубль — только для новых (мок+тест обновлён).
- B-06: зеркала фото не откатываются unchanged-upsert'ом. B-10: release()
  дедупа при сбое upsert.
- B-07/08 (ревизор): placement дедлайн = GREATEST(старый, новый) — параллельные
  вебхуки не теряют недель; archived-лот не оживляется старым инвойсом.
- SEC-01: SSRF-гвард в фото-зеркале (приватные IP/редиректы; тест
  test_mirror_ssrf). AUTH-01: client_ip берёт правый XFF-хоп + nginx
  X-Real-IP. AI-01: гость 403 в AI-диалоге. SEC-02: list_path в
  SSRF-валидации источников. INFRA-01/02/03: прод-compose закрывает
  qdrant/minio/translate/rag порты, креды из env; translate/rag
  fail-closed + compare_digest (тесты). BOT-01..03: html.escape во всех
  HTML-сообщениях бота. PRIV-01: маскировка голых номеров (≥10 цифр) и
  email; порядок правил wa.me→t.me→телефоны (20/20 тестов). DOS-01:
  Query-констрейнты фасетов. INFRA-04: bytes-compare в subscribe-proxy.
  MKT-01: фото лотов только https. AUTH-гость-гейт, EXT-01 openExternal
  http(s)-only, RACE-01 общий busy на тарифах (фронт).

### Починено — фронтенд (vitest 600/600, было 568)
- BF-01 (Critical): ценовые пресеты шлют USD (usdToKrw убран; тесты
  переписаны с KRW-археологии). BF-02: deepLinkQuery — белый список
  feed-ключей, применяется только при монтировании (чужие ?tab/?similar
  не сбрасывают фильтры). BF-03: поллинг-фоллбэк чатов оживлён
  (t.subscribe(userChannel)). BF-04: Favorites слушает autobot:auth.
  BF-06: Calc-префилл один раз (нет гонки страны/URL). BF-08/UX-P0:
  SellCar → /auto?tab=mine во всех 8 местах.
- UX-002: валюта следует за страной (RU→RUB, KZ→KZT, BY→BYN; селект
  RUB/USD/EUR/KZT/BYN). UX-003: PDP «Доставка и растаможка» несёт
  ?country=; Calc читает страну, маршрут/сроки из DeliveryOut (хардкод
  «Пусан→Владивосток» убран). UX-004: sticky-бар PDP — primary CTA
  экрана. UX-005/006/007: apiErrorText в чатах/PDP/платежах. UX-013:
  тосты aria-live. UX-014: контрасты AA. UX-015/016: тач-зоны ≥44px
  (compare/partner-чипы). UX-025/024/035/028: Login-табы, aria-pressed,
  микрокопии, актуальные страны на лендинге. BF-13/14: символы валют
  ₸/¥/AED в formatOriginal, минимальный toUsd.

### Тест-склейка ревизора после гибели агентов
- dedup-мок .all() + SELECT-ветка; кросс-тест под новую семантику B-04.
- Listing UX-003-тесты: поиск по роли (текст со стрелкой), импорт
  useLocation. SellCar UX-002: независимые рендеры + чистка sellDraft.
- Calc: scoped-ассерт .calc-total__route (маршрут в двух местах).

### Открыто (см. docs/audits/2026-10-29-TRIAGE.md + TECHDEBT.md)
- 👤 владельцу: ротация MinIO-пароля на проде; SSO/ADMIN_TOKEN (ADM-01);
  публичность ленты подтвердить; firewall 8101–8107; RAG_JWT_SECRET.
- 📋: AUTH-02/03 (refresh-ротация, login-лимиты), TOK-01/02 (httpOnly),
  UX-P2/P3 хвосты (второй ряд чипсов, пустая страна, GeoBadge-компонент,
  гео в партнёрке), B-12..18 (P3).
- Деплой волны НЕ выполнен (запрет Docker из-за OOM машины): прод ждёт
  B-01/SEC-фиксы; после разрешения — build micro+workers+bot+miniapp,
  browser-use прогон сценариев аудиторов.

## 2026-10-29 (ночь): источники v2 — kolesa детальные + антибот-контур

Фидбек владельца: «доп источники не готовы — мало инфы, мало фоток, не работают».

- **kolesa v2** (`app/infrastructure/sources/kolesa.py`): обогащение топ-8
  карточек страницы деталями (Referer-гвард от 418): галерея до 10 фото
  `{N}-full.webp` (было 1), словарные характеристики (кузов/привод/руль/
  цвет/город/поколение/двигатель с гибридами/точный пробег), опции-чипы до
  40. Живая проверка: Camry — 8 фото + 38 опций, BMW 750 — 10 фото/awd.
  Тесты 18/18 (в т.ч. «деталь 500 не роняет страницу»).
- **Антиботы**: прямые пробы dubizzle/cars.com (HTML+API+GraphQL) и
  альтернатив (yallamotor/ksl/guazi/autohome) — все 403/JS-челлендж с
  датацентрового IP. Вывод: включение только через резидентные прокси;
  контур готов (ProxyPool-Redis + dataimpulse-шлюз env + use_proxy в
  сидах) — задокументировано в SOURCES.md §4b. Нужно владельцу: аккаунт
  резидентных прокси (креды в .env) → рестарт воркера → enabled=true.
- Все адаптер-тесты: 116/116.
