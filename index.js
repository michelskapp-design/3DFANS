import dotenv from "dotenv";
dotenv.config({ override: true, path: process.env.DOTENV_PATH || ".env" });


import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import OpenAI, { toFile } from "openai";

/* ================== APP ================== */
const app = express();
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString(); // ✅ importante p/ assinatura OpenPix
    },
  })
);

app.use(express.urlencoded({ extended: true, limit: "2mb" }));
// ✅ Body parsers (garante que req.body venha preenchido)

/* ================== CONFIG ================== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const SHOP_PUBLIC_DOMAIN = (process.env.SHOP_PUBLIC_DOMAIN || "https://3dfans.com.br").replace(/\/+$/, "");

const APPMAX_LINK_16 = (process.env.APPMAX_LINK_16 || "").trim();
const APPMAX_LINK_21 = (process.env.APPMAX_LINK_21 || "").trim();

const APPMAX_BASE_URL = (process.env.APPMAX_BASE_URL || "https://admin.appmax.com.br/api/v3").replace(/\/+$/, "");
const APPMAX_ACCESS_TOKEN = (process.env.APPMAX_ACCESS_TOKEN || "").trim();

const PORT = Number(process.env.PORT || 3000);

/** Prévia (taxa) - base (QR estático) */
const PREVIEW_FEE_BASE_CENTS = 990; // R$9,90 base
const PREVIEW_FEE_BRL_BASE = "R$9,90";

/** Checkout da prévia (se você usa um link/landing para mostrar QR) */
const PREVIEW_CHECKOUT_URL = (process.env.PREVIEW_CHECKOUT_URL || "https://3dfans.short.gy/miniatura").trim();

/** OpenPix/Woovi webhook secret (para validar X-OpenPix-Signature) */
const OPENPIX_WEBHOOK_SECRET = (process.env.OPENPIX_WEBHOOK_SECRET || "").trim();

/** Debug */
const DEBUG = String(process.env.DEBUG || "").toLowerCase() === "true";

