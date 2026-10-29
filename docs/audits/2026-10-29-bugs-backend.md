# Аудит логических багов бэкенда — 2026-10-29

Скоуп: гонки/транзакции, идемпотентность, lifecycle рынка, денежные расчёты,
фасеты/лента, воркеры, AI-квоты, миграции. Только логика — стилистика не рассматривалась.
Код читался целиком по сферам; ключевые гипотезы проверены запуском (см. «Метод проверки»).

**Свод: 18 багов — P0: 1, P1: 5, P2: 5, P3: 7.**
Самый тяжёлый кластер — «рынок + fetch-воркер»: ночной stale-check убивает
owner-лоты рынка (включая оплаченные размещения), а Redis-дедуп ингеста глотает
повторные фетчи тех же лотов, откладывая price_drop/обновления на срок до 48 часов.

Severity: P0 = деньги/данные/крэш прода; P1 = серьёзная поломка фичи/денег в узком окне;
P2 = баг с обходным путём или редким сценарием; P3 = edge/расхождение с контрактом.

---

## Сводная таблица

| ID | Sev | Компонент | Файл:строка | Баг (кратко) |
|----|-----|-----------|-------------|--------------|
| B-01 | P0 | рынок / stale-check | `app/infrastructure/db/repositories/listings_writer.py:298-310` | `mark_stale` деактивирует owner-лоты рынка (paid/slot) через 3 дня после создания |
| B-02 | P1 | payments | `app/application/payments/use_cases.py:280` | вызов несуществующего `PaymentRepository.rollback()` → AttributeError на гонке вебхуков |
| B-03 | P1 | лента / GEO | `app/infrastructure/db/repositories/listings_read.py:52-57` | USD-фильтр/сортировка цен не конвертирует KZT/AED/CNY — новые источники выпадают из фильтра цены |
| B-04 | P1 | fetch / дедуп | `app/infrastructure/sources/common/dedup.py:30-40,149-175` + `app/application/listings/ingest.py:75-88` | cross-dup ключи не содержат source: повторный фетч того же лота отбрасывается как «межисточниковый дубль» до 48 ч |
| B-05 | P1 | fetch / circuit breaker | `app/infrastructure/workers/fetch.py:110-118` + `services/source_health.py:50-59` | `record_error` на абортнутой сессии → CB не открывается при DB-ошибках ингеста |
| B-06 | P1 | fetch / mirror | `app/infrastructure/workers/fetch.py:477-511` + `listings_writer.py:84` | зеркала фото откатываются следующим upsert'ом (images ← исходные URL), повторное зеркалирование скипается |
| B-07 | P2 | payments / placement | `app/application/payments/use_cases.py:202-232` | read-compute-write дедлайнов без блокировки: параллельные вебхуки двух placement-платежей теряют оплаченную неделю |
| B-08 | P2 | payments / lifecycle | `app/infrastructure/db/repositories/payments.py:118-142` | оплата старого инвойса воскрешает archived/снятый лот (status→accepted, is_active→True) без модерации |
| B-09 | P2 | партнёры / claim | `app/application/partners/use_cases.py:155-210` + `services/partners/repository.py:195-212` | TOCTOU по балансу в ClaimLead/ClaimBatch → баланс партнёра уходит в минус |
| B-10 | P2 | fetch / дедуп | `app/application/listings/ingest.py:57-73` | нарушен контракт `claim`→`release`: при ошибке upsert ключи дедупа не отпускаются → потеря новых лотов до 48 ч |
| B-11 | P2 | calc / GEO | `app/domain/logistics/routes.py:45-87` + `app/transport/http/routers/calc.py:113-122` | `freight_usd` маршрута не попадает в расчёт: для CN/AE/US/KZ логистика считается по KR-константе |
| B-12 | P3 | AI-квота | `app/infrastructure/ai/agent.py:165-189` | квота AI-поиска: allow→consume не атомарен (вопреки докстрингу) — оверхлимит на гонке |
| B-13 | P3 | чат | `app/application/chat/use_cases.py:565-622` | POST messages без идемпотент-ключа — ретрай клиента дублирует сообщение |
| B-14 | P3 | лиды | `app/application/leads/use_cases.py:52-61` + `db/repositories/leads.py:43-47` | Idempotency-Key не привязан к user_id: чужой ключ возвращает чужой LeadView |
| B-15 | P3 | подписки | `app/infrastructure/workers/send.py:435-443` | `days_left=(until-now).days`: за <24 ч до конца подписки даунгрейд срабатывает раньше срока |
| B-16 | P3 | рынок | `app/infrastructure/db/repositories/market_lots.py:198-220` | кулдаун free-периода считает черновики — неотправленный draft сжигает бесплатную неделю (гипотеза намеренности) |
| B-17 | P3 | лента / lifecycle | `app/infrastructure/db/repositories/listings_read.py:374-387,449-495` | expired owner-лоты (is_active=True) попадают в by-url/similar/facets, но PDP отдаёт 404 |
| B-18 | P3 | миграции | `app/infrastructure/db/migrations/versions/0031_geo_listing_columns.py:56-59` | downgrade 0031/0030 безвозвратно теряет country/city/moderation-данные на проде |

