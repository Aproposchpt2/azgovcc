'use strict';
// AzGovCC â€” Member login step 2: verify OTP, issue session token.

const crypto = require('crypto');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const j   = (c, o) => ({ statusCode: c, headers: CORS, body: JSON.stringify(o) });
const sbH = (x = {}) => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...x });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return j(405, { error: 'POST only' });

  let b; try { b = JSON.parse(event.body || '{}'); } catch { return j(400, { error: 'Invalid JSON' }); }
  const email = (b.email || '').trim().toLowerCase();
  const code  = (b.code || '').trim();
  if (!email || !/^\d{6}$/.test(code)) return j(400, { error: 'Enter the 6-digit code.' });

  const nowIso = new Date().toISOString();
  const cr = await fetch(`${SUPABASE_URL}/rest/v1/state_login_codes?email=eq.${encodeURIComponent(email)}&code=eq.${encodeURIComponent(code)}&expires_at=gt.${encodeURIComponent(nowIso)}&state=eq.AZ&order=created_at.desc&limit=1`, { headers: sbH() });
  const codes = await cr.json();
  if (!Array.isArray(codes) || !codes.length) return j(401, { error: 'That code is invalid or expired.' });

  const lr = await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?email=eq.${encodeURIComponent(email)}&state=eq.AZ&status=eq.active&select=state,comp,business_name,keywords`, { headers: sbH() });
  const lookup = await lr.json();
  if (!Array.isArray(lookup) || !lookup.length) return j(403, { error: 'No active AzGovCC subscription found for that email.' });

  const isComp = lookup.some(r => r.comp === true);
  const token = 'ses_' + crypto.randomUUID().replace(/-/g, '');
  const ttlDays = isComp ? 3650 : 30;
  const session_expires_at = new Date(Date.now() + ttlDays * 86400000).toISOString();

  const pr = await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?email=eq.${encodeURIComponent(email)}&state=eq.AZ&status=eq.active`, {
    method: 'PATCH',
    headers: sbH({ Prefer: 'return=representation' }),
    body: JSON.stringify({ session_token: token, session_expires_at }),
  });
  const subs = await pr.json();
  if (!Array.isArray(subs) || !subs.length) return j(403, { error: 'No active subscription found.' });

  await fetch(`${SUPABASE_URL}/rest/v1/state_login_codes?email=eq.${encodeURIComponent(email)}&state=eq.AZ`, { method: 'DELETE', headers: sbH({ Prefer: 'return=minimal' }) });

  return j(200, { ok: true, token, state: 'AZ', business_name: subs[0].business_name, keywords: subs[0].keywords });
};