/** Admin phones para ensinar (ex: "5511999999999,5511988887777") */
const ADMIN_PHONES = new Set(
  String(process.env.ADMIN_PHONES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

console.log("ENV CHECK:", {
  OPENAI_API_KEY: !!OPENAI_API_KEY,
  ZAPI_INSTANCE: !!ZAPI_INSTANCE,
  ZAPI_TOKEN: !!ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN: !!ZAPI_CLIENT_TOKEN,
  SHOPIFY_DOMAIN: !!SHOPIFY_DOMAIN,
  SHOPIFY_STOREFRONT_TOKEN: !!SHOPIFY_STOREFRONT_TOKEN,
  SHOP_PUBLIC_DOMAIN,
  APPMAX_LINK_16: !!APPMAX_LINK_16,
  APPMAX_LINK_21: !!APPMAX_LINK_21,
  APPMAX_BASE_URL,
  APPMAX_ACCESS_TOKEN: !!APPMAX_ACCESS_TOKEN,
  PREVIEW_CHECKOUT_URL,
  OPENPIX_WEBHOOK_SECRET: !!OPENPIX_WEBHOOK_SECRET,
  ADMIN_PHONES: ADMIN_PHONES.size,
  DEBUG,
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ================== LOG GLOBAL (DEBUG) ================== */
if (DEBUG) {
  app.use((req, _res, next) => {
    console.log("➡️ IN:", req.method, req.url);
    next();
  });
}

/* ================== PROMPTS EXTERNOS ================== */
const PROMPTS_DIR = path.resolve(process.cwd(), "prompts");
const SYSTEM_TXT_PATH = path.join(PROMPTS_DIR, "system.txt");
const REPLIES_JSON_PATH = path.join(PROMPTS_DIR, "replies.json");

let SYSTEM_PROMPT = "";
let REPLIES = {};

const FALLBACK_SYSTEM = `Você é o atendente da 3DFANS no WhatsApp.`;
const FALLBACK_REPLIES = {
  welcome: "Olá{nome}! 😊 O que você procura hoje?\n\n1️⃣ Mascotes de time de futebol\n2️⃣ Miniaturas personalizadas\n\nResponda com 1 ou 2.",
  menuMascote: "Show! ⚽ Temos mascotes 10cm, 16cm e 21cm.\n📸 As fotos são reais do produto.\nMe diga qual time você quer.",
  menuMiniatura: "Perfeito 😊 Conte-me o que você quer transformar em miniatura.\n📸 Envie a foto por aqui mesmo.\nTamanhos: 16cm ou 21cm.",
  prazoMiniatura: "Levamos até 7 dias úteis para produzir, pintar e embalar para envio.",
};

function loadPrompts() {
  try {
    SYSTEM_PROMPT = fs.readFileSync(SYSTEM_TXT_PATH, "utf8").trim() || FALLBACK_SYSTEM;
  } catch {
    SYSTEM_PROMPT = FALLBACK_SYSTEM;
  }

  try {
    const json = JSON.parse(fs.readFileSync(REPLIES_JSON_PATH, "utf8"));
    REPLIES = Object.keys(json).length ? json : FALLBACK_REPLIES;
  } catch {
    REPLIES = FALLBACK_REPLIES;
  }
}
loadPrompts();
try {
  fs.watch(PROMPTS_DIR, () => loadPrompts());
} catch {}

/* ================== UTILS ================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function normalize(t) {
  return String(t || "").toLowerCase().trim();
}

function normalizePhone(phone) {
  const digits = onlyDigits(phone);
  if (!digits) return "";
  return digits.startsWith("55") ? digits : `55${digits}`;
}

function centsToBRL(cents) {
  const v = Number(cents || 0) / 100;
  return `R$${v.toFixed(2).replace(".", ",")}`;
}

/* ================== OPENPIX SIGNATURE (HMAC-SHA1 base64) ================== */
function getHeader(req, name) {
  return req.headers?.[String(name).toLowerCase()] || req.headers?.[name] || "";
}

function verifyOpenPixSignature({ secret, rawBody, signature }) {
  if (!secret || !rawBody || !signature) return false;

  const expected = crypto.createHmac("sha1", secret).update(rawBody, "utf8").digest("base64");

  const a = Buffer.from(String(signature));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ================== DATA DIR (ARQUIVOS) ================== */
const DATA_DIR = path.resolve(process.cwd(), "data");
const MEMORY_PATH = path.join(DATA_DIR, "memory.json");
const REFS_PATH = path.join(DATA_DIR, "refs.json");

// ✅ CSV de clientes
const CSV_PATH = path.join(DATA_DIR, "clientes.csv");

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

/* ================== ✅ SALVAR CLIENTE NO CSV (SEM DUPLICAR) ================== */
function csvHasPhone(csvText, telefone) {
  const lines = String(csvText || "").split(/\r?\n/);
  return lines.some((ln) => ln.startsWith(`${telefone},`));
}

function saveClientToCSV(phoneRaw, nameRaw) {
  ensureDataDir();

  const telefone = normalizePhone(phoneRaw);
  if (!telefone) return;

  const nome = String(nameRaw || "")
    .replace(/[\r\n,]/g, " ")
    .trim();

  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, "telefone,nome\n", "utf8");
  }

  let content = "";
  try {
    content = fs.readFileSync(CSV_PATH, "utf8");
  } catch {}

  if (csvHasPhone(content, telefone)) return;

  try {
    fs.appendFileSync(CSV_PATH, `${telefone},${nome}\n`, "utf8");
    if (DEBUG) console.log("💾 Cliente salvo no CSV:", { telefone, nome });
  } catch (e) {
    console.log("❌ Erro ao salvar CSV:", e?.message || e);
  }
}

/* ================== ✅ FILTRO SEGURO: IGNORAR OUTGOING/STATUS ================== */
function isFromMe(body) {
  const candidates = [
    body?.fromMe,
    body?.message?.fromMe,
    body?.data?.fromMe,
    body?.sentByMe,
    body?.message?.sentByMe,
    body?.data?.sentByMe,
  ];
  return candidates.some((v) => v === true || v === "true");
}

function isStatusEvent(body) {
  const type = body?.type || body?.event || body?.data?.type || body?.data?.event || body?.message?.type;
  const t = String(type || "").toLowerCase().trim();
  return ["ack", "status", "delivery", "delivered", "read", "seen"].includes(t);
}

/* ================== Z-API ================== */
function zapiHeaders() {
  return {
    "client-token": ZAPI_CLIENT_TOKEN,
    "Client-Token": ZAPI_CLIENT_TOKEN,
    "Content-Type": "application/json",
  };
}

async function simulateTyping(phone) {
  const delay = 500 + Math.random() * 1000;
  try {
    await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-presence`,
      { phone, presence: "composing" },
      { headers: zapiHeaders(), timeout: 10000 }
    );
  } catch {}
  await sleep(delay);
}

async function zapiSendText(phoneRaw, message) {
  const phone = normalizePhone(phoneRaw);
  await simulateTyping(phone);
  try {
    const r = await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      { phone, message },
      { headers: zapiHeaders(), timeout: 20000 }
    );
    if (DEBUG) console.log("✅ ZAPI text sent:", { phone, status: r.status });
    return r;
  } catch (e) {
    console.log("❌ zapiSendText:", e?.response?.status, e?.response?.data || e?.message);
    throw e;
  }
}

async function zapiSendImage(phoneRaw, image, caption) {
  const phone = normalizePhone(phoneRaw);
  await simulateTyping(phone);
  try {
    const r = await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-image`,
      { phone, image, caption },
      { headers: zapiHeaders(), timeout: 45000 }
    );
    if (DEBUG) console.log("✅ ZAPI image sent:", { phone, status: r.status });
    return r;
  } catch (e) {
    console.log("❌ zapiSendImage:", e?.response?.status, e?.response?.data || e?.message);
    throw e;
  }
}

async function zapiSendCheckoutButton(phoneRaw, message, url) {
  const phone = normalizePhone(phoneRaw);
  await simulateTyping(phone);

  const msg =
    `${message}\n\n` +
    `✅ Link/QR:\n${url}\n\n` +
    `Depois de pagar, você não precisa digitar nada — a confirmação é automática 😊`;

  return zapiSendText(phone, msg);
}

async function sendLoadingStep(phone, text, delay = 1200) {
  await zapiSendText(phone, text);
  await sleep(delay);
}

/* ================== ANTI DUPLICAÇÃO ================== */
const recentIncoming = new Map();
function isDuplicate(phone, text) {
  const key = `${phone}:${text}`;
  const now = Date.now();
  if (recentIncoming.has(key) && now - recentIncoming.get(key) < 8000) return true;
  recentIncoming.set(key, now);
  return false;
}

/* ================== PARSE PAYLOAD Z-API (ROBUSTO) ================== */
function extractPhone(body) {
  const v =
    body?.phone ||
    body?.from ||
    body?.data?.phone ||
    body?.data?.from ||
    body?.message?.from ||
    body?.message?.phone ||
    body?.text?.from ||
    body?.sender ||
    body?.senderPhone ||
    body?.message?.sender ||
    null;

  return v;
}

function extractText(body) {
  if (typeof body?.message === "string") return body.message; // ✅ pega direto
  // resto igual:
  const v =
    body?.message ??
    body?.text?.message ??
    body?.text?.text ??
    body?.text ??
    body?.data?.message ??
    body?.data?.text?.message ??
    body?.data?.text ??
    "";

  if (typeof v === "string") return v;
  if (typeof v?.message === "string") return v.message;
  return "";
}

function extractContactName(body) {
  const name =
    body?.senderName ||
    body?.pushName ||
    body?.data?.senderName ||
    body?.data?.pushName ||
    body?.message?.senderName ||
    body?.message?.pushName ||
    body?.sender?.name ||
    body?.contact?.name ||
    null;

  if (!name) return null;
  const first = String(name).trim().split(/\s+/)[0];
  return first || null;
}

function renderTemplate(text, vars = {}) {
  let out = String(text || "");
  if (out.includes("{nome}")) {
    const nome = vars.nome ? ` ${vars.nome}` : "";
    out = out.replaceAll("{nome}", nome);
  }
  return out;
}

function extractImageUrl(body) {
  const candidates = [
    body?.image?.imageUrl,
    body?.image?.url,
    body?.imageUrl,
    body?.message?.image?.imageUrl,
    body?.message?.imageUrl,
    body?.message?.media?.url,
    body?.message?.mediaUrl,
    body?.media?.url,
    body?.mediaUrl,
    body?.data?.image?.imageUrl,
    body?.data?.media?.url,
    body?.data?.mediaUrl,
  ].filter((v) => typeof v === "string" && v.startsWith("http"));

  return candidates[0] || null;
}

function hasImage(body) {
  return !!extractImageUrl(body);
}

/* ================== COMANDOS/DETECÇÃO ================== */
function isMenuCommand(t) {
  return ["menu", "voltar", "inicio", "início", "começar", "comecar"].includes(t);
}

function isHumanCommand(t) {
  const s = String(t || "").toLowerCase().trim();
  return s === "humano" || s.includes("falar com humano") || s.includes("atendente");
}

function isPaidCommand(t) {
  const s = String(t || "").toLowerCase().trim();
  return (
    s === "paguei" ||
    s === "pago" ||
    s === "já paguei" ||
    s === "ja paguei" ||
    s === "paguei sim" ||
    s === "paguei!" ||
    s === "pago!" ||
    s.includes("paguei")
  );
}

function detectMainChoice(tRaw) {
  const t = String(tRaw || "").toLowerCase().trim();
  if (t === "1" || t.includes("mascote")) return "mascote";
  if (t === "2" || t.includes("miniatura")) return "miniatura";
  return null;
}

function detectMiniSize(tRaw) {
  const s = String(tRaw || "").toLowerCase().trim();
  if (/\b(16|16cm|16 cm)\b/.test(s)) return "16cm";
  if (/\b(21|21cm|21 cm)\b/.test(s)) return "21cm";
  return null;
}

/* ================== ✅ ESTILO DA MINIATURA ================== */
function detectMiniStyle(tRaw) {
  const t = String(tRaw || "").toLowerCase().trim();

  if (t === "1" || (t.includes("realista") && !t.includes("pixar"))) return "realista";
  if (t === "2" || t === "pixar") return "pixar";
  if (t === "3" || t.includes("pixar realista") || t.includes("pixar-realista")) return "pixar_realista";
  if (t === "4" || t.includes("cartoon")) return "cartoon";
  if (t === "5" || t.includes("anime")) return "anime";

  return null;
}

function styleLabel(style) {
  const map = {
    realista: "Realista",
    pixar: "Pixar",
    pixar_realista: "Pixar Realista",
    cartoon: "Cartoon",
    anime: "Anime",
  };
  return map[style] || style;
}

function stylePromptFragment(style) {
  switch (style) {
    case "realista":
      return `Style: premium ultra-realistic physical product (hand-painted 3D print).`;
    case "pixar":
      return `Style: Pixar-like 3D animated character look (clean shapes, friendly proportions), while keeping the subject identity.`;
    case "pixar_realista":
      return `Style: "Pixar-realistic" — stylized 3D character but with realistic materials, paint texture, and studio product photography.`;
    case "cartoon":
      return `Style: cartoon 3D collectible (simplified shapes, bold features), still a physical hand-painted 3D print.`;
    case "anime":
      return `Style: anime-inspired 3D collectible (anime facial aesthetics), still a physical hand-painted 3D print.`;
    default:
      return ``;
  }
}

function styleMenuText() {
  return (
    "Escolha o *ESTILO* da sua prévia:\n\n" +
    "1 - Realista\n" +
    "2 - Pixar\n" +
    "3 - Pixar Realista\n" +
    "4 - Cartoon\n" +
    "5 - Anime\n\n" +
    "Responda com o *número* (1 a 5) ou escreva o nome do estilo."
  );
}

/* ================== MEMÓRIA (mantido) ================== */
function loadMemory() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(MEMORY_PATH, "utf8");
    const json = JSON.parse(raw);
    if (json && typeof json === "object") return json;
  } catch {}
  return { global: {} };
}
function saveMemory(mem) {
  ensureDataDir();
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(mem, null, 2), "utf8");
}
let MEMORY = loadMemory();

