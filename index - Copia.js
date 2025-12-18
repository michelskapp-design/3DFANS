import dotenv from "dotenv";
dotenv.config({ override: true });

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
      req.rawBody = buf.toString();
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

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

/** Prévia (taxa) */
const PREVIEW_FEE_BRL = "R$9,90";
const PREVIEW_FEE_AMOUNT = 9.9;

/** Checkout da prévia (Carrinho.app) */
const PREVIEW_CHECKOUT_URL = (process.env.PREVIEW_CHECKOUT_URL || "https://3dfansia1765825644536.carrinho.app/one-checkout/ocmdf/32352603").trim();

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
  welcome:
    "Olá{nome}! 😊 O que você procura hoje?\n\n1️⃣ Mascotes de time de futebol\n2️⃣ Miniaturas personalizadas\n\nResponda com 1 ou 2.",
  menuMascote:
    "Show! ⚽ Temos mascotes 10cm, 16cm e 21cm.\n📸 As fotos são reais do produto.\nMe diga qual time você quer.",
  menuMiniatura:
    "Perfeito 😊 Conte-me o que você quer transformar em miniatura.\n📸 Envie a foto por aqui mesmo.\nTamanhos: 16cm ou 21cm.",
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

/**
 * ✅ BOTÃO "COPIAR"
 */
