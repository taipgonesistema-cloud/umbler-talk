require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const API_BASE = "https://app-utalk.umbler.com/api";
const TOKEN = process.env.UTALK_API_TOKEN;
const FROM_PHONE = process.env.FROM_PHONE;
const FROM_PHONE_2 = process.env.FROM_PHONE_2;
const ORG_ID = process.env.ORGANIZATION_ID;

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

app.post("/api/send-bulk", async (req, res) => {
  try {
    const { contacts, fromPhone, organizationId, message } = req.body;
    const results = [];
    for (const contact of contacts) {
      try {
        const personalizedMsg = (message || "").replace(/\{\{nome\}\}/g, contact.name || "");
        if (req.body.scheduleAt) {
          const result = await apiFetch("/v1/scheduled-messages/", {
            method: "POST",
            body: JSON.stringify({
              dateSendAtUTC: req.body.scheduleAt,
              organizationId,
              toPhone: contact.phoneNumber,
              fromPhone,
              message: personalizedMsg,
            }),
          });
          results.push({ phone: contact.phoneNumber, status: "scheduled", id: result.id, dateSendAtUtc: req.body.scheduleAt, contactName: contact.name });
        } else {
          const result = await apiFetch("/v1/messages/simplified/", {
            method: "POST",
            body: JSON.stringify({
              toPhone: contact.phoneNumber,
              fromPhone,
              organizationId,
              message: personalizedMsg,
              contactName: contact.name || undefined,
            }),
          });
          results.push({ phone: contact.phoneNumber, status: "ok", result });
        }
      } catch (err) {
        results.push({ phone: contact.phoneNumber, status: "error", error: err.message });
      }
    }
    res.json({
      sent: results.filter(r => r.status === "ok").length,
      scheduled: results.filter(r => r.status === "scheduled").length,
      failed: results.filter(r => r.status === "error").length,
      scheduledItems: results.filter(r => r.status === "scheduled").map(r => ({ id: r.id, phone: r.phone, dateSendAtUtc: r.dateSendAtUtc, contactName: r.contactName })),
      results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  if (!TOKEN) console.log("AVISO: Configure UTALK_API_TOKEN no .env");
  if (!FROM_PHONE) console.log("AVISO: Configure FROM_PHONE no .env");
});