/* ================== ORÇAMENTO (SÓ APÓS PRÉVIA) ================== */
function buildBudget(size) {
  const price = size === "16cm" ? "R$399" : "R$699";
  const link = size === "16cm" ? APPMAX_LINK_16 : APPMAX_LINK_21;
  const linkLine = link ? `👉 Link de pagamento (AppMax): ${link}\n\n` : "👉 Link de pagamento: vou te enviar já já por aqui.\n\n";

  return (
    "Perfeito! 😊 Segue o orçamento da sua miniatura personalizada:\n\n" +
    `📏 Tamanho: ${size}\n` +
    `💰 Valor: ${price}\n` +
    "⏱️ Prazo: até 7 dias úteis\n" +
    "🚚 Frete: Grátis\n\n" +
    linkLine +
    "Assim que o pagamento for confirmado, iniciamos a produção."
  );
}

/* ================== SHOPIFY (BUSCA PRODUTOS) ================== */
async function shopifySearchProducts(term) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_STOREFRONT_TOKEN) return [];

  const query = `
    query ($q: String!) {
      search(query: $q, first: 6, types: [PRODUCT]) {
        edges {
          node {
            ... on Product {
              title
              handle
              tags
              featuredImage { url }
              priceRange { minVariantPrice { amount currencyCode } }
            }
          }
        }
      }
    }
  `;

  const res = await axios.post(
    `https://${SHOPIFY_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`,
    { query, variables: { q: term } },
    {
      headers: {
        "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN,
        "Content-Type": "application/json",
      },
      timeout: 25000,
    }
  );

  const edges = res.data?.data?.search?.edges || [];
  return edges.map((e) => ({
    title: e.node.title,
    image: e.node.featuredImage?.url || null,
    priceAmount: e.node.priceRange?.minVariantPrice?.amount || null,
    currency: e.node.priceRange?.minVariantPrice?.currencyCode || null,
    url: `${SHOP_PUBLIC_DOMAIN}/products/${e.node.handle}`,
    tags: e.node.tags || [],
  }));
}