---

## Детали

### B-01 — P0: stale_check_job деактивирует owner-лоты рынка (деньги: оплаченные размещения и слоты)

**Файлы:**
- `app/infrastructure/db/repositories/listings_writer.py:298-310` — `mark_stale`:
  `update(Listing).where(Listing.is_active.is_(True), Listing.last_seen_at < threshold)`
  — **нет фильтра `owner_type IS NULL`**;
- `app/infrastructure/db/models.py:511-513` — `last_seen_at` NOT NULL `server_default=now()`;
- `app/infrastructure/db/repositories/market_lots.py:72-108` — `create_lot` не проставляет
  `last_seen_at` (заполняет server_default временем создания), owner-лоты никогда не
  пере-фетчатся → `last_seen_at` навсегда остаётся датой создания;
- `app/infrastructure/workers/fetch.py:336-350` — cron 04:00 UTC зовёт `mark_stale`;
- `app/config.py:302` — `stale_max_age_days: int = Field(default=3, gt=0)`.

**Сценарий воспроизведения:**
1. Юзер публикует лот рынка (или партнёр — за слот), оплачивает продление на 4 недели
   (`placement_paid_until = now + 28d`), `status='accepted'`, `is_active=True`.
2. Проходит 3 дня. В 04:00 UTC `stale_check_job` → `mark_stale` матчит строку
   (`is_active=True`, `last_seen_at` = время создания < now−3d) →
   `is_active=False, disappeared_at=now()`.
3. Лот исчезает из витрины рынка: `list_public_lots` (market_lots.py:154-158) требует
   `is_active=True AND status='accepted'`; из ленты — `_conditions` (listings_read.py:216).
   Оплаченные недели/слот сгорают. `market_placement_expiry` (send.py:585) тут бессилен —
   он трогает только `status`, а `is_active` уже сбит.
4. Каскад в тот же день: `stale_check_job` ставит «gone»-скан (fetch.py:346-348) —
   аудитория `sent_log` получает «объявление исчезло»; в 04:30 `favorites_sold_job` →
   `collect_sold_favorites` (`app/infrastructure/services/notify.py:137-158`, тоже без
   owner-фильтра: `is_active=False OR disappeared_at IS NOT NULL`) шлёт «продана»
   и **удаляет лот из избранного** всех, кто его лайкнул.

Докстринг `stale_check_job` («owner-лоты рынка не трогаем») относится только к
S3-очистке (`gone_external_rows`, listings_writer.py:315-335, там фильтр
`owner_type IS NULL` есть) — сам `mark_stale` владельцев не различает.
Отдельно замечание: docstring `fetch.py:341-342` создаёт ложное чувство защищённости.

**Фикс:** в `mark_stale` добавить `Listing.owner_type.is_(None)` (owner-лоты живут
своим lifecycle: `market_placement_expiry` + `deactivate_lot`), либо в `create_lot`
проставлять и поддерживать `last_seen_at`. Дополнительно — фильтр owner-лотов в
`collect_sold_favorites`/`event_audience` как вторую линию защиты.

---

### B-02 — P1: `ConfirmPayment` вызывает несуществующий `rollback()` у репозитория платежей

**Файлы:**
- `app/application/payments/use_cases.py:274-285` — ветка «параллельный вебхук уже
  активировал» (`mark_paid` вернул False) делает `await self._payments.rollback()`;
- `app/application/billing/ports.py:11-72` — порт `PaymentRepository`: метода `rollback` нет;
- `app/infrastructure/db/repositories/payments.py:30-204` — адаптер: тоже нет.

