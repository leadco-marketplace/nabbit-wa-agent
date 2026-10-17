/**
 * Nabbit WhatsApp Agent — the in-house replacement for the external "Grokbot".
 *
 * Runs on an always-on VPS, QR-linked to a DEDICATED WhatsApp number. It:
 *   1. connects to WhatsApp (Baileys) + keeps the session alive 24/7,
 *   2. reports its group membership + online status back to Nabbit,
 *   3. polls Nabbit's send queue and sends each message with a jittered gap
 *      (and a business-hours guard for cold-outreach DMs),
 *   4. reports sent/failed so the admin stats update.
 *
 * Nabbit admin controls WHAT and HOW FAST (the enqueue cron paces cold outreach
 * to ~25/day inside 9–17). This worker just drains the queue politely.
 *
 * ⚑ Use a dedicated number you're willing to lose. Cold WhatsApp outreach is
 * against Meta policy; low volume + pacing is what keeps the number alive.
 *
 * ENV (see .env.example):
 *   NABBIT_BASE       https://www.nabbitmarketplace.com
 *   WA_AGENT_SECRET   must equal WA_AGENT_SECRET set on the Nabbit Vercel project
 *   WORKER_ID         a label for this bot (default "vps-1")
 *   MIN_GAP_SEC / MAX_GAP_SEC   polite gap between any two sends (default 35/95)
 *   POLL_SEC          how often to check the queue when idle (default 20)
 *   WA_HOURS_START / WA_HOURS_END   send-window for OUTREACH DMs, local (default 9/17)
 */
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import fs from "node:fs";

const BASE = (process.env.NABBIT_BASE || "https://www.nabbitmarketplace.com").replace(/\/+$/, "");
const SECRET = process.env.WA_AGENT_SECRET || "";
const WORKER_ID = process.env.WORKER_ID || "vps-1";
const MIN_GAP = (parseInt(process.env.MIN_GAP_SEC || "35", 10) || 35) * 1000;
const MAX_GAP = (parseInt(process.env.MAX_GAP_SEC || "95", 10) || 95) * 1000;
const POLL = (parseInt(process.env.POLL_SEC || "20", 10) || 20) * 1000;
const HOURS_START = parseInt(process.env.WA_HOURS_START || "9", 10);
const HOURS_END = parseInt(process.env.WA_HOURS_END || "17", 10);
const AUTH_DIR = process.env.AUTH_DIR || "./auth";

// A 401 "loggedOut" means the stored session is invalid (e.g. left over from a
// failed pairing attempt). Wiping it lets the next connect start clean and
// request a fresh, working pairing code / QR.
function wipeAuth() {
  // Delete the CONTENTS of AUTH_DIR, not the dir itself — on Railway the volume
  // is mounted AT /app/auth, so removing the dir fails with EBUSY. Clearing the
  // session files inside it is what actually re-links clean.
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const name of fs.readdirSync(AUTH_DIR)) {
      fs.rmSync(`${AUTH_DIR}/${name}`, { recursive: true, force: true });
    }
    console.log("cleared stale auth — re-linking fresh");
  } catch (e) {
    console.warn(`could not clear auth dir: ${e.message}`);
  }
}

if (!SECRET) {
  console.error("WA_AGENT_SECRET is required (must match the Nabbit env var). Exiting.");
  process.exit(1);
}

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => MIN_GAP + Math.floor(Math.random() * Math.max(1, MAX_GAP - MIN_GAP));

let sock = null;
let connected = false;
let lastSentAt = 0;

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SECRET}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

const heartbeat = (patch) =>
  api("/api/wa-agent/heartbeat", { method: "POST", body: patch }).catch((e) => log.warn(e.message));

async function syncGroups() {
  try {
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all || {}).map((g) => ({ jid: g.id, name: g.subject || "" }));
    await api("/api/wa-agent/groups", { method: "POST", body: { number: myNumber(), groups } });
    log.info(`synced ${groups.length} groups`);
  } catch (e) {
    log.warn(`group sync failed: ${e.message}`);
  }
}

function myNumber() {
  try {
    return (sock?.user?.id || "").split(":")[0] || null;
  } catch {
    return null;
  }
}

function withinOutreachHours() {
  const h = new Date().getHours();
  return h >= HOURS_START && h < HOURS_END;
}

// ── Inbound replies → the Nabbit concierge brain ─────────────────────────────
// When someone REPLIES to this number, hand the text to Nabbit's full-knowledge
// WhatsApp brain (same as the main line) and send back whatever it returns.
const replying = new Set(); // per-sender in-flight guard (no double-answers)

function textOf(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  ).trim();
}

