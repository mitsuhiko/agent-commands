#!/usr/bin/env node

import { SENTRY_API_BASE, getAuthToken, fetchJson, formatTimestamp } from "../lib/auth.js";

const HELP = `Usage: search-events.js [options]

Search for events (transactions, errors) in Sentry Discover.

Options:
  --org, -o <org>          Organization slug (required)
  --project, -p <project>  Project slug or ID
  --query, -q <query>      Search query (Discover syntax)
  --period, -t <period>    Time period (default: 24h, e.g., 1h, 7d, 14d)
  --start <datetime>       Start time (ISO 8601, e.g., 2025-12-23T15:00:00)
  --end <datetime>         End time (ISO 8601)
  --transaction <name>     Filter by transaction name
  --tag <key:value>        Filter by tag (can be repeated)
  --level <level>          Filter by level (error, warning, info)
  --limit, -n <n>          Max results (default: 25, max: 100)
  --fields <fields>        Comma-separated fields to include
  --json                   Output raw JSON
  -h, --help               Show this help

Common Fields:
  id, title, timestamp, transaction, message, level, environment,
  user.email, user.id, tags[key], http.method, http.url

Query Syntax (Discover):
  transaction:process-*    Match transaction names with wildcards
  level:error              Filter by log level
  user.email:foo@bar.com   Filter by user email
  environment:production   Filter by environment
  has:stack.filename       Events with stack traces
  !has:user                Events without user

Date Range Examples:
  --period 7d                        Last 7 days
  --start 2025-12-23T15:00:00        From specific time to now
  --start 2025-12-23T15:00:00 --end 2025-12-23T18:00:00   Specific range

Examples:
  # Find all transactions for a transaction name
  search-events.js --org myorg --project backend --transaction process-incoming-email

  # Find errors in the last 7 days
  search-events.js --org myorg --query "level:error" --period 7d

  # Find events around a specific time
  search-events.js --org myorg --start 2025-12-23T15:00:00 --end 2025-12-23T17:00:00

  # Search with a specific tag
  search-events.js --org myorg --tag thread_id:th_abc123

  # Get more fields
  search-events.js --org myorg --fields "id,title,timestamp,user.email"
`;

function parseArgs(args) {
  const options = {
    org: null,
    project: null,
    query: null,
    period: null,
    start: null,
    end: null,
    transaction: null,
    tags: [],
    level: null,
    limit: 25,
    fields: ["id", "title", "timestamp", "transaction", "message"],
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--org":
      case "-o":
        options.org = args[++i];
        break;
      case "--project":
      case "-p":
        options.project = args[++i];
        break;
      case "--query":
      case "-q":
        options.query = args[++i];
        break;
      case "--period":
      case "-t":
        options.period = args[++i];
        break;
      case "--start":
        options.start = args[++i];
        break;
      case "--end":
        options.end = args[++i];
        break;
      case "--transaction":
        options.transaction = args[++i];
        break;
      case "--tag":
        options.tags.push(args[++i]);
        break;
      case "--level":
        options.level = args[++i];
        break;
      case "--limit":
      case "-n":
        options.limit = parseInt(args[++i], 10);
        break;
      case "--fields":
        options.fields = args[++i].split(",").map((f) => f.trim());
        break;
    }
  }

  // Default to 24h if no time range specified
  if (!options.period && !options.start) {
    options.period = "24h";
  }

  return options;
}

function formatEvent(event, fields) {
  const lines = [];

  const id = event.id || event["event.type"] || "?";
  const ts = event.timestamp || "N/A";
  const title = event.title || event.transaction || event.message || "(no title)";
  const transaction = event.transaction || "";

  // Format timestamp
  let displayTs = ts;
  try {
    const date = new Date(ts);
    if (!isNaN(date.getTime())) {
      displayTs = date.toISOString().replace("T", " ").slice(0, 19);
    }
  } catch {}

  lines.push(`[${displayTs}] ${title}`);

  if (transaction && transaction !== title) {
    lines.push(`  transaction: ${transaction}`);
  }

  if (event.message && event.message !== title) {
    lines.push(`  message: ${event.message}`);
  }

  // Show any extra fields the user requested
  for (const field of fields) {
    if (["id", "title", "timestamp", "transaction", "message"].includes(field)) continue;
    const value = event[field];
    if (value !== undefined && value !== null && value !== "") {
      lines.push(`  ${field}: ${value}`);
    }
  }

  lines.push(`  id: ${id}`);

  return lines.join("\n");
}

function formatOutput(data, fields) {
  if (!data.data || data.data.length === 0) {
    return "No events found matching your query.";
  }

  const lines = [];
  lines.push(`Found ${data.data.length} events:\n`);

  for (const event of data.data) {
    lines.push(formatEvent(event, fields));
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (!options.org) {
    console.error("Error: --org is required");
    console.error("Run with --help for usage information");
    process.exit(1);
  }

  const token = getAuthToken();

  // Build query parameters
  const params = new URLSearchParams();
  params.set("dataset", "discover");

  // Time range
  if (options.start) {
    params.set("start", options.start);
    if (options.end) {
      params.set("end", options.end);
    } else {
      // If only start, use current time as end
      params.set("end", new Date().toISOString());
    }
  } else if (options.period) {
    params.set("statsPeriod", options.period);
  }

  params.set("per_page", Math.min(options.limit, 100).toString());
  params.set("sort", "-timestamp");

  // Add fields
  for (const field of options.fields) {
    params.append("field", field);
  }

  // Always include project.name for context
  if (!options.fields.includes("project.name")) {
    params.append("field", "project.name");
  }

  // Build search query
  const queryParts = [];

  if (options.project) {
    params.set("project", options.project);
  }

  if (options.query) {
    queryParts.push(options.query);
  }

  if (options.transaction) {
    queryParts.push(`transaction:${options.transaction}`);
  }

  if (options.level) {
    queryParts.push(`level:${options.level}`);
  }

  for (const tag of options.tags) {
    // Handle tags[key]:value format
    if (tag.includes(":")) {
      const [key, value] = tag.split(":", 2);
      if (key.startsWith("tags[")) {
        queryParts.push(`${key}:${value}`);
      } else {
        queryParts.push(`tags[${key}]:${value}`);
      }
    }
  }

  if (queryParts.length > 0) {
    params.set("query", queryParts.join(" "));
  }

  const url = `${SENTRY_API_BASE}/organizations/${encodeURIComponent(options.org)}/events/?${params.toString()}`;

  try {
    const data = await fetchJson(url, token);

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatOutput(data, options.fields));
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
