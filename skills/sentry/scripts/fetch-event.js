#!/usr/bin/env node

import { SENTRY_API_BASE, getAuthToken, fetchJson, formatTimestamp } from "../lib/auth.js";

const HELP = `Usage: fetch-event.js <event-id> [options]

Fetch a specific event by ID with full details.

Arguments:
  event-id                 The event ID to fetch

Options:
  --org, -o <org>          Organization slug (required)
  --project, -p <project>  Project slug (required)
  --json                   Output raw JSON
  --breadcrumbs, -b        Show all breadcrumbs (default: last 30)
  --spans                  Show span tree (for transactions)
  -h, --help               Show this help

Examples:
  # Fetch an event
  fetch-event.js 571076d9728248739cecac2c9e96a24c --org myorg --project backend

  # Get full breadcrumb history
  fetch-event.js abc123 --org myorg --project backend --breadcrumbs

  # Show spans for a transaction
  fetch-event.js abc123 --org myorg --project backend --spans

  # Get raw JSON for further analysis
  fetch-event.js abc123 --org myorg --project backend --json
`;

function parseArgs(args) {
  const options = {
    eventId: null,
    org: null,
    project: null,
    json: false,
    allBreadcrumbs: false,
    showSpans: false,
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
      case "--breadcrumbs":
      case "-b":
        options.allBreadcrumbs = true;
        break;
      case "--spans":
        options.showSpans = true;
        break;
      default:
        if (!arg.startsWith("-") && !options.eventId) {
          options.eventId = arg;
        }
    }
  }

  return options;
}

function formatStacktrace(frames, { maxFrames = 20, showContext = true } = {}) {
  if (!frames || frames.length === 0) return "  (no frames)";

  const reversed = frames.slice().reverse();
  const appFrames = reversed.filter((f) => f.inApp !== false);
  const framesToShow = appFrames.length > 0 ? appFrames : reversed;

  return framesToShow
    .slice(0, maxFrames)
    .map((f, i) => {
      const file = f.filename || f.absPath || f.module || "unknown";
      const func = f.function || "(anonymous)";
      const line = f.lineNo || f.lineno;
      const col = f.colNo || f.colno;
      const loc = line ? `:${line}${col ? `:${col}` : ""}` : "";

      let out = `  ${i + 1}. ${file}${loc}\n     → ${func}`;

      if (showContext && f.context_line) {
        out += `\n     | ${f.context_line.trim()}`;
      }

      return out;
    })
    .join("\n\n");
}

function formatBreadcrumb(crumb) {
  let ts = "??:??:??";
  if (crumb.timestamp) {
    try {
      const date =
        typeof crumb.timestamp === "number"
          ? new Date(crumb.timestamp * 1000)
          : new Date(crumb.timestamp);
      if (!isNaN(date.getTime())) {
        ts = date.toISOString().slice(11, 19);
      }
    } catch {}
  }

  const cat = crumb.category || crumb.type || "?";
  const level = crumb.level && crumb.level !== "info" ? `[${crumb.level}] ` : "";
  let msg = crumb.message || "";

  if (!msg && crumb.data) {
    if (crumb.data.url) msg = crumb.data.url;
    else if (crumb.data.method) msg = `${crumb.data.method} ${crumb.data.url || ""}`;
    else if (typeof crumb.data === "object") msg = JSON.stringify(crumb.data);
  }

  return `  [${ts}] ${level}${cat}: ${msg}`;
}

function formatSpan(span, indent = 0) {
  const prefix = "  ".repeat(indent);
  const op = span.op || "?";
  const desc = span.description || "(no description)";
  const status = span.status || "?";
  const duration = span.exclusive_time ? `${span.exclusive_time.toFixed(1)}ms` : "?";

  return `${prefix}[${op}] ${desc}\n${prefix}  status: ${status} | duration: ${duration}`;
}

