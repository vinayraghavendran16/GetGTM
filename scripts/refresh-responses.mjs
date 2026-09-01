// GetGTM Response Tracker - automated backend refresh
//
// What this does, end to end:
//   1. Lists every client subfolder inside the shared Drive "Response Screenshots" folder
//   2. For each subfolder (= one client), lists image files inside it
//   3. Compares against what's already in Firebase (matched by exact filename) - never reprocesses
//      or duplicates an already-logged screenshot
//   4. For each genuinely new screenshot, downloads it and sends it to Claude's vision API with a
//      structured extraction prompt - the same reasoning a human would do reading the screenshot:
//      who replied, what they said, and what Heddl Status that reply represents
//   5. Writes the new response row straight to Firebase (getgtm_tracker/responses), via the Admin
//      SDK - this bypasses the client-side security rules entirely (Admin SDK has full privileged
//      access by design), so the existing rules for the web app don't need to change
//
// This is meant to run on a schedule via GitHub Actions (see .github/workflows/refresh-responses.yml)
// - completely independent of any browser session or team member being logged in.

import { google } from 'googleapis';
import admin from 'firebase-admin';
import Anthropic from '@anthropic-ai/sdk';

// ── Config ────────────────────────────────────────────────────────────────
const DRIVE_RESPONSES_ROOT_ID = '1Hr3GWko3ixmEJZTl6DHgNiJauG502gL8'; // parent folder, one subfolder per client
const HEDDL_STATUSES = ['Positive Reply', 'Meeting Booked', 'No Fit', 'Not Interested'];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

// Clients are created lazily inside init() - NOT at module load time. This means the pure functions
// below can be safely imported and unit tested without needing real credentials in the environment;
// only actually running main() (directly or via the GitHub Action) triggers real SDK initialization.
let drive, db, anthropic;

function init() {
  const GOOGLE_SERVICE_ACCOUNT_JSON = requireEnv('GOOGLE_SERVICE_ACCOUNT_JSON');
  const FIREBASE_SERVICE_ACCOUNT_JSON = requireEnv('FIREBASE_SERVICE_ACCOUNT_JSON');
  const FIREBASE_DATABASE_URL = requireEnv('FIREBASE_DATABASE_URL');
  const ANTHROPIC_API_KEY = requireEnv('ANTHROPIC_API_KEY');

  const googleCreds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const driveAuth = new google.auth.GoogleAuth({
    credentials: googleCreds,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  drive = google.drive({ version: 'v3', auth: driveAuth });

  const firebaseCreds = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(firebaseCreds),
    databaseURL: FIREBASE_DATABASE_URL,
  });
  db = admin.database();

  anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

async function listSubfolders(parentId) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 100,
  });
  return res.data.files || [];
}

async function listImageFiles(folderId) {
  let files = [];
  let pageToken = undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: 'nextPageToken, files(id, name, webViewLink)',
      pageSize: 200,
      pageToken,
    });
    files = files.concat(res.data.files || []);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function downloadFileAsBase64(fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data).toString('base64');
}

// Note: the campaign list for the current client is injected at call time (see buildExtractionPrompt)
// so the model can match the reply to one of the client's REAL, currently-live campaigns by name -
// otherwise it either invented a plausible-looking name or left campaign context in freeform prose,
// both of which meant the frontend had nothing structured to render into the Campaign column.
export function buildExtractionPrompt(campaignNames) {
  const hasCampaigns = Array.isArray(campaignNames) && campaignNames.length > 0;
  const campaignBlock = hasCampaigns
    ? `The following campaigns are currently active for this client. Pick the ONE whose subject matter
best matches the outreach thread in the screenshot. Match on the substance of what's being asked
(products, use-cases, personas) - do NOT guess based on which name looks plausible. If none clearly
fits, use "":

${campaignNames.map((n, i) => `  ${i + 1}. ${n}`).join('\n')}

Return the campaign field as EXACTLY one of the strings above, character-for-character, or "".`
    : `No known campaigns for this client - return "" for the campaign field.`;

  return `You are looking at a screenshot from a sales outreach tool (Heddl), showing a reply
thread with a prospect. Extract the following as strict JSON, no other text:

{
  "contact": "Full name of the prospect who replied, with their company in parentheses if visible, e.g. 'Jane Doe (Acme Corp)'",
  "date": "The date of the most recent/relevant reply shown, in YYYY-MM-DD format. If year is ambiguous, assume 2026.",
  "heddlStatus": "One of exactly: Positive Reply, Meeting Booked, No Fit, Not Interested",
  "campaign": "The name of the campaign this reply belongs to - see the campaign list below",
  "notes": "One or two sentences summarizing what the reply actually said - quote short key phrases where useful, in third person, no more than 40 words. Do NOT restate the campaign name here; the campaign field already captures that."
}

Guidance for heddlStatus:
- "Meeting Booked": the reply confirms a scheduled call/meeting, or explicitly accepts a booking link
- "Positive Reply": the prospect engages substantively, asks a relevant question, gives useful information, or expresses interest - even if not the final decision-maker, as long as they're helpful or curious
- "No Fit": the prospect replies but says they're not the right person, wrong team, or the ask doesn't apply to their role - without a hostile or final "not interested" tone
- "Not Interested": a clear decline, "not interested", "no thanks", or similar

Guidance for campaign:
${campaignBlock}

If you cannot confidently identify a contact name or reply content in the image, respond with:
{"error": "could not extract - not a recognizable reply screenshot"}

Respond with ONLY the JSON object, nothing else.`;
}

async function classifyScreenshot(base64Image, mimeType, campaignNames) {
  const prompt = buildExtractionPrompt(campaignNames);
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  const text = msg.content.find((b) => b.type === 'text')?.text || '{}';
  return parseClassificationText(text);
}

