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
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

const BASE = (process.env.NABBIT_BASE || "https://www.nabbitmarketplace.com").replace(/\/+$/, "");
const SECRET = process.env.WA_AGENT_SECRET || "";
const WORKER_ID = process.env.WORKER_ID || "vps-1";
const MIN_GAP = (parseInt(process.env.MIN_GAP_SEC || "35", 10) || 35) * 1000;
const MAX_GAP = (parseInt(process.env.MAX_GAP_SEC || "95", 10) || 95) * 1000;
const POLL = (parseInt(process.env.POLL_SEC || "20", 10) || 20) * 1000;
const HOURS_START = parseInt(process.env.WA_HOURS_START || "9", 10);
const HOURS_END = parseInt(process.env.WA_HOURS_END || "17", 10);

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
    await sock.sendMessage(jid, { text: job.message });
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
  const { state, saveCreds } = await useMultiFileAuthState(process.env.AUTH_DIR || "./auth");
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Nabbit Agent", "Chrome", "1.0"],
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

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
      log.warn(`connection closed (${code}); ${loggedOut ? "logged out — delete ./auth and re-link" : "reconnecting"}`);
      if (!loggedOut) setTimeout(connect, 3000);
    }
  });

  // Periodic group resync (groups change over time).
  setInterval(() => connected && syncGroups(), 1000 * 60 * 30);
}

connect().then(pollLoop);
