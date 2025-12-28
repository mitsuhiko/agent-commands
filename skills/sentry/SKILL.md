---
name: sentry
description: "Fetch and analyze Sentry issues, events, transactions, and logs. Helps agents debug errors, find root causes, and understand what happened at specific times."
---

# Sentry Skill

Access Sentry data via the API for debugging and investigation. Uses auth token from `~/.sentryclirc`.

## Quick Reference

| Task | Command |
|------|---------|
| Find errors on a date | `search-events.js --org X --start 2025-12-23T15:00:00 --level error` |
| List open issues | `list-issues.js --org X --status unresolved` |
| Get issue details | `fetch-issue.js <issue-id-or-url> --latest` |
| Get event details | `fetch-event.js <event-id> --org X --project Y` |
| Search logs | `search-logs.js --org X --project Y "level:error"` |

## Common Debugging Workflows

### "What went wrong at this time?"

Find events around a specific timestamp:

```bash
# Find all events in a 2-hour window
./scripts/search-events.js --org myorg --project backend \
  --start 2025-12-23T15:00:00 --end 2025-12-23T17:00:00

# Filter to just errors
./scripts/search-events.js --org myorg --start 2025-12-23T15:00:00 \
  --level error

# Find a specific transaction type
./scripts/search-events.js --org myorg --start 2025-12-23T15:00:00 \
  --transaction process-incoming-email
```

### "What errors have occurred recently?"

```bash
# List unresolved errors from last 24 hours
./scripts/list-issues.js --org myorg --status unresolved --level error --period 24h

# Find high-frequency issues
./scripts/list-issues.js --org myorg --query "times_seen:>50" --sort freq

# Issues affecting users
./scripts/list-issues.js --org myorg --query "is:unresolved has:user" --sort user
```

### "Get details about a specific issue/event"

```bash
# Get issue with latest stack trace
./scripts/fetch-issue.js 5765604106 --latest
./scripts/fetch-issue.js https://sentry.io/organizations/myorg/issues/123/ --latest
./scripts/fetch-issue.js MYPROJ-123 --org myorg --latest

# Get specific event with all breadcrumbs
./scripts/fetch-event.js abc123def456 --org myorg --project backend --breadcrumbs
```

### "Find events with a specific tag"

```bash
# Find by custom tag (e.g., thread_id, user_id)
./scripts/search-events.js --org myorg --tag thread_id:th_abc123

# Find by user email
./scripts/search-events.js --org myorg --query "user.email:*@example.com"
```

---

## Fetch Issue

```bash
./scripts/fetch-issue.js <issue-id-or-url> [options]
```

Get details about a specific issue (grouped error).

**Accepts:**
- Issue ID: `5765604106`
- Issue URL: `https://sentry.io/organizations/sentry/issues/5765604106/`
- New URL format: `https://myorg.sentry.io/issues/5765604106/`
- Short ID: `JAVASCRIPT-ABC` (requires `--org` flag)

**Options:**
- `--latest` - Include the latest event with full stack trace
- `--org <org>` - Organization slug (for short IDs)
- `--json` - Output raw JSON

**Output includes:**
- Title, culprit, status, level
- First/last seen timestamps
- Event count and user impact
- Tags and environment info
- With `--latest`: stack trace, request details, breadcrumbs, runtime context

---

## Fetch Event

```bash
./scripts/fetch-event.js <event-id> --org <org> --project <project> [options]
```

Get full details of a specific event by its ID.

**Options:**
- `--org, -o <org>` - Organization slug (required)
- `--project, -p <project>` - Project slug (required)
- `--breadcrumbs, -b` - Show all breadcrumbs (default: last 30)
- `--spans` - Show span tree for transactions
- `--json` - Output raw JSON

**Output includes:**
- Timestamp, project, title, message
- All tags
- Context (runtime, browser, OS, trace info)
- Request details
- Exception with stack trace
- Breadcrumbs
- Spans (with `--spans`)

---

## Search Events

```bash
./scripts/search-events.js [options]
```

Search for events (transactions, errors) using Sentry Discover.

**Time Range Options:**
- `--period, -t <period>` - Relative time (24h, 7d, 14d)
- `--start <datetime>` - Start time (ISO 8601: 2025-12-23T15:00:00)
- `--end <datetime>` - End time (ISO 8601)

**Filter Options:**
- `--org, -o <org>` - Organization slug (required)
- `--project, -p <project>` - Project slug or ID
- `--query, -q <query>` - Discover search query
- `--transaction <name>` - Transaction name filter
- `--tag <key:value>` - Tag filter (repeatable)
- `--level <level>` - Level filter (error, warning, info)
- `--limit, -n <n>` - Max results (default: 25, max: 100)
- `--fields <fields>` - Comma-separated fields to include

**Query Syntax:**
```
transaction:process-*     Wildcard transaction match
level:error               Filter by level
user.email:foo@bar.com    Filter by user
environment:production    Filter by environment
has:stack.filename        Has stack trace
```

---

## List Issues

```bash
./scripts/list-issues.js [options]
```

List and search issues (grouped errors) in a project.

**Options:**
- `--org, -o <org>` - Organization slug (required)
- `--project, -p <project>` - Project slug (repeatable)
- `--query, -q <query>` - Issue search query
- `--status <status>` - unresolved, resolved, ignored
- `--level <level>` - error, warning, info, fatal
- `--period, -t <period>` - Time period (default: 14d)
- `--limit, -n <n>` - Max results (default: 25)
- `--sort <sort>` - date, new, priority, freq, user
- `--json` - Output raw JSON

**Query Syntax:**
```
is:unresolved             Status filter
is:assigned               Has assignee
assigned:me               Assigned to current user
level:error               Level filter
firstSeen:+7d             First seen > 7 days ago
lastSeen:-24h             Last seen within 24h
times_seen:>100           Event count filter
has:user                  Has user context
error.handled:0           Unhandled errors only
```

---

## Search Logs

```bash
./scripts/search-logs.js [query|url] [options]
```

Search for logs in Sentry's Logs Explorer.

**Options:**
- `--org, -o <org>` - Organization slug (required unless URL provided)
- `--project, -p <project>` - Filter by project slug or ID
- `--period, -t <period>` - Time period (default: 24h)
- `--limit, -n <n>` - Max results (default: 100, max: 1000)
- `--json` - Output raw JSON

**Query Syntax:**
```
level:error              Filter by level (trace, debug, info, warn, error, fatal)
message:*timeout*        Search message text with wildcards
trace:abc123             Filter by trace ID
project:my-project       Filter by project slug
```

**Accepts Sentry URLs:**
```bash
./scripts/search-logs.js "https://myorg.sentry.io/explore/logs/?project=123&statsPeriod=7d"
```

---

## Tips for Debugging

1. **Start broad, then narrow down**: Use `search-events.js` with a time range first, then drill into specific events

2. **Use breadcrumbs**: The `--breadcrumbs` flag on `fetch-event.js` shows the full history of what happened before an error

3. **Look for patterns**: Use `list-issues.js --sort freq` to find frequently occurring problems

4. **Check related events**: If you find one event, look for others with the same transaction name or trace ID

5. **Tags are your friend**: Custom tags like `thread_id`, `user_id`, `request_id` help correlate events
