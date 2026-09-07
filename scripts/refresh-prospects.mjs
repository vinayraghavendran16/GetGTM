// refresh-prospects.mjs
//
// Backend Gmail sweep for the GetGTM Engagement Tracker Prospects tab. Triggered by the
// "Refresh from Gmail" button in the tracker via workflow_dispatch; also safe to run on cron.
//
// What it does, end to end:
//   1. Uses a Gmail OAuth refresh token to fetch messages matching the standard prospect-sweep
//      query (adapted from Vinay's memory): outbound threads from vinay@ or rajiv@getgtm.ai in
//      the last N days, excluding internal forwards.
//   2. Groups messages into threads and pulls a compact summary (participants, subject, last
//      message body) per thread.
//   3. Loads the current prospects list from Firebase.
//   4. Calls Claude (Anthropic API) once per thread to decide: is this a known prospect
//      (fuzzy company/email match)? A new prospect? Neither (skip)? If yes, extract:
//        - status (from the fixed PROSPECT_STATUSES list)
//        - lastActivity (ISO date of the latest message in the thread)
//        - nextStep (one sentence, action-oriented)
//        - notes (short paragraph if new prospect)
//   5. Applies changes to the Firebase prospects array with the same addIfMissing /
//      updateIfExists semantics the tracker uses locally. Only updates when a field changed,
//      so this is safe to run repeatedly.
//   6. Writes a lastGmailRefresh timestamp so the UI shows when it last ran.
//
// Env vars required (set as GitHub Actions secrets):
//   GMAIL_CLIENT_ID        - Google OAuth 2.0 client id
//   GMAIL_CLIENT_SECRET    - Google OAuth 2.0 client secret
//   GMAIL_REFRESH_TOKEN    - Long-lived refresh token for vinay@getgtm.ai (see README)
//   GMAIL_USER             - Address to sweep (usually vinay@getgtm.ai); the refresh token
//                            has to belong to this user
//   ANTHROPIC_API_KEY      - For classification / extraction
//   FIREBASE_DATABASE_URL  - e.g. https://getgtm-tracker-d0f97-default-rtdb.firebaseio.com
//   FIREBASE_DATABASE_SECRET - Legacy database secret from Firebase console (Service accounts
//                              → Database secrets). REST calls append ?auth=<secret>.
//
// Optional:
//   SWEEP_DAYS             - Lookback window in days (default: 14)
//   ANTHROPIC_MODEL        - Defaults to claude-sonnet-4-6
//   RAJIV_EMAIL            - Second sender to include (default: rajiv@getgtm.ai)
//
// Safety notes:
//   - This script never overwrites name/company/email/dateContacted/source on an existing row
//     (mirrors the tracker's local updateIfExists semantics).
//   - It never deletes prospects.
//   - Failed API calls log and skip the affected thread rather than aborting the whole run.
//   - Rate limits are respected with a small delay between Anthropic calls.

import { google } from "googleapis";

const {
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
  GMAIL_USER = "vinay@getgtm.ai",
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-4-6",
  FIREBASE_DATABASE_URL,
  FIREBASE_DATABASE_SECRET,
  SWEEP_DAYS = "14",
  RAJIV_EMAIL = "rajiv@getgtm.ai",
} = process.env;

const REQUIRED = { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, ANTHROPIC_API_KEY, FIREBASE_DATABASE_URL, FIREBASE_DATABASE_SECRET };
for (const [k, v] of Object.entries(REQUIRED)) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
}

const PROSPECT_STATUSES = [
  "New", "Contacted", "Follow-up Sent", "In Conversation", "Objection Handling",
  "Proposal Requested", "Proposal Sent", "Deck Shared", "Meeting Booked", "Scheduling",
  "Kickoff Scheduled", "Stalled", "Closed Lost", "Not a Fit", "Converted",
];

// ── Firebase REST helpers ──────────────────────────────────────────────────────────────────
async function fbGet(path) {
  const url = `${FIREBASE_DATABASE_URL.replace(/\/$/, "")}/${path}.json?auth=${FIREBASE_DATABASE_SECRET}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}
async function fbPut(path, value) {
  const url = `${FIREBASE_DATABASE_URL.replace(/\/$/, "")}/${path}.json?auth=${FIREBASE_DATABASE_SECRET}`;
  const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  if (!res.ok) throw new Error(`Firebase PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Gmail helpers ──────────────────────────────────────────────────────────────────────────
function gmailClient() {
  const oauth2 = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth: oauth2 });
}

