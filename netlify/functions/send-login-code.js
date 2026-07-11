'use strict';
// AzGovCC â€” Member login step 1: email a 6-digit OTP to an active AzGovCC subscriber.

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.BC_SUPA_URL || '').replace(/\/$/, '');
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.BC_SUPA_KEY || '';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const FROM         = process.env.RESEND_FROM_EMAIL || 'AzGovCC <no-reply@aproposgroupllc.com>';

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const j   = (c, o) => ({ statusCode: c, headers: CORS, body: JSON.stringify(o) });
const sbH = (x = {}) => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...x });

const validStatus = m => {
  const s = String(m.subscription_status || '').toLowerCase();
  const te = m.trial_end ? Date.parse(m.trial_end) : 0;
  return ['active', 'trial', 'trialing', 'paid', 'comp'].includes(s) || (Number.isFinite(te) && te > Date.now());
};
const keywordsFrom = m => Array.from(new Set(String(m.industry || '').split(/[,&/|]+/).map(x => x.trim()).filter(Boolean).slice(0, 8)));

async function getSubscriber(email) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?email=eq.${encodeURIComponent(email)}&state=eq.CA&status=eq.active&select=email,business_name&limit=1`, { headers: sbH() });
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function getBcMember(email) {
  const select = 'email,full_name,business_name,industry,city,state,subscription_status,trial_end,bc_access_activated';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/biz_center_members?email=eq.${encodeURIComponent(email)}&bc_access_activated=eq.true&select=${encodeURIComponent(select)}&limit=1`, { headers: sbH() });
  const rows = await r.json().catch(() => []);
  if (!r.ok || !Array.isArray(rows) || !rows.length) return null;
  return validStatus(rows[0]) ? rows[0] : null;
}

async function provisionFromBc(member) {
  const email = String(member.email || '').toLowerCase();
  const payload = { email, business_name: member.business_name || 'Business Center Member', state: 'AZ', status: 'active', comp: true, keywords: keywordsFrom(member) };
  const existing = await fetch(`${SUPABASE_URL}/rest/v1/state_alert_subscribers?email=eq.${encodeURIComponent(email)}&state=eq.CA&select=email&limit=1`, { headers: sbH() }).then(r => r.json()).catch(() => []);
  const method = Array.isArray(existing) && existing.length ? 'PATCH' : 'POST';
  const url = method === 'PATCH' ? `${SUPABASE_URL}/rest/v1/state_alert_subscribers?email=eq.${encodeURIComponent(email)}&state=eq.CA` : `${SUPABASE_URL}/rest/v1/state_alert_subscribers`;
  await fetch(url, { method, headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify(payload) });
  return { email, business_name: payload.business_name };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return j(405, { error: 'POST only' });
  if (!SUPABASE_URL || !SERVICE_KEY) return j(500, { error: 'Supabase environment variables are not configured.' });

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return j(400, { error: 'Invalid JSON' }); }
  const email = String(b.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return j(400, { error: 'A valid email is required.' });

  let subscriber = await getSubscriber(email);
  if (!subscriber) {
    const member = await getBcMember(email);
    if (member) subscriber = await provisionFromBc(member);
  }
  if (!subscriber) return j(200, { ok: true, found: false });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires_at = new Date(Date.now() + 10 * 60000).toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/state_login_codes`, { method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify({ email, state: 'AZ', code, expires_at }) });

  if (RESEND_KEY) {
    const html = `<div style="background:#0F2A6A;padding:34px 16px;font-family:Arial,sans-serif"><div style="max-width:460px;margin:0 auto;background:#11264f;border:1px solid #1c3878;border-radius:8px;padding:32px;text-align:center"><div style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#9DB0D4;margin-bottom:14px">Arizona Government Contracts Center Â· Member Login</div><p style="color:#9DB0D4;font-size:14px;margin:0 0 18px">Your login code:</p><div style="font-size:34px;letter-spacing:.32em;font-weight:700;color:#fff;background:#07111f;border:2px solid #6EE7A8;border-radius:10px;padding:18px;margin-bottom:18px">${code}</div><p style="color:#9DB0D4;font-size:13px;line-height:1.6">Enter this code to access your AzGovCC dashboard. It expires in 10 minutes.</p></div></div>`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [email], subject: `Your AzGovCC login code: ${code}`, html }),
    }).catch(e => console.error('[send-login-code-ca] fetch error:', e.message));
  }

  return j(200, { ok: true, found: true });
};

