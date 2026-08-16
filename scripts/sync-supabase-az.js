'use strict';
/* AzGovCC (AZ) — sync bids.json into the shared Supabase raw table
   `state_contract_opportunities` (project judislfknmhofcgzyozc, same project
   CA and NV use). Mirrors nevada-gov-contracts/scripts/sync-supabase-nv.js --
   same admission-guard-aware requirements population, same identity-reuse
   fix, same uniform-bulk-insert-keys fix. Read that file's comments for the
   full "why" on each of those three fixes; not re-explained here. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const TABLE = 'state_contract_opportunities';
const BATCH_SIZE = 200;

function sbHeaders(extra) {
  return Object.assign({
    apikey: SERVICE_KEY,
    authorization: 'Bearer ' + SERVICE_KEY,
    'content-type': 'application/json',
  }, extra || {});
}

function readJson(file) {
  const p = path.join(__dirname, '..', file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// Phoenix is entirely within Maricopa County -- every real bid.json row from
// scrape-phoenix.js is a City of Phoenix department, so this is unconditional
// for now. Written as a function (not a constant) so a second AZ source
// (Tucson/Pima, a real state-level SPO feed, etc.) can be added later without
// changing the shape of fromBid() below.
function countyFor(agency) {
  return /phoenix/i.test(agency || '') ? 'Maricopa' : null;
}

// Same admission-guard requirement as NV: natcorp_canonical_contract_
// admission_guard_trg silently drops any row whose `requirements` isn't
// substantive real content. Phoenix's own API already hands back a full,
// real description (row.summary, HTML-stripped by scrape-phoenix.js) inline
// in the list response -- no separate detail fetch needed the way NGEM
// required, so this is simpler than NV's version.
function buildRequirements(b) {
  const scope = (b.description || '').trim();
  if (scope.length < 20) return null;
  return { scope, source: 'phoenix_opengov_public_api' };
}

function fromBid(b) {
  const deadline = b.close_date || null;
  const county = countyFor(b.agency);
  return {
    state_code: 'AZ',
    jurisdiction_type: 'local',
    jurisdiction_name: b.agency || null,
    issuing_organization: b.agency || 'Arizona public agency',
    source_platform: 'phoenix_opengov',
    source_record_id: String(b.source_record_id || b.id),
    source_url: b.url || null,
    solicitation_number: b.solicitation_no || null,
    title: b.title,
    description: b.description || null,
    notice_type: b.bid_type || null,
    status: 'open',
    response_deadline: deadline,
    posted_at: b.release_date || null,
    place_of_performance_city: /phoenix/i.test(b.agency || '') ? 'Phoenix' : null,
    place_of_performance_county: county,
    place_of_performance_state: 'AZ',
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    document_urls: [],
    requirements: buildRequirements(b),
    acquisition_method: 'official_public_opengov_portal',
    extraction_confidence: 1.0,
    data_quality_score: 100,
    qa_status: (b.title && deadline) ? 'auto_ingested' : 'incomplete',
    qa_notes: !deadline ? 'proposalDeadline missing or did not parse from source' : null,
    raw_source_payload: b,
  };
}

// Identity-reuse fix (see sync-supabase-nv.js for the full 23505 root cause):
// reuse apie_contract_identity's existing id for a source record that's
// already been through the admission -> processing funnel once, otherwise
// generate a fresh uuid client-side. Every row must carry the same key set
// (PGRST102 uniform-keys requirement), so id is always present.
async function fetchExistingIdentities() {
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/apie_contract_identity?source_platform=eq.phoenix_opengov&select=id,source_record_id',
      { headers: sbHeaders() }
    );
    if (!res.ok) return {};
    const rows = await res.json().catch(() => []);
    const map = {};
    (Array.isArray(rows) ? rows : []).forEach(r => { if (r.source_record_id) map[r.source_record_id] = r.id; });
    return map;
  } catch (e) {
    console.log('[sync-supabase-az] fetchExistingIdentities error:', e.message);
    return {};
  }
}

async function upsertBatch(rows) {
  if (!rows.length) return { ok: 0, failed: 0 };
  let ok = 0, failed = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/' + TABLE + '?on_conflict=source_platform,source_record_id',
        { method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(chunk) }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.log('[sync-supabase-az] batch upsert FAILED (' + res.status + '): ' + body.slice(0, 400));
        failed += chunk.length;
      } else {
        ok += chunk.length;
      }
    } catch (e) {
      console.log('[sync-supabase-az] batch upsert error:', e.message);
      failed += chunk.length;
    }
  }
  return { ok, failed };
}

async function closeExpired() {
  const nowIso = new Date().toISOString();
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/' + TABLE + '?state_code=eq.AZ&status=neq.closed&response_deadline=lt.' + encodeURIComponent(nowIso),
      { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ status: 'closed', closed_at: nowIso }) }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.log('[sync-supabase-az] close-expired FAILED (' + res.status + '): ' + body.slice(0, 400));
      return 0;
    }
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  } catch (e) {
    console.log('[sync-supabase-az] close-expired error:', e.message);
    return 0;
  }
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.log('[sync-supabase-az] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase sync (bids.json is unaffected).');
    return;
  }

  const data = readJson('bids.json');
  if (!data || !Array.isArray(data.bids) || !data.bids.length) {
    console.log('[sync-supabase-az] No bids.json bids found — nothing to sync.');
    return;
  }

  const identityMap = await fetchExistingIdentities();
  const rows = data.bids.map(fromBid).map(r => ({
    ...r,
    id: identityMap[r.source_record_id] || crypto.randomUUID(),
  }));
  console.log('[sync-supabase-az] bids: ' + rows.length + ' mapped');

  const { ok, failed } = await upsertBatch(rows);
  console.log('[sync-supabase-az] upserted ' + ok + ' row(s), ' + failed + ' failed, into ' + TABLE + '.');

  const closed = await closeExpired();
  console.log('[sync-supabase-az] marked ' + closed + ' AZ row(s) closed (response_deadline passed).');
}

main().catch(e => {
  console.error('[sync-supabase-az] FAILED:', e.message);
  process.exit(0);
});
