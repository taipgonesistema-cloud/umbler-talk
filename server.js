require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

const API_BASE = "https://app-utalk.umbler.com/api";
const TOKEN = process.env.UTALK_API_TOKEN;
const FROM_PHONE = process.env.FROM_PHONE;
const FROM_PHONE_2 = process.env.FROM_PHONE_2;
const ORG_ID = process.env.ORGANIZATION_ID;

const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + ext);
  }
});
const upload = multer({ storage });

const CSV_DIR = path.join(__dirname, "csv");
if (!fs.existsSync(CSV_DIR)) fs.mkdirSync(CSV_DIR, { recursive: true });

const REGISTRY_PATH = path.join(__dirname, "csv-registry.json");
let csvRegistry = [];
if (fs.existsSync(REGISTRY_PATH)) {
  try { csvRegistry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8")); } catch {}
}

function saveCsvRegistry() {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(csvRegistry, null, 2));
}

const csvStorage = multer.diskStorage({
  destination: CSV_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + ext);
  }
});
const uploadCsv = multer({
  storage: csvStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".csv") return cb(new Error("Apenas arquivos .csv são aceitos"));
    cb(null, true);
  }
});

function parseCsvLine(line) {
  const result = [];
  let current = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ""; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err}`);
  }
  return res.json();
}

async function apiFetchFormData(path, formData) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}` },
    body: formData,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err}`);
  }
  return res.json();
}

app.get("/api/me", async (req, res) => {
  try {
    const data = await apiFetch("/v1/members/me/");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tags", async (req, res) => {
  try {
    const { organizationId } = req.query;
    const data = await apiFetch(`/v1/tags/?organizationId=${organizationId}&Take=200`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/contacts", async (req, res) => {
  try {
    const { organizationId, tagIds } = req.query;
    let url = `/v1/contacts/?organizationId=${organizationId}&Take=1000`;
    if (tagIds) {
      const ids = tagIds.split(",");
      ids.forEach(id => { url += `&Tags.Values=${id}`; });
      url += "&Tags.Rule=ContainsAny";
    }
    const data = await apiFetch(url);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const activeJobs = new Map();
let jobIdCounter = 0;
const BATCH_SIZE = 50;
const BATCH_VARY = 15;
const BATCH_DELAY_MS = 720000;
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT) || 250;
const LARGE_LIST_THRESHOLD = 1000;
const SEND_WINDOWS = [
  { name: "Manhã", start: 8, end: 11 },
  { name: "Tarde", start: 13, end: 16 },
  { name: "Noite", start: 18, end: 21 },
];
const STATS_PATH = path.join(__dirname, "daily-stats.json");

function getDailyStats() {
  const today = new Date().toISOString().slice(0, 10);
  if (fs.existsSync(STATS_PATH)) {
    try { const s = JSON.parse(fs.readFileSync(STATS_PATH, "utf-8")); if (s.date === today) return s; } catch {}
  }
  return { date: today, sent: 0 };
}

function saveDailyStats(s) { fs.writeFileSync(STATS_PATH, JSON.stringify(s)); }

function getRemainingDaily() { return Math.max(0, DAILY_LIMIT - getDailyStats().sent); }

function recordSent(n) { const s = getDailyStats(); s.sent += n; saveDailyStats(s); }

function randomBatchSize() {
  return Math.max(1, BATCH_SIZE + Math.floor((Math.random() - 0.5) * 2 * BATCH_VARY));
}

function getRandomWindowTime(w) {
  const total = Math.floor(Math.random() * ((w.end - w.start) * 60));
  return { hour: w.start + Math.floor(total / 60), minute: total % 60 };
}

function getMsUntilTime(h, m) {
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}

const MIME_TYPES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".avi": "video/x-msvideo", ".mov": "video/quicktime",
  ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

async function sendSingleContact(contact, fromPhone, organizationId, message, scheduleAt, fileId) {
  function fileBlob(fp) {
    const ext = path.extname(fp).toLowerCase();
    const type = MIME_TYPES[ext] || "application/octet-stream";
    return new Blob([fs.readFileSync(fp)], { type });
  }
  const personalizedMsg = (message || "").replace(/\{\{nome\}\}/g, contact.name || "");
  if (scheduleAt) {
    const body = {
      dateSendAtUTC: scheduleAt,
      organizationId,
      toPhone: contact.phoneNumber,
      fromPhone,
      message: personalizedMsg,
    };
    if (fileId) {
      const filePath = path.join(UPLOADS_DIR, fileId);
      if (fs.existsSync(filePath)) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(body)) fd.append(k, v);
        fd.append("File", fileBlob(filePath), fileId);
        const result = await apiFetchFormData("/v1/scheduled-messages/", fd);
        return { phone: contact.phoneNumber, status: "scheduled", id: result.id, dateSendAtUtc: scheduleAt, contactName: contact.name };
      }
    }
    const result = await apiFetch("/v1/scheduled-messages/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { phone: contact.phoneNumber, status: "scheduled", id: result.id, dateSendAtUtc: scheduleAt, contactName: contact.name };
  } else {
    const body = {
      toPhone: contact.phoneNumber,
      fromPhone,
      organizationId,
      message: personalizedMsg,
      contactName: contact.name || undefined,
    };
    if (fileId) {
      const filePath = path.join(UPLOADS_DIR, fileId);
      if (fs.existsSync(filePath)) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(body)) fd.append(k, v);
        fd.append("File", fileBlob(filePath), fileId);
        const result = await apiFetchFormData("/v1/messages/simplified/", fd);
        return { phone: contact.phoneNumber, status: "ok", result };
      }
    }
    const result = await apiFetch("/v1/messages/simplified/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { phone: contact.phoneNumber, status: "ok", result };
  }
}


function processBatch(job) {
  let size = Math.min(randomBatchSize(), job.contacts.length - job.processed);
  if (size <= 0) return Promise.resolve();
  const batch = job.contacts.slice(job.processed, job.processed + size);
  return Promise.allSettled(
    batch.map(c => sendSingleContact(c, job.fromPhone, job.organizationId, job.message, job.scheduleAt, job.fileId).then(r => {
      job.results.push(r);
      if (r.status === "ok") job.sent++;
      else if (r.status === "scheduled") { job.scheduled++; job.scheduledItems.push({ id: r.id, phone: r.phone, dateSendAtUtc: r.dateSendAtUtc, contactName: r.contactName }); }
      return r;
    }).catch(err => {
      job.results.push({ phone: c.phoneNumber, status: "error", error: err.message });
      job.failed++;
    }))
  ).then((results) => {
    job.processed += batch.length;
    job.progress = Math.round((job.processed / job.contacts.length) * 100);
    job.lastBatch = batch.map(c => c.phoneNumber);
    const sentNow = results.filter(r => r.status === "fulfilled" && r.value && (r.value.status === "ok" || r.value.status === "scheduled")).length;
    if (sentNow > 0) recordSent(sentNow);
  });
}

function startBackgroundJob(job) {
  const isLarge = job.contacts.length > LARGE_LIST_THRESHOLD;
  function cleanupFile() {
    if (job.fileId) { const fp = path.join(UPLOADS_DIR, job.fileId); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  }

  if (isLarge) {
    // === DAILY SCHEDULE MODE (listas grandes) ===
    function calcDaysRemaining() {
      return Math.ceil((job.contacts.length - job.processed) / DAILY_LIMIT);
    }
    function scheduleDay() {
      if (job.cancelled) { job.status = "cancelled"; cleanupFile(); return; }
      job.daysRemaining = calcDaysRemaining();
      const remaining = getRemainingDaily();
      const left = job.contacts.length - job.processed;
      if (left <= 0) { job.status = "done"; job.finishedAt = new Date().toISOString(); cleanupFile(); return; }
      if (remaining <= 0) {
        const ms = getMsUntilTime(SEND_WINDOWS[0].start, 0);
        job.status = "waiting"; job.nextWindow = "Amanhã (" + SEND_WINDOWS[0].name + ")";
        job.timeout = setTimeout(scheduleDay, ms); return;
      }
      const canSend = Math.min(left, remaining);
      const perWindow = Math.max(1, Math.ceil(canSend / 3));
      const windows = SEND_WINDOWS.map(w => ({ w, t: getRandomWindowTime(w) }));
      scheduleWindow(0, windows, perWindow);
    }

    function scheduleWindow(idx, windows, perWindow) {
      if (idx >= 3 || job.cancelled) { scheduleDay(); return; }
      const w = windows[idx];
      const ms = getMsUntilTime(w.t.hour, w.t.minute);
      const label = w.w.name + " " + String(w.t.hour).padStart(2, "0") + ":" + String(w.t.minute).padStart(2, "0");
      job.status = "waiting"; job.nextWindow = label;
      job.timeout = setTimeout(async () => {
        if (job.cancelled) { job.status = "cancelled"; cleanupFile(); return; }
        job.status = "running"; job.nextWindow = null;
        const batchSize = Math.min(perWindow, job.contacts.length - job.processed, getRemainingDaily());
        if (batchSize > 0) {
          const batch = job.contacts.slice(job.processed, job.processed + batchSize);
          await Promise.allSettled(batch.map(c => sendSingleContact(c, job.fromPhone, job.organizationId, job.message, job.scheduleAt, job.fileId).then(r => {
            job.results.push(r);
            if (r.status === "ok") job.sent++; else if (r.status === "scheduled") { job.scheduled++; job.scheduledItems.push({ id: r.id, phone: r.phone, dateSendAtUtc: r.dateSendAtUtc, contactName: r.contactName }); }
            return r;
          }).catch(err => { job.results.push({ phone: c.phoneNumber, status: "error", error: err.message }); job.failed++; })));
          const sentNow = batch.filter((_, i) => {
            const r = job.results[job.results.length - batch.length + i];
            return r && (r.status === "ok" || r.status === "scheduled");
          }).length;
          if (sentNow > 0) recordSent(sentNow);
          job.processed += batch.length;
          job.progress = Math.round((job.processed / job.contacts.length) * 100);
        }
        scheduleWindow(idx + 1, windows, perWindow);
      }, ms);
    }
    scheduleDay();

  } else {
    // === CONTINUOUS MODE (listas pequenas) ===
    function nextBatch() {
      if (job.cancelled) { job.status = "cancelled"; cleanupFile(); return; }
      processBatch(job).then(() => {
        if (job.processed >= job.contacts.length) {
          job.status = "done"; job.finishedAt = new Date().toISOString(); cleanupFile();
        } else {
          job.status = "waiting"; job.nextWindow = null;
          job.timeout = setTimeout(nextBatch, BATCH_DELAY_MS);
        }
      });
    }
    nextBatch();
  }
}

app.post("/api/send-bulk", async (req, res) => {
  try {
    const { contacts, fromPhone, organizationId, message, scheduleAt } = req.body;
    if (!contacts || !contacts.length) return res.status(400).json({ error: "Nenhum contato" });

    if (contacts.length <= BATCH_SIZE) {
      const results = await Promise.allSettled(
        contacts.map(c => sendSingleContact(c, fromPhone, organizationId, message, scheduleAt, req.body.fileId)
          .then(r => r)
          .catch(err => ({ phone: c.phoneNumber, status: "error", error: err.message }))
        )
      );
      const items = results.map(r => r.status === "fulfilled" ? r.value : r.reason);
      const sentCount = items.filter(r => r.status === "ok" || r.status === "scheduled").length;
      if (sentCount > 0) recordSent(sentCount);
      return res.json({
        sent: items.filter(r => r.status === "ok").length,
        scheduled: items.filter(r => r.status === "scheduled").length,
        failed: items.filter(r => r.status === "error").length,
        scheduledItems: items.filter(r => r.status === "scheduled").map(r => ({ id: r.id, phone: r.phone, dateSendAtUtc: r.dateSendAtUtc, contactName: r.contactName })),
        results: items, dailyStats: getDailyStats(), dailyLimit: DAILY_LIMIT
      });
    }

    const jobId = ++jobIdCounter;
    const job = {
      id: jobId,
      status: "running",
      progress: 0, sent: 0, scheduled: 0, failed: 0, processed: 0,
      results: [],
      scheduledItems: [],
      contacts, fromPhone, organizationId, message, scheduleAt,
      fileId: req.body.fileId || null,
      lastBatch: [],
      cancelled: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      timeout: null,
      nextWindow: null,
      daysRemaining: null
    };
    activeJobs.set(jobId, job);
    startBackgroundJob(job);
    res.json({ jobId, total: contacts.length, batchSize: BATCH_SIZE, batchDelayMs: BATCH_DELAY_MS, dailyStats: getDailyStats(), dailyLimit: DAILY_LIMIT });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/bulk-status/:jobId", (req, res) => {
  const job = activeJobs.get(parseInt(req.params.jobId));
  if (!job) return res.status(404).json({ error: "Job nao encontrado" });
  res.json({
    jobId: job.id, status: job.status, progress: job.progress,
    sent: job.sent, scheduled: job.scheduled, failed: job.failed,
    total: job.contacts.length, processed: job.processed,
    lastBatch: job.lastBatch, nextWindow: job.nextWindow,
    daysRemaining: job.daysRemaining,
    scheduledItems: job.scheduledItems,
    startedAt: job.startedAt, finishedAt: job.finishedAt
  });
});

app.get("/api/bulk-jobs", (req, res) => {
  const list = [];
  for (const job of activeJobs.values()) {
    list.push({
      jobId: job.id, status: job.status, progress: job.progress,
      sent: job.sent, scheduled: job.scheduled, failed: job.failed,
      total: job.contacts.length, processed: job.processed,
      nextWindow: job.nextWindow, daysRemaining: job.daysRemaining,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
      organizationId: job.organizationId
    });
  }
  list.sort((a, b) => b.jobId - a.jobId);
  res.json(list);
});

app.get("/api/daily-stats", (req, res) => {
  res.json({ ...getDailyStats(), dailyLimit: DAILY_LIMIT, remaining: getRemainingDaily() });
});

// cleanup old jobs every 5 min
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [id, job] of activeJobs) {
    if ((job.status === "done" || job.status === "cancelled") && new Date(job.finishedAt).getTime() < cutoff) {
      if (job.timeout) clearTimeout(job.timeout);
      activeJobs.delete(id);
    }
  }
}, 300000);

// cleanup orphaned uploads (no job associated) older than 1h
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  const usedFiles = new Set();
  for (const job of activeJobs.values()) {
    if (job.fileId) usedFiles.add(job.fileId);
  }
  if (fs.existsSync(UPLOADS_DIR)) {
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const fp = path.join(UPLOADS_DIR, f);
      try {
        if (!usedFiles.has(f) && fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {}
    }
  }
}, 300000);

app.get("/api/quick-answers", async (req, res) => {
  try {
    const { organizationId } = req.query;
    const data = await apiFetch(`/v1/quick-answers/?organizationId=${organizationId}&Take=200`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });
  res.json({ fileId: req.file.filename, originalName: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size });
});

app.get("/api/file/:fileId", (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.fileId);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Arquivo nao encontrado" });
  res.sendFile(filePath);
});

app.get("/api/config", (req, res) => {
  const phones = [FROM_PHONE];
  if (FROM_PHONE_2) phones.push(FROM_PHONE_2);
  res.json({ fromPhones: phones.filter(Boolean) });
});

app.delete("/api/scheduled/:id", async (req, res) => {
  try {
    const { organizationId } = req.query;
    await apiFetch(`/v1/scheduled-messages/${req.params.id}/?organizationId=${organizationId}`, { method: "DELETE" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/csv/upload", (req, res) => {
  uploadCsv.single("file")(req, res, function (err) {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      originalName: req.file.originalname,
      filename: req.file.filename,
      size: req.file.size,
      uploadedAt: new Date().toISOString(),
      contactCount: 0
    };
    try {
      const content = fs.readFileSync(path.join(CSV_DIR, entry.filename), "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      entry.contactCount = Math.max(0, lines.length - 1);
    } catch {}
    csvRegistry.push(entry);
    saveCsvRegistry();
    res.json(entry);
  });
});

app.get("/api/csv/list", (req, res) => {
  res.json(csvRegistry.slice().reverse());
});

app.get("/api/csv/template", (req, res) => {
  const template = 'name,phoneNumber\nJoão Silva,5538991072975\nMaria Santos,5538999493213\nCarlos Oliveira,553800000000';
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=modelo-contatos.csv");
  res.send(template);
});

app.get("/api/csv/:id/download", (req, res) => {
  const entry = csvRegistry.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "CSV não encontrado" });
  const fp = path.join(CSV_DIR, entry.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Arquivo não encontrado no disco" });
  res.download(fp, entry.originalName);
});

app.delete("/api/csv/:id", (req, res) => {
  const idx = csvRegistry.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "CSV não encontrado" });
  const entry = csvRegistry[idx];
  const fp = path.join(CSV_DIR, entry.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  csvRegistry.splice(idx, 1);
  saveCsvRegistry();
  res.json({ ok: true });
});

app.get("/api/csv/:id/contacts", (req, res) => {
  const entry = csvRegistry.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "CSV não encontrado" });
  const fp = path.join(CSV_DIR, entry.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Arquivo não encontrado no disco" });
  const content = fs.readFileSync(fp, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return res.json({ contacts: [], total: 0 });
  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase());
  const nameIdx = headers.indexOf("name") >= 0 ? headers.indexOf("name") : headers.indexOf("nome");
  const phoneIdx = headers.indexOf("phonenumber") >= 0 ? headers.indexOf("phonenumber")
    : headers.indexOf("telefone") >= 0 ? headers.indexOf("telefone")
    : headers.indexOf("phone") >= 0 ? headers.indexOf("phone") : -1;
  if (phoneIdx === -1) return res.status(400).json({ error: "CSV deve ter coluna 'phoneNumber' ou 'telefone'" });
  const contacts = lines.slice(1).map(line => {
    const cols = parseCsvLine(line).map(c => c.replace(/^"|"$/g, ""));
    const phone = (cols[phoneIdx] || "").replace(/[\s\-\+\(\)]/g, "");
    return { name: nameIdx >= 0 ? cols[nameIdx] : "", phoneNumber: phone };
  }).filter(c => c.phoneNumber.length >= 10);
  res.json({ contacts, total: contacts.length, fileName: entry.originalName });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  if (!TOKEN) console.log("AVISO: Configure UTALK_API_TOKEN no .env");
  if (!FROM_PHONE) console.log("AVISO: Configure FROM_PHONE no .env");
});