**Проверка (запуск):** `hasattr(SqlAlchemyPaymentRepository, 'rollback') == False`.
Тесты этого не ловят: replay-кейс (`tests/billing/test_payments_api.py:236-240`) идёт по
раннему `record.status == "paid"` (use_cases.py:258), а ветка `mark_paid→False` не покрыта;
фakes сессий в `tests/conftest.py:239` имеют свой `rollback`, но он не делегируется репозиторию.

**Сценарий:** два вебхука `successful_payment` одного платежа приходят параллельно;
оба прочли `status='pending'`, первый успел `mark_paid`, второй получает rowcount=0 →
`AttributeError: 'SqlAlchemyPaymentRepository' object has no attribute 'rollback'` →
500 на internal-эндпоинте `/api/payments/success`. Деньги при этом уже зачислены
(эффект применён первой транзакцией), но бот получает ошибку и может ретраить/дублировать
сообщение юзеру.

**Фикс:** добавить `rollback()` в порт и адаптер (`await self._session.rollback()`),
либо убрать вызов (в этой ветке вне транзакции не осталось ничего грязного —
no-op UPDATE не абортит транзакцию; достаточно вернуть подтверждение).

---

### B-03 — P1: фильтр/сортировка цены не знают KZT/AED/CNY (GEO-V1)

**Файлы:**
- `app/infrastructure/db/repositories/listings_read.py:52-57`:
  `_usd_price_expr()` конвертирует **только KRW** (`price / 1350`), всё остальное
  проходит как есть;
- применение: строки 150-159 (сортировки `price_asc/price_desc`), 253-258
  (`price_min/price_max`);
- валюты источников: kolesa=KZT (`sources/kolesa.py:262`), dubizzle=AED
  (`sources/dubizzle.py:450`), che168=CNY (`sources/che168.py:372`), cars_com=USD,
  encar/kcar=KRW. Конверсий KZT/AED/CNY→USD в бэке нет (grep: только `_USD_KRW_FALLBACK`).

**Сценарий:** лот kolesa за 21 000 000 KZT (~$40k). Пользователь ставит
`price_max=30000` (USD, как весь фильтр — см. docstring «цена в USD», listings_read.py:5):
SQL сравнивает `21000000 <= 30000` → лот исключён. Любой KZ/CN/AE-лот выпадает из
практически любого ценового окна и всегда сортируется как «самый дорогой».
Фильтр цены по новой гео-ленте фактически не работает, сортировка по цене ломается.

**Фикс:** расширить `case(...)` курсами KZT/AED/CNY (константы или Settings, как
сделано для KRW), либо фильтровать в исходной валюте при явном `currency=`
и запрещать `price_min/max` без `currency` для мультивалютной выдачи.

---

### B-04 — P1: Redis-дедуп глотает повторные фетчи тех же лотов (до 48 часов)

**Файлы:**
- `app/infrastructure/sources/common/dedup.py:30-40` — `_CLAIM_SCRIPT`: если ключ
  существует → «дубль», TTL не продлевается;
- `dedup.py:149-175` — `fuzzy_key` = make|model|year|mileage(округл. до 1000),
  **без source**; `vin_key` — тоже без source;
- `app/application/listings/ingest.py:75-88` — `_drop_duplicates` применяется ко всем
  item'ам каждой пачки перед upsert;
- TTL: `DEDUP_TTL_SEC = 48*60*60`.

**Сценарий:**
1. Прогон 1 (t=0): лот encar/kcar/kolesa «new» → claim ключей → upsert.
2. Прогон 2 (t=+1ч, тот же лот, тот же источник): `EXISTS` → `is_duplicate=True` →
   item отброшен как `cross_dup`, **до upsert не доходит**. Цены/контент не сравниваются:
   `updated`/`price_changed`/`unchanged` не возникают, `last_seen_at` не обновляется,
   `translate_ids` не собираются.
3. Только когда TTL истечёт (t≈48ч), ближайший фетч снова проходит claim → upsert видит
   изменение цены → `price_drop`-уведомление приходит с задержкой до ~48 часов.

Тест `tests/infrastructure/test_fetch.py:247-255` («cross_source_dup») закрепляет
поведение **для одного и того же источника** (`_item()` в обоих вызовах, только
redis общий) — т.е. это не случайный регресс, а невыловленная логическая ошибка:
докстринг dedup.py говорит «межИсточниковый дедуп», но ключи не различают источник.
Весь конвейер `decide()`/цена-история/перевод спроектирован под повторные фетчи,
а фактически срабатывает раз в 48 ч на лот. (Побочный эффект: B-06 отчасти маскируется
этим багом — откат зеркал тоже происходит не чаще раза в 48 ч.)

