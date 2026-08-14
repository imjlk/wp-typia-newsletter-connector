# WPTypia Email Service Provider Connector for Newspack Newsletters with Listmonk Setup

This guide is for beta validation on a staging WordPress site.

## Requirements

- WordPress 6.7 or later.
- PHP 8.0 or later.
- Newspack Newsletters installed and active.
- The broader Newspack platform plugin is optional for this MVP; this connector
  depends on Newspack Newsletters provider APIs.
- A reachable Listmonk server.
- The beta zip built with `pnpm run release:zip`.

Review [PRIVACY.md](PRIVACY.md) before connecting production subscriber data.
Uninstall deletes local Listmonk credential settings and connector sync-error
transients, but it does not delete remote Listmonk data or newsletter post meta.

## Listmonk API User

Create a Listmonk API user for the connector instead of reusing an administrator
login.

Minimum MVP permissions:

- `lists:get_all`
- `campaigns:manage`
- `campaigns:send`
- `campaigns:get_analytics`
- `subscribers:get`
- `subscribers:manage`
- `bounces:get`

Keep `subscribers:sql_query` disabled. The connector only uses subscriber list
fetch, local exact email matching, subscriber create/update, and list membership
APIs.

The connector API user does not need `webhooks:post_bounce`. That permission is
for posting bounce notifications into Listmonk's inbound webhook endpoint, not
for WordPress-to-Listmonk campaign sync or subscriber reflection.

## Bounce And Webhook Policy

Configure bounce and complaint processing in Listmonk for the staging mail
provider. Supported SMTP provider webhooks should point at Listmonk's
`/webhooks/service/*` endpoints, and custom processors can post to Listmonk's
`/webhooks/bounce` endpoint.

The connector does not expose a public WordPress webhook receiver. It reads
subscriber `blocklisted` state, bounce records, and campaign bounce analytics
from Listmonk after Listmonk has processed those events. See
`docs/WEBHOOK-POLICY.md` for the full policy.

## Double Opt-In Policy

The connector preserves Listmonk's double opt-in behavior by default.

- New subscribers are created with `preconfirm_subscriptions: false`.
- Existing subscribers added to a list use membership `status: unconfirmed`.
- The connector does not automatically call Listmonk's opt-in confirmation API.

Sites that intentionally want to bypass Listmonk confirmation can opt in with
PHP filters:

```php
add_filter( 'newspack_listmonk_connector_preconfirm_subscriptions', '__return_true' );
add_filter( 'newspack_listmonk_connector_subscriber_list_add_status', fn() => 'confirmed' );
```

Use those filters only when the upstream signup flow has already captured the
required consent.

## Install The Plugin

1. In WordPress admin, install and activate Newspack Newsletters.
2. Upload `artifacts/wp-typia-newsletter-connector-<version>.zip`.
3. Activate WPTypia Email Service Provider Connector for Newspack Newsletters with Listmonk.
4. Open Settings > Newsletter Connector.
5. Enter:
   - Listmonk API URL over HTTPS, for example `https://listmonk.example.com`.
     Plain HTTP is allowed only when WordPress runs in a local or development environment.
   - API user
   - API token
   - Default From email, for example `Newsroom <news@example.com>`
   - Default template ID, or `0` to use raw campaign HTML without forcing a template
   - Default list IDs as comma-separated numeric IDs
6. Click Save and test connection.

## Unsubscribe And Tracking Placeholders

Listmonk exposes `{{ UnsubscribeURL }}` for unsubscribe and manage-preferences
links. When Default template ID is `0`, the connector appends a minimal footer
with this placeholder to raw campaign HTML if the newsletter body does not
already include it.

When a Default template ID or newsletter template ID is configured, the
connector assumes the Listmonk campaign template owns the footer. Add
`{{ UnsubscribeURL }}` to that Listmonk template footer before staging sends.
The connector does not inject `{{ TrackView }}`; tracking pixel placement should
remain a Listmonk template decision.

The Newspack editor panel shows helper rows for the two MVP placeholders:
`{{ UnsubscribeURL }}` and `{{ TrackView }}`. Both placeholders are preserved by
the HTML cleanup pass if they appear in the newsletter body or Listmonk template
content.

Credentials may also be supplied through constants:

```php
define( 'NEWSPACK_LISTMONK_CONNECTOR_BASE_URL', 'https://listmonk.example.com' );
define( 'NEWSPACK_LISTMONK_CONNECTOR_API_USER', 'api_user' );
define( 'NEWSPACK_LISTMONK_CONNECTOR_API_TOKEN', 'token' );
```

## Select The Newspack Provider

Set `listmonk` as the active Newspack Newsletters service provider. If the site
does not expose a provider selector in admin, use WP-CLI:

```bash
wp option update newspack_newsletters_service_provider listmonk
```

## Smoke Check

1. Create a draft Newspack newsletter.
2. Open the editor document settings sidebar.
3. Confirm the Listmonk panel appears.
4. Select a Listmonk list.
5. Confirm raw HTML preview and payload preview render.
6. Click Sync to Listmonk and confirm a campaign ID appears.
7. In Listmonk admin, confirm the campaign is still `draft`.
8. Click Send test and confirm the editor shows a success notice.
9. Publish a low-risk staging newsletter and confirm Listmonk status becomes `running`.
10. Schedule a separate staging newsletter and confirm Listmonk status becomes `scheduled`.

For local automated checks, see `docs/INTEGRATION-TESTING.md` in the source
repository.
