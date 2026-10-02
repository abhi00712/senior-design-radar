// Daily scan for Senior Design Radar.
// Reads LinkedIn's public job search (no login), enriches new jobs with OpenAI when
// OPENAI_API_KEY is set, merges into jobs.js, and leaves committing to the workflow.
// Run locally: node scripts/scan.mjs   (add DRY_RUN=1 to skip writing jobs.js)

import { readFile, writeFile } from "node:fs/promises";

const DATA_FILE = new URL("../jobs.js", import.meta.url);
// Remove whitespace/quotes that sneak in when pasting a key (real keys never contain them).
const OPENAI_KEY = (process.env.OPENAI_API_KEY || "").replace(/\s+/g, "").replace(/^["']|["']$/g, "");
if (OPENAI_KEY) console.log(`OpenAI key check: ${OPENAI_KEY.length} chars, starts with "${OPENAI_KEY.slice(0, 3)}", contains whitespace: ${/\s/.test(OPENAI_KEY)}`);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MAX_DETAIL_FETCHES = 70;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const LINKEDIN_QUERIES = ["senior product designer", "senior ux designer", "product designer", "ux designer", "lead product designer"];
const LINKEDIN_PAGES = [0, 25, 50];
const LLM_PAGES = [
  { portal: "Wellfound", url: "https://wellfound.com/role/l/product-designer/bangalore", base: "https://wellfound.com" },
  { portal: "Wellfound", url: "https://wellfound.com/role/l/ui-ux-designer/bangalore", base: "https://wellfound.com" },
  { portal: "Cutshort", url: "https://cutshort.io/jobs/product-design-jobs-in-bangalore-bengaluru", base: "https://cutshort.io" },
];
const RECRUITERS = /talent pro|peak hire|careerxperts|staffnix|hr folks|hr works|hr lobby|hyrme|dash hire|versatile club|neogencode|success pact|outsourcing|consult|recruit|staffing|placement|manpower|talent solutions|\bhire\b/i;

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const istNow = () => {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  return { date: d.toISOString().slice(0, 10), iso: d.toISOString().slice(0, 16) + ":00+05:30" };
};
const TODAY = istNow().date;
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400e3);
const decode = s => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
const text = html => decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const liId = url => (String(url).match(/(\d{8,})(?:[/?#]|$)/) || [])[1];
const keyOf = j => (j.portal === "LinkedIn" && liId(j.url)) ? "li:" + liId(j.url) : "u:" + String(j.url).split("?")[0].toLowerCase();
const looseKey = j => [j.title, j.company, j.portal].join("|").toLowerCase().replace(/\s+/g, " ");

async function get(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9" } });
      if (r.status === 429 || r.status >= 500) { await sleep(4000 * attempt); continue; }
      if (!r.ok) return { ok: false, status: r.status, body: "" };
      return { ok: true, status: r.status, body: await r.text() };
    } catch (e) { await sleep(2000 * attempt); }
  }
  return { ok: false, status: 0, body: "" };
}

// ---------- rules used when OpenAI is unavailable ----------
const isDesignRole = t => /design/i.test(t) && /(ux|ui|product|interaction|experience|user)/i.test(t);
const isExcluded = t => /intern|trainee|junior|jr\.?\b|associate|graphic|motion|brand|visual designer|content designer|writer|product manager|industrial|mechanical|cad\b|fashion|interior/i.test(t);
function levelOf(t) {
  if (/staff|principal|director|head of|vp\b/i.test(t)) return "Staff";
  if (/\blead\b|manager/i.test(t)) return "Lead";
  if (/senior|\bsr\.?\b/i.test(t)) return "Senior";
  return "Mid";
}
function expFromText(s) {
  const m = s.match(/(\d{1,2})\s*(?:\+|plus)?\s*(?:-|–|to)\s*(\d{1,2})\s*\+?\s*(?:years|yrs)/i);
  if (m && +m[1] < +m[2] && +m[2] <= 20) return `${m[1]}–${m[2]} yrs`;
  const n = s.match(/(\d{1,2})\s*\+\s*(?:years|yrs)|(?:minimum|at least|min\.?)\s*(?:of\s*)?(\d{1,2})\s*(?:years|yrs)/i);
  if (n) return `${n[1] || n[2]}+ yrs`;
  return "";
}

// ---------- OpenAI ----------
async function askJSON(system, user) {
  if (!OPENAI_KEY) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, response_format: { type: "json_object" }, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!r.ok) { console.warn("OpenAI error", r.status, (await r.text()).slice(0, 300)); return null; }
    const j = await r.json();
    return JSON.parse(j.choices[0].message.content);
  } catch (e) { console.warn("OpenAI call failed:", e.message); return null; }
}

const ENRICH_RULES = `You classify Bengaluru design job listings for a senior UX designer with 4 years of experience.
Return JSON: {"relevant": boolean, "level": "Senior"|"Mid"|"Lead"|"Staff", "exp": string, "payMinL": number|null, "payMaxL": number|null, "domain": string, "note": string}
- relevant: true only for UX, product, UI/UX, interaction or experience designer roles (design-engineer roles count) based in Bengaluru/Bangalore. False for interns, junior/associate roles, roles asking only 0–2 years, graphic/motion/brand/visual-only, content/UX writing, product managers, and non-digital design (industrial, mechanical, fashion).
- level: Staff for Staff/Principal/Director/Head; Lead for Lead/Manager; Senior for Senior/Sr; Mid for Product Designer, UX Designer, Designer II/2/III without Senior.
- exp: experience asked, formatted like "4–7 yrs", "5+ yrs", "5 yrs"; "" if not stated.
- payMinL/payMaxL: annual pay in lakhs INR only if stated, else null.
- domain: 1–3 words, e.g. "Fintech", "B2B SaaS", "E-commerce", "AI".
- note: up to 4 words from: work mode ("Hybrid", "In office", "Remote"), "needs coding" for design-engineer roles, "Recruiter" if posted by a staffing agency. "" if none.`;

// ---------- sources ----------
async function scanLinkedIn() {
  const seen = new Map();
  let okPages = 0;
  for (const q of LINKEDIN_QUERIES) {
    for (const start of LINKEDIN_PAGES) {
      const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(q)}&location=Bengaluru%2C%20Karnataka%2C%20India&start=${start}`;
      const r = await get(url);
      await sleep(1500);
      if (!r.ok) { console.warn("LinkedIn page failed", r.status, q, start); continue; }
      okPages++;
      const cards = r.body.split(/<li>/).slice(1);
      if (!cards.length) break;
      for (const c of cards) {
        const id = (c.match(/urn:li:jobPosting:(\d+)/) || [])[1];
        const href = (c.match(/base-card__full-link[^>]*href="([^"]+)"/) || [])[1];
        const title = text((c.match(/base-search-card__title">([\s\S]*?)<\/h3>/) || [])[1] || "");
        const company = text((c.match(/base-search-card__subtitle">([\s\S]*?)<\/h4>/) || [])[1] || "");
        const location = text((c.match(/job-search-card__location">([\s\S]*?)<\/span>/) || [])[1] || "");
        const posted = (c.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/) || [])[1] || TODAY;
        if (!id || !title || !href) continue;
        if (!/bengaluru|bangalore/i.test(location)) continue;
        if (!isDesignRole(title) || isExcluded(title)) continue;
        seen.set("li:" + id, { id, title, company, posted, url: decode(href).split("?")[0] });
      }
    }
  }
  return { ok: okPages > 0, jobs: [...seen.values()] };
}

async function enrichLinkedIn(job) {
  const r = await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${job.id}`);
  await sleep(1500);
  const desc = r.ok ? text((r.body.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "") : "";
  return enrichText(job, desc);
}
async function enrichText(job, desc) {
  const ai = await askJSON(ENRICH_RULES, `Title: ${job.title}\nCompany: ${job.company}\nLocation: Bengaluru\nDescription:\n${desc.slice(0, 7000)}`);
  if (ai) return (ai.relevant === false || tooJunior(ai.exp)) ? null : {
    level: ["Senior", "Mid", "Lead", "Staff"].includes(ai.level) ? ai.level : levelOf(job.title),
    exp: String(ai.exp || ""), payMinL: num(ai.payMinL), payMaxL: num(ai.payMaxL),
    domain: String(ai.domain || ""), note: String(ai.note || ""),
  };
  return { level: levelOf(job.title), exp: expFromText(desc), payMinL: null, payMaxL: null, domain: "", note: RECRUITERS.test(job.company) ? "Recruiter" : "" };
}
// Pay below 1 lakh is almost always a monthly figure read as yearly; drop it rather than mislead.
const num = v => (typeof v === "number" && isFinite(v) && v >= 1 && v < 500) ? Math.round(v * 10) / 10 : null;
// Roles that only ask for 0–2 years are too junior for a senior UX designer.
const tooJunior = exp => { const m = String(exp).match(/(\d+)\D+(\d+)/); return /^0\b/.test(String(exp)) || (m && +m[2] <= 2); };

async function scanLLMPage(src) {
  if (!OPENAI_KEY) return { ok: false, jobs: [] };
  const r = await get(src.url);
  if (!r.ok) { console.warn(src.portal, "page failed", r.status); return { ok: false, jobs: [] }; }
  const links = [...r.body.matchAll(/href="(\/(?:jobs|job)\/[^"#?]+)"/g)].map(m => src.base + m[1]);
  const ai = await askJSON(
    ENRICH_RULES + `\nYou receive a job board page instead of one listing. Return {"jobs": [ {title, company, posted (YYYY-MM-DD; convert relative ages using today ${TODAY}), url (absolute; choose from the provided links), relevant, level, exp, payMinL, payMaxL, domain, note} ]}. Include every listing on the page.`,
    `Today: ${TODAY}\nLinks on page:\n${[...new Set(links)].slice(0, 150).join("\n")}\n\nPage text:\n${text(r.body).slice(0, 24000)}`
  );
  if (!ai || !Array.isArray(ai.jobs)) return { ok: false, jobs: [] };
  const jobs = ai.jobs.filter(j => j && j.relevant !== false && j.title && j.url && /^https?:\/\//.test(j.url)
    && isDesignRole(String(j.title)) && !isExcluded(String(j.title)) && !tooJunior(j.exp)).map(j => ({
    title: String(j.title), company: String(j.company || ""), portal: src.portal,
    // Reject malformed or future dates (relative ages are sometimes miscounted).
    posted: (/^\d{4}-\d{2}-\d{2}$/.test(j.posted) && j.posted <= TODAY) ? j.posted : TODAY,
    exp: String(j.exp || ""), payMinL: num(j.payMinL), payMaxL: num(j.payMaxL),
    level: ["Senior", "Mid", "Lead", "Staff"].includes(j.level) ? j.level : levelOf(String(j.title)),
    domain: String(j.domain || ""), url: String(j.url).split("?")[0], note: String(j.note || ""),
  }));
  return { ok: true, jobs };
}

// ---------- more portals (public JSON APIs) ----------
const istDate = ms => new Date(+ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const safeDate = d => (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= TODAY) ? d : TODAY;
const isBlr = l => /bengaluru|bangalore/i.test(String(l || ""));
const keep = t => isDesignRole(t) && !isExcluded(t);
async function getJSON(url, headers = {}) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function scanHirist() {
  const out = new Map(); let ok = false;
  for (const q of ["product designer", "ux designer", "ui ux designer", "interaction designer"]) {
    for (let page = 0; page < 3; page++) {
      const d = await getJSON(`https://gladiator.hirist.tech/job/search?query=${encodeURIComponent(q)}&loc=3&pageNo=${page}`);
      await sleep(800);
      if (!d || !Array.isArray(d.data)) break;
      ok = true;
      for (const x of d.data) {
        const company = x.companyData?.companyName || "";
        // Hirist titles read "Company - Role - Skill"; drop the company prefix.
        const parts = String(x.title || "").split(" - ");
        const first = parts[0].toLowerCase().replace(/[^a-z]/g, "").slice(0, 5);
        const title = parts.length > 1 && company.toLowerCase().replace(/[^a-z]/g, "").startsWith(first) ? parts.slice(1).join(" - ") : x.title;
        if (!keep(title) || !(x.locations || []).some(l => isBlr(l.name))) continue;
        const min = +x.min, max = +x.max;
        out.set(x.jobDetailUrl, { title, company, portal: "Hirist", url: x.jobDetailUrl, posted: safeDate(istDate(x.createdTimeMs)),
          exp: isFinite(min) && isFinite(max) && max > 0 ? `${min}–${max} yrs` : "", desc: "" });
      }
      if (!d.hasMore) break;
    }
  }
  return { ok, jobs: [...out.values()] };
}

async function scanInstahyre() {
  const out = new Map(); let ok = false;
  for (const fn of [7, 77]) { // 7 = UX / Visual Design, 77 = Other Design / Creative
    for (let offset = 0; offset < 300; offset += 100) {
      const d = await getJSON(`https://www.instahyre.com/api/v1/job_search?company_size=0&job_type=0&location=Bangalore&job_functions=${fn}&limit=100&offset=${offset}`);
      await sleep(800);
      if (!d || !Array.isArray(d.objects)) break;
      ok = true;
      for (const x of d.objects) {
        if (!keep(x.title || "") || !isBlr(x.locations)) continue;
        out.set(x.public_url, { title: x.title, company: x.employer?.company_name || "", portal: "Instahyre", url: x.public_url, posted: TODAY, exp: "", desc: "", needsPage: true });
      }
      if (!d.meta?.next || d.objects.length < 100) break;
    }
  }
  return { ok, jobs: [...out.values()] };
}

async function scanAmazon() {
  const out = new Map(); let ok = false;
  for (const q of ["ux designer", "product designer", "interaction designer"]) {
    const d = await getJSON(`https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(q)}&loc_query=Bengaluru%2C%20Karnataka%2C%20India&country=IND&result_limit=50`);
    await sleep(800);
    if (!d || !Array.isArray(d.jobs)) continue;
    ok = true;
    for (const x of d.jobs) {
      if (!keep(x.title || "") || !isBlr(x.normalized_location || x.location)) continue;
      const p = new Date(x.posted_date + " 12:00 GMT+0530");
      out.set(x.job_path, { title: x.title.trim(), company: "Amazon", portal: "Amazon Jobs", url: "https://www.amazon.jobs" + x.job_path,
        posted: safeDate(isNaN(p) ? TODAY : istDate(p.getTime())), exp: "", desc: text([x.basic_qualifications, x.preferred_qualifications, x.description_short].join("\n")) });
    }
  }
  return { ok, jobs: [...out.values()] };
}

const boardsFetched = new Set();
async function scanCompanyBoards() {
  const cfg = JSON.parse(await readFile(new URL("./companies.json", import.meta.url), "utf8"));
  const jobs = []; let ok = false;
  for (const [slug, name] of Object.entries(cfg.greenhouse || {})) {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    if (!d || !Array.isArray(d.jobs)) continue;
    ok = true; boardsFetched.add("greenhouse.io/" + slug);
    for (const x of d.jobs) {
      if (!keep(x.title || "") || !isBlr(x.location?.name)) continue;
      const full = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${x.id}`);
      jobs.push({ title: x.title, company: name, portal: "Company site", url: x.absolute_url, posted: safeDate(String(x.first_published || x.updated_at || "").slice(0, 10)),
        exp: "", desc: text(decode(full?.content || "")), board: "greenhouse.io/" + slug });
    }
  }
  for (const [slug, name] of Object.entries(cfg.lever || {})) {
    const d = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (!Array.isArray(d)) continue;
    ok = true; boardsFetched.add("lever.co/" + slug);
    for (const x of d) {
      const locs = [x.categories?.location, ...(x.categories?.allLocations || [])];
      if (!keep(x.text || "") || !locs.some(isBlr)) continue;
      jobs.push({ title: x.text, company: name, portal: "Company site", url: x.hostedUrl, posted: safeDate(istDate(x.createdAt)),
        exp: "", desc: String(x.descriptionPlain || "") + "\n" + (x.lists || []).map(l => l.text + ": " + text(l.content || "")).join("\n"), board: "lever.co/" + slug });
    }
  }
  for (const [slug, name] of Object.entries(cfg.ashby || {})) {
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    if (!d || !Array.isArray(d.jobs)) continue;
    ok = true; boardsFetched.add("ashbyhq.com/" + slug);
    for (const x of d.jobs) {
      const locs = [x.location, ...(x.secondaryLocations || []).map(l => l.location)];
      if (!keep(x.title || "") || !locs.some(isBlr)) continue;
      jobs.push({ title: x.title.trim(), company: name, portal: "Company site", url: x.jobUrl, posted: safeDate(String(x.publishedAt || "").slice(0, 10)),
        exp: "", desc: String(x.descriptionPlain || ""), board: "ashbyhq.com/" + slug });
    }
  }
  return { ok, jobs };
}

// ---------- main ----------
const raw = await readFile(DATA_FILE, "utf8");
const data = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
// Scheduled backup runs stop if a morning scan already happened today (IST).
if (process.env.SKIP_IF_SCANNED_TODAY && String(data.scannedAt || "").slice(0, 10) === TODAY && String(data.scannedAt).slice(11, 13) >= "08") {
  console.log(`Already scanned today at ${data.scannedAt}; skipping this backup run.`);
  process.exit(0);
}
const existing = new Map(data.jobs.map(j => [keyOf(j), j]));
const existingLoose = new Map(data.jobs.map(j => [looseKey(j), keyOf(j)]));
// Same title + company on any portal counts as the same job (e.g. LinkedIn and the company site).
const tcKey = j => (j.title + "|" + j.company).toLowerCase().replace(/[^a-z0-9|]+/g, "");
const existingTC = new Map(data.jobs.map(j => [tcKey(j), keyOf(j)]));
const seenToday = new Set();
const sourceOk = {};
let added = [], detailFetches = 0;

const li = await scanLinkedIn();
sourceOk.LinkedIn = li.ok;
console.log(`LinkedIn: ${li.ok ? li.jobs.length + " design roles found" : "failed"}`);
for (const j of li.jobs) {
  const k = "li:" + j.id;
  seenToday.add(k);
  const old = existing.get(k);
  if (old) { old.posted = j.posted; continue; }
  if (existingTC.has(tcKey(j))) { seenToday.add(existingTC.get(tcKey(j))); continue; }
  if (daysBetween(j.posted, TODAY) > 120) continue;
  if (detailFetches >= MAX_DETAIL_FETCHES) continue;
  detailFetches++;
  const extra = await enrichLinkedIn(j);
  if (!extra) continue;
  const job = { title: j.title, company: j.company, portal: "LinkedIn", posted: j.posted, ...extra, url: j.url, firstSeen: TODAY };
  existing.set(k, job); added.push(job); existingTC.set(tcKey(job), k);
}

for (const src of LLM_PAGES) {
  const res = await scanLLMPage(src);
  sourceOk[src.portal] = sourceOk[src.portal] || res.ok;
  console.log(`${src.portal} (${src.url}): ${res.ok ? res.jobs.length + " roles" : "skipped or failed"}`);
  for (const j of res.jobs) {
    let k = keyOf(j);
    if (!existing.has(k) && existingLoose.has(looseKey(j))) k = existingLoose.get(looseKey(j));
    if (!existing.has(k) && existingTC.has(tcKey(j))) k = existingTC.get(tcKey(j));
    seenToday.add(k);
    const old = existing.get(k);
    // Board pages often lack a precise date; keep the earliest posting date we've seen.
    if (old) { Object.assign(old, { ...j, firstSeen: old.firstSeen, url: old.url, posted: old.posted < j.posted ? old.posted : j.posted }); continue; }
    if (daysBetween(j.posted, TODAY) > 120) continue;
    const job = { ...j, firstSeen: TODAY };
    existing.set(k, job); added.push(job); existingTC.set(tcKey(job), k);
  }
}

for (const [portal, scan] of [["Hirist", scanHirist], ["Instahyre", scanInstahyre], ["Amazon Jobs", scanAmazon], ["Company site", scanCompanyBoards]]) {
  const res = await scan();
  sourceOk[portal] = sourceOk[portal] || res.ok;
  console.log(`${portal}: ${res.ok ? res.jobs.length + " design roles found" : "failed"}`);
  for (const j of res.jobs) {
    let k = keyOf(j);
    if (!existing.has(k) && existingTC.has(tcKey(j))) k = existingTC.get(tcKey(j));
    seenToday.add(k);
    const old = existing.get(k);
    if (old) {
      if (j.posted < old.posted) old.posted = j.posted;
      if (j.exp && !old.exp) old.exp = j.exp;
      continue;
    }
    if (daysBetween(j.posted, TODAY) > 120 || tooJunior(j.exp)) continue;
    if (detailFetches >= MAX_DETAIL_FETCHES) continue;
    detailFetches++;
    let desc = j.desc;
    if (j.needsPage) { const r = await get(j.url); await sleep(800); desc = r.ok ? text(r.body).slice(0, 8000) : ""; }
    const extra = await enrichText(j, desc);
    if (!extra) continue;
    const job = { title: j.title, company: j.company, portal: j.portal, posted: j.posted, ...extra, exp: j.exp || extra.exp, url: j.url, firstSeen: TODAY };
    existing.set(k, job); added.push(job); existingTC.set(tcKey(job), k);
  }
}

// Remove stale rows
let removed = 0;
for (const [k, j] of existing) {
  const age = daysBetween(j.posted, TODAY);
  const fromScanned = ["LinkedIn", "Wellfound", "Cutshort", "Hirist", "Instahyre", "Amazon Jobs"].includes(j.portal);
  // A company board lists only open roles, so a role missing from a board we just read has closed.
  const closedOnBoard = j.portal === "Company site" && [...boardsFetched].some(b => j.url.includes(b)) && !seenToday.has(k);
  const gone = (fromScanned && sourceOk[j.portal] && !seenToday.has(k) && age > 45) || closedOnBoard;
  if (age > 120 || gone) { existing.delete(k); removed++; }
}

// Final cleanup on every row: drop too-junior roles, mark recruiter posts, merge same-title duplicates per portal.
const byTC = new Map();
for (const [k, j] of existing) {
  if (tooJunior(j.exp)) { existing.delete(k); removed++; continue; }
  if (RECRUITERS.test(j.company) && !/recruiter/i.test(j.note || "")) j.note = j.note ? j.note + " · Recruiter" : "Recruiter";
  const dk = tcKey(j) + "|" + j.portal;
  const prev = byTC.get(dk);
  if (prev) {
    const keepOld = prev.job.posted <= j.posted;
    const [winner, loserKey] = keepOld ? [prev.job, k] : [j, prev.key];
    if (!winner.exp) winner.exp = (keepOld ? j : prev.job).exp || "";
    existing.delete(loserKey); removed++;
    if (!keepOld) byTC.set(dk, { key: k, job: j });
  } else byTC.set(dk, { key: k, job: j });
}

const jobs = [...existing.values()].map(j => ({
  title: j.title, company: j.company, portal: j.portal, posted: j.posted, exp: j.exp || "",
  payMinL: j.payMinL ?? null, payMaxL: j.payMaxL ?? null, level: j.level, domain: j.domain || "",
  url: j.url, note: j.note || "", firstSeen: j.firstSeen || TODAY,
})).sort((a, b) => b.posted.localeCompare(a.posted));

// Validate before writing
const urls = new Set();
for (const j of jobs) {
  if (!j.title || !j.url || !/^\d{4}-\d{2}-\d{2}$/.test(j.posted) || !["Senior", "Mid", "Lead", "Staff"].includes(j.level)) throw new Error("Invalid job: " + JSON.stringify(j));
  if (urls.has(j.url)) throw new Error("Duplicate url: " + j.url);
  urls.add(j.url);
}
if (!Object.values(sourceOk).some(Boolean) || jobs.length < 30) {
  console.error(`Safety stop: ${jobs.length} jobs, sources ok: ${JSON.stringify(sourceOk)}. jobs.js left unchanged.`);
  process.exit(1);
}

const out = { scannedAt: istNow().iso, previousScanAt: data.scannedAt, sources: data.sources, jobs };
console.log(`Total ${jobs.length} · new ${added.length} · removed ${removed} · OpenAI ${OPENAI_KEY ? "on (" + OPENAI_MODEL + ")" : "off"}`);
for (const j of added.slice(0, 12)) console.log(`  + ${j.title} – ${j.company} (${j.portal})`);
if (process.env.DRY_RUN) { console.log("DRY_RUN: not writing jobs.js"); process.exit(0); }
await writeFile(DATA_FILE, "window.RADAR = " + JSON.stringify(out, null, 1) + ";\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `### Daily scan ${TODAY}\n- Total: ${jobs.length}\n- New: ${added.length}\n- Removed: ${removed}\n- Sources OK: ${Object.entries(sourceOk).map(([k, v]) => `${k} ${v ? "✅" : "❌"}`).join(", ")}\n- OpenAI: ${OPENAI_KEY ? "on" : "off (rules only)"}\n${added.slice(0, 20).map(j => `  - ${j.title} – ${j.company}`).join("\n")}\n`, { flag: "a" });
}
