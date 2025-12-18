// ================== BOOT ==================
import dotenv from "dotenv";
dotenv.config({ override: true, path: process.env.DOTENV_PATH || ".env" });

import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import OpenAI, { toFile } from "openai";

// ================== APP ==================
const app = express();

// 🔴 IMPORTANTE: UM ÚNICO body parser (com rawBody p/ OpenPix)
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// ================== CONFIG ==================
const PORT = Number(process.env.PORT || 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const SHOP_PUBLIC_DOMAIN = (process.env.SHOP_PUBLIC_DOMAIN || "https://3dfans.com.br").replace(/\/+$/, "");

const PREVIEW_CHECKOUT_URL = (process.env.PREVIEW_CHECKOUT_URL || "https://3dfans.short.gy/miniatura").trim();
const OPENPIX_WEBHOOK_SECRET = (process.env.OPENPIX_WEBHOOK_SECRET || "").trim();

const DEBUG = String(process.env.DEBUG || "").toLowerCase() === "true";

console.log("ENV CHECK:", {
  OPENAI_API_KEY: !!OPENAI_API_KEY,
  ZAPI_INSTANCE: !!ZAPI_INSTANCE,
  ZAPI_TOKEN: !!ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN: !!ZAPI_CLIENT_TOKEN,
  SHOPIFY_DOMAIN: !!SHOPIFY_DOMAIN,
  SHOPIFY_STOREFRONT_TOKEN: !!SHOPIFY_STOREFRONT_TOKEN,
  PREVIEW_CHECKOUT_URL,
  OPENPIX_WEBHOOK_SECRET: !!OPENPIX_WEBHOOK_SECRET,
  PORT,
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ================== UTILS ==================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onlyDigits = (v) => String(v || "").replace(/\D/g, "");
const normalizePhone = (p) => {
  const d = onlyDigits(p);
  return d.startsWith("55") ? d : `55${d}`;
};

// ================== Z-API ==================
const zapiHeaders = () => ({
  "client-token": ZAPI_CLIENT_TOKEN,
  "Content-Type": "application/json",
});

async function zapiSendText(phoneRaw, message) {
  const phone = normalizePhone(phoneRaw);
  try {
    await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      { phone, message },
      { headers: zapiHeaders(), timeout: 20000 }
    );
  } catch (e) {
    console.error("❌ Z-API ERROR:", e?.response?.data || e?.message);
  }
}

// ================== OPENPIX ==================
function verifyOpenPixSignature({ secret, rawBody, signature }) {
  if (!secret || !rawBody || !signature) return false;
  const expected = crypto.createHmac("sha1", secret).update(rawBody, "utf8").digest("base64");
  return expected === signature;
}

// ================== WEBHOOK Z-API ==================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Z-API exige resposta imediata

  try {
    if (DEBUG) {
      console.log("📩 WEBHOOK RECEBIDO:", JSON.stringify(req.body, null, 2));
    }

    const phone = req.body?.phone || req.body?.data?.phone || req.body?.from;
    const text = req.body?.message || req.body?.data?.message || "";

    if (!phone) return;

    await zapiSendText(phone, "🚀 Webhook ativo! Mensagem recebida com sucesso.");
  } catch (err) {
    console.error("❌ ERRO WEBHOOK:", err?.message || err);
  }
});

// ================== OPENPIX WEBHOOK ==================
app.post("/openpix/webhook", (req, res) => {
  const signature = req.headers["x-openpix-signature"];
  const rawBody = req.rawBody || "";

  const ok = verifyOpenPixSignature({
    secret: OPENPIX_WEBHOOK_SECRET,
    rawBody,
    signature,
  });

  if (!ok) return res.sendStatus(401);

  console.log("💰 OPENPIX OK:", req.body);
  return res.sendStatus(200);
});

app.get("/openpix/webhook", (_req, res) => res.sendStatus(200));

// ================== HEALTH ==================
app.get("/", (_req, res) => res.send("🚀 3DFANS webhook online"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ================== LISTEN ==================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