**Фикс:** пропускать дедуп для item'ов, уже известных в своей паре
`(source, source_id)` (проверка до Redis-claim), либо включать `source` в ключ
и оставить чисто межисточниковую семантику + «первый источник выигрывает» по конфигу.

---

### B-05 — P1: circuit breaker мёртв для DB-ошибок ингеста («current transaction is aborted»)

**Файлы:**
- `app/infrastructure/workers/fetch.py:75-118` — цикл фетча: `save_listings(...)`
  → при исключении `except Exception: await record_error(session, ...)`;
- `app/infrastructure/services/source_health.py:50-59` — `record_error` делает
  `session.get(...)` + `commit()` **без rollback**.

**Сценарий:** `save_listings` падает посреди транзакции (IntegrityError/DataError —
например, значение не влезает в колонку, обрыв коннекта). Сессия остаётся в
aborted state → `record_error` падает на первом же запросе с
`PendingRollbackError: current transaction is aborted…` → исключение вылетает
из `except`-блока → задача уходит в retry воркера, но `error_streak` так и не
инкрементирован ни в одном прогоне → `should_skip_source` никогда не сработает,
алерт «Circuit breaker» не уйдёт, воркер будет молотить падающий фетч бесконечно.
(Тот же паттерн, что в недавнем реальном инциденте: голая сессия без rollback.)

Для сетевых ошибок адаптера (сессия чистая, только SELECT `should_skip_source`)
`record_error` работает — CB живёт только для этого класса ошибок.

**Фикс:** в `fetch_source_task` перед `record_error` делать `await session.rollback()`,
а сам `record_error` обернуть `try/except` с rollback+retry — здоровье источника
не должно падать от состояния транзакции ингеста.

---

### B-06 — P1: зеркалирование фото откатывается следующим же фетчем

**Файлы:**
- `app/infrastructure/workers/fetch.py:477-511` — `mirror_photos_task` заменяет
  `listings.images` на S3-URL зеркал (update в БД), но `content_hash` не трогает;
- `app/domain/listings/ingestion.py:35-51` — `compute_content_hash` включает
  `sorted(images)` — хэш считался по **исходным** URL;
- `app/infrastructure/db/repositories/listings_writer.py:84` — upsert безусловно:
  `images = EXCLUDED.images` — при «unchanged» (хэш совпал, item несёт исходные URL)
  изображения молча откатываются к исходным;
- `fetch.py:483-485` — на следующем прогоне `photos.has_mirror(src, sid) == True`
  → лот скипается → URL зеркал больше никогда не вернутся в БД.

**Сценарий:** фетч №1 создал лот → `mirror_photos_task` сохранил зеркала и переписал
`images` → фетч №2 (после истечения dedup-TTL, см. B-04) апсерит тот же лот
как «unchanged» и перезаписывает `images` исходными ссылками. S3-объекты остаются
(мусор), анти-хотлинк-защита не работает: карточки снова dépendят от CDN источника,
а при смерти CDN фото пропадут, хотя зеркала физически есть.
Дополнительно: `enqueue("mirror_photos_task")` дергается на каждую страницу фетча
(fetch.py:86-90) — дубли задач на один прогон (безвредно, но гонит лишнюю работу).

**Фикс:** при «unchanged» не перезаписывать images, если в БД уже зеркальные URL
(например, сравнивать по префику зеркал и оставлять их), либо сравнивать хэш по
нормализованному «первому фото»/без images и вести отдельный признак «зеркалён».

---

### B-07 — P2: потеря оплаченной недели при параллельных placement-вебхуках

**Файлы:** `app/application/payments/use_cases.py:202-232` (чтение дедлайнов →
`mark_paid` → `save_placement_paid_until`), `db/repositories/payments.py:118-142`
(безусловный UPDATE по owner-фильтру).

**Сценарий:** юзер почти одновременно оплачивает два инвойса на один лот (1 нед + 4 нед).
Оба вебхука читают `placement_paid_until=X`, оба `mark_paid` своих платежей проходят
(разные строки), оба пишут `X + свой период`; последний коммит затирает первого.
Итог: заплачено за 5 недель, получено 4 (или 1). `lock_user_lots` (advisory 9106)
в этом сценарии не берётся, `save_placement_paid_until` не делает
`GREATEST(placement_paid_until, :until)`.