async function replyMascoteSearch(phone, termRaw) {
  const term = String(termRaw || "").trim();
  const results = await shopifySearchProducts(term);

  if (!results.length) {
    await zapiSendText(
      phone,
      `Não achei produtos para *${term}* 😕\n\nDigite o nome do time novamente (ex: Flamengo, Vasco, Bahia) ou digite *menu*.`
    );
    return;
  }

  await zapiSendText(phone, `Encontrei essas opções para *${term}* 👇`);

  for (const p of results.slice(0, 3)) {
    const price = p.priceAmount ? `R$${Number(p.priceAmount).toFixed(2).replace(".", ",")}` : "Consulte no link";
    const caption = `⚽ ${p.title}\n💰 A partir de: ${price}\n🔗 ${p.url}`;
    if (p.image) await zapiSendImage(phone, p.image, caption);
    else await zapiSendText(phone, caption);
  }

  await zapiSendText(phone, "Quer outro time? É só digitar o nome 😊");
}

/* ================== ✅ REMOVE FUNDO + GERA ESTATUETA ================== */
async function removeBackground(imageUrl) {
  const resp = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 45000 });
  const buf = Buffer.from(resp.data);

  const file = await toFile(buf, "input.png", { type: "image/png" });

  const rsp = await openai.images.edit({
    model: "gpt-image-1",
    image: [file],
    prompt: "Remove the background completely. Keep only the main subject. Transparent background.",
    size: "1024x1024",
    quality: "high",
    background: "transparent",
  });

  const b64 = rsp?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI não retornou imagem (removeBackground)");

  return Buffer.from(b64, "base64");
}

