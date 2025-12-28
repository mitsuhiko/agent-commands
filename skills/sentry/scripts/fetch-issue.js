#!/usr/bin/env node

import { SENTRY_API_BASE, getAuthToken, fetchJson, formatTimestamp } from "../lib/auth.js";

function parseIssueInput(input) {
  // Full URL: https://sentry.io/organizations/sentry/issues/5765604106/
  const urlMatch = input.match(
    /sentry\.io\/organizations\/([^/]+)\/issues\/(\d+)/
  );
  if (urlMatch) {
    return { org: urlMatch[1], issueId: urlMatch[2] };
  }

  // New URL format: https://ORG.sentry.io/issues/5765604106/
  const newUrlMatch = input.match(
    /([^/.]+)\.sentry\.io\/issues\/(\d+)/
  );
  if (newUrlMatch) {
    return { org: newUrlMatch[1], issueId: newUrlMatch[2] };
  }

  // Numeric issue ID
  if (/^\d+$/.test(input)) {
    return { issueId: input };
  }

  // Short ID like JAVASCRIPT-ABC
  if (/^[A-Z]+-[A-Z0-9]+$/i.test(input)) {
    return { shortId: input };
  }

  return { issueId: input };
}


function formatStacktrace(frames, { maxFrames = 20, showContext = true } = {}) {
  if (!frames || frames.length === 0) return "  (no frames)";

  const reversed = frames.slice().reverse();
  const appFrames = reversed.filter(f => f.inApp !== false);
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

      // Show pre/post context if available
      if (showContext && f.preContext && f.preContext.length > 0) {
        const pre = f.preContext.slice(-2).map(l => `     . ${l.trim()}`).join("\n");
        const post = f.postContext?.slice(0, 2).map(l => `     . ${l.trim()}`).join("\n") || "";
        if (pre || post) {
          out = `  ${i + 1}. ${file}${loc}\n     → ${func}`;
          if (pre) out += `\n${pre}`;
          out += `\n     > ${f.context_line.trim()}`;
          if (post) out += `\n${post}`;
        }
      }

      return out;
    })
    .join("\n\n");
}

function formatException(exc) {
  let out = `**${exc.type || "Error"}:** ${exc.value || "(no message)"}\n`;

  if (exc.module) {
    out += `Module: ${exc.module}\n`;
  }

  if (exc.stacktrace?.frames) {
    out += "\n" + formatStacktrace(exc.stacktrace.frames);
  }

  return out;
}

function formatIssue(issue) {
  const lines = [];

  lines.push(`# ${issue.title}`);
  lines.push("");
  lines.push(`**Project:** ${issue.project?.slug || "unknown"}`);
  lines.push(`**Short ID:** ${issue.shortId}`);
  lines.push(`**Status:** ${issue.status}`);
  lines.push(`**Level:** ${issue.level}`);
  if (issue.culprit) {
    lines.push(`**Culprit:** ${issue.culprit}`);
  }
  lines.push("");
  lines.push(`**First Seen:** ${formatTimestamp(issue.firstSeen)}`);
  lines.push(`**Last Seen:** ${formatTimestamp(issue.lastSeen)}`);
  lines.push(`**Events:** ${issue.count || 0}`);
  lines.push(`**Users Affected:** ${issue.userCount || 0}`);

  if (issue.tags && issue.tags.length > 0) {
    lines.push("");
    lines.push("## Tags");
    for (const tag of issue.tags.slice(0, 10)) {
      const topValue = tag.topValues?.[0];
      if (topValue) {
        lines.push(`- **${tag.key}:** ${topValue.value} (${topValue.count})`);
      }
    }
  }

  if (issue.metadata) {
    const m = issue.metadata;
    if (m.type || m.value) {
      lines.push("");
      lines.push("## Exception");
      lines.push(`**Type:** ${m.type || "unknown"}`);
      lines.push(`**Value:** ${m.value || "unknown"}`);
    }
  }

  return lines.join("\n");
}

