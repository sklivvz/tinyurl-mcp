# TinyURL MCP

A local stdio [Model Context Protocol](https://modelcontextprotocol.io/) server
for managing individual [TinyURL](https://tinyurl.com/) aliases through the
authenticated TinyURL API. It supports exact-alias link creation and changes,
archive and expiration controls, analytics reports and settings, raw analytics
logs, and bounded typed bulk operations.

It requires Node.js 20 or newer and has **zero runtime dependencies**. All calls
use the fixed `tinyurl.com` domain and the fixed `https://api.tinyurl.com` API
origin; callers cannot supply an arbitrary host, path, or endpoint.

## Requirements

- Node.js 20 or newer.
- A TinyURL API token with the permissions needed for the tools you enable.
- A private directory for the configuration, token, and server state.

## Setup

From a checkout, no dependency installation is required:

```sh
npm test
```

The tests use Node's built-in test runner and provider mocks; they do not need a
TinyURL token.

### 1. Create private files

Use real absolute paths in place of the `/path/to/...` placeholders. The token
file must be a regular file with mode `0600`. The state directory and its
immediate parent must be real directories with mode `0700`.

```sh
mkdir -p /path/to/private/tinyurl-state
chmod 700 /path/to/private /path/to/private/tinyurl-state

printf '%s\n' '<your-tinyurl-api-token>' > /path/to/private/tinyurl-api-token
chmod 600 /path/to/private/tinyurl-api-token

cp config.example.json /path/to/private/tinyurl-config.json
chmod 600 /path/to/private/tinyurl-config.json
$EDITOR /path/to/private/tinyurl-config.json
```

The token file may contain a raw token or JSON using either `token` or
`apiToken`:

```json
{ "token": "<your-tinyurl-api-token>" }
```

### 2. Configure the server

`config.example.json` uses placeholders only:

```json
{
  "tokenFile": "/path/to/private/tinyurl-api-token",
  "stateDir": "/path/to/private/tinyurl-state",
  "timeoutMs": 4000
}
```

| Field | Required | Description |
| --- | --- | --- |
| `tokenFile` | Yes | Absolute path to the private token file. The file must be a regular, non-symlink file with mode `0600`. |
| `stateDir` | Yes | Absolute path to the private state directory. It must be a real, non-symlink directory with mode `0700`; its immediate parent must also be `0700`. |
| `timeoutMs` | No | API request timeout from `100` to `4000` milliseconds. Defaults to `4000`. |

The config file itself must be a regular, non-symlink file with mode `0600`,
no larger than 64 KiB, and its path must be absolute. Do not commit the config
file, token file, or state directory.

### 3. Token permissions

TinyURL applies permissions to API tokens. The server uses one token, so grant
the permissions required by the tools you expose. The tools declare these
TinyURL token permissions:

| TinyURL token permission | Tools |
| --- | --- |
| `Create TinyURL` | `tinyurl_create` |
| No separate scope shown by TinyURL | `tinyurl_read` |
| `Update TinyURL` | `tinyurl_update` |
| `Change URL` | `tinyurl_change_destination` |
| `Manage TinyURL Expiration` | Expiration fields in `tinyurl_create`, `tinyurl_update` and `tinyurl_set_expiration` |
| `Delete TinyURL` | `tinyurl_delete` |
| `Archive TinyURL` | `tinyurl_archive` |
| `Use Analytics` | `tinyurl_analytics_report`, `tinyurl_analytics_status`, `tinyurl_analytics_sharing` |
| `Raw Analytics Logs` | `tinyurl_analytics_raw_logs` |
| `Use Bulk Requests` | `tinyurl_bulk_create`, `tinyurl_bulk_status`, `tinyurl_bulk_report` |
| None required | `tinyurl_status` |

`tinyurl_status` checks only whether the token file and state directory appear
usable. It does not enumerate or validate token scopes. A token that lacks a
required permission is rejected by TinyURL when the relevant tool runs,
typically as an `api_rejected` error. Use least privilege and grant only the
permissions needed by the tool set you intend to use.

### 4. Register with an MCP client

Set `TINYURL_CONFIG_FILE` to the absolute path of the private config file. Use
Node.js 20 or newer to launch the server:

```json
{
  "mcpServers": {
    "tinyurl": {
      "command": "node",
      "args": ["/path/to/tinyurl-mcp/main.mjs"],
      "env": {
        "TINYURL_CONFIG_FILE": "/path/to/private/tinyurl-config.json"
      }
    }
  }
}
```

The server communicates over stdin/stdout using MCP JSON-RPC. It is intended to
be launched by an MCP client; running it directly starts a silent server that
waits for protocol messages:

```sh
TINYURL_CONFIG_FILE=/path/to/private/tinyurl-config.json npm start
```

## Tools

Every call is restricted to the fixed API origin. Link tools address one exact
`tinyurl.com` alias; the optional `domain` field, where accepted, may only be
`tinyurl.com`. Analytics reports are selected from a fixed set, and analytics
date ranges, pages, and bulk IDs are validated.

### Link management

| Tool | Access | Purpose |
| --- | --- | --- |
| `tinyurl_create` | Write | Creates one short link for an exact URL, with an optional alias and expiration. A verified prior result may be reused for the same exact operation. |
| `tinyurl_read` | Read-only | Reads one exact alias and returns its destination and available metadata. |
| `tinyurl_update` | Write | Updates metadata or renames one exact alias. It cannot change the destination. |
| `tinyurl_change_destination` | Write | Changes the destination of one exact alias, redirecting existing traffic to the new URL. |
| `tinyurl_delete` | Destructive write | Permanently deletes one exact alias. |
| `tinyurl_archive` | Write | Toggles, archives, or unarchives one exact alias and verifies the resulting archive state. |
| `tinyurl_set_expiration` | Write | Sets or clears the expiration of one exact alias. |

### Analytics

| Tool | Access | Purpose |
| --- | --- | --- |
| `tinyurl_analytics_report` | Read-only | Reads one fixed analytics report: `timeline`, `general`, `weekday`, `hour`, `top_sources`, `top_languages`, or `location`. |
| `tinyurl_analytics_raw_logs` | Read-only, sensitive | Reads a bounded page of raw analytics JSON over a date range. |
| `tinyurl_analytics_status` | Write | Enables or disables analytics collection for one exact alias. |
| `tinyurl_analytics_sharing` | Write, privacy-sensitive | Enables or disables public analytics sharing for one exact alias. |

### Bulk operations

| Tool | Access | Purpose |
| --- | --- | --- |
| `tinyurl_bulk_create` | Bulk write | Submits 1-100 typed `create`, `update`, `change`, `delete`, `archive`, or `unarchive` items. A batch can include destructive items. |
| `tinyurl_bulk_status` | Read-only | Reads the status of one bulk request. |
| `tinyurl_bulk_report` | Read-only | Reads a bounded page of one bulk request report. |

### Server status

| Tool | Access | Purpose |
| --- | --- | --- |
| `tinyurl_status` | Read-only | Checks whether the configuration, token, and state directory appear usable. Does not call TinyURL or write state. |

### Inputs

- `tinyurl_create` requires `url` and accepts optional `alias` and `expires_at`.
  `expires_at` is an ISO 8601 date-time or duration accepted by TinyURL, or
  `null` for no expiration.
- `tinyurl_read` requires `alias`.
- `tinyurl_update` requires `alias` and at least one of `new_alias`,
  `new_stats`, `new_tags`, `new_expires_at`, or `new_description`.
- `tinyurl_change_destination` requires `alias` and `url`.
- `tinyurl_delete` requires `alias`.
- `tinyurl_archive` requires `alias` and `action` (`toggle`, `archive`, or
  `unarchive`). `toggle` always performs one toggle; `archive` and `unarchive`
  read the current state first and skip a no-op write.
- `tinyurl_set_expiration` requires `alias` and `new_expires_at` (an ISO 8601
  date-time/duration, or `null` to clear the expiration).
- `tinyurl_analytics_report` requires `report` and `from`. Optional filters are
  `to`, `alias`, `tag`, and `domain`. `interval` is valid only for `timeline`
  and accepts `minute`, `hour`, `day`, `week`, or `month`. `region` is valid
  only for `location` and accepts `world` or a two-letter country code.
- `tinyurl_analytics_raw_logs` requires `from` and accepts optional `to`,
  `alias`, `tag`, `domain`, `offset` (0-50000), and `limit` (1-1000, default
  100). The report returns `total`, `returned`, `hasMore`, and `nextOffset`.
- `tinyurl_analytics_status` requires `alias` and boolean `enabled`.
- `tinyurl_analytics_sharing` requires `alias` and boolean `public`.
- `tinyurl_bulk_create` requires between 1 and 100 items. `create` requires
  `url`; `update` requires `alias` and at least one `new_*` change; `change`
  requires `alias` and `url`; `delete`, `archive`, and `unarchive` require
  `alias`. Items may include up to 20 primitive `metadata` values.
- `tinyurl_bulk_status` requires a positive integer `bulkRequestId`.
- `tinyurl_bulk_report` requires a positive integer `bulkRequestId` and accepts
  `offset` (0-100000) and `limit` (1-500, default 100).
- `tinyurl_status` takes no arguments.

## Examples

Placeholder values only. Replace them with the exact values you intend to use.

Create an alias with an optional expiration:

```json
{
  "url": "https://example.com/page",
  "alias": "example-alias",
  "expires_at": "2030-01-01T00:00:00Z"
}
```

Read an alias:

```json
{ "alias": "example-alias" }
```

Update metadata without changing the destination:

```json
{
  "alias": "example-alias",
  "new_description": "Example description",
  "new_tags": ["example-tag"]
}
```

Change the destination of an existing alias:

```json
{
  "alias": "example-alias",
  "url": "https://example.com/new-page"
}
```

Archive an alias:

```json
{
  "alias": "example-alias",
  "action": "archive"
}
```

Set an expiration, or use `null` to clear it:

```json
{
  "alias": "example-alias",
  "new_expires_at": "2030-01-01T00:00:00Z"
}
```

Read a timeline analytics report:

```json
{
  "report": "timeline",
  "from": "2026-01-01",
  "to": "2026-01-31",
  "interval": "day",
  "alias": "example-alias"
}
```

Read a page of raw analytics logs:

```json
{
  "from": "2026-01-01",
  "to": "2026-01-31",
  "alias": "example-alias",
  "offset": 0,
  "limit": 100
}
```

Enable analytics collection and disable public sharing:

```json
{ "alias": "example-alias", "enabled": true }
```

```json
{ "alias": "example-alias", "public": false }
```

Submit a bulk batch:

```json
{
  "items": [
    {
      "operation": "create",
      "url": "https://example.com/one",
      "alias": "example-one"
    },
    {
      "operation": "archive",
      "alias": "example-two"
    }
  ]
}
```

Read bulk status and a report page:

```json
{ "bulkRequestId": 12345 }
```

```json
{ "bulkRequestId": 12345, "offset": 0, "limit": 100 }
```

Delete an alias permanently:

```json
{ "alias": "example-alias" }
```

## Safety

Writes affect live TinyURL state. There is no dry-run mode.

- **Confirm before every write.** Check the exact alias, URLs, expiration
  value, analytics flags, and every bulk item before calling a write tool. MCP
  clients should ask the user for explicit confirmation, with extra scrutiny
  for deletion, destination changes, expiration changes, public analytics, and
  bulk batches.
- **Deletion is permanent.** `tinyurl_delete` and `delete` items inside
  `tinyurl_bulk_create` remove short links and cannot be undone. Do not call
  them on production aliases without confirmation.
- **Bulk batches can combine destructive operations.** A single
  `tinyurl_bulk_create` call may contain up to 100 changes, including
  `change`, `delete`, and `archive` items. Review the entire batch before
  submission.
- **Destination changes redirect live traffic.** `tinyurl_change_destination`
  and `change` bulk items are security-sensitive. Verify the new URL before
  applying them.
- **Archive and expiration change link availability.** Confirm the intended
  archive action and expiration. Use `null` only when the link should never
  expire.
- **Analytics sharing can expose data.** `tinyurl_analytics_sharing` with
  `public: true` makes analytics publicly accessible. Review whether that is
  appropriate before changing it.
- **Raw analytics logs are sensitive.** `tinyurl_analytics_raw_logs` can return
  IP addresses, referrers, devices, languages, countries, browser/OS data, and
  URLs. This is read-only data, but it should be handled as sensitive personal
  data and kept out of logs and source control.
- **Ambiguous writes are not retried automatically.** On a timeout, network
  failure, server error, or unreadable provider response, a write may have been
  applied. The server reports `write_outcome_unknown` and leaves a private
  pending marker for the affected alias. Do not retry blindly or clear the
  state directory. Reconcile the exact alias first, then follow the reported
  next action.
- **Bulk ambiguity blocks further bulk submissions.** A bulk submission is
  serialized and checkpointed before it is sent. If its outcome is unknown, a
  private bulk barrier blocks all later bulk submissions until an operator
  reconciles the batch. An exact repeat of a verified submission returns the
  stored `bulkRequestId`; do not submit a modified batch as a retry.
- **Preserve the state directory.** It contains durable operation receipts,
  alias locks, bulk receipts, and mutation-outcome markers. Losing or editing it
  can make a retry unsafe.
- **Fixed access boundary.** The server does not accept a caller-supplied host,
  path, API endpoint, or analytics endpoint. Reports are selected from a fixed
  set, aliases and bulk IDs are validated, and there is no anonymous fallback.
  Destinations must be absolute `http` or `https` URLs.
- **Protect the token and use least privilege.** The token is read from the
  private token file and is sent only as a bearer credential to
  `https://api.tinyurl.com`. Grant only the scopes needed for the tools you
  expose, and keep the token out of environment variables, command lines, logs,
  and source control.
- **File modes are not a complete security boundary.** Processes running as the
  same OS user may still access private files. Restrict host access, mount the
  configuration read-only where possible, or run the server under a separate
  identity.

## Development

```sh
npm test
```

The implementation is plain ESM using Node.js built-in modules. There is no
build step and no dependency installation step.

## License

[MIT](LICENSE) © 2026 Marco Cecconi
