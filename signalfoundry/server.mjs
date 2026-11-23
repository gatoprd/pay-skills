import http from "node:http";
import { randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = (process.env.PUBLIC_ORIGIN || "https://signalforge-gr.onrender.com").replace(/\/$/, "");
const PORT = Number(process.env.PORT || 10000);
const SCAN_MS = 4 * 60 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const PAYPAL = {
  id: (process.env.PAYPAL_CLIENT_ID || "").trim(),
  secret: (process.env.PAYPAL_CLIENT_SECRET || "").trim(),
  merchant: (process.env.PAYPAL_MERCHANT_EMAIL || "nikoslioli@yahoo.gr").toLowerCase().trim(),
  signing: (process.env.SIGNALFORGE_SIGNING_SECRET || "").trim(),
  endpoint: process.env.PAYPAL_SANDBOX === "1" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com",
};
const PRICE = "9.90";
const SOURCE = "https://diavgis.gr";
const LICENSE = "https://creativecommons.org/licenses/by/4.0/";
const isCheckoutReady = () => Boolean(PAYPAL.id && PAYPAL.secret && PAYPAL.signing);
const CAT = {
  digital: { name: "Πληροφορική & τεχνολογία", cpv: ["48", "72", "30"], terms: ["λογισμικ", "πληροφορικ", "τεχνολογ"] },
  services: { name: "Επιχειρηματικές υπηρεσίες", cpv: ["79", "71"], terms: ["συμβουλευ", "οργανωσ", "υπηρεσι"] },
  healthcare: { name: "Υγεία & εξοπλισμός", cpv: ["33", "85"], terms: ["νοσοκομ", "ιατρικ", "φαρμακ"] },
  facility: { name: "Καθαριότητα & συντήρηση", cpv: ["90", "50"], terms: ["καθαριοτ", "συντηρησ", "αποκομιδ"] },
  supply: { name: "Προμήθειες & υλικά", cpv: ["39", "44", "15", "18"], terms: ["προμηθει", "υλικ", "εξοπλισμ"] },
  construction: { name: "Κατασκευές & έργα", cpv: ["45"], terms: ["κατασκευ", "ανακαιν", "εργασι"] },
  transport: { name: "Μεταφορές & οχήματα", cpv: ["60", "34"], terms: ["μεταφορ", "οχημα"] },
  education: { name: "Εκπαίδευση", cpv: ["80"], terms: ["εκπαιδευ", "καταρτισ"] },
};
let runtime = {
  items: [], checkedAt: null, successAt: null, errors: [], countRead: 0,
  releaseCount: 0, candidates: 0, lastSources: [], cycles: 0, status: "booting",
};
let refreshPromise = null;
const txt = v => String(v == null ? "" : v).normalize("NFC");
const safeText = v => txt(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 650);
const strip = v => safeText(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const sec = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const finiteAmount = x => typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : null;
const days = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const escXml = sec;
const json = (res, status, data) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(data));
};
const html = (res, status, body) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self' https://www.paypal.com; base-uri 'none'; frame-ancestors 'none'" });
  res.end(body);
};
const htmlOption = (x) => sec(x);
const money = x => x == null ? "Δεν δημοσιεύεται" : new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format(x);