function decodeBody(part) {
  if (!part) return "";
  if (part.body && part.body.data) {
    return Buffer.from(part.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  }
  if (part.parts) {
    // Prefer text/plain if available, fall back to text/html stripped
    const textPart = part.parts.find(p => p.mimeType === "text/plain");
    if (textPart) return decodeBody(textPart);
    const htmlPart = part.parts.find(p => p.mimeType === "text/html");
    if (htmlPart) return decodeBody(htmlPart).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    for (const p of part.parts) {
      const s = decodeBody(p);
      if (s) return s;
    }
  }
  return "";
}

function extractEmail(header) {
  if (!header) return "";
  const match = header.match(/<([^>]+)>/);
  return (match ? match[1] : header).trim().toLowerCase();
}

async function fetchThreads(gmail) {
  const days = parseInt(SWEEP_DAYS, 10);
  // Two searches unioned: threads Vinay sent, threads Rajiv sent. Both exclude internal forwards.
  const queries = [
    `in:sent from:${GMAIL_USER} newer_than:${days}d -to:getgtm.ai -to:heddl.app`,
    `in:sent from:${RAJIV_EMAIL} newer_than:${days}d -to:getgtm.ai -to:heddl.app`,
  ];
  const threadIds = new Set();
  for (const q of queries) {
    let pageToken = undefined;
    do {
      const res = await gmail.users.threads.list({ userId: "me", q, maxResults: 100, pageToken });
      (res.data.threads || []).forEach(t => threadIds.add(t.id));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }
  console.log(`Found ${threadIds.size} candidate threads`);

  const threads = [];
  for (const id of threadIds) {
    try {
      const res = await gmail.users.threads.get({ userId: "me", id, format: "full" });
      const messages = res.data.messages || [];
      if (!messages.length) continue;
      const last = messages[messages.length - 1];
      const headers = Object.fromEntries((last.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
      const first = messages[0];
      const firstHeaders = Object.fromEntries((first.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
      // Gather all unique external addresses across from/to/cc on all messages
      const external = new Set();
      messages.forEach(m => {
        const hs = Object.fromEntries((m.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
        [hs.from, hs.to, hs.cc].filter(Boolean).forEach(field => {
          field.split(",").forEach(entry => {
            const email = extractEmail(entry);
            if (email && !email.endsWith("@getgtm.ai") && !email.endsWith("@heddl.app")) external.add(email);
          });
        });
      });
      const body = decodeBody(last.payload).slice(0, 3000);
      threads.push({
        id,
        subject: headers.subject || firstHeaders.subject || "(no subject)",
        externalAddresses: [...external],
        lastMessageDate: new Date(parseInt(last.internalDate, 10)).toISOString().slice(0, 10),
        lastMessageBody: body,
        messageCount: messages.length,
      });
    } catch (err) {
      console.warn(`Failed to fetch thread ${id}:`, err.message);
    }
  }
  return threads;
}

// ── Claude classification ──────────────────────────────────────────────────────────────────
async function classifyThread(thread, existingProspects) {
  const knownCompanies = existingProspects.map(p => ({ company: p.company, email: p.email })).slice(0, 50);
  const prompt = [
    `You are triaging Gmail threads for a B2B sales pipeline tracker (GetGTM). Decide whether this thread represents a real prospect and, if so, extract structured updates.`,
    ``,
    `Known prospects already tracked (partial list):`,
    JSON.stringify(knownCompanies, null, 2),
    ``,
    `Thread to classify:`,
    `- Subject: ${thread.subject}`,
    `- External participants: ${thread.externalAddresses.join(", ")}`,
    `- Last message date: ${thread.lastMessageDate}`,
    `- Message count in thread: ${thread.messageCount}`,
    `- Last message body (may be truncated):`,
    thread.lastMessageBody,
    ``,
    `Return ONLY a JSON object (no prose, no code fences) with one of these shapes:`,
    ``,
    `A) Skip (spam, internal, no clear prospect):`,
    `   { "action": "skip", "reason": "..." }`,
    ``,
    `B) Update an existing prospect (match by company name or contact email):`,
    `   {`,
    `     "action": "update",`,
    `     "matchCompany": "<company name exactly as it appears in the known list>",`,
    `     "status": "<one of: ${PROSPECT_STATUSES.join(", ")}>",`,
    `     "lastActivity": "<YYYY-MM-DD - use the last message date>",`,
    `     "nextStep": "<one action-oriented sentence describing what just happened and what's owed next>"`,
    `   }`,
    ``,
    `C) Add a new prospect (only if the thread clearly represents an external sales conversation):`,
    `   {`,
    `     "action": "add",`,
    `     "name": "<contact first + last>",`,
    `     "company": "<company>",`,
    `     "email": "<primary external contact email>",`,
    `     "dateContacted": "<YYYY-MM-DD - date of the FIRST message in the thread if known, else the last>",`,
    `     "lastActivity": "<YYYY-MM-DD - use the last message date>",`,
    `     "status": "<one of the statuses above>",`,
    `     "nextStep": "<one action-oriented sentence>",`,
    `     "source": "<who led / how it originated>",`,
    `     "notes": "<one short paragraph summarizing the conversation to date>"`,
    `   }`,
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    console.warn(`Anthropic API error for thread ${thread.id}: ${res.status} ${await res.text()}`);
    return { action: "skip", reason: "api_error" };
  }
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || "").join("").trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn(`No JSON in Claude response for thread ${thread.id}:`, text.slice(0, 200));
    return { action: "skip", reason: "no_json" };
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn(`JSON parse failed for thread ${thread.id}:`, err.message);
    return { action: "skip", reason: "parse_error" };
  }
}

// ── Apply changes to Firebase ──────────────────────────────────────────────────────────────
function findProspect(prospects, matchCompany) {
  const needle = matchCompany.trim().toLowerCase();
  return prospects.findIndex(p => (p.company || "").trim().toLowerCase() === needle);
}

async function applyChanges(prospects, decisions) {
  let added = 0, updated = 0;
  for (const d of decisions) {
    if (d.action === "update" && d.matchCompany) {
      const idx = findProspect(prospects, d.matchCompany);
      if (idx === -1) { console.log(`  · update skipped (no match): ${d.matchCompany}`); continue; }
      const p = prospects[idx];
      const before = JSON.stringify(p);
      // Only overwrite status/lastActivity/nextStep - never touch name/company/email/dateContacted/source
      ["status", "lastActivity", "nextStep"].forEach(k => {
        if (d[k] && p[k] !== d[k]) p[k] = d[k];
      });
      if (JSON.stringify(p) !== before) { updated++; console.log(`  ✓ updated ${p.company} → ${p.status}`); }
    } else if (d.action === "add" && d.company) {
      if (findProspect(prospects, d.company) !== -1) { console.log(`  · add skipped (dup): ${d.company}`); continue; }
      prospects.push({
        id: "p_" + Math.random().toString(36).slice(2, 10),
        name: d.name, company: d.company, email: d.email,
        dateContacted: d.dateContacted, lastActivity: d.lastActivity,
        status: d.status, nextStep: d.nextStep,
        source: d.source || "Auto-detected by Gmail sweep",
        notes: d.notes || "",
      });
      added++;
      console.log(`  ✓ added ${d.company} (${d.name})`);
    }
  }
  return { added, updated };
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Prospects Gmail sweep starting - lookback ${SWEEP_DAYS} days`);
  const gmail = gmailClient();
  const threads = await fetchThreads(gmail);

  const prospects = (await fbGet("prospects")) || [];
  console.log(`Loaded ${prospects.length} existing prospects from Firebase`);

  const decisions = [];
  for (const t of threads) {
    const decision = await classifyThread(t, prospects);
    decisions.push(decision);
    if (decision.action !== "skip") console.log(`  ${decision.action}: ${decision.matchCompany || decision.company}`);
    await new Promise(r => setTimeout(r, 300)); // gentle rate limit
  }

  const { added, updated } = await applyChanges(prospects, decisions);
  console.log(`Applying ${added} adds, ${updated} updates`);

  if (added || updated) {
    await fbPut("prospects", prospects);
  }
  await fbPut("lastGmailRefresh", new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }));
  console.log("Done.");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
