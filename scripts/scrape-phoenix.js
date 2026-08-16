'use strict';
/* AzGovCC — City of Phoenix (OpenGov Procurement Portal) scheduled ingest.
   First real AZ data source -- az-pipeline.js previously had nothing but a
   hardcoded SAMPLE_BIDS fallback (bids.json never existed). Same shape/
   convention as NV's scripts/scrape-ngem.js: list pass writes bids.json,
   matching az-pipeline.js's expected fields (id, solicitation_no, title,
   bid_type, agency, close_date, due_in_days, url).

   Confirmed live (2026-08-16): api.procurement.opengov.com's public project
   endpoint is genuinely open -- no login, no Cloudflare gate, plain
   cookie-less POST works (unlike the portal HTML page itself, which does
   sit behind a Cloudflare interactive challenge; the underlying API does
   not). The list response already carries the FULL real description in
   `summary` (rich HTML) -- no separate per-bid detail fetch is needed the
   way NGEM/Bonfire required, this platform is materially more open than
   either Nevada source. Maricopa County itself (BidNet Direct) was scoped
   separately and is NOT usable this way -- everything past the bid title/
   dates is paywalled there; Phoenix is a different government entity on a
   different platform, not the county's.

   Addenda: the list response only carries addendum {id} stubs, not
   filenames/URLs -- real per-addendum resolution needs the portal's own
   authenticated-feeling flow (untested; not attempted). Not blocking core
   ingest, just not covered here yet. */

const fs = require('fs');
const path = require('path');

const API_URL = 'https://api.procurement.opengov.com/api/v1/government/phoenix/project/public';
const PAGE_LIMIT = 50;
const OUT_FILE = path.join(__dirname, '..', 'bids.json');

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&rsquo;/g, "'").replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ').trim();
}

function daysUntil(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

async function fetchPage(page) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ departmentId: 'all', status: 'open', page, limit: PAGE_LIMIT, sortField: 'proposalDeadline', sortDirection: 'DESC' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Phoenix API HTTP ${res.status} on page ${page}`);
  const data = await res.json();
  if (!Array.isArray(data.rows)) throw new Error('Phoenix API response missing rows array');
  return data;
}

function normalize(row) {
  const closeDate = row.proposalDeadline || null;
  const due_in_days = daysUntil(closeDate);
  const noticeType = (row.template && row.template.title) || '';
  return {
    id: `phx-${row.id}`,
    source_record_id: String(row.id),
    solicitation_no: row.financialId || '',
    title: row.title || '',
    bid_type: noticeType,
    agency: (row.department && row.department.name) ? `City of Phoenix — ${row.department.name}` : 'City of Phoenix',
    description: stripHtml(row.summary).slice(0, 6000),
    close_date: closeDate,
    due_in_days,
    daysToClose: due_in_days,
    release_date: row.releaseProjectDate || null,
    addendum_count: Array.isArray(row.addendums) ? row.addendums.length : 0,
    url: `https://procurement.opengov.com/portal/phoenix/projects/${row.id}`,
    status: 'live',
  };
}

async function main() {
  console.log('[scrape-phoenix] loading Phoenix OpenGov open solicitations...');
  const first = await fetchPage(1);
  const total = Number(first.count || first.rows.length);
  console.log(`[scrape-phoenix] page 1: ${first.rows.length} row(s), total reported: ${total}`);

  let allRows = [...first.rows];
  const pages = Math.ceil(total / PAGE_LIMIT);
  for (let page = 2; page <= pages && page <= 20; page++) {
    const data = await fetchPage(page);
    console.log(`[scrape-phoenix] page ${page}: ${data.rows.length} row(s)`);
    allRows.push(...data.rows);
    if (!data.rows.length) break;
  }

  const bids = allRows
    .map(normalize)
    .filter(b => b.due_in_days === null || (b.due_in_days >= 0 && b.due_in_days <= 730))
    .sort((a, b) => (a.due_in_days ?? 9999) - (b.due_in_days ?? 9999));

  const payload = {
    source: 'arizona-procurement', state: 'AZ',
    scanMode: 'live', generatedAt: new Date().toISOString(),
    count: bids.length, bids,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log(`[scrape-phoenix] WROTE bids.json — ${bids.length} open Phoenix solicitations.`);
}

main().catch(e => { console.error('[scrape-phoenix] FAILED:', e.message); process.exit(1); });