async function zapiSendCopyButton(phoneRaw, message, code, buttonText = "📋 Copiar PIX") {
  const phone = normalizePhone(phoneRaw);
  await simulateTyping(phone);

  try {
    const r = await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-button-otp`,
      { phone, message, code, buttonText },
      { headers: zapiHeaders(), timeout: 20000 }
    );

    if (DEBUG) console.log("✅ ZAPI copy-button sent:", { phone, status: r.status });
    return r;
  } catch (e) {
    console.log("❌ zapiSendCopyButton:", e?.response?.status, e?.response?.data || e?.message);
    await zapiSendText(
      phone,
      `${message}\n\nPIX Copia e Cola:\n${code}\n\nSe preferir, copie o código acima e pague no app do seu banco.`
    );
  }
}

/**
 * ✅ Checkout (link)
 */
async function zapiSendCheckoutButton(phoneRaw, message, url) {
  const phone = normalizePhone(phoneRaw);
  await simulateTyping(phone);

  const msg =
    `${message}\n\n` +
    `✅ Pague aqui:\n${url}\n\n` +
    `Depois de realizar o pagamento, digite a palavra PAGUEI que vamos criar sua previa de miniatura em 3 minutos.`;

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
  return (
    body?.phone ||
    body?.from ||
    body?.text?.from ||
    body?.sender ||
    body?.chatId ||
    body?.message?.from ||
    body?.data?.phone ||
    body?.data?.from ||
    null
  );
}

function extractText(body) {
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

function isMenuCommand(t) {
  return ["menu", "voltar", "inicio", "início", "começar", "comecar"].includes(t);
}

function isHumanCommand(t) {
  return (
    t.includes("humano") ||
    t.includes("atendente") ||
    t.includes("falar com atendente") ||
    t.includes("falar com alguem") ||
    t.includes("falar com alguém")
  );
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

function detectMiniSize(t) {
  if (/\b(16|16cm|16 cm)\b/.test(t)) return "16cm";
  if (/\b(21|21cm|21 cm)\b/.test(t)) return "21cm";
  return null;
}

/* ================== APRENDIZADO (MEMÓRIA) ================== */
const DATA_DIR = path.resolve(process.cwd(), "data");
const MEMORY_PATH = path.join(DATA_DIR, "memory.json");

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

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

function teachParse(tRaw) {
  const s = String(tRaw || "").trim();
  let rest = s;
  if (rest.toLowerCase().startsWith("ensinar:")) rest = rest.slice(8).trim();
  else if (rest.toLowerCase().startsWith("ensinar")) rest = rest.slice(7).trim();
  else if (rest.toLowerCase().startsWith("aprenda:")) rest = rest.slice(7).trim();
  else if (rest.toLowerCase().startsWith("aprenda")) rest = rest.slice(6).trim();

  const m = rest.match(/^(.*?)(?:=|=>|->)(.*)$/);
  if (!m) return null;

  const q = normalize(m[1]);
  const a = String(m[2] || "").trim();
  if (!q || !a) return null;

  return { q, a };
}

function memoryGetAnswer(qNorm) {
  return MEMORY?.global?.[qNorm] || null;
}

function memorySetAnswer(qNorm, answer) {
  MEMORY.global = MEMORY.global || {};
  MEMORY.global[qNorm] = answer;
  saveMemory(MEMORY);
}

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

function buildPreviewCopyMessage() {
  return (
    "💳 *PIX para liberar a PRÉVIA*\n\n" +
    "Clique no botão abaixo para *copiar o PIX* e pagar no app do seu banco.\n\n" +
    "⏱️ Assim que o pagamento for confirmado, eu gero a prévia automaticamente. 😊"
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

/* ================== ✅ NOVO: REMOVE FUNDO + GERA ESTATUETA ================== */
async function removeBackground(imageUrl) {
  // baixa imagem
  const resp = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 45000 });
  const buf = Buffer.from(resp.data);

  // manda para o gpt-image-1 remover fundo
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

  return Buffer.from(b64, "base64"); // PNG com fundo transparente
}

async function generateStatueFromPng(pngBuffer) {
  const file = await toFile(pngBuffer, "subject.png", { type: "image/png" });

  const prompt =
    "Create a premium realistic 3D collectible statue based EXACTLY on the provided subject. " +
    "Physical product appearance, hand-painted 3D print, professional studio lighting, neutral background, " +
    "elegant black round base. " +
    "Full-body framing, show the entire character from head to feet, " +
    "show 100% of the black base, add margin above the head and below the base, " +
    "center the character vertically, no cropping. " +
    "Do not change facial identity, proportions, or main characteristics.";

  const rsp = await openai.images.edit({
    model: "gpt-image-1",
    image: [file],
    prompt, // ✅ agora está correto
    size: "1024x1024",
    quality: "high",
    input_fidelity: "high",
  });

  const b64 = rsp?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI não retornou imagem (generateStatueFromPng)");

  return `data:image/png;base64,${b64}`;
}


// ✅ wrapper final: URL -> remove fundo -> estatueta
async function generateStatueFromImageUrl(imageUrl) {
  const pngNoBg = await removeBackground(imageUrl);
  return generateStatueFromPng(pngNoBg);
}

/* ================== REF PERSISTÊNCIA (CRÍTICO) ================== */
const REFS_PATH = path.join(DATA_DIR, "refs.json");

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
      previewPixLink: null,
      previewCheckoutUrl: null,
      previewRef: null,
      previewPaymentPending: false,
      previewPaid: false,
      previewSent: false,
      miniSize: null,
      humanHandoff: false,
      lastPaymentReminderAt: 0,
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

/* ================== APPMAX API v3 ================== */
async function appmaxPost(endpoint, payload) {
  if (!APPMAX_ACCESS_TOKEN) throw new Error("APPMAX_ACCESS_TOKEN ausente no .env");
  const url = `${APPMAX_BASE_URL}${endpoint}`;
  const body = { "access-token": APPMAX_ACCESS_TOKEN, ...payload };
  const r = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });
  return r.data;
}

async function createPreviewOrderAppmax({ phone, cpf }) {
  const ref = createOrGetRefForPhone(phone);
  const tel11 = onlyDigits(phone).replace(/^55/, "");

  const customer = await appmaxPost("/customer", {
    firstname: "Cliente",
    lastname: "3DFANS",
    email: `${tel11}@3dfans.com.br`,
    telephone: tel11,
    document_number: onlyDigits(cpf),
    custom_txt: `3DFANS_PREVIA ref=${ref}`,
    tracking: {
      utm_source: "whatsapp",
      utm_medium: "bot",
      utm_campaign: "previa_3dfans",
      utm_content: `ref=${ref}`,
    },
  });

  const customer_id = customer?.data?.id || customer?.id;
  if (!customer_id) {
    console.log("❌ APPMAX CUSTOMER RAW:", JSON.stringify(customer, null, 2));
    throw new Error("customer_id não retornado");
  }

  const order = await appmaxPost("/order", {
    customer_id,
    external_id: ref,
    products: [
      {
        sku: "PREVIA-3DFANS",
        name: "Taxa de Prévia 3DFANS",
        qty: 1,
        price: PREVIEW_FEE_AMOUNT,
        digital_product: 1,
      },
    ],
    shipping: 0,
    discount: 0,
  });

  const order_id = order?.data?.id || order?.id;
  if (!order_id) {
    console.log("❌ APPMAX ORDER RAW:", JSON.stringify(order, null, 2));
    throw new Error("order_id não retornado");
  }

  const expiration_date = new Date(Date.now() + 30 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  const pix = await appmaxPost("/payment/pix", {
    cart: { order_id },
    customer: { customer_id },
    payment: {
      pix: {
        document_number: onlyDigits(cpf),
        expiration_date,
      },
    },
  });

  if (DEBUG) console.log("🧾 APPMAX PIX RAW:", JSON.stringify(pix, null, 2));

  const pixEmv = pix?.data?.pix?.pix_emv || pix?.pix_emv || null;
  return { ref, customer_id, order_id, pixEmv };
}

/* ================== FUNÇÃO: GERAR PRÉVIA ================== */
async function runPreviewFlow(phone) {
  const st = getState(phone);

  if (!st.lastImageUrl) {
    await zapiSendText(phone, "Não encontrei sua foto aqui 😕 Pode reenviar a imagem?");
    return;
  }

  if (!st.previewPaid) {
    const checkoutUrl = st.previewCheckoutUrl || PREVIEW_CHECKOUT_URL;
    const msg =
      "📸 Nossa que foto top, nós a recebemos com sucesso! 😊\n\n" +
      `Para eu criar a *PRÉVIA* de como vai ficar sua miniatura, é necessário que você pague uma pequena taxa de *${PREVIEW_FEE_BRL}*.\n\n` +
      "Clique no link abaixo para concluir o pagamento em 1 minutinho.";

    await zapiSendCheckoutButton(phone, msg, checkoutUrl);
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

    const generatedDataUri = await generateStatueFromImageUrl(st.lastImageUrl);

    await zapiSendImage(
      phone,
      generatedDataUri,
      "✨ Aqui está a PRÉVIA da sua estatueta!\n\nAgora escolha o tamanho para liberar o pagamento:\n👉 16cm ou 21cm"
    );

    setState(phone, { previewSent: true });
  } catch (e) {
    console.log("❌ Erro ao gerar prévia:", e?.response?.status, e?.response?.data || e?.message);
    await zapiSendText(phone, "❌ Deu um erro ao gerar a prévia.\nPode reenviar a foto? Se preferir, digite *humano*.");
  } finally {
    processingPreview.delete(phone);
  }
}

/* ================== WEBHOOK APPMAX (ÚNICO) ================== */
app.post("/webhook-appmax", async (req, res) => {
  try {
    const event = req.body?.event;
    const status = String(req.body?.data?.status || "").toLowerCase();

    const isPaid = event === "OrderApproved" && status === "aprovado";
    if (!isPaid) return res.sendStatus(200);

    const ref = req.body?.data?.external_id || req.body?.external_id || null;
    const phone = ref ? refToPhoneObj[ref] : null;
    if (!phone) return res.sendStatus(200);

    setState(phone, { previewPaid: true, previewPaymentPending: false });
    res.sendStatus(200);

    setImmediate(async () => {
      try {
        await zapiSendText(phone, "✅ Pagamento confirmado! Vou gerar sua PRÉVIA agora 😊🎨");
        await runPreviewFlow(phone);
      } catch (e) {
        console.log("❌ erro pós-pagamento:", e?.message);
      }
    });
  } catch (err) {
    console.error("❌ ERRO APPMAX", err?.response?.data || err?.message || err);
    return res.sendStatus(200);
  }
});

/* ================== WEBHOOK: MENSAGENS WHATSAPP (Z-API) ================== */
app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const phoneRaw = extractPhone(req.body);
      const text = extractText(req.body);
      const firstName = extractContactName(req.body);

      if (!phoneRaw) return;

      const phone = normalizePhone(phoneRaw);
      if (isDuplicate(phone, text)) return;

      const t = normalize(text);
      const state = getState(phone);

      // Saudação com {nome}
      if (!greeted.has(phone)) {
        greeted.add(phone);
        const tpl = REPLIES.welcome || FALLBACK_REPLIES.welcome;
        await zapiSendText(phone, renderTemplate(tpl, { nome: firstName }));
        return;
      }

      // Foto recebida
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
          previewPaymentPending: true,
          previewPaid: false,
          previewSent: false,
          miniSize: null,
        });

        await zapiSendText(
          phone,
          `📸 Foto recebida! 😊\n\nPara eu criar a *PRÉVIA*, é necessário pagar a taxa de *${PREVIEW_FEE_BRL}*.\n\nVou te mandar o link de pagamento agora.`
        );

        await zapiSendCheckoutButton(phone, "Clique no link para pagar:", checkoutUrl || PREVIEW_CHECKOUT_URL);
        return;
      }

      // PAGUEI (manual)
      if (isPaidCommand(t) && state.mode === "miniatura" && state.previewPaymentPending && !state.previewPaid) {
        if (confirmingPayment.has(phone)) {
          await zapiSendText(phone, "⏳ Já estou verificando seu pagamento 😊");
          return;
        }
        confirmingPayment.add(phone);

        await zapiSendText(phone, "⏳ Recebi! Confirmando o pagamento…");

        setTimeout(async () => {
          try {
            setState(phone, { previewPaid: true, previewPaymentPending: false });
            await zapiSendText(phone, "✅ Pagamento confirmado! Agora vou gerar sua PRÉVIA 🎨");
            await runPreviewFlow(phone);
          } catch (e) {
            await zapiSendText(phone, "❌ Tive um problema ao confirmar agora.\nTente novamente ou digite *humano*.");
          } finally {
            confirmingPayment.delete(phone);
          }
        }, 10000);

        return;
      }

      // Menu
      if (isMenuCommand(t)) {
        setState(phone, {
          mode: null,
          photoReceived: false,
          lastImageUrl: null,
          cpf: null,
          previewPixLink: null,
          previewCheckoutUrl: null,
          previewRef: null,
          previewPaymentPending: false,
          previewPaid: false,
          previewSent: false,
          miniSize: null,
          humanHandoff: false,
          lastPaymentReminderAt: 0,
        });

        const tpl = REPLIES.welcome || FALLBACK_REPLIES.welcome;
        await zapiSendText(phone, renderTemplate(tpl, { nome: firstName }));
        return;
      }

      // Fluxo básico
      if (t === "1") {
        setState(phone, { mode: "mascote" });
        await zapiSendText(phone, REPLIES.menuMascote || FALLBACK_REPLIES.menuMascote);
        return;
      }

      if (t === "2") {
        setState(phone, { mode: "miniatura" });
        await zapiSendText(phone, REPLIES.menuMiniatura || FALLBACK_REPLIES.menuMiniatura);
        return;
      }

      // ✅ Pós-prévia: escolher tamanho (16cm / 21cm)
if (state.mode === "miniatura" && state.photoReceived) {
  const size = detectMiniSize(t);

  // se o cliente digitou 16/21
  if (size) {
    setState(phone, { miniSize: size });
    await zapiSendText(phone, buildBudget(size));
    return;
  }

  // se a prévia já foi enviada e ele ainda não escolheu tamanho
  if (state.previewSent && !state.miniSize) {
    await zapiSendText(phone, "✨ Agora escolha o tamanho para continuar:\n👉 16cm ou 21cm");
    return;
  }

  // se ainda não pagou a prévia, reenvia o link
  if (state.previewPaymentPending && !state.previewPaid) {
    const checkoutUrl = state.previewCheckoutUrl || PREVIEW_CHECKOUT_URL;
    await zapiSendCheckoutButton(phone, "💳 Falta só pagar a taxa da PRÉVIA 😊\nPague aqui:", checkoutUrl);
    return;
  }
}


      // fallback
      // fallback (não pedir foto se já tem foto)
if (state.mode === "miniatura" && state.photoReceived) {
  await zapiSendText(phone, "✨ Para continuar, escolha:\n👉 16cm ou 21cm\n\nOu digite *menu* para voltar.");
  return;
}

await zapiSendText(phone, "📸 Me envie uma foto por aqui para eu criar sua miniatura 😊");

    } catch (err) {
      console.error("ERRO /webhook:", err?.response?.status, err?.response?.data || err?.message || err);
    }
  });
});

/* ================== HEALTH ================== */
app.get("/", (_req, res) => res.send("OK - webhook online"));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));