async function generateStatueFromPng(pngBuffer, style) {
  const file = await toFile(pngBuffer, "subject.png", { type: "image/png" });

  const prompt = `
${stylePromptFragment(style)}

Create a premium 3D collectible statue based EXACTLY on the provided subject.
Physical product appearance, hand-painted 3D print, professional studio lighting, neutral background,
elegant black round base.
Full-body framing, show the entire character from head to feet,
show 100% of the black base, add margin above the head and below the base,
center the character vertically, no cropping.
Do not change facial identity, proportions, or main characteristics.
  `.trim();

  const rsp = await openai.images.edit({
    model: "gpt-image-1",
    image: [file],
    prompt,
    size: "1024x1536", // ✅ 9:16
    quality: "high",
    input_fidelity: "high",
  });

  const b64 = rsp?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI não retornou imagem (generateStatueFromPng)");

  return `data:image/png;base64,${b64}`;
}

async function generateStatueFromImageUrl(imageUrl, style) {
  const pngNoBg = await removeBackground(imageUrl);
  return generateStatueFromPng(pngNoBg, style);
}

/* ================== REF PERSISTÊNCIA (CRÍTICO) ================== */
function loadRefs() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(REFS_PATH, "utf8");
    const j = JSON.parse(raw);
    return {
      refToPhone: j?.refToPhone || {},
      phoneToRef: j?.phoneToRef || {},
    };
  } catch {
    return { refToPhone: {}, phoneToRef: {} };
  }
}

function saveRefs(refToPhoneObj, phoneToRefObj) {
  ensureDataDir();
  fs.writeFileSync(
    REFS_PATH,
    JSON.stringify({ refToPhone: refToPhoneObj, phoneToRef: phoneToRefObj }, null, 2),
    "utf8"
  );
}

/* ================== ESTADO DO CLIENTE ================== */
const greeted = new Set();
const processingPreview = new Set();
const clientState = new Map();
const confirmingPayment = new Set();

const refsDisk = loadRefs();
const refToPhoneObj = refsDisk.refToPhone;
const phoneToRefObj = refsDisk.phoneToRef;

function getState(phone) {
  return (
    clientState.get(phone) || {
      mode: null,
      photoReceived: false,
      lastImageUrl: null,
      cpf: null,
      previewCheckoutUrl: null,
      previewRef: null,
      previewPaymentPending: false,
      previewPaid: false,
      previewSent: false,
      miniSize: null,

      // ✅ estilo antes do pagamento
      miniStyle: null,
      awaitingStyle: false,

      // ✅ QR estático: valor esperado (centavos)
      expectedPreviewCents: null,
      previewCreatedAt: null,

      // ✅ controle anti-spam do link
      previewChargeSends: 0,
      lastPreviewChargeAt: 0,
    }
  );
}

function setState(phone, patch) {
  clientState.set(phone, { ...getState(phone), ...patch });
}

function createOrGetRefForPhone(phone) {
  const existing = phoneToRefObj[phone];
  if (existing) return existing;

  const ref = crypto.randomBytes(8).toString("hex");
  phoneToRefObj[phone] = ref;
  refToPhoneObj[ref] = phone;
  saveRefs(refToPhoneObj, phoneToRefObj);

  return ref;
}

/* ================== ✅ LEMBRETE 60s (OI AINDA ESTÁ AI?) ================== */
const nudgeTimers = new Map(); // phone -> Timeout

function cancelNudge(phone) {
  const t = nudgeTimers.get(phone);
  if (t) clearTimeout(t);
  nudgeTimers.delete(phone);
}

function scheduleNudge(phone) {
  cancelNudge(phone);

  const id = setTimeout(async () => {
    try {
      const st = getState(phone);
      if (st?.previewPaymentPending && !st?.previewPaid) {
        await zapiSendText(phone, "Oi, ainda está aí? 😊");
      }
    } catch (e) {
      if (DEBUG) console.log("⚠️ Nudge error:", e?.message || e);
    } finally {
      nudgeTimers.delete(phone);
    }
  }, 60_000);

  nudgeTimers.set(phone, id);
}

/* ================== ✅ IGNORAR MENSAGENS ENQUANTO GERA PRÉVIA ================== */
const busyNotifyAt = new Map(); // phone -> timestamp

function shouldNotifyBusy(phone, cooldownMs = 15000) {
  const now = Date.now();
  const last = busyNotifyAt.get(phone) || 0;
  if (now - last < cooldownMs) return false;
  busyNotifyAt.set(phone, now);
  return true;
}