function guessMimeType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

// ── Pure logic, exported for direct unit testing (no SDK/network mocking needed) ──

export function parseClassificationText(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

export function isValidClassification(extracted) {
  if (!extracted || extracted.error) return false;
  return HEDDL_STATUSES.includes(extracted.heddlStatus);
}

export function contactKey(client, contact) {
  return (client || '').trim().toLowerCase() + '::' + (contact || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function filterNewFiles(files, existingRefs) {
  const refsSet = existingRefs instanceof Set ? existingRefs : new Set(existingRefs);
  return files.filter((f) => !refsSet.has(f.name));
}

// Only accept the campaign value if it exactly matches one of the client's live campaign names,
// otherwise blank it. This is deliberately strict - a made-up or misspelled campaign in Firebase is
// worse than blank, because it can't be filtered on and won't roll up correctly in the pivot.
export function validateCampaign(extractedCampaign, campaignNames) {
  if (!extractedCampaign || typeof extractedCampaign !== 'string') return '';
  const list = Array.isArray(campaignNames) ? campaignNames : [];
  return list.includes(extractedCampaign) ? extractedCampaign : '';
}

export function buildEntry(clientName, file, extracted, campaignNames) {
  return {
    id: 'r_' + Math.random().toString(36).slice(2, 10),
    client: clientName,
    contact: extracted.contact || 'Unknown',
    date: extracted.date || new Date().toISOString().slice(0, 10),
    heddlStatus: extracted.heddlStatus,
    clientStatus: '',
    confirmed: false,
    campaign: validateCampaign(extracted.campaign, campaignNames),
    notes: extracted.notes || '',
    screenshotRef: file.name,
    screenshotUrl: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
  };
}

async function main() {
  init();
  console.log('Starting response refresh -', new Date().toISOString());

  const responsesSnap = await db.ref('getgtm_tracker/responses').once('value');
  const existingResponses = responsesSnap.val() || [];
  const existingRefs = new Set(existingResponses.map((r) => r.screenshotRef));
  // Content-based dedup: the same reply thread can get screenshotted more than once, producing a
  // new filename each time - filename dedup alone misses that. Track (client, contact) pairs too,
  // seeded from what's already logged, so a re-screenshotted thread is skipped instead of duplicated.
  const seenContactKeys = new Set(existingResponses.map((r) => contactKey(r.client, r.contact)));
  console.log(`${existingResponses.length} responses already logged in Firebase.`);

  // Load the campaign catalog once and group by client, so each client's replies get classified
  // against ONLY their own campaigns (avoids cross-client contamination in the model's choices).
  const campaignsSnap = await db.ref('getgtm_tracker/campaigns').once('value');
  const allCampaigns = campaignsSnap.val() || [];
  const campaignsByClient = {};
  allCampaigns.forEach((c) => {
    if (!c || !c.client || !c.name) return;
    if (!campaignsByClient[c.client]) campaignsByClient[c.client] = [];
    campaignsByClient[c.client].push(c.name);
  });
  console.log(`Loaded ${allCampaigns.length} campaign(s) across ${Object.keys(campaignsByClient).length} client(s).`);

  const clientFolders = await listSubfolders(DRIVE_RESPONSES_ROOT_ID);
  console.log(`Found ${clientFolders.length} client folder(s):`, clientFolders.map((f) => f.name).join(', '));

  const newEntries = [];

  for (const folder of clientFolders) {
    const clientName = folder.name;
    const clientCampaigns = campaignsByClient[clientName] || [];
    const files = await listImageFiles(folder.id);
    const newFiles = filterNewFiles(files, existingRefs);
    if (newFiles.length === 0) {
      console.log(`[${clientName}] no new screenshots (${clientCampaigns.length} known campaign(s)).`);
      continue;
    }
    console.log(`[${clientName}] ${newFiles.length} new screenshot(s) to process against ${clientCampaigns.length} known campaign(s).`);

    for (const file of newFiles) {
      try {
        const base64 = await downloadFileAsBase64(file.id);
        const mimeType = guessMimeType(file.name);
        const extracted = await classifyScreenshot(base64, mimeType, clientCampaigns);

        if (!isValidClassification(extracted)) {
          console.log(`  - ${file.name}: skipped (${extracted.error || 'invalid heddlStatus'})`);
          continue;
        }

        const key = contactKey(clientName, extracted.contact);
        if (seenContactKeys.has(key)) {
          console.log(`  - ${file.name}: skipped (duplicate - "${extracted.contact}" at ${clientName} already logged, likely the same thread screenshotted again)`);
          continue;
        }
        seenContactKeys.add(key);

        const entry = buildEntry(clientName, file, extracted, clientCampaigns);
        newEntries.push(entry);
        console.log(`  - ${file.name}: added as "${entry.contact}" (${entry.heddlStatus})${entry.campaign ? ' [campaign: ' + entry.campaign + ']' : ' [no campaign matched]'}`);
      } catch (err) {
        console.error(`  - ${file.name}: FAILED -`, err.message);
      }
    }
  }

  if (newEntries.length === 0) {
    console.log('No new entries to write. Done.');
    return;
  }

  const merged = existingResponses.concat(newEntries);
  await db.ref('getgtm_tracker/responses').set(merged);
  console.log(`Wrote ${newEntries.length} new response(s) to Firebase. Total now: ${merged.length}.`);
}

// Only run the live script when executed directly (e.g. `node scripts/refresh-responses.mjs` or via
// the GitHub Action) - not when imported by the test suite, so tests can exercise the pure functions
// above without needing real Drive/Firebase/Anthropic credentials.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}

