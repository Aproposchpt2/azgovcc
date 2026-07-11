'use strict';
// AzGovCC — Arizona Government Contracts Center
// Reads bids from bids.json (populated by GitHub Actions scraper).
// Falls back to sample Arizona bids if bids.json is missing.

const fs   = require('fs');
const path = require('path');

const HEADERS = {
  'Content-Type':                'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control':               'public, max-age=300, s-maxage=300',
};

const SAMPLE_BIDS = [
  {
    id: 'AZ-SAMPLE-001',
    solicitation_no: 'ADOA-2026-001',
    title: 'Information Technology Professional Services',
    bid_type: 'RFP',
    agency: 'Arizona Department of Administration',
    close_date: new Date(Date.now() + 12 * 86400000).toISOString(),
    due_in_days: 12,
    url: 'https://spo.az.gov',
    status: 'sample',
  },
  {
    id: 'AZ-SAMPLE-002',
    solicitation_no: 'MAR-2026-IT-042',
    title: 'Enterprise Software Licensing and Support',
    bid_type: 'RFQ',
    agency: 'Maricopa County',
    close_date: new Date(Date.now() + 7 * 86400000).toISOString(),
    due_in_days: 7,
    url: 'https://www.maricopa.gov/purchasing',
    status: 'sample',
  },
  {
    id: 'AZ-SAMPLE-003',
    solicitation_no: 'PHX-2026-0391',
    title: 'AI Automation and Workflow Services',
    bid_type: 'RFP',
    agency: 'City of Phoenix',
    close_date: new Date(Date.now() + 18 * 86400000).toISOString(),
    due_in_days: 18,
    url: 'https://www.phoenix.gov/finance/contracts',
    status: 'sample',
  },
  {
    id: 'AZ-SAMPLE-004',
    solicitation_no: 'ASU-2026-PROC-88',
    title: 'CRM System Implementation and Integration',
    bid_type: 'RFP',
    agency: 'Arizona State University',
    close_date: new Date(Date.now() + 21 * 86400000).toISOString(),
    due_in_days: 21,
    url: 'https://asu.edu/procurement',
    status: 'sample',
  },
  {
    id: 'AZ-SAMPLE-005',
    solicitation_no: 'TUC-2026-IT-019',
    title: 'Managed IT Services — Network Infrastructure',
    bid_type: 'IFB',
    agency: 'City of Tucson',
    close_date: new Date(Date.now() + 5 * 86400000).toISOString(),
    due_in_days: 5,
    url: 'https://www.tucsonaz.gov/procurement',
    status: 'sample',
  },
];

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  let rawBids = [];

  try {
    const bidsPath = path.resolve(__dirname, '../../bids.json');
    const raw      = fs.readFileSync(bidsPath, 'utf-8');
    const parsed   = JSON.parse(raw);
    rawBids        = Array.isArray(parsed.bids) ? parsed.bids : [];
  } catch {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        source: 'arizona-procurement', state: 'AZ',
        scanMode: 'sample', generatedAt: new Date().toISOString(),
        count: SAMPLE_BIDS.length, bids: SAMPLE_BIDS,
      }),
    };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const bids = rawBids
    .map(b => {
      const due_in_days = b.due_in_days !== undefined ? b.due_in_days
        : b.daysToClose !== undefined ? b.daysToClose
        : (() => {
            if (!b.close_date) return null;
            const close = new Date(b.close_date);
            return isNaN(close) ? null : Math.ceil((close - today) / 86400000);
          })();
      return {
        id: String(b.id || ''),
        solicitation_no: b.solicitation_no || '',
        title:     b.title    || '',
        bid_type:  b.bid_type || '',
        agency:    b.agency   || '',
        close_date: b.close_date || '',
        due_in_days, daysToClose: due_in_days,
        url:    b.url    || 'https://spo.az.gov',
        status: 'live',
      };
    })
    .filter(b => b.due_in_days !== null && b.due_in_days >= 0 && b.due_in_days <= 730)
    .sort((a, b) => (a.due_in_days ?? 9999) - (b.due_in_days ?? 9999));

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      source: 'arizona-procurement', state: 'AZ',
      scanMode: 'live', generatedAt: new Date().toISOString(),
      count: bids.length, bids,
    }),
  };
};
