"""RAG HTTP API — синхронный REST-фасад над query-RPC очередью.

POST /api/v1/ask  {question, context?}  (Bearer/X-API-Token — общий секрет)
→ минтует короткоживущий JWT (sub=SERVICE_USER_ID, groups=SERVICE_GROUPS)
→ публикует RPC в query_queue (reply_to на exclusive-очередь)
→ ждёт ответ QueryConsumer (таймаут ASK_TIMEOUT_SEC)
→ маппит в контракт auto_bot: {answer, sources[], confidence, latency_ms}.

Аутентификация fail-closed (INFRA-03, аудит 2026-10-29): пустой
API_TOKEN = отказ всем (раньше пустой токен открывал ask/ingest
анонимно), сравнение timing-safe через hmac.compare_digest.

GET /health — liveness (+ статус соединения с брокером).

Конфиг (env): API_TOKEN, RABBITMQ_URL, JWT_SECRET, JWT_ALGORITHM,
SERVICE_USER_ID, SERVICE_GROUPS, ASK_TIMEOUT_SEC, PORT.
"""

import asyncio
import hmac
import os
import time
import uuid
from typing import Any

import aio_pika
import jwt
import orjson
import structlog
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

logger = structlog.get_logger(__name__)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    context: dict[str, Any] = Field(default_factory=dict)


class SourceOut(BaseModel):
    doc_id: str
    chunk_id: str
    score: float
    title: str | None = None
    snippet: str | None = None


class AskResponse(BaseModel):
    answer: str
    sources: list[SourceOut] = Field(default_factory=list)
    confidence: float = 0.0
    latency_ms: int = 0
    cached: bool = False
    conversation_id: str | None = None


def _env(name: str, default: str = '') -> str:
    return os.environ.get(name, default)


API_TOKEN = _env('API_TOKEN')
RABBITMQ_URL = _env('RABBITMQ_URL', 'amqp://guest:guest@localhost:5672/')
QUERY_QUEUE = _env('QUERY_QUEUE', 'query_queue')
JWT_SECRET = _env('JWT_SECRET')
JWT_ALGORITHM = _env('JWT_ALGORITHM', 'HS256')
SERVICE_USER_ID = _env('SERVICE_USER_ID', 'auto_bot')
SERVICE_GROUPS = [g for g in _env('SERVICE_GROUPS', '').split(',') if g.strip()]
ASK_TIMEOUT = float(_env('ASK_TIMEOUT_SEC', '30'))
PORT = int(_env('PORT', '8100'))

app = FastAPI(title='rag-api', version='0.1.0')
_state: dict[str, Any] = {'connection': None, 'channel': None}


async def _publish_default(
    channel: aio_pika.abc.AbstractChannel,
    message: aio_pika.Message,
    routing_key: str,
) -> None:
    """Publish via the default exchange.

    aio-pika >= 10 removed ``Channel.default_exchange``, and RabbitMQ
    refuses even a passive declare of the default exchange. So:
    - RobustChannel (producer side): bare Exchange object with empty name;
    - plain Channel (what ``IncomingMessage.channel`` returns): fall back
      to low-level ``basic_publish`` with pamqp properties.
    """
    if hasattr(channel, 'get_underlay_channel'):  # RobustChannel
        exchange = aio_pika.Exchange(channel, '', type='direct')
        await exchange.publish(message, routing_key=routing_key)
        return
    # message.properties — готовый pamqp Basic.Properties (correlation_id,
    # headers, delivery_mode внутри): передаём как есть, иначе теряется
    # correlation_id и RPC-матчинг ответа ломается.
    await channel.basic_publish(
        body=message.body,
        exchange='',
        routing_key=routing_key,
        properties=message.properties,
    )


async def _ensure_rabbit() -> None:
    if _state['connection'] is not None and not _state['connection'].is_closed:
        return
    _state['connection'] = await aio_pika.connect_robust(RABBITMQ_URL)
    _state['channel'] = await _state['connection'].channel()
    # query_queue объявляет worker; шлюз публикует через default exchange
    logger.info('rabbit_connected')