function extractCpv(tender) {
  const arr = [];
  const add = x => {
    if (typeof x === "string" && /^\d{6,9}$/.test(x.replace(/[^0-9]/g, ""))) arr.push(x.replace(/[^0-9]/g, "").slice(0, 8));
  };
  add(tender?.mainProcurementCategory?.id);
  add(tender?.classification?.id);
  for (const el of [...(tender?.additionalClassifications || []), ...(tender?.items || []).flatMap(x => [x.classification, ...(x.additionalClassifications || [])])]) add(el?.id);
  return [...new Set(arr)].slice(0, 8);
}
function categorize(title, cpv) {
  const normalized = strip(title);
  for (const [id, c] of Object.entries(CAT)) if (cpv.some(x => c.cpv.some(p => x.startsWith(p)))) return id;
  for (const [id, c] of Object.entries(CAT)) if (c.terms.some(t => normalized.includes(t))) return id;
  return "supply";
}
function stage(tender, now = Date.now()) {
  const deadline = tender?.tenderPeriod?.endDate || tender?.enquiryPeriod?.endDate || "";
  const stamp = Date.parse(deadline);
  if (!Number.isFinite(stamp) || stamp < now) return { live: false, deadline: null, daysLeft: null };
  return { live: true, deadline: new Date(stamp).toISOString(), daysLeft: Math.ceil((stamp - now) / 86400000) };
}
export function normalizeRelease(release, now = Date.now()) {
  if (!release || typeof release !== "object" || !release.tender || !release.ocid) return null;
  const t = release.tender;
  const time = stage(t, now);
  // A tender is presented as active only with a verifiably future deadline.
  if (!time.live || (t.status && t.status !== "active" && t.status !== "planning")) return null;
  const title = safeText(t.title || release.title);
  if (title.length < 12) return null;
  const cpv = extractCpv(t);
  const buyer = safeText(release.buyer?.name || "Φορέας μη καταχωρισμένος");
  const amount = finiteAmount(t.value?.amount);
  const id = safeText(release.ocid).slice(0, 160);
  if (!id.startsWith("ocds-")) return null;
  let official = [];
  for (const d of t.documents || []) {
    try { const u = new URL(d.url); if (u.protocol === "https:") official.push(u.toString()); } catch {}
  }
  const cat = categorize(title, cpv);
  const explanation = [
    "Εντοπίστηκε προκήρυξη με μελλοντική προθεσμία στα δημόσια δεδομένα.",
    cpv.length ? "Κωδικοί CPV: " + cpv.join(", ") : "Δεν εντοπίστηκε CPV στην εγγραφή.",
    amount != null ? "Δημοσιευμένη αξία: " + money(amount) : "Η αξία δεν διατίθεται στο εξεταζόμενο αρχείο.",
    "Απαιτείται έλεγχος των επίσημων εγγράφων πριν από κάθε ενέργεια."
  ];
  // The score is about completeness and preparation urgency, not probability of winning.
  const score = Math.min(100, 35 + (cpv.length ? 15 : 0) + (amount ? 10 : 0) + (official.length ? 15 : 0) + (time.daysLeft > 2 && time.daysLeft <= 21 ? 20 : 0));
  return { id, title, buyer, cpv, category: cat, amount, currency: t.value?.currency || "EUR", deadline: time.deadline, daysLeft: time.daysLeft, score, source: SOURCE, official: official.slice(0, 3), issuedAt: release.date || null, stage: "δημοσιευμένη προκήρυξη", explanation };
}
export function mergeReleases(releases, now = Date.now()) {
  const dedup = new Map();
  for (const release of releases) {
    const item = normalizeRelease(release, now);
    if (!item) continue;
    const prior = dedup.get(item.id);
    if (!prior || (item.issuedAt || "") > (prior.issuedAt || "")) dedup.set(item.id, item);
  }
  return [...dedup.values()].sort((a, b) => b.score - a.score || a.daysLeft - b.daysLeft || a.title.localeCompare(b.title, "el")).slice(0, 250);
}
async function fetchLimited(url) {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "SignalForgeGR/1.0 (+https://signalforge-gr.onrender.com)" }, signal: AbortSignal.timeout(16000) });
  if (!response.ok) throw new Error("upstream HTTP " + response.status);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) throw new Error("upstream response exceeds 8 MiB limit");
  return JSON.parse(Buffer.from(buffer).toString("utf8"));
}
// Agent 1: sourced discovery, Agent 2: cautious validation, Agent 3: scoring,
// Agent 4: evidence-backed briefing, Agent 5: autonomous SEO/RSS distribution.
export async function runCycle(fetcher = fetchLimited) {
  const sources = [days(1), days(2), days(3), days(5), days(8)];
  const outcomes = await Promise.allSettled(sources.map(async d => {
    const url = "https://api.diavgis.gr/ocds/releases/" + d;
    const result = await fetcher(url);
    if (!Array.isArray(result.releases)) throw new Error("no OCDS releases array");
    return { day: d, url, data: result.releases, partial: Boolean(result.links?.next) };
  }));
  let rows = [], errors = [], sourcesRead = [], partialCount = 0;
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o.status === "fulfilled") {
      rows.push(...o.value.data);
      sourcesRead.push(o.value.url);
      if (o.value.partial) partialCount++;
    } else errors.push(sources[i] + ": " + String(o.reason?.message || o.reason).slice(0, 90));
  }
  const items = mergeReleases(rows);
  const successful = sourcesRead.length > 0;
  runtime = {
    ...runtime, items: successful ? items : runtime.items,
    checkedAt: new Date().toISOString(), successAt: successful ? new Date().toISOString() : runtime.successAt,
    errors, countRead: successful ? rows.length : runtime.countRead, releaseCount: rows.length,
    candidates: successful ? items.length : runtime.candidates, lastSources: sourcesRead,
    partialCount, cycles: runtime.cycles + 1, status: successful ? "ready" : "source_unavailable",
  };
  console.log(JSON.stringify({agentCycle:runtime.cycles,status:runtime.status,sources:sourcesRead.length,releases:rows.length,candidates:items.length,errors}));
  return runtime;
}
function triggerCycle() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = runCycle().finally(() => refreshPromise = null);
  return refreshPromise;
}
function maybeRefresh() {
  if (!runtime.checkedAt || Date.now() - Date.parse(runtime.checkedAt) >= SCAN_MS) return triggerCycle();
  return Promise.resolve(runtime);
}
function report(item) {
  const known = [
    { name: "Ταυτοποίηση φορέα", state: item.buyer !== "Φορέας μη καταχωρισμένος" ? "Αναφέρεται" : "Χρειάζεται έλεγχο" },
    { name: "Κατάταξη CPV", state: item.cpv.length ? item.cpv.join(", ") : "Χρειάζεται έλεγχο" },
    { name: "Καταληκτική ημερομηνία", state: item.deadline ? new Date(item.deadline).toLocaleDateString("el-GR") : "Χρειάζεται έλεγχο" },
    { name: "Προϋπολογισμός", state: money(item.amount) },
    { name: "Απαιτούμενα δικαιολογητικά", state: "Δεν εξάγονται αυτόματα από το ανοιχτό dataset — ελέγξτε το πλήρες κείμενο" },
    { name: "Εγγυητική επιστολή", state: "Δεν τεκμηριώνεται — ελέγξτε το πλήρες κείμενο" },
    { name: "Δικαιώματα συμμετοχής", state: "Δεν τεκμηριώνονται — ελέγξτε το πλήρες κείμενο" },
  ];
  return { title: item.title, buyer: item.buyer, deadline: item.deadline, amount: item.amount, cpv:item.cpv, checklist:known, nextSteps:[
    "Επαληθεύστε τη δημοσίευση στην πρωτογενή πηγή.",
    "Ανοίξτε και μελετήστε τα πλήρη τεύχη και τυχόν διορθώσεις.",
    "Ελέγξτε προϋποθέσεις συμμετοχής, προθεσμίες και κριτήρια.",
    "Προετοιμάστε μόνο ακριβή δικαιολογητικά της δικής σας επιχείρησης.",
    "Υποβάλετε προσφορά μόνο μέσω των προβλεπόμενων επισήμων καναλιών."
  ], provenance: { dataset: SOURCE, originalDocs: item.official, ocds: item.id, license: LICENSE }, limitation: "Προκαταρκτική αυτοματοποιημένη σύνοψη, όχι πλήρης έλεγχος προκήρυξης ή εγγύηση ανάθεσης." };
}
function makeBriefHtml(item, premium = false) {
  const r = report(item);
  return '<article class="brief"><h2>' + sec(item.title) + '</h2><p><b>Φορέας:</b> ' + sec(item.buyer) + '</p><p><b>Προθεσμία:</b> ' + sec(new Date(item.deadline).toLocaleDateString("el-GR")) + '</p><p><b>Αξία:</b> ' + sec(money(item.amount)) + '</p><p><b>CPV:</b> ' + sec(item.cpv.join(", ") || "Μη διαθέσιμο") + '</p>' +
    (premium ? '<h3>Προκαταρκτικός πίνακας ενεργειών</h3><ol>' + r.checklist.map(c => '<li><b>' + sec(c.name) + ':</b> ' + sec(c.state) + '</li>').join("") + '</ol><h3>Επόμενα βήματα</h3><ol>' + r.nextSteps.map(s => '<li>' + sec(s) + '</li>').join("") + '</ol>' : '<p>Σύντομη επαληθευμένη εικόνα. Ο πληρέστερος πίνακας ενεργειών διατίθεται εφόσον ενεργοποιηθεί η ασφαλής πληρωμή.</p>') +
    '<p><small>' + sec(r.limitation) + ' · Πηγή <a href="' + SOURCE + '" rel="nofollow noopener" target="_blank">Diavgis</a> · CC BY 4.0</small></p></article>';
}
function signed(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", PAYPAL.signing).update(data).digest("base64url");
  return data + "." + sig;
}
function verified(token) {
  const parts = String(token).split(".");
  if (parts.length !== 2 || !PAYPAL.signing) return null;
  const computed = createHmac("sha256", PAYPAL.signing).update(parts[0]).digest("base64url");
  const a = Buffer.from(parts[1]), b = Buffer.from(computed);
  if (a.length !== b.length || !timingSafeEqual(a,b)) return null;
  let obj; try { obj = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { return null }
  return obj && Number.isFinite(obj.exp) && obj.exp > Date.now() ? obj : null;
}
async function paypalToken() {
  const token = Buffer.from(PAYPAL.id + ":" + PAYPAL.secret).toString("base64");
  const response = await fetch(PAYPAL.endpoint + "/v1/oauth2/token", { method:"POST", headers: { authorization: "Basic " + token, "content-type":"application/x-www-form-urlencoded" }, body:"grant_type=client_credentials", signal:AbortSignal.timeout(15000) });
  if (!response.ok) throw Error("PayPal authentication failed (" + response.status + ")");
  return (await response.json()).access_token;
}
async function paypalCall(pathname, method, body, id) {
  const bearer = await paypalToken();
  const headers = { authorization:"Bearer " + bearer, "content-type":"application/json" };
  if (id) headers["PayPal-Request-Id"] = id;
  const response = await fetch(PAYPAL.endpoint + pathname, { method, headers, body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error("PayPal returned HTTP " + response.status + " (" + safeText(data.name || data.message || "transaction error") + ")");
  return data;
}
async function createOrder(itemId) {
  if (!isCheckoutReady()) throw Error("PayPal is not connected");
  const item = runtime.items.find(x => x.id === itemId);
  if (!item) throw Error("The selected opportunity is no longer present");
  const nonce = randomUUID().slice(0,18);
  const key = createHash("sha256").update(item.id).digest("hex").slice(0,20);
  const clear = key + "." + Math.floor(Date.now()/1000).toString(36) + "." + nonce.slice(0,8);
  const state = clear + "." + createHmac("sha256",PAYPAL.signing).update(clear).digest("base64url").slice(0,30);
  const body = {
    intent:"CAPTURE",
    purchase_units:[{ reference_id:"bidbrief", custom_id:state, amount:{currency_code:"EUR",value:PRICE}, description:"SignalForge — Procurement preparation brief" }],
    payment_source:{ paypal:{ experience_context:{ brand_name:"SignalForge GR", user_action:"PAY_NOW", return_url:ORIGIN + "/payment/return", cancel_url:ORIGIN + "/payment/cancel" } } }
  };
  const order = await paypalCall("/v2/checkout/orders","POST",body,randomUUID());
  const approve = order.links?.find(x=>x.rel==="payer-action"||x.rel==="approve")?.href;
  if (!approve || !approve.startsWith("https://www.paypal.com/") && !approve.startsWith("https://www.sandbox.paypal.com/")) throw Error("No valid PayPal approval link");
  return { orderId:order.id,approve };
}
async function captureOrder(orderId) {
  if (!isCheckoutReady() || !/^[A-Z0-9]{10,30}$/.test(orderId)) throw Error("Invalid order");
  const order = await paypalCall("/v2/checkout/orders/" + orderId,"GET");
  const unit = order.purchase_units?.[0];
  const parts = String(unit?.custom_id||"").split(".");
  if (parts.length !== 4) throw Error("Invalid order marker");
  const clear = parts.slice(0,3).join(".");
  const expected = createHmac("sha256",PAYPAL.signing).update(clear).digest("base64url").slice(0,30);
  const left=Buffer.from(parts[3]),right=Buffer.from(expected);
  if(left.length!==right.length||!timingSafeEqual(left,right))throw Error("Unverified order origin");
  const age=Date.now()/1000-parseInt(parts[1],36);
  if(!Number.isFinite(age)||age<0||age>7200)throw Error("Order marker expired");
  if (unit?.reference_id !== "bidbrief") throw Error("Unverified order origin");
  const item = runtime.items.find(x=>createHash("sha256").update(x.id).digest("hex").slice(0,20)===parts[0]);
  if(!item)throw Error("Product no longer available for delivery; contact support with the PayPal order reference");
  if (unit.amount?.value !== PRICE || unit.amount?.currency_code !== "EUR") throw Error("Order price mismatch");
  if (!unit.payee?.email_address || unit.payee.email_address.toLowerCase() !== PAYPAL.merchant) throw Error("Verified seller email is required");
  if (order.status === "APPROVED") await paypalCall("/v2/checkout/orders/" + orderId + "/capture","POST",null,orderId + "-sf1");
  const updated = await paypalCall("/v2/checkout/orders/" + orderId,"GET");
  const pu = updated.purchase_units?.[0];
  const capture = pu?.payments?.captures?.[0];
  if (updated.status !== "COMPLETED" || capture?.status !== "COMPLETED" || capture.amount?.value !== PRICE || capture.amount?.currency_code !== "EUR") throw Error("PayPal has not confirmed a complete capture");
  if (capture.seller_receivable_breakdown == null) { /* Still rely on PayPal capture status, not client redirects. */ }
  return signed({ item, exp:Date.now()+30*86400000, orderId, paid:true });
}
function bodyJson(req, max = 8000) {
  return new Promise((resolve, reject) => {
    let str=""; req.on("data",c=>{str+=c;if(str.length>max){reject(Error("request too long"));req.destroy()}});
    req.on("end",()=>{try{resolve(JSON.parse(str||"{}"))}catch{reject(Error("invalid JSON"))}});
    req.on("error",reject);
  });
}
function paymentStatus() { return { active:isCheckoutReady(), priceEUR:PRICE, provider:"PayPal", instructions:isCheckoutReady() ? "Verified PayPal Orders v2 checkout is available." : "No merchant API credentials configured; checkout is intentionally disabled." }; }
function prettyDate(date) { return new Date(date).toLocaleString("el-GR",{dateStyle:"medium"}); }
function tenderUrl(item) { return ORIGIN + "/o/" + encodeURIComponent(item.id); }
function rssFeed() {
  const items = runtime.items.slice(0, 40);
  return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>SignalForge GR — Τεκμηριωμένα δημόσια σήματα</title><link>'+ORIGIN+'</link><description>Αυτοματοποιημένος προέλεγχος με παραπομπές στο Diavgis. Όχι εγγύηση συμμετοχής.</description><language>el</language>'+
   items.map(x=>'<item><title>'+escXml(x.title)+'</title><link>'+escXml(tenderUrl(x))+'</link><guid>'+escXml(tenderUrl(x))+'</guid><description>'+escXml(x.buyer+' · Προθεσμία '+prettyDate(x.deadline))+'</description></item>').join("")+
   '</channel></rss>';
}
function sitemap() {
 const urls = [ORIGIN,ORIGIN+"/about",...runtime.items.slice(0,80).map(tenderUrl)];
 return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+urls.map(x=>'<url><loc>'+escXml(x)+'</loc></url>').join("")+'</urlset>';
}
function webPage(title, content) {
 return '<!doctype html><html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+sec(title)+' — SignalForge GR</title><link rel="canonical" href="'+ORIGIN+'"><style>body{background:#0b1720;color:#e6f2ed;max-width:850px;margin:8vh auto;padding:20px;font:16px/1.75 system-ui}a{color:#b1eccd}.brief{border:1px solid #46665b;border-radius:18px;background:#162b31;padding:30px}.brief li{padding:7px 0}</style></head><body><p><a href="/">← SignalForge GR</a></p>'+content+'<p>Στοιχεία Diavgis, άδεια <a href="'+LICENSE+'">CC BY 4.0</a>. Δεν αποτελεί επίσημη κυβερνητική πλατφόρμα.</p></body></html>';
}
async function handler(req,res) {
 const url = new URL(req.url, ORIGIN);
 const route = url.pathname;
 try {
   if (route === "/health") return json(res,200,{ok:true,service:"signalfoundry-gr",mode:runtime.status,sourceSuccess:!!runtime.successAt,checkedAt:runtime.checkedAt});
   if (route === "/api/agents") return json(res,200,{mode:"autonomous-cooperating-workers",agents:[
    {name:"Scout",state:runtime.checkedAt?"operational":"starting",role:"Fetches documented public OCDS packages"},
    {name:"Verifier",state:"operational",role:"Requires future tender deadlines and provenance"},
    {name:"Matcher",state:"operational",role:"Classifies CPV and describes buyer demand"},
    {name:"Briefmaker",state:"operational",role:"Produces source-grounded supplier briefs"},
    {name:"Publisher",state:"operational",role:"Automatically exposes RSS, sitemap, and public opportunity pages"},
    {name:"Commerce",state:isCheckoutReady()?"configured":"blocked_missing_paypal_credentials",role:"Captures verified PayPal orders before unlocking reports"}],
    stats:{cycles:runtime.cycles,checkedAt:runtime.checkedAt,sourceSuccess:runtime.successAt,releaseCount:runtime.releaseCount,candidates:runtime.candidates,partialDays:runtime.partialCount},checkout:paymentStatus()});
   if (route === "/api/market") {
     await maybeRefresh();
     const sector = url.searchParams.get("sector");
     const q = strip((url.searchParams.get("q")||"").slice(0,80));
     const all = runtime.items.filter(i=>(!sector||!CAT[sector]||sector===i.category) && (!q||strip(i.title+" "+i.buyer+" "+i.cpv.join(" ")).includes(q)));
     return json(res,200,{status:runtime.status,source:SOURCE,license:LICENSE,checkedAt:runtime.checkedAt,successAt:runtime.successAt,scanned:runtime.countRead,partialDays:runtime.partialCount,categories:CAT,total:all.length,items:all.slice(0,100),errors:runtime.errors,checkout:paymentStatus(),disclaimer:"Only records with verifiably future deadlines are listed. The feed is sampled, not a complete register; use official tender documents."});
   }
   if (route === "/api/brief") {
     await maybeRefresh();
     const item=runtime.items.find(x=>x.id===url.searchParams.get("id"));return item?json(res,200,{preview:true,item,explanation:item.explanation,reportAvailability:paymentStatus()}):json(res,404,{error:"Opportunity not present in current source snapshot"});
   }
   if (route === "/api/commerce") return json(res,200,paymentStatus());
   if (route === "/api/pay/create"&&req.method==="POST") {
     if (!isCheckoutReady()) return json(res,503,{error:"PayPal seller credentials have not been configured. No payment was initiated."});
     const reqBody=await bodyJson(req);
     try{const order=await createOrder(String(reqBody.id||""));return json(res,201,order)}catch(e){return json(res,502,{error:safeText(e.message)})}
   }
   if (route === "/payment/return") {
     const orderId=url.searchParams.get("token")||"";
     if (!isCheckoutReady()) return html(res,503,webPage("Η πληρωμή δεν είναι ενεργή","<h1>Η πληρωμή δεν είναι διαθέσιμη.</h1>"));
     try {
       const receipt=await captureOrder(orderId);
       res.writeHead(302,{location:"/purchase/report?receipt="+encodeURIComponent(receipt),"cache-control":"no-store"});
       return res.end();
     }catch(e){return html(res,409,webPage("Δεν επιβεβαιώθηκε η αγορά","<h1>Η αγορά δεν επιβεβαιώθηκε.</h1><p>"+sec(e.message)+"</p><p>Εάν το PayPal σας χρέωσε, κρατήστε το αποδεικτικό· μη δοκιμάσετε δεύτερη πληρωμή πριν γίνει επιβεβαίωση.</p>"))}
   }
   if (route==="/payment/cancel")return html(res,200,webPage("Ακύρωση πληρωμής","<h1>Η συναλλαγή ακυρώθηκε.</h1><p>Δεν έχει παραδοθεί πληρωμένο προϊόν.</p>"));
   if (route==="/purchase/report") {
     const claims=verified(url.searchParams.get("receipt")||"");
     if (!claims||!claims.paid) return html(res,403,webPage("Απαιτείται επιβεβαιωμένη πληρωμή","<h1>Δεν υπάρχει ενεργή απόδειξη αγοράς.</h1>"));
     const item=claims.item;
     if(!item||!item.title||!item.deadline)return html(res,409,webPage("Εσφαλμένη απόδειξη","<h1>Η επιβεβαιωμένη αναφορά δεν μπορεί να ανακτηθεί.</h1>"));
     return html(res,200,webPage("Αναφορά προετοιμασίας",makeBriefHtml(item,true)));
   }
   if (route === "/robots.txt"){res.writeHead(200,{"content-type":"text/plain; charset=utf-8"});return res.end("User-agent: *\nAllow: /\nSitemap: "+ORIGIN+"/sitemap.xml\n")}
   if (route === "/sitemap.xml"){res.writeHead(200,{"content-type":"application/xml; charset=utf-8"});return res.end(sitemap())}
   if (route === "/feed.xml"){res.writeHead(200,{"content-type":"application/rss+xml; charset=utf-8"});return res.end(rssFeed())}
   if (route.startsWith("/o/")) {
     await maybeRefresh();
     const id=decodeURIComponent(route.slice(3));
     const item=runtime.items.find(x=>x.id===id);
     return item?html(res,200,webPage(item.title,makeBriefHtml(item))):html(res,404,webPage("Δεν βρέθηκε","<h1>Η εγγραφή δεν είναι πλέον διαθέσιμη στο πρόσφατο δείγμα.</h1>"));
   }
   if (route === "/about")return html(res,200,webPage("Μεθοδολογία","<h1>Μεθοδολογία</h1><p>Πέντε ανεξάρτητες διεργασίες συλλέγουν, επαληθεύουν, κατηγοριοποιούν, συνθέτουν και διανέμουν πληροφορίες, με έλεγχο πραγματικής προθεσμίας. Χρησιμοποιούμε ανοιχτά δεδομένα Diavgis με άδεια CC BY 4.0. Δεν υποβάλλουμε προσφορές για λογαριασμό τρίτων ούτε υποσχόμαστε ανάθεση ή κέρδος. Εάν δεν λειτουργεί η πηγή, δεν δημιουργούνται πλαστές ευκαιρίες.</p>"));
   if (route === "/") {
     const page=await readFile(path.join(HERE,"public","index.html"),"utf8");
     return html(res,200,page.replaceAll("__PUBLIC_ORIGIN__",ORIGIN));
   }
   return json(res,404,{error:"Not found"});
 } catch (error) {
   console.error("Request error:",String(error?.stack||error).slice(0,600));
   return json(res,500,{error:"Temporary error, no payment initiated"});
 }
}
export function start(){
 const srv=http.createServer(handler);
 srv.listen(PORT,"0.0.0.0",()=>console.log("SignalForge GR listening on "+PORT));
 triggerCycle().catch(e=>console.error("Cycle start:",String(e)));
 setInterval(()=>triggerCycle().catch(e=>console.error("Cycle:",String(e))),SCAN_MS).unref();
 return srv;
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) start();