async function handleInbound(upsert) {
  if (!upsert || upsert.type !== "notify") return;
  for (const msg of upsert.messages || []) {
    const jid = msg.key?.remoteJid || "";
    // Only direct messages from other people (not our own sends, not groups/status).
    if (msg.key?.fromMe) continue;
    if (!jid.endsWith("@s.whatsapp.net")) continue;
    const text = textOf(msg.message);
    if (!text) continue;
    if (replying.has(jid)) continue;

    replying.add(jid);
    try {
      const from = jid.split("@")[0];
      const name = msg.pushName || null;
      const { reply } = await api("/api/wa-agent/reply", { method: "POST", body: { from, text, name } });
      if (reply) {
        await sleep(1200 + Math.floor(Math.random() * 1500)); // small human-like pause
        await sock.sendMessage(jid, { text: reply });
        log.info(`replied to ${from}`);
      }
    } catch (e) {
      log.warn(`reply failed for ${jid}: ${e.message}`);
    } finally {
      replying.delete(jid);
    }
  }
}

async function sendJob(job) {
  // Cold-outreach DMs only go out in business hours; lead fan-out is real-time.
  if (job.kind === "outreach" && !withinOutreachHours()) return; // leave it pending for later

  const jid =
    job.destType === "group"
      ? job.dest
      : `${String(job.dest).replace(/[^0-9]/g, "")}@s.whatsapp.net`;

  // Polite gap with jitter since the last send (defense-in-depth on top of the
  // enqueue pacing) so we never fire two messages back-to-back.
  const wait = lastSentAt + jitter() - Date.now();
  if (wait > 0) await sleep(wait);

  try {
    // With an image, send it as a photo with the text as the caption; else plain text.
    if (job.mediaUrl) {
      await sock.sendMessage(jid, { image: { url: job.mediaUrl }, caption: job.message });
    } else {
      await sock.sendMessage(jid, { text: job.message });
    }
    lastSentAt = Date.now();
    await api("/api/wa-agent/report", { method: "POST", body: { jobId: job.id, status: "sent" } });
    log.info(`sent ${job.kind} → ${job.dest}`);
  } catch (e) {
    await api("/api/wa-agent/report", {
      method: "POST",
      body: { jobId: job.id, status: "failed", error: e.message },
    }).catch(() => {});
    log.warn(`send failed → ${job.dest}: ${e.message}`);
  }
}

async function pollLoop() {
  // one job at a time keeps sends naturally serialized + paced
  for (;;) {
    if (connected) {
      try {
        const { jobs } = await api(`/api/wa-agent/poll?limit=1&worker=${encodeURIComponent(WORKER_ID)}`);
        if (jobs && jobs.length) {
          await sendJob(jobs[0]);
          continue; // immediately look for the next (sendJob enforces the gap)
        }
      } catch (e) {
        log.warn(`poll error: ${e.message}`);
      }
    }
    await sleep(POLL);
  }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    // A STANDARD browser identity — a custom name makes pairing-code linking
    // fail with "Couldn't link device". Ubuntu/Chrome is the reliable choice.
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  // Someone replied to this number → answer with the Nabbit concierge brain.
  sock.ev.on("messages.upsert", (u) => { handleInbound(u).catch((e) => log.warn(`inbound handler: ${e.message}`)); });

  // PAIRING-CODE LINKING (easier than scanning a QR from a log viewer).
  // Set WA_PAIR_NUMBER to the dedicated number in international format, digits
  // only (e.g. 15551234567). On first boot the bot prints an 8-char code; on
  // the phone: WhatsApp → Settings → Linked Devices → Link a Device →
  // "Link with phone number instead" → enter the code. Once linked, the
  // session persists on the volume and this never runs again.
  const pairNumber = (process.env.WA_PAIR_NUMBER || "").replace(/[^0-9]/g, "");
  if (pairNumber && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(pairNumber);
        const pretty = code?.match(/.{1,4}/g)?.join("-") || code;
        console.log(
          `\n========================================\n` +
            `  WHATSAPP PAIRING CODE:  ${pretty}\n` +
            `  On the dedicated phone: WhatsApp → Settings → Linked Devices →\n` +
            `  Link a Device → "Link with phone number instead" → enter the code.\n` +
            `========================================\n`
        );
      } catch (e) {
        log.warn(`pairing code request failed: ${e.message} (falling back to QR)`);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log("\nScan this QR with WhatsApp (Linked Devices) on the DEDICATED number:\n");
      qrcode.generate(qr, { small: true });
      heartbeat({ online: false, qr_pending: true });
    }
    if (connection === "open") {
      connected = true;
      log.info(`connected as ${myNumber()}`);
      heartbeat({ online: true, qr_pending: false, number: myNumber() });
      syncGroups();
    }
    if (connection === "close") {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      heartbeat({ online: false, qr_pending: false });
      log.warn(`connection closed (${code}); ${loggedOut ? "logged out — clearing stale session and re-linking" : "reconnecting"}`);
      // Self-heal: a 401 logout usually means a poisoned/stale session on the
      // volume. Wipe it and reconnect clean so a fresh pairing code works.
      if (loggedOut) wipeAuth();
      setTimeout(connect, 3000);
    }
  });

  // Periodic group resync (groups change over time).
  setInterval(() => connected && syncGroups(), 1000 * 60 * 30);
}

connect().then(pollLoop);