def _mint_token() -> str:
    now = int(time.time())
    payload = {
        'sub': SERVICE_USER_ID,
        'jti': uuid.uuid4().hex,
        'iat': now,
        'exp': now + int(ASK_TIMEOUT) + 60,
    }
    if SERVICE_GROUPS:
        payload['groups'] = SERVICE_GROUPS
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _map_sources(raw: Any) -> list[SourceOut]:
    out: list[SourceOut] = []
    for s in raw or []:
        if not isinstance(s, dict):
            continue
        out.append(
            SourceOut(
                doc_id=str(s.get('doc_id', s.get('document_id', ''))),
                chunk_id=str(s.get('chunk_id', '')),
                score=float(s.get('score', s.get('rrf_score', 0.0)) or 0.0),
                title=s.get('title'),
                snippet=(s.get('snippet') or s.get('text') or '')[:400] or None,
            )
        )
    return out


@app.post('/api/v1/ask', response_model=AskResponse)
async def ask(
    body: AskRequest,
    authorization: str | None = Header(default=None),
    x_api_token: str | None = Header(default=None),
) -> AskResponse:
    started = time.perf_counter()
    token = None
    if authorization and authorization.startswith('Bearer '):
        token = authorization[7:]
    token = x_api_token or token
    # INFRA-03: fail-closed — пустой API_TOKEN = токен не настроен → отказ
    # всем (раньше «не задан» означало «открыт»); сравнение timing-safe.
    if not API_TOKEN:
        raise HTTPException(status_code=401, detail='API token not configured')
    if not token or not hmac.compare_digest(
        token.encode(), API_TOKEN.encode()
    ):
        raise HTTPException(status_code=401, detail='Invalid API token')

    await _ensure_rabbit()
    channel = _state['channel']

    # exclusive-очередь под этот запрос (RPC reply_to)
    reply_queue = await channel.declare_queue(exclusive=True)
    query_id = uuid.uuid4().hex
    message = aio_pika.Message(
        body=orjson.dumps(
            {
                'token': _mint_token(),
                'query': body.question,
                'query_id': query_id,
                'conversation_id': body.context.get('conversation_id'),
            }
        ),
        reply_to=reply_queue.name,
        correlation_id=query_id,
        delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
    )

    loop = asyncio.get_running_loop()
    future: asyncio.Future[bytes] = loop.create_future()

    async def _on_reply(amqp_message: aio_pika.abc.AbstractIncomingMessage) -> None:
        if not future.done() and amqp_message.correlation_id == query_id:
            future.set_result(amqp_message.body)
        await amqp_message.ack()

    consumer_tag = await reply_queue.consume(_on_reply, no_ack=False)
    try:
        await _publish_default(channel, message, routing_key=QUERY_QUEUE)
        raw = await asyncio.wait_for(future, timeout=ASK_TIMEOUT)
    except asyncio.TimeoutError:
        logger.warning('rpc_timeout', query_id=query_id)
        raise HTTPException(status_code=504, detail='RAG worker timeout') from None
    finally:
        await reply_queue.cancel(consumer_tag)

    reply = orjson.loads(raw)
    if isinstance(reply.get('payload'), dict):
        reply = reply['payload']
    if reply.get('error'):
        raise HTTPException(status_code=502, detail=f"worker error: {reply['error']}")

    sources = _map_sources(reply.get('sources'))
    confidence = 0.9 if sources else 0.3
    return AskResponse(
        answer=str(reply.get('answer', '')),
        sources=sources,
        confidence=confidence,
        latency_ms=int((time.perf_counter() - started) * 1000),
        cached=False,
        conversation_id=reply.get('conversation_id'),
    )


@app.get('/health')
async def health() -> dict[str, Any]:
    connected = _state['connection'] is not None and not _state['connection'].is_closed
    return {'status': 'ok' if connected else 'degraded', 'rabbit': connected}


def main_entry() -> None:
    import uvicorn

    uvicorn.run(app, host='0.0.0.0', port=PORT, log_level='info')


if __name__ == '__main__':
    main_entry()