function formatEvent(event, options) {
  const lines = [];

  lines.push(`# Event: ${event.eventID || event.id}`);
  lines.push("");
  lines.push(`**Timestamp:** ${formatTimestamp(event.dateCreated || event.timestamp)}`);
  lines.push(`**Project:** ${event.projectSlug || event.projectID || "?"}`);

  if (event.title) {
    lines.push(`**Title:** ${event.title}`);
  }

  if (event.message) {
    lines.push(`**Message:** ${event.message}`);
  }

  // Tags
  if (event.tags && event.tags.length > 0) {
    lines.push("");
    lines.push("## Tags");
    for (const tag of event.tags) {
      lines.push(`- **${tag.key}:** ${tag.value}`);
    }
  }

  // Contexts
  if (event.contexts) {
    const ctx = event.contexts;
    const contextLines = [];

    if (ctx.runtime) {
      contextLines.push(
        `- **Runtime:** ${ctx.runtime.name || "?"} ${ctx.runtime.version || ""}`
      );
    }
    if (ctx.browser) {
      contextLines.push(
        `- **Browser:** ${ctx.browser.name || "?"} ${ctx.browser.version || ""}`
      );
    }
    if (ctx.os) {
      contextLines.push(`- **OS:** ${ctx.os.name || "?"} ${ctx.os.version || ""}`);
    }
    if (ctx.device && ctx.device.family) {
      contextLines.push(`- **Device:** ${ctx.device.family}`);
    }
    if (ctx.trace) {
      contextLines.push(`- **Trace ID:** ${ctx.trace.trace_id || "?"}`);
      contextLines.push(`- **Span ID:** ${ctx.trace.span_id || "?"}`);
      if (ctx.trace.op) {
        contextLines.push(`- **Operation:** ${ctx.trace.op}`);
      }
      if (ctx.trace.status) {
        contextLines.push(`- **Status:** ${ctx.trace.status}`);
      }
    }

    if (contextLines.length > 0) {
      lines.push("");
      lines.push("## Context");
      lines.push(...contextLines);
    }
  }

  // Process entries
  if (event.entries) {
    // Request
    for (const entry of event.entries) {
      if (entry.type === "request" && entry.data) {
        const req = entry.data;
        lines.push("");
        lines.push("## Request");
        if (req.method && req.url) {
          lines.push(`**${req.method}** ${req.url}`);
        }
        if (req.headers && req.headers.length > 0) {
          const importantHeaders = ["User-Agent", "Content-Type", "Host"];
          const headers = req.headers.filter(([k]) => importantHeaders.includes(k));
          if (headers.length > 0) {
            for (const [k, v] of headers) {
              lines.push(`  ${k}: ${v}`);
            }
          }
        }
      }
    }

    // Exceptions
    for (const entry of event.entries) {
      if (entry.type === "exception" && entry.data?.values) {
        lines.push("");
        lines.push("## Exception");
        for (const exc of entry.data.values) {
          lines.push("");
          lines.push(`**${exc.type || "Error"}:** ${exc.value || "(no message)"}`);
          if (exc.stacktrace?.frames) {
            lines.push("");
            lines.push(formatStacktrace(exc.stacktrace.frames));
          }
        }
      }
    }

    // Breadcrumbs
    for (const entry of event.entries) {
      if (entry.type === "breadcrumbs" && entry.data?.values) {
        const crumbs = options.allBreadcrumbs
          ? entry.data.values
          : entry.data.values.slice(-30);

        if (crumbs.length > 0) {
          lines.push("");
          lines.push(`## Breadcrumbs (${crumbs.length}${options.allBreadcrumbs ? "" : " most recent"})`);
          for (const c of crumbs) {
            lines.push(formatBreadcrumb(c));
          }
        }
      }
    }

    // Spans (for transactions)
    if (options.showSpans) {
      for (const entry of event.entries) {
        if (entry.type === "spans" && entry.data) {
          lines.push("");
          lines.push("## Spans");
          const spans = Array.isArray(entry.data) ? entry.data : [entry.data];
          for (const span of spans.slice(0, 50)) {
            lines.push(formatSpan(span));
            lines.push("");
          }
        }
      }
    }
  }

  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (!options.eventId) {
    console.error("Error: event-id is required");
    console.error("Run with --help for usage information");
    process.exit(1);
  }

  if (!options.org) {
    console.error("Error: --org is required");
    console.error("Run with --help for usage information");
    process.exit(1);
  }

  if (!options.project) {
    console.error("Error: --project is required");
    console.error("Run with --help for usage information");
    process.exit(1);
  }

  const token = getAuthToken();

  const url = `${SENTRY_API_BASE}/projects/${encodeURIComponent(options.org)}/${encodeURIComponent(options.project)}/events/${encodeURIComponent(options.eventId)}/`;

  try {
    const event = await fetchJson(url, token);

    if (options.json) {
      console.log(JSON.stringify(event, null, 2));
    } else {
      console.log(formatEvent(event, options));
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
