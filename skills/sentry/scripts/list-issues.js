#!/usr/bin/env node

import { SENTRY_API_BASE, getAuthToken, fetchJson, formatTimestamp } from "../lib/auth.js";

const HELP = `Usage: list-issues.js [options]

List and search issues in Sentry.

Options:
  --org, -o <org>          Organization slug (required)
  --project, -p <project>  Project slug (can be repeated for multiple projects)
  --query, -q <query>      Search query (Sentry issue search syntax)
  --status <status>        Filter by status (unresolved, resolved, ignored)
  --level <level>          Filter by level (error, warning, info, fatal)
  --period, -t <period>    Time period (default: 14d, e.g., 24h, 7d, 14d)
  --limit, -n <n>          Max results (default: 25)
  --sort <sort>            Sort order (date, new, priority, freq, user)
  --json                   Output raw JSON
  -h, --help               Show this help

Query Syntax:
  is:unresolved            Unresolved issues only
  is:resolved              Resolved issues only
  is:ignored               Ignored issues only
  is:assigned              Assigned to someone
  is:unassigned            Not assigned
  assigned:me              Assigned to current user
  level:error              Error level only
  firstSeen:+7d            First seen more than 7 days ago
  lastSeen:-24h            Last seen within 24 hours
  event.timestamp:>=2025-12-23   Events since date
  times_seen:>100          Seen more than 100 times
  user.email:*@example.com User email pattern
  has:user                 Has user context
  error.handled:0          Unhandled errors

Sort Options:
  date       - Last seen (default)
  new        - First seen (newest first)
  priority   - Priority score
  freq       - Frequency (events per time)
  user       - Users affected

Examples:
  # List unresolved errors
  list-issues.js --org myorg --project backend --status unresolved

  # Find recent high-priority issues
  list-issues.js --org myorg --query "is:unresolved lastSeen:-24h" --sort priority

  # Search for specific error type
  list-issues.js --org myorg --query "AI_NoOutputGeneratedError"

  # Find issues first seen in a date range
  list-issues.js --org myorg --query "firstSeen:>=2025-12-23 firstSeen:<=2025-12-24"

  # Find issues with many events
  list-issues.js --org myorg --query "times_seen:>50" --sort freq
`;

function parseArgs(args) {
  const options = {
    org: null,
    projects: [],
    query: null,
    status: null,
    level: null,
    period: "14d",
    limit: 25,
    sort: null,
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
        options.projects.push(args[++i]);
        break;
      case "--query":
      case "-q":
        options.query = args[++i];
        break;
      case "--status":
        options.status = args[++i];
        break;
      case "--level":
        options.level = args[++i];
        break;
      case "--period":
      case "-t":
        options.period = args[++i];
        break;
      case "--limit":
      case "-n":
        options.limit = parseInt(args[++i], 10);
        break;
      case "--sort":
        options.sort = args[++i];
        break;
    }
  }

  return options;
}

function formatIssue(issue) {
  const lines = [];

  const id = issue.shortId || issue.id;
  const title = issue.title || "(no title)";
  const level = issue.level || "?";
  const status = issue.status || "?";
  const count = issue.count || 0;
  const userCount = issue.userCount || 0;
  const firstSeen = formatTimestamp(issue.firstSeen);
  const lastSeen = formatTimestamp(issue.lastSeen);
  const project = issue.project?.slug || "?";
  const culprit = issue.culprit || "";
  const permalink = issue.permalink || "";

  lines.push(`[${id}] ${title}`);
  lines.push(`  level: ${level} | status: ${status} | project: ${project}`);
  lines.push(`  events: ${count} | users: ${userCount}`);
  lines.push(`  first: ${firstSeen} | last: ${lastSeen}`);

  if (culprit) {
    lines.push(`  culprit: ${culprit}`);
  }

  if (permalink) {
    lines.push(`  url: ${permalink}`);
  }

  return lines.join("\n");
}

function formatOutput(issues) {
  if (!issues || issues.length === 0) {
    return "No issues found matching your query.";
  }

  const lines = [];
  lines.push(`Found ${issues.length} issues:\n`);

  for (const issue of issues) {
    lines.push(formatIssue(issue));
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

  if (options.period) {
    params.set("statsPeriod", options.period);
  }

  params.set("limit", Math.min(options.limit, 100).toString());

  // Build search query
  const queryParts = [];

  if (options.query) {
    queryParts.push(options.query);
  }

  if (options.status) {
    queryParts.push(`is:${options.status}`);
  }

  if (options.level) {
    queryParts.push(`level:${options.level}`);
  }

  if (queryParts.length > 0) {
    params.set("query", queryParts.join(" "));
  }

  if (options.sort) {
    params.set("sort", options.sort);
  }

  // Build URL based on whether project is specified
  // If a single project slug is given, use the project endpoint which accepts slugs
  // If multiple projects or none, use the org endpoint (which needs project IDs)
  let url;
  if (options.projects.length === 1 && !/^\d+$/.test(options.projects[0])) {
    // Single project slug - use project endpoint
    url = `${SENTRY_API_BASE}/projects/${encodeURIComponent(options.org)}/${encodeURIComponent(options.projects[0])}/issues/?${params.toString()}`;
  } else {
    // Multiple projects or project IDs - use org endpoint
    for (const project of options.projects) {
      params.append("project", project);
    }
    url = `${SENTRY_API_BASE}/organizations/${encodeURIComponent(options.org)}/issues/?${params.toString()}`;
  }

  try {
    const data = await fetchJson(url, token);

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatOutput(data));
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