/* ================== FUNÇÃO: GERAR PRÉVIA ================== */
async function runPreviewFlow(phone) {
  const st = getState(phone);

  if (!st.lastImageUrl) {
    await zapiSendText(phone, "Não encontrei sua foto aqui 😕 Pode reenviar a imagem?");
    return;
  }

  if (!st.miniStyle) {
    setState(phone, { awaitingStyle: true, previewPaymentPending: false, previewPaid: false });
    await zapiSendText(phone, "Antes de continuar, escolha o estilo 😊\n\n" + styleMenuText());
    return;
  }

  // Se ainda não pagou, pede pagamento (QR estático)
  if (!st.previewPaid) {
    const checkoutUrl = st.previewCheckoutUrl || PREVIEW_CHECKOUT_URL;

    const valueTxt = st.expectedPreviewCents ? centsToBRL(st.expectedPreviewCents) : PREVIEW_FEE_BRL_BASE;

    const msg =
      "📸 Foto recebida com sucesso! 😊\n\n" +
      `Para eu criar a *PRÉVIA* (${styleLabel(st.miniStyle)}), faça o Pix no valor EXATO de *${valueTxt}*.\n` +
      "⚠️ (Esse valor é único para identificar seu pagamento automaticamente.)\n\n" +
      "Aqui está o link/QR:";

    await zapiSendCheckoutButton(phone, msg, checkoutUrl);
    scheduleNudge(phone);
    return;
  }

  if (processingPreview.has(phone)) {
    await zapiSendText(phone, "Já estou gerando sua prévia 😊 Só um instante…");
    return;
  }

  processingPreview.add(phone);
  try {
    await sendLoadingStep(phone, "3DFANS: Analisando a foto… 25%");
    await sendLoadingStep(phone, "3DFANS: Removendo o fundo… 45%");
    await sendLoadingStep(phone, "3DFANS: Modelando a miniatura em 3D… 70%");
    await sendLoadingStep(phone, "3DFANS: Aplicando acabamento e pintura… 90%");

    const generatedDataUri = await generateStatueFromImageUrl(st.lastImageUrl, st.miniStyle);

    await zapiSendImage(
      phone,
      generatedDataUri,
      `✨ Aqui está a PRÉVIA (${styleLabel(st.miniStyle)}) da sua estatueta!\n\nAgora escolha o tamanho para saber o valor:\n👉 16cm ou 21cm`
    );

    setState(phone, { previewSent: true });
  } catch (e) {
    console.log("❌ Erro ao gerar prévia:", e?.response?.status, e?.response?.data || e?.message);
    await zapiSendText(phone, "❌ Deu um erro ao gerar a prévia.\nPode reenviar a foto? Se preferir, digite *humano*.");
  } finally {
    processingPreview.delete(phone);
  }
}

/* ================== ✅ OPENPIX WEBHOOK (TRANSACTION_RECEIVED) ================== */
app.post("/openpix/webhook", async (req, res) => {
  try {
    const signature = getHeader(req, "x-openpix-signature") || getHeader(req, "X-OpenPix-Signature");
    const rawBody = req.rawBody || JSON.stringify(req.body || {});

    const ok = verifyOpenPixSignature({
      secret: OPENPIX_WEBHOOK_SECRET,
      rawBody,
      signature,
    });

    if (!ok) {
      console.log("❌ OpenPix webhook signature inválida");
      return res.sendStatus(401);
    }

    // ✅ assinatura OK
    res.sendStatus(200);

    const body = req.body || {};
    const event = body?.event || body?.type || body?.data?.event || "";

    // Aceita os formatos mais comuns
    const pix = body?.pix || body?.data?.pix || body?.transaction || body?.data?.transaction || null;
    if (!pix) {
      if (DEBUG) console.log("⚠️ Webhook OpenPix sem pix/transaction");
      return;
    }

    // valor geralmente vem em centavos
    const valueCents = Number(pix.value ?? pix?.pix?.value ?? 0);
    if (!valueCents) return;

    if (DEBUG) console.log("💰 OPENPIX WEBHOOK OK:", { event, valueCents });

    // Casa por valor esperado + pendente + janela de tempo
    const now = Date.now();
    const WINDOW_MS = 30 * 60 * 1000; // 30 min

    for (const [phone, st] of clientState.entries()) {
      if (!st?.previewPaymentPending) continue;
      if (st?.previewPaid) continue;
      if (!st?.expectedPreviewCents) continue;

      if (Number(st.expectedPreviewCents) !== valueCents) continue;

      const createdAt = Number(st.previewCreatedAt || 0);
      if (createdAt && now - createdAt > WINDOW_MS) continue;

      console.log("✅ Pix confirmado automaticamente para:", phone);

      cancelNudge(phone);

      setState(phone, {
        previewPaid: true,
        previewPaymentPending: false,
      });

      await zapiSendText(phone, `✅ Pix confirmado! Agora vou gerar sua PRÉVIA (${styleLabel(st.miniStyle)}) 🎨`);
      await runPreviewFlow(phone);
      break;
    }
  } catch (e) {
    console.error("❌ Erro OpenPix webhook:", e?.message || e);
    return;
  }
});

