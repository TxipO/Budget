# Contract: Inbound Telegram Webhook (`POST /api/webhooks/telegram`)

## Request (from Telegram, per Bot API's webhook update format)

Relevant shape for a voice message (irrelevant fields omitted):

```json
{
  "update_id": 123456789,
  "message": {
    "message_id": 42,
    "from": { "id": 999888777, "first_name": "Паша" },
    "date": 1783500000,
    "voice": {
      "file_id": "AwACAgIAAxkBAAI...",
      "file_unique_id": "AgADbQADq...",
      "duration": 4,
      "mime_type": "audio/ogg",
      "file_size": 12345
    }
  }
}
```

Non-voice messages (text, stickers, etc.) MUST be accepted with a 200 and no-op — this endpoint only acts on `message.voice`, mirroring the Monobank webhook's existing "accept and no-op on anything we don't handle" pattern (there, `hold: true` items; here, any non-voice update).

## Response (to Telegram)

- **200** — always, once the update has been handled (successfully processed, rejected as unlinked-sender, or asked for clarification) or intentionally skipped (non-voice update, duplicate `file_unique_id`). Telegram retries on non-200, so anything we've already handled must not cause a retry storm.
- **No response body required** — Telegram does not act on the webhook response body for this integration style (contrast: it optionally accepts a JSON method call in the body as a lightweight response, but this feature replies to the user via an explicit `sendMessage` call instead, kept separate for clarity).

## Side effect: outbound reply via `sendMessage`

Every processed voice message gets exactly one reply via `POST https://api.telegram.org/bot<TOKEN>/sendMessage` with `chat_id` = the sender's `message.from.id` and `text` = one of:
- Confirmation (FR-010): amount, category, household member name.
- Clarification ask (FR-004/FR-005): what's missing (amount or direction).
- Unlinked-sender message (FR-009): instructions to link via the app first.
- Transcription failure (Edge Cases): asks the sender to try again.

## Authentication / trust boundary

Unlike the Monobank webhook (which trusts a per-user random secret path segment), Telegram's webhook has no equivalent built-in secret in the URL by default. **MUST** set Telegram's `secret_token` parameter when registering the webhook (via `setWebhook`) and verify the `X-Telegram-Bot-Api-Secret-Token` header on every incoming request, rejecting (200, no-op — never reveal *why* via a different status code) anything that doesn't match. This is the equivalent trust mechanism to the Monobank webhook's per-user secret path, adapted to Telegram's actual mechanism (Telegram doesn't support arbitrary per-integration secret path segments the way a hand-rolled webhook URL can).