function formatEvent(event) {
  const lines = [];

  lines.push(`## Latest Event`);
  lines.push("");
  lines.push(`**Event ID:** ${event.eventID}`);
  lines.push(`**Timestamp:** ${formatTimestamp(event.dateCreated)}`);

  // Show relevant tags (filter out noisy ones)
  if (event.tags && event.tags.length > 0) {
    const importantTags = ["environment", "release", "server_name", "transaction", "url", "browser", "os", "runtime"];
    const filteredTags = event.tags.filter(t =>
      importantTags.includes(t.key) || t.key.startsWith("sentry:")
    );
    if (filteredTags.length > 0) {
      lines.push("");
      lines.push("### Tags");
      for (const tag of filteredTags) {
        lines.push(`- **${tag.key}:** ${tag.value}`);
      }
    }
  }

  if (event.entries) {
    // Show request info first if available
    for (const entry of event.entries) {
      if (entry.type === "request" && entry.data) {
        const req = entry.data;
        lines.push("");
        lines.push("### Request");
        if (req.method && req.url) {
          lines.push(`**${req.method}** ${req.url}`);
        }
        if (req.headers && req.headers.length > 0) {
          const importantHeaders = ["User-Agent", "Content-Type", "Accept", "Host", "Referer"];
          const headers = req.headers.filter(([k]) => importantHeaders.includes(k));
          if (headers.length > 0) {
            lines.push("");
            for (const [k, v] of headers) {
              lines.push(`  ${k}: ${v}`);
            }
          }
        }
        if (req.data) {
          lines.push("");
          lines.push("**Body:**");
          const body = typeof req.data === "string" ? req.data : JSON.stringify(req.data, null, 2);
          lines.push("```");
          lines.push(body.slice(0, 1000) + (body.length > 1000 ? "..." : ""));
          lines.push("```");
        }
      }
    }

    // Show exceptions with stack traces
    for (const entry of event.entries) {
      if (entry.type === "exception" && entry.data?.values) {
        lines.push("");
        lines.push("### Exception");
        for (const exc of entry.data.values) {
          lines.push("");
          lines.push(formatException(exc));
        }
      }

      if (entry.type === "message" && entry.data?.formatted) {
        lines.push("");
        lines.push("### Message");
        lines.push(entry.data.formatted);
      }
    }

    // Show breadcrumbs last
    for (const entry of event.entries) {
      if (entry.type === "breadcrumbs" && entry.data?.values) {
        const crumbs = entry.data.values.slice(-15);
        if (crumbs.length > 0) {
          lines.push("");
          lines.push("### Recent Breadcrumbs");
          for (const c of crumbs) {
            let ts = "??:??:??";
            if (c.timestamp) {
              try {
                // Handle both unix timestamps and ISO strings
                const date = typeof c.timestamp === "number"
                  ? new Date(c.timestamp * 1000)
                  : new Date(c.timestamp);
                if (!isNaN(date.getTime())) {
                  ts = date.toISOString().slice(11, 19);
                }
              } catch {}
            }
            const cat = c.category || c.type || "?";
            const level = c.level && c.level !== "info" ? `[${c.level}] ` : "";
            let msg = c.message || "";
            if (!msg && c.data) {
              if (c.data.url) msg = c.data.url;
              else if (c.data.method) msg = `${c.data.method} ${c.data.url || ""}`;
              else msg = JSON.stringify(c.data);
            }
            lines.push(`  [${ts}] ${level}${cat}: ${msg}`);
          }
        }
      }
    }
  }

  // Show contexts (runtime, browser, os, device, etc.)
  if (event.contexts) {
    const ctx = event.contexts;
    const contextLines = [];

    if (ctx.runtime) {
      contextLines.push(`- **Runtime:** ${ctx.runtime.name || "?"} ${ctx.runtime.version || ""}`);
    }
    if (ctx.browser) {
      contextLines.push(`- **Browser:** ${ctx.browser.name || "?"} ${ctx.browser.version || ""}`);
    }
    if (ctx.os) {
      contextLines.push(`- **OS:** ${ctx.os.name || "?"} ${ctx.os.version || ""}`);
    }
    if (ctx.device && ctx.device.family) {
      contextLines.push(`- **Device:** ${ctx.device.family}`);
    }

    if (contextLines.length > 0) {
      lines.push("");
      lines.push("### Context");
      lines.push(...contextLines);
    }
  }

  // Fallback to old context field
  if (!event.contexts && event.context) {
    const ctx = event.context;
    if (ctx.browser || ctx.os || ctx.device) {
      lines.push("");
      lines.push("### Context");
      if (ctx.browser)
        lines.push(`- **Browser:** ${ctx.browser.name} ${ctx.browser.version || ""}`);
      if (ctx.os) lines.push(`- **OS:** ${ctx.os.name} ${ctx.os.version || ""}`);
      if (ctx.device) lines.push(`- **Device:** ${ctx.device.family || "unknown"}`);
    }
  }

  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: fetch-issue.js <issue-id-or-url> [options]");
    console.log("");
    console.log("Options:");
    console.log("  --latest     Fetch the latest event with full stack trace");
    console.log("  --org <org>  Organization slug (for short IDs like PROJECT-123)");
    console.log("  --json       Output raw JSON instead of formatted text");
    console.log("");
    console.log("Examples:");
    console.log("  fetch-issue.js 5765604106");
    console.log("  fetch-issue.js https://sentry.io/organizations/sentry/issues/123/");
    console.log("  fetch-issue.js MYPROJ-ABC --org myorg");
    console.log("  fetch-issue.js 5765604106 --latest");
    process.exit(0);
  }

  const input = args[0];
  const wantLatest = args.includes("--latest");
  const wantJson = args.includes("--json");
  const orgIndex = args.indexOf("--org");
  const cliOrg = orgIndex !== -1 ? args[orgIndex + 1] : null;

  const token = getAuthToken();
  const parsed = parseIssueInput(input);

  try {
    let issue;

    if (parsed.shortId) {
      const org = cliOrg || parsed.org;
      if (!org) {
        console.error("Error: Short ID requires --org flag");
        console.error("Example: fetch-issue.js MYPROJ-123 --org myorg");
        process.exit(1);
      }
      // Use the shortids endpoint to resolve the short ID
      const shortIdUrl = `${SENTRY_API_BASE}/organizations/${org}/shortids/${encodeURIComponent(parsed.shortId)}/`;
      const result = await fetchJson(shortIdUrl, token);
      if (!result || !result.group) {
        console.error(`Error: Issue ${parsed.shortId} not found`);
        process.exit(1);
      }
      issue = result.group;
    } else {
      const issueUrl = `${SENTRY_API_BASE}/issues/${parsed.issueId}/`;
      issue = await fetchJson(issueUrl, token);
    }

    if (wantJson && !wantLatest) {
      console.log(JSON.stringify(issue, null, 2));
      return;
    }

    let output = formatIssue(issue);

    if (wantLatest) {
      const eventUrl = `${SENTRY_API_BASE}/issues/${issue.id}/events/latest/`;
      const event = await fetchJson(eventUrl, token);

      if (wantJson) {
        console.log(JSON.stringify({ issue, event }, null, 2));
        return;
      }

      output += "\n\n" + formatEvent(event);
    }

    console.log(output);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