/* ================== WEBHOOK: MENSAGENS WHATSAPP (Z-API) ================== */
app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      if (DEBUG) {
        console.log("📦 WEBHOOK BODY KEYS:", Object.keys(req.body || {}));
        console.log("📦 WEBHOOK TYPE/EVENT:", {
          type: req.body?.type,
          event: req.body?.event,
          dataType: req.body?.data?.type,
          dataEvent: req.body?.data?.event,
          fromMe: req.body?.fromMe,
          dataFromMe: req.body?.data?.fromMe,
          sentByMe: req.body?.sentByMe,
          dataSentByMe: req.body?.data?.sentByMe,
        });
      }

      const fromMe = isFromMe(req.body);
      const statusEvt = isStatusEvent(req.body);

      if (fromMe || statusEvt) {
        if (DEBUG) console.log("↩️ Ignorado (fromMe/status):", { fromMe, statusEvt });
        return;
      }

      const phoneRaw = extractPhone(req.body);
      const text = extractText(req.body);
      const firstName = extractContactName(req.body);

      if (!phoneRaw) return;

      const phone = normalizePhone(phoneRaw);

      if (DEBUG) console.log("📩 INCOMING RESOLVIDO:", { phoneRaw, phone, text });

      if (isDuplicate(phone, text)) return;

      // cliente falou algo: cancela lembrete
      cancelNudge(phone);

      // se estiver gerando a prévia, ignora
      if (processingPreview.has(phone)) {
        if (shouldNotifyBusy(phone)) {
          await zapiSendText(phone, "⏳ Estou gerando sua prévia agora… já já te envio aqui 😊");
        }
        return;
      }

      // salva telefone + nome em CSV
      saveClientToCSV(phone, firstName);

      const t = normalize(text);
      const state = getState(phone);

      // HUMANO
      if (isHumanCommand(t)) {
        await zapiSendText(phone, "✅ Ok! Vou chamar um atendente humano pra você.\nEnquanto isso, me diga o que você precisa 😊");
        return;
      }

      // Saudação
      if (!greeted.has(phone)) {
        greeted.add(phone);
        const tpl = REPLIES.welcome || FALLBACK_REPLIES.welcome;
        await zapiSendText(phone, renderTemplate(tpl, { nome: firstName }));
        return;
      }

      // Menu reset
      if (isMenuCommand(t)) {
        cancelNudge(phone);

        setState(phone, {
          mode: null,
          photoReceived: false,
          lastImageUrl: null,
          cpf: null,
          previewCheckoutUrl: null,
          previewRef: null,
          previewPaymentPending: false,
          previewPaid: false,
          previewSent: false,
          miniSize: null,
          miniStyle: null,
          awaitingStyle: false,
          expectedPreviewCents: null,
          previewCreatedAt: null,
          previewChargeSends: 0,
          lastPreviewChargeAt: 0,
        });

        const tpl = REPLIES.welcome || FALLBACK_REPLIES.welcome;
        await zapiSendText(phone, renderTemplate(tpl, { nome: firstName }));
        return;
      }

      // Foto recebida -> pedir estilo (texto)
      if (hasImage(req.body)) {
        const imageUrl = extractImageUrl(req.body);
        if (!imageUrl) {
          await zapiSendText(phone, "Não consegui acessar sua imagem 😕 Pode reenviar a foto por aqui?");
          return;
        }

        const ref = createOrGetRefForPhone(phone);
        const checkoutUrl = PREVIEW_CHECKOUT_URL
          ? `${PREVIEW_CHECKOUT_URL}${PREVIEW_CHECKOUT_URL.includes("?") ? "&" : "?"}ref=${encodeURIComponent(ref)}`
          : null;

        setState(phone, {
          mode: "miniatura",
          photoReceived: true,
          lastImageUrl: imageUrl,
          previewCheckoutUrl: checkoutUrl,
          previewRef: ref,

          previewPaymentPending: false,
          previewPaid: false,
          previewSent: false,
          miniSize: null,

          miniStyle: null,
          awaitingStyle: true,

          expectedPreviewCents: null,
          previewCreatedAt: null,

          previewChargeSends: 0,
          lastPreviewChargeAt: 0,
        });

        await zapiSendText(phone, `📸 Foto recebida! 😊\n\nAgora escolha o estilo da sua prévia:\n\n${styleMenuText()}`);
        return;
      }

      // Escolha inicial (1/2)
      if (!state.mode) {
        const choice = detectMainChoice(text);

        if (choice === "mascote") {
          setState(phone, { mode: "mascote" });
          await zapiSendText(phone, REPLIES.menuMascote || FALLBACK_REPLIES.menuMascote);
          return;
        }

        if (choice === "miniatura") {
          setState(phone, {
            mode: "miniatura",
            photoReceived: false,
            lastImageUrl: null,
            miniStyle: null,
            awaitingStyle: false,
            previewPaymentPending: false,
            previewPaid: false,
            previewSent: false,
            miniSize: null,
            expectedPreviewCents: null,
            previewCreatedAt: null,
            previewChargeSends: 0,
            lastPreviewChargeAt: 0,
          });

          await zapiSendText(
            phone,
            "Escolha perfeita 🤩\n\n" +
              "Agora me envie uma *FOTO* por aqui 📸\n" +
              "👉 Pode ser rosto ou corpo inteiro.\n" +
              "👉 Quanto mais nítida, melhor a prévia.\n\n" +
              "Nós vamos criar sua miniatura apartir da foto que você enviar."
          );
          return;
        }

        await zapiSendText(phone, "Responda com *1* (Mascotes) ou *2* (Miniaturas) 😊");
        return;
      }

      // MODO MASCOTE
      if (state.mode === "mascote") {
        if (t && t.length >= 3) {
          await replyMascoteSearch(phone, text);
          return;
        }
        await zapiSendText(phone, "⚽ Me diga qual time você quer (ex: Flamengo, Vasco, Bahia).");
        return;
      }

      // MODO MINIATURA SEM FOTO
      if (state.mode === "miniatura" && !state.photoReceived) {
        await zapiSendText(phone, "📸 Me envie uma foto por aqui para eu criar sua miniatura 😊");
        return;
      }

      // Cliente digitou PAGUEI (mantido, mas agora não é necessário)
      if (isPaidCommand(t) && state.mode === "miniatura" && state.photoReceived && state.awaitingStyle) {
        await zapiSendText(phone, "Antes de confirmar, escolha o estilo 😊\n\n" + styleMenuText());
        return;
      }

      // Fluxo miniatura com foto
      if (state.mode === "miniatura" && state.photoReceived) {
        // 1) Escolha do estilo antes de cobrar
        if (state.awaitingStyle) {
          const style = detectMiniStyle(text);

          if (!style) {
            await zapiSendText(phone, "Escolha um estilo válido 😊\n\n" + styleMenuText());
            return;
          }

          // ✅ QR estático: valor único por cliente
          const extra = Math.floor(Math.random() * 80) + 1; // 1..80
          const expected = PREVIEW_FEE_BASE_CENTS + extra;

          setState(phone, {
            miniStyle: style,
            awaitingStyle: false,
            previewPaymentPending: true,
            previewPaid: false,
            previewSent: false,
            expectedPreviewCents: expected,
            previewCreatedAt: Date.now(),
          });

          const checkoutUrl = state.previewCheckoutUrl || PREVIEW_CHECKOUT_URL;

          await zapiSendText(
            phone,
            `Perfeito! ✅ Estilo escolhido: *${styleLabel(style)}*.\n\n` +
              `Agora faça um Pix no valor EXATO de *${centsToBRL(expected)}*.\n` +
              `⚠️ Esse valor é único para identificação automática (QR estático).\n\n` +
              `Assim que o Pix cair, eu já começo a gerar sua prévia 😊`
          );

          await zapiSendCheckoutButton(phone, "Link/QR do Pix:", checkoutUrl);

          setState(phone, { previewChargeSends: 1, lastPreviewChargeAt: Date.now() });
          scheduleNudge(phone);
          return;
        }

        // 2) PAGUEI (agora só informativo)
        if (isPaidCommand(t) && state.previewPaymentPending && !state.previewPaid) {
          await zapiSendText(
            phone,
            "✅ Perfeito! Agora é só aguardar a confirmação automática do Pix 😊\n" +
              "Assim que cair, eu gero sua prévia sem você precisar fazer mais nada."
          );
          return;
        }

        // 3) Pós-prévia: escolher tamanho
        const size = detectMiniSize(text);
        if (size) {
          setState(phone, { miniSize: size });
          await zapiSendText(phone, buildBudget(size));
          return;
        }

        if (state.previewSent && !state.miniSize) {
          await zapiSendText(phone, "✨ Agora escolha o tamanho para continuar:\n👉 16cm ou 21cm");
          return;
        }

        // 4) Reenvio do link com limite
        if (state.previewPaymentPending && !state.previewPaid) {
          const checkoutUrl = state.previewCheckoutUrl || PREVIEW_CHECKOUT_URL;

          const now = Date.now();
          const sends = Number(state.previewChargeSends || 0);
          const lastAt = Number(state.lastPreviewChargeAt || 0);

          const MAX_SENDS = 3;
          const COOLDOWN_MS = 60 * 1000;

          if (sends >= MAX_SENDS) {
            await zapiSendText(
              phone,
              "✅ Eu já te enviei o link/QR.\n\nAssim que o Pix cair, eu confirmo automaticamente 😊\nSe precisar de ajuda, digite *humano*."
            );
            return;
          }

          if (lastAt && now - lastAt < COOLDOWN_MS) {
            await zapiSendText(phone, "⏳ Só um instante 😊\nO link/QR já foi enviado. Assim que o Pix cair, eu confirmo automaticamente.");
            return;
          }

          const valueTxt = state.expectedPreviewCents ? centsToBRL(state.expectedPreviewCents) : PREVIEW_FEE_BRL_BASE;

          await zapiSendCheckoutButton(
            phone,
            `💳 Falta só pagar a prévia (${styleLabel(state.miniStyle)}) 😊\nValor EXATO: *${valueTxt}*\nLink/QR:`,
            checkoutUrl
          );

          setState(phone, { previewChargeSends: sends + 1, lastPreviewChargeAt: now });
          scheduleNudge(phone);
          return;
        }

        await zapiSendText(phone, "✨ Para continuar, escolha:\n👉 16cm ou 21cm\n\nOu digite *menu* para voltar.");
        return;
      }

      // fallback final
      await zapiSendText(phone, "Responda com *1* (Mascotes) ou *2* (Miniaturas) 😊");
    } catch (err) {
      console.error("ERRO /webhook:", err?.response?.status, err?.response?.data || err?.message || err);
    }
  });
});

/* ================== HEALTH ================== */
app.get("/", (_req, res) => res.send("OK - webhook online"));
app.get("/health", (_req, res) => res.json({ ok: true }));

/* ================== OPENPIX WEBHOOK (HANDSHAKE / TESTE) ================== */
app.get("/openpix/webhook", (_req, res) => {
  // Woovi faz GET para validar o endpoint
  return res.sendStatus(200);
});

/* ================== START (RAILWAY) ================== */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Rodando na porta ${PORT}`);
});

