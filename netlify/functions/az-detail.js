'use strict';
// CalGCC â€” on-demand bid detail / SOW fetcher.
// GET ?url=<encoded bid URL> â€” fetches the bid's detail page and extracts description, docs, contact.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function clean(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ').trim();
}

function extract(html, patterns) {
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m && m[1] && clean(m[1]).length > 5) return clean(m[1]);
  }
  return null;
}

function parseDetail(html) {
  const description = extract(html, [
    /Description[^<]*<\/[^>]+>\s*<[^>]*>\s*([\s\S]{20,2000}?)<\/(?:td|div|span)/i,
    /Scope[^<]*<\/[^>]+>\s*<[^>]*>\s*([\s\S]{20,2000}?)<\/(?:td|div|span)/i,
    /Summary[^<]*<\/[^>]+>\s*<[^>]*>\s*([\s\S]{20,2000}?)<\/(?:td|div|span)/i,
    /Comments[^<]*<\/[^>]+>\s*<[^>]*>\s*([\s\S]{20,2000}?)<\/(?:td|div|span)/i,
    /Commodity[^<]*<\/[^>]+>\s*<[^>]*>\s*([\s\S]{10,500}?)<\/(?:td|div|span)/i,
  ]);

  const docMatches = [...html.matchAll(/href="[^"]*(?:download|document|attachment|file)[^"]*"[^>]*>([^<]{3,80})</gi)];
  const documents = [...new Set(docMatches.map(m => clean(m[1])).filter(d => d.length > 3))];

  const contactName = extract(html, [
    /Contact\s*Name[^<]*<\/[^>]+>\s*<[^>]*>\s*([A-Za-z\s,\.]{5,60}?)<\//i,
    /Buyer[^<]*<\/[^>]+>\s*<[^>]*>\s*([A-Za-z\s,\.]{5,60}?)<\//i,
    /Purchasing\s*Officer[^<]*<\/[^>]+>\s*<[^>]*>\s*([A-Za-z\s,\.]{5,60}?)<\//i,
  ]);

  const contactEmail = extract(html, [
    /Contact\s*Email[^<]*<\/[^>]+>\s*<[^>]*>\s*([^\s<@]+@[^\s<]{4,60})/i,
    /mailto:([^"]{5,80})"/i,
  ]);

  const preBid = extract(html, [
    /Pre[- ]?[Bb]id[^<]*<\/[^>]+>\s*<[^>]*>\s*([\s\S]{10,300}?)<\/(?:td|div)/i,
    /Pre[- ]?[Pp]roposal[^<]*<\/[^>]+>\s*<[^>]*>\s*([\s\S]{10,300}?)<\/(?:td|div)/i,
  ]);

  return { description, documents, contactName, contactEmail, preBid };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const rawUrl = event.queryStringParameters?.url || '';
  if (!rawUrl) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'url required' }) };

  // Only allow California government domains
  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    const host = new URL(targetUrl).hostname.toLowerCase();
    const allowed = ['.az.gov,.edu,.maricopa.gov,.phoenix.gov,.tucsonaz.gov,.mesaaz.gov,spo.az.gov,planetbids.com', '.az.gov,.edu,.maricopa.gov,.phoenix.gov,.tucsonaz.gov,.mesaaz.gov,spo.az.gov,planetbids.com', '.az.gov,.edu,.maricopa.gov,.phoenix.gov,.tucsonaz.gov,.mesaaz.gov,spo.az.gov,planetbids.com', '.az.gov,.edu,.maricopa.gov,.phoenix.gov,.tucsonaz.gov,.mesaaz.gov,spo.az.gov,planetbids.com', '.az.gov,.edu,.maricopa.gov,.phoenix.gov,.tucsonaz.gov,.mesaaz.gov,spo.az.gov,planetbids.com', '.az.gov,.edu,.maricopa.gov,.phoenix.gov,.tucsonaz.gov,.mesaaz.gov,spo.az.gov,planetbids.com', '.az.gov,.edu,.maricopa.gov,.phoenix.gov,.tucsonaz.gov,.mesaaz.gov,spo.az.gov,planetbids.com'];
    if (!allowed.some(d => host.endsWith(d))) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Domain not allowed' }) };
    }
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid URL' }) };
  }

  try {
    const res = await fetch(targetUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const detail = parseDetail(html);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, ...detail }) };
  } catch (e) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: e.message, description: null, documents: [], contactName: null }) };
  }
};