**Фикс:** писать атомарно
`UPDATE … SET placement_paid_until = GREATEST(COALESCE(placement_paid_until, now()), :until) + :period`
или брать `pg_advisory_xact_lock(9106, user_id)`/`SELECT FOR UPDATE` лота до чтения дедлайнов.

---

### B-08 — P2: оплата старого инвойса воскрешает снятый/отклонённый лот

**Файлы:** `app/infrastructure/db/repositories/payments.py:118-142` —
`save_placement_paid_until` ставит `is_active=True, status='accepted'` без проверки
текущего статуса; `app/application/market/use_cases.py:833-866` (`ExtendLot`) проверяет
статус **только при создании инвойса**.

**Сценарий:** юзер создал инвойс на продление accepted-лота → передумал и снял лот
(`DELETE /market/lots/{id}` → `status='archived'`, `is_active=False`) → затем оплатил
залежавшийся инвойс в чате Telegram (инвойс-ссылки живут в чате неограниченно).
Вебхук `ConfirmPayment`→`save_placement_paid_until` принудительно возвращает лот в
ленту (`accepted`, `is_active=True`) — владелец этого не просил, модерация не смотрела.
Аналогично лот мог уйти в `rejected` через патч-очередь.

**Фикс:** в `save_placement_paid_until` добавить
`Listing.status.in_('accepted','expired')` в WHERE и при rowcount=0 возвращать
NotFound/Conflict («лот снят — оплата не принята»/возврат).

---

### B-09 — P2: claim лида может увести баланс партнёра в минус

**Файлы:**
- `app/application/partners/use_cases.py:155-210` (`ClaimLead`) и `:244-290`
  (`ClaimBatch`): `_refusal` читает баланс/квоту вне блокировки →
  `claim_lead_row` (атомарный по лиду) → `update_balance_returning(-unit_cost)`;
- `app/infrastructure/services/partners/repository.py:195-212` —
  `update_balance_returning` без условия `balance >= -delta`.

**Сценарий:** баланс = стоимость одного лида. Партнёр дёргает claim двух **разных**
лидов параллельно: оба `_refusal` видят достаточный баланс, оба атомарно забирают
свои лиды (конфликта нет), оба списывают → баланс отрицательный. Для сравнения,
`purchase_placement_package` (market_lots.py:581-614) корректно защищает списание
условием `balance >= price`. `claimed_today` (квота) — та же гонка чтения.

**Фикс:** `UPDATE partner_accounts SET balance = balance - :c
WHERE id = :id AND balance >= :c RETURNING …` (как в BuyPackage), при rowcount=0 —
откатить claim лида (или не коммитить — claim и списание в одной транзакции UoW).

---

### B-10 — P2: после сбоя upsert ключи дедупа не отпускаются (потеря новых лотов до 48 ч)

**Файлы:** `app/application/listings/ingest.py:57-73` — после `_drop_duplicates`
(claim) вызов `upsert_many` не обёрнут в try/release; контракт из
`dedup.py:201-224`: «Если после claim вставка в БД упала — вызывающий обязан
вызвать release, иначе объявление потеряется до истечения TTL». Никто не вызывает.

**Сценарий:** пачка новых лотов прошла claim, upsert упал (мигр. дрейф, обрыв) →
TaskWorker ретраит задачу → attempt 2 видит ключи занятыми → все лоты пачки
считаются `cross_dup` и выбрасываются → до 48 ч лоты из выдачи источника в БД не попадут.
Компаундится с B-04. `release()` в коде есть, но ни одного вызова вне тестов.

**Фикс:** в `IngestListings.execute` обернуть upsert:
`try: … except BaseException: for item in kept: await duplicates.release(item); raise`.

---

### B-11 — P2: калькулятор игнорирует фрейт маршрута (GEO-V1: money-расчёт для новых стран)

**Файлы:**
- `app/domain/logistics/routes.py:31,45-87` — `DeliveryRoute.freight_usd`:
  KR 1400 / CN 1200 / AE 2500 / US 2800 / KZ 0 («сухопутно своего фрейта нет»);
- `app/transport/http/routers/calc.py:113-122,216-226` — `route_for(country)` берёт
  только `route/days_min/days_max`; `freight_usd` **нигде не используется**
  (grep по app/ и frontend — только определение);
