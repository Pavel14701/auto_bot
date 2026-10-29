"""Маскировка контактов (08 §3): чистая функция mask_contacts.

Unit-тесты без БД: телефоны (плюс/8-префикс, >=9 цифр, разделители),
мессенджер-ссылки (wa.me / whatsapp / t.me) и исключения — наш бот
(ftadasd_bot), t.me/share, VIN, 8-значные коды, наши домены.
"""

from __future__ import annotations

from app.application.chat.privacy import (
    MESSENGER_MASK,
    PHONE_MASK,
    mask_contacts,
)

BOT = "ftadasd_bot"


def _masked_phone(body: str) -> str:
    """Тело после маскировки телефона."""
    return mask_contacts(body, BOT)


def test_phone_with_plus_and_separators_masked():
    """`+7 999 123-45-67` — плейсхолдер вместо номера."""
    assert _masked_phone("+7 999 123-45-67") == PHONE_MASK


def test_phone_8_prefix_masked():
    """`88005553535` (8-префикс, 11 цифр) — маскируется."""
    assert _masked_phone("88005553535") == PHONE_MASK


def test_phone_korean_format_masked():
    """`+82-10-1234-5678` — дефисы внутри номера не мешают."""
    assert _masked_phone("+82-10-1234-5678") == PHONE_MASK


def test_phone_with_parentheses_masked():
    """`+375 (29) 123-45-67` — скобки допускаются как разделители."""
    assert _masked_phone("+375 (29) 123-45-67") == PHONE_MASK


def test_vin_not_masked():
    """VIN (буквы) не подходит под телефонный паттерн (08 §9)."""
    assert _masked_phone("vin WBA12345678901234") == "vin WBA12345678901234"


def test_eight_digit_code_not_masked():
    """8-значный код без +/8-префикса и с <9 цифрами — не номер."""
    assert _masked_phone("код 12345678") == "код 12345678"
    # 8 в начале, но цифр меньше девяти — тоже не номер.
    assert _masked_phone("код 87654321") == "код 87654321"


def test_phone_in_middle_of_text_masked():
    """Номер в середине текста маскируется, текст вокруг остаётся."""
    masked = _masked_phone("Звоните вечером на +7 999 123-45-67, обсудим")
    assert masked.startswith("Звоните вечером на ")
    assert masked.endswith(", обсудим")
    assert PHONE_MASK in masked
    assert "999" not in masked


def test_two_phones_in_one_message_both_masked():
    """Два номера одним сообщением — оба заменены."""
    masked = _masked_phone(
        "Мой +7 999 123-45-67, брата 88005553535"
    )
    assert masked.count(PHONE_MASK) == 2
    assert "999" not in masked and "5553535" not in masked


def test_wa_me_link_masked():
    """wa.me/... — внешний мессенджер."""
    assert _masked_phone("wa.me/79161234567") == MESSENGER_MASK


def test_whatsapp_api_and_web_masked():
    """api.whatsapp.com и web.whatsapp.com — маскируются (схемой и без)."""
    assert _masked_phone("https://api.whatsapp.com/send?phone=1") == (
        MESSENGER_MASK
    )
    assert _masked_phone("пишите web.whatsapp.com") == (
        f"пишите {MESSENGER_MASK}"
    )


def test_tme_foreign_username_masked():
    """t.me/<чужой username> — маскируется целиком."""
    assert _masked_phone("t.me/autobot_korea") == MESSENGER_MASK
    assert _masked_phone("https://t.me/autobot_korea") == MESSENGER_MASK


def test_tme_our_bot_not_masked():
    """t.me/<наш бот> (BOT_USERNAME) — не маскируется."""
    assert _masked_phone("t.me/ftadasd_bot") == "t.me/ftadasd_bot"
    assert _masked_phone("https://t.me/ftadasd_bot?start=chat") == (
        "https://t.me/ftadasd_bot?start=chat"
    )


def test_tme_share_not_masked():
    """t.me/share/url?... — шаринг нашей карточки, не мессенджер."""
    body = "https://t.me/share/url?url=https://autobot.example/lot/1"
    assert _masked_phone(body) == body


def test_encar_kcar_localhost_not_masked():
    """Наши/аукционные домены и localhost не трогаем (08 §3)."""
    body = (
        "лот: https://fem.encar.com/cars/12345 и "
        "https://kcar.com/used/9, локально http://localhost:8080/lot/3"
    )
    assert _masked_phone(body) == body


def test_empty_bot_username_masks_all_tme():
    """Пустой конфиг бота — маскируем все t.me (безопаснее, 08 §9)."""
    assert mask_contacts("t.me/anybody", "") == MESSENGER_MASK
    # share всё равно не трогаем — это наш формат шаринга.
    assert mask_contacts("t.me/share/url?url=x", "") == "t.me/share/url?url=x"


def test_masked_body_then_validation_order():
    """Маскировка не ломает текст без контактов (no-op)."""
    assert _masked_phone("Обычное сообщение без контактов") == (
        "Обычное сообщение без контактов"
    )


# ---------- PRIV-01 (аудит 2026-10-29): голые номера и email ----------


def test_bare_phone_without_plus_masked():
    """Телефон без +/8 (>=10 цифр) маскируется — обход «без плюса» закрыт."""
    assert mask_contacts("звони 9991234567 сейчас", "bot") == (
        "звони " + PHONE_MASK + " сейчас"
    )
    # с разделителями внутри
    assert "скрыт" in mask_contacts("9 999 123 45 67", "bot")


def test_email_masked():
    """Email маскируется (обмен почтой — только через сделку)."""
    assert mask_contacts("пиши ivan.ivanov@gmail.com", "bot").endswith(PHONE_MASK)


def test_vin_and_codes_not_masked():
    """VIN/модели/годы не задеваются новым BARE_PHONE_RE."""
    for keep in ("VIN WVWZZZ1KZAW123456", "модель 520i, 2022", "объём 2.5 л"):
        assert mask_contacts(keep, "bot") == keep


def test_wa_me_with_phone_single_mask():
    """wa.me/<номер> — одна маска мессенджера, телефон не дублируется."""
    assert mask_contacts("wa.me/79161234567", "bot") == MESSENGER_MASK