- `app/domain/calc/delivery.py:102-109,379` — логистика всегда
  `LOGISTICS_USD=1800` (Бусан→Владивосток) / `LOGISTICS_BY_USD`.

**Сценарий:** расчёт «под ключ» для страны отправки AE показывает маршрут
«Джебель-Али → Новороссийск, 40-55 дней», но в деньгах остаётся морской фрейт Кореи
($1800 вместо $2500); для KZ в итог входит морская доставка $1800, которой не существует
(маршрут «свой ход/автовоз», freight 0). Итог/`total_usd` для новых стран врёт на
$700–1000 в пользу сервиса. Помечено как «константы-приближения», но поле задумано
и мертво — это несшитый GEO-V1 контур.

**Фикс:** прокинуть `route.freight_usd` в `calc_delivery(..., logistics_usd=...)`
(KZ: не добавлять морскую часть, оставив брокера/СБКТС по месту).

---

### B-13…B-18 — P3 (кратко)

- **B-12** `app/infrastructure/ai/agent.py:165-189`: докстринг обещает атомарность,
  но это тот же allow→consume (два запроса на границе лимита оба пройдут). Фикс:
  `INCR`-потом-проверка с декрементом при отказе или Lua. Суточное окно UTC
  (`quota_key`, `application/quota/use_cases.py:27-48`) — консистентно, TZ-скачки
  отсутствуют (счётчик и ключ меняются одновременно в 00:00 UTC).
- **B-13** `app/application/chat/use_cases.py:565-622`: нет client_message_id /
  дедуп-окна — повторный POST (ретрай прокси/пользователя) пишет второе сообщение.
- **B-14** `app/application/leads/use_cases.py:52-61`: replay по ключу возвращает лид
  **любого** пользователя (индекс уникален глобально, поиск без user_id). Два клиента
  с одинаковым ключом → второй получит LeadView первого (user_id, comment). TTL нет —
  ключи вечные (миграция 0025, partial unique). Фикс: scope `find_by_idempotency_key`
  по user_id.
- **B-15** `app/infrastructure/workers/send.py:435-443`: при остатке подписки <24 ч
  `(until-now).days == 0` → ветка `days_left <= 0` → даунгрейд и «подписка закончилась»
  за полдня до фактического конца. Фикс: сравнивать `until <= now`.
- **B-16** `app/infrastructure/db/repositories/market_lots.py:198-220`
  (`has_recent_market_lots` по `first_seen_at` без фильтра статуса): созданный и
  брошенный **черновик** запускает 30-дневный кулдаун бесплатного периода — первый
  «настоящий» лот уже не получит free-неделю. Возможно намеренно («ротация снять/создать»),
  но черновики в комментарии не упомянуты — помечаю как гипотезу.
- **B-17** `app/infrastructure/db/repositories/listings_read.py:374-387` (by-url),
  `:449-495` (similar), `:304-368` (facets): фильтр только `is_active`, а
  `market_placement_expiry` оставляет expired-лотам `is_active=True` (10 §1).
  Итог: карточка приходит по URL/в «похожих», клик на PDP (`get_active`: status==accepted)
  даёт 404. Мелкий UX-разрыв.
- **B-18** миграции: `downgrade()` 0031 (`drop_column country/city`) и 0030
  (pending_patch/moderation_payload) без сохранения данных — на проде с данными
  откат необратимо теряет пользовательские country/city и модерационные артефакты.
  Бэкфилл идемпотентны, цепочка 0029→0030→0031 сшита корректно (down_revision
  проверены), `WHERE country IS NULL` защищает повторный прогон.

---

## Проверено — чисто

- **claim лида (одиночный):** `claim_lead_row` — условный `UPDATE … WHERE partner_id
  IS NULL RETURNING` + корректная классификация not_found/already_yours/taken
  (`services/partners/repository.py:235-262`); batch — `FOR UPDATE SKIP LOCKED` +
  повторный условный UPDATE (`:264-297`). Атомарно.
- **mark_paid:** условный `UPDATE … WHERE status != 'paid'` + rowcount, идемпотентность
  ретрая вебхука (ранний return по `record.status == 'paid'`) — корректно для обоих kind
  (`db/repositories/payments.py:154-190`, `use_cases.py:190-198,258-263`).
- **Пакеты слотов:** `purchase_placement_package` — guarded UPDATE + partner_tx одной
  транзакцией; `consume_placement_slot` — условный инкремент (`market_lots.py:565-614`).
- **Placement-решения:** advisory-lock `pg_advisory_xact_lock(9106, user_id)`
  сериализует Create/Submit/ModerateLot.approve — двойной клик не даёт два free-периода
  (`market_lots.py:171-177`). (Не покрывает только placement-вебхук — B-07.)
- **Keyset-пагинация:** `cursor` разрешён только с `sort=new`
  (`application/listings/use_cases.py:103-104`) — рассинхрона keyset с сортировкой
  по цене нет; `has_more` через limit+1 — корректно, включая границу.
- **Фасеты v2:** кэш-ключ включает `country` (`routers/listings.py:178-183`),
  `countries`-фасет — по `is_active`, порядок по частоте; 5-минутный TTL для
  «страна появится после первого лота» — приемлемо. Пересечение `country` + `source=market`
  — owner_type IS NOT NULL + upper(country) — работает.
- **Upsert листингов:** `first_seen_at` не сбрасывается, `disappeared_at=NULL` при
  реактивации, `COALESCE(EXCLUDED.country, listings.country)` не затирает бэкфилл 0031,
  спеки не перетираются пустыми (`listings_writer.py:75-102`).
- **Circuit breaker:** один 403 kolesa НЕ открывает CB — нужен streak ≥ 5
  (`source_cb_error_streak`), cooldown 10 минут, восстановление алертится
  (`services/source_health.py`, `domain/sources/health.py`).
- **raw_retention_job:** ключи raw содержат yyyy/mm парсинга, удаляются только объекты
  старше retention, `raw_key` обнуляется точным совпадением ключей — незаобогащённые
  сырые данные не задеваются (`workers/fetch.py:308-333`).
- **Cron/interval:** все расписания в UTC, `datetime.now(timezone.utc)` и в
  `schedule_fetch_due`, и в `_cron_loop`; Redis-локи `cron:{job}:{минута}` /
  `interval:{name}:{slot}` защищают от дублей между репликами воркеров
  (`messaging/legacy_worker.py:305-385`).
- **Калькулятор, возрастные границы:** `<3` / `3–5 (<=5)` / `>5` лет — соответствует
  brackets ЕТТ ЕАЭС; льгота утильсбора — `<=160 л.с.` и `<=3000 см³` включительно,
  при неуказанной мощности — льготный с оговоркой (delivery.py:199-214).
  float vs Decimal: расчёт в float с округлением на выводе — для MVP-оценки допустимо,
  искажений границ не нашёл.
- **AI-квота суток:** ключ `ai_quota:{uid}:{YYYYMMDD}` UTC + TTL при создании — окно
  не растягивается; компенсация при падении поиска есть (agent.py:292-302).
- **Анализы free 1/нед:** скользящее окно 7 дней от текущего момента
  (`analysis/use_cases.py:163-167`) — «1/нед» выполняется (следующий доступ через 7д
  после предыдущего), расхождения с контрактом нет.
- **UoW/сессии:** `SqlAlchemyUnitOfWork.__aexit__`/`SessionUnitOfWork`/`get_session`
  делают rollback в exception-путях; savepoints для inspection-upsert
  (`begin_nested`) не роняют сохранение объявлений.
- **Чат/говернанс:** операции только group-тредов, роли проверяются, archived →
  read-only в SendMessage (`thread.status != 'active'`).
- **Миграции:** 0031 бэкфилл идемпотентен; 0030 backfill (внешние → accepted,
  живые owner → accepted, остальные → draft) корректен под CHECK; цепочка
  0029→0030→0031 без развилок.

## Метод проверки

Статическое чтение перечисленных файлов + точечные запуски:
- `hasattr(SqlAlchemyPaymentRepository, 'rollback')` → False (порт `PaymentRepository`
  метода тоже не содержит) — B-02 подтверждена запуском;
- `pytest tests/infrastructure/test_dedup.py` — 13 passed: семантика
  claim/is_duplicate (повторный claim того же лота → True) подтверждена прогоном;
  `tests/infrastructure/test_fetch.py:247-255` закрепляет drop повторного фетча (B-04).
БД-тесты с тестовой Postgres не поднимались — БД в окружении недоступна без Docker
(запрещён заданием); выводы по SQL-путям основаны на коде и покрытии тестов.
