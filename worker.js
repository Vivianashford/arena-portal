/**
 * Arena Partners - Cloudflare Worker (R2 Storage + GHL Integration)
 * 
 * Handles secure file uploads from the client portal,
 * stores in R2 bucket, and updates GHL contacts.
 * 
 * Environment bindings required:
 *   - ARENA_BUCKET: R2 bucket binding
 *   - AUTH_TOKEN: shared secret for admin endpoints
 *   - GHL_TOKEN: GoHighLevel API token
 *   - GHL_LOCATION_ID: GHL location ID
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token',
  'Access-Control-Max-Age': '86400',
};

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const GHL_LOCATION_ID = 'LSvdgiiT7ManCRx9CCwE';
const JEAN_EMAIL = 'jhardy@trekonecapital.com';

// Custom field IDs
const CF_COMPANY_INFO_STATUS = '34Hw5yMzDL7XoXe4z2zK';

// Max file size: 50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Allowed file extensions
const ALLOWED_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt',
  'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'gif', 'zip',
  'rar', '7z', 'rtf', 'odt', 'ods'
];

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Route requests
      if (path === '/upload' && request.method === 'POST') {
        return await handleUpload(request, env);
      }
      if (path === '/submit' && request.method === 'POST') {
        return await handleSubmit(request, env);
      }
      if (path === '/clients' && request.method === 'GET') {
        return await handleListClients(request, env);
      }
      if (path.startsWith('/clients/') && request.method === 'GET') {
        return await handleListClientFiles(request, env, path);
      }
      if (path.startsWith('/files/') && request.method === 'GET') {
        return await handleDownloadFile(request, env, path);
      }

      // GHL API Proxy - passes requests through to GHL with stored token
      if (path.startsWith('/api/ghl/')) {
        return await handleGHLProxy(request, env, path);
      }

      // Apollo enrichment endpoint
      if (path === '/api/enrich' && request.method === 'POST') {
        return await handleEnrich(request, env);
      }

      // Health check
      if (path === '/health') {
        return jsonResponse({ status: 'ok', service: 'arena-api', timestamp: new Date().toISOString() });
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Internal server error', detail: err.message }, 500);
    }
  }
};

// ============================================================
// UPLOAD HANDLER
// ============================================================

async function handleUpload(request, env) {
  const formData = await request.formData();
  const company = sanitizePath(formData.get('company') || 'unknown');
  const category = sanitizePath(formData.get('category') || 'general');
  const contactId = formData.get('contactId') || '';

  const results = [];

  for (const [key, value] of formData.entries()) {
    if (key === 'company' || key === 'category' || key === 'contactId') continue;
    if (!(value instanceof File)) continue;

    const file = value;

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      results.push({
        name: file.name,
        error: 'File exceeds 50MB limit',
        status: 'rejected'
      });
      continue;
    }

    // Validate file extension
    const ext = file.name.split('.').pop().toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      results.push({
        name: file.name,
        error: 'File type not allowed',
        status: 'rejected'
      });
      continue;
    }

    // Build R2 key: {company}/{category}/{filename}
    const timestamp = Date.now();
    const safeName = sanitizeFilename(file.name);
    const r2Key = `${company}/${category}/${timestamp}-${safeName}`;

    // Store in R2
    const arrayBuffer = await file.arrayBuffer();
    await env.ARENA_BUCKET.put(r2Key, arrayBuffer, {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream',
      },
      customMetadata: {
        originalName: file.name,
        uploadedAt: new Date().toISOString(),
        contactId: contactId,
        category: category,
        company: company,
      }
    });

    results.push({
      name: file.name,
      key: r2Key,
      size: file.size,
      status: 'uploaded'
    });
  }

  return jsonResponse({
    success: true,
    uploaded: results.filter(r => r.status === 'uploaded').length,
    rejected: results.filter(r => r.status === 'rejected').length,
    files: results
  });
}

// ============================================================
// SUBMIT HANDLER (Final submission - updates GHL)
// ============================================================

async function handleSubmit(request, env) {
  const body = await request.json();
  const { contactId, company, name, email, categories } = body;

  if (!contactId || !company) {
    return jsonResponse({ error: 'contactId and company are required' }, 400);
  }

  const ghlToken = env.GHL_TOKEN;
  if (!ghlToken) {
    return jsonResponse({ error: 'GHL token not configured' }, 500);
  }

  // 1. Update GHL contact: Company Info Status = "Complete"
  const updateResult = await ghlRequest('PUT', `/contacts/${contactId}`, ghlToken, {
    customFields: [
      { id: CF_COMPANY_INFO_STATUS, field_value: 'Complete' }
    ],
    tags: await getUpdatedTags(contactId, ghlToken, ['company-info-submitted'])
  });

  // 2. Add note to contact with submission details
  const categoryList = (categories || []).map(c => `  - ${c.name}: ${c.fileCount} file(s)`).join('\n');
  const noteBody = `COMPANY INFO SUBMITTED\n` +
    `Company: ${company}\n` +
    `Contact: ${name} (${email})\n` +
    `Time: ${new Date().toISOString()}\n` +
    `\nDocuments uploaded:\n${categoryList}\n` +
    `\nFiles stored in R2: ${company}/`;

  await ghlRequest('POST', `/contacts/${contactId}/notes`, ghlToken, {
    body: noteBody
  });

  // 3. Notify Jean via email
  const notificationHtml = buildNotificationEmail(name, email, company, categories);
  
  // Get or create Jean's contact for notification
  const jeanContact = await ghlRequest('POST', '/contacts/upsert', ghlToken, {
    locationId: GHL_LOCATION_ID,
    firstName: 'Jean',
    lastName: 'Hardy',
    email: JEAN_EMAIL,
  });
  const jeanId = jeanContact?.contact?.id || '';

  if (jeanId) {
    await ghlRequest('POST', '/conversations/messages', ghlToken, {
      type: 'Email',
      contactId: jeanId,
      subject: `Company Info Received: ${company} (${name})`,
      html: notificationHtml,
      emailFrom: 'The Arena Partners <support@thearenapartners.com>'
    });
  }

  return jsonResponse({
    success: true,
    message: 'Submission complete. GHL updated, Jean notified.',
    contactId: contactId
  });
}

// ============================================================
// ADMIN: LIST ALL CLIENTS
// ============================================================

async function handleListClients(request, env) {
  if (!verifyAuth(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // List all objects with delimiter to get "folders"
  const listed = await env.ARENA_BUCKET.list({ delimiter: '/' });
  const clients = (listed.delimitedPrefixes || []).map(prefix => ({
    name: prefix.replace(/\/$/, ''),
    prefix: prefix
  }));

  return jsonResponse({ clients });
}

// ============================================================
// ADMIN: LIST FILES FOR A CLIENT
// ============================================================

async function handleListClientFiles(request, env, path) {
  if (!verifyAuth(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const company = decodeURIComponent(path.replace('/clients/', ''));
  const prefix = `${company}/`;
  
  const listed = await env.ARENA_BUCKET.list({ prefix });
  const files = (listed.objects || []).map(obj => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded,
    category: obj.key.split('/')[1] || 'unknown',
    filename: obj.key.split('/').pop(),
    metadata: obj.customMetadata || {}
  }));

  return jsonResponse({ company, files, count: files.length });
}

// ============================================================
// ADMIN: DOWNLOAD A FILE
// ============================================================

async function handleDownloadFile(request, env, path) {
  if (!verifyAuth(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const fileKey = decodeURIComponent(path.replace('/files/', ''));
  const object = await env.ARENA_BUCKET.get(fileKey);

  if (!object) {
    return jsonResponse({ error: 'File not found' }, 404);
  }

  const headers = new Headers(CORS_HEADERS);
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${object.customMetadata?.originalName || fileKey.split('/').pop()}"`);
  headers.set('Content-Length', object.size);

  return new Response(object.body, { headers });
}

// ============================================================
// GHL API PROXY
// ============================================================

async function handleGHLProxy(request, env, path) {
  const ghlToken = env.GHL_TOKEN;
  if (!ghlToken) {
    return jsonResponse({ error: 'GHL token not configured' }, 500);
  }

  const ghlPath = path.replace('/api/ghl', '');
  const url = `${GHL_API}${ghlPath}`;

  const headers = {
    'Authorization': `Bearer ${ghlToken}`,
    'Version': GHL_VERSION,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  const options = { method: request.method, headers };

  if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH' || request.method === 'DELETE') {
    try {
      const body = await request.text();
      if (body) options.body = body;
    } catch (e) {}
  }

  // Forward query string
  const incomingUrl = new URL(request.url);
  if (incomingUrl.search) {
    const targetUrl = new URL(url);
    targetUrl.search = incomingUrl.search;
    const resp = await fetch(targetUrl.toString(), options);
    const data = await resp.text();
    return new Response(data, {
      status: resp.status,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }

  const resp = await fetch(url, options);
  const data = await resp.text();
  return new Response(data, {
    status: resp.status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

// ============================================================
// PEOPLE DATA LABS ENRICHMENT (Free: 100 calls/month)
// Upgrade path: 100+ leads/month -> PDL paid plan
// ============================================================

const GENERIC_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'mail.com', 'protonmail.com',
  'comcast.net', 'att.net', 'verizon.net', 'cox.net',
  'sbcglobal.net', 'bellsouth.net', 'charter.net',
];

async function handleEnrich(request, env) {
  const pdlKey = env.PDL_API_KEY;
  if (!pdlKey) {
    return jsonResponse({ error: 'People Data Labs API key not configured. Add PDL_API_KEY as Worker secret.' }, 500);
  }

  const ghlToken = env.GHL_TOKEN;
  if (!ghlToken) {
    return jsonResponse({ error: 'GHL token not configured' }, 500);
  }

  const { contact_id, email, first_name, last_name, company_name } = await request.json();

  if (!contact_id) {
    return jsonResponse({ error: 'contact_id is required' }, 400);
  }

  console.log(`Enriching contact: ${contact_id} (${email})`);

  // 1. Person enrichment via PDL
  let person = null;
  if (email) {
    try {
      const params = new URLSearchParams({ email, pretty: 'false' });
      const personRes = await fetch(`https://api.peopledatalabs.com/v5/person/enrich?${params}`, {
        headers: { 'X-Api-Key': pdlKey },
      });
      if (personRes.ok) {
        const data = await personRes.json();
        if (data.status === 200) person = data;
      } else if (personRes.status === 404) {
        console.log('PDL: person not found by email');
      } else if (personRes.status === 429) {
        console.log('PDL: rate limited');
      }
    } catch (err) {
      console.log('PDL person.enrich failed:', err.message);
    }
  }

  // Fallback: search by name + company
  if (!person && first_name && last_name && company_name) {
    try {
      const params = new URLSearchParams({
        first_name, last_name, company: company_name, pretty: 'false'
      });
      const personRes = await fetch(`https://api.peopledatalabs.com/v5/person/enrich?${params}`, {
        headers: { 'X-Api-Key': pdlKey },
      });
      if (personRes.ok) {
        const data = await personRes.json();
        if (data.status === 200) person = data;
      }
    } catch (err) {
      console.log('PDL person search fallback failed:', err.message);
    }
  }

  // 2. Company enrichment via PDL
  let company = null;
  const domain = email ? email.split('@')[1]?.toLowerCase() : null;
  const enrichDomain = (domain && !GENERIC_DOMAINS.includes(domain)) ? domain : null;

  if (enrichDomain) {
    try {
      const params = new URLSearchParams({ website: enrichDomain, pretty: 'false' });
      const companyRes = await fetch(`https://api.peopledatalabs.com/v5/company/enrich?${params}`, {
        headers: { 'X-Api-Key': pdlKey },
      });
      if (companyRes.ok) {
        const data = await companyRes.json();
        if (data.status === 200) company = data;
      }
    } catch (err) {
      console.log('PDL company.enrich failed:', err.message);
    }
  }

  // Also try company from person data
  if (!company && person && person.job_company_website) {
    try {
      const params = new URLSearchParams({ website: person.job_company_website, pretty: 'false' });
      const companyRes = await fetch(`https://api.peopledatalabs.com/v5/company/enrich?${params}`, {
        headers: { 'X-Api-Key': pdlKey },
      });
      if (companyRes.ok) {
        const data = await companyRes.json();
        if (data.status === 200) company = data;
      }
    } catch (err) {}
  }

  // 3. Build custom fields (mapped from PDL response)
  const fields = {};

  if (person) {
    fields.enriched_title = person.job_title || '';
    fields.enriched_seniority = person.job_title_role || '';
    fields.enriched_linkedin = person.linkedin_url || '';
    fields.enriched_full_name = person.full_name || '';
    fields.enriched_city = person.location_locality || '';
    fields.enriched_state = person.location_region || '';

    // If we got company info from the person record
    if (!company) {
      if (person.job_company_name) fields.enriched_company_name = person.job_company_name;
      if (person.job_company_industry) fields.enriched_industry = person.job_company_industry;
      if (person.job_company_size) fields.enriched_employee_count = person.job_company_size;
      if (person.job_company_founded) {
        fields.enriched_founded_year = String(person.job_company_founded);
        fields.enriched_years_in_business = String(new Date().getFullYear() - person.job_company_founded);
      }
      if (person.job_company_location_locality) fields.enriched_company_city = person.job_company_location_locality;
      if (person.job_company_location_region) fields.enriched_company_state = person.job_company_location_region;
      if (person.job_company_website) fields.enriched_website = person.job_company_website;
    }
  }

  if (company) {
    fields.enriched_company_name = company.name || '';
    fields.enriched_industry = company.industry || '';
    fields.enriched_sub_industry = company.sub_industry || '';
    fields.enriched_website = company.website || enrichDomain || '';
    fields.enriched_description = company.summary || '';
    fields.enriched_logo_url = company.profile_pic_url || '';
    fields.enriched_company_city = '';
    fields.enriched_company_state = '';

    if (company.location) {
      fields.enriched_company_city = company.location.locality || '';
      fields.enriched_company_state = company.location.region || '';
    }

    if (company.employee_count) {
      fields.enriched_employee_count = String(company.employee_count);
    } else if (company.size) {
      fields.enriched_employee_count = company.size;
    }

    if (company.founded) {
      fields.enriched_founded_year = String(company.founded);
      fields.enriched_years_in_business = String(new Date().getFullYear() - company.founded);
    }

    if (company.estimated_annual_revenue) {
      fields.enriched_annual_revenue = company.estimated_annual_revenue;
    }

    if (company.tags && company.tags.length > 0) {
      fields.enriched_keywords = company.tags.slice(0, 10).join(', ');
    }

    // Company size label
    const empCount = parseInt(fields.enriched_employee_count) || 0;
    if (empCount > 0) {
      if (empCount <= 10) fields.enriched_company_size_label = 'small team';
      else if (empCount <= 50) fields.enriched_company_size_label = 'growing team';
      else if (empCount <= 200) fields.enriched_company_size_label = 'established operation';
      else fields.enriched_company_size_label = 'major operation';
    }
  }

  fields.enriched_at = new Date().toISOString();
  fields.enrichment_source = 'peopledatalabs';
  fields.enrichment_status = (person || company) ? 'enriched' : 'not_found';

  // 4. Write to GHL
  const customFieldsPayload = Object.entries(fields)
    .filter(([k, v]) => v)
    .map(([key, value]) => ({ key, value }));

  await ghlRequest('PUT', `/contacts/${contact_id}`, ghlToken, { customFields: customFieldsPayload });

  // 5. Tag as enriched
  const tag = fields.enrichment_status === 'enriched' ? 'enriched' : 'enrichment_failed';
  await ghlRequest('POST', `/contacts/${contact_id}/tags`, ghlToken, { tags: [tag] });

  console.log(`Enrichment complete for ${contact_id}: ${fields.enrichment_status} (via PDL)`);

  return jsonResponse({
    success: true,
    contact_id,
    enrichment_status: fields.enrichment_status,
    enrichment_source: 'peopledatalabs',
    fields_written: customFieldsPayload.length,
    company_found: company ? company.name : (person ? person.job_company_name : null),
    person_found: person ? person.full_name : null,
  });
}

// ============================================================
// HELPERS
// ============================================================

function verifyAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || request.headers.get('X-Auth-Token') || '';
  const token = authHeader.replace('Bearer ', '');
  return token && token === env.AUTH_TOKEN;
}

async function ghlRequest(method, path, token, data) {
  const url = `${GHL_API}${path}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Version': GHL_VERSION,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }
  };
  if (data && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(data);
  }
  try {
    const resp = await fetch(url, options);
    return await resp.json();
  } catch (err) {
    console.error(`GHL ${method} ${path} error:`, err);
    return {};
  }
}

async function getUpdatedTags(contactId, ghlToken, newTags) {
  const contact = await ghlRequest('GET', `/contacts/${contactId}`, ghlToken);
  const existing = contact?.contact?.tags || [];
  const combined = [...new Set([...existing, ...newTags])];
  return combined;
}

function sanitizePath(str) {
  return str.replace(/[^a-zA-Z0-9\s\-_]/g, '').replace(/\s+/g, '-').toLowerCase().substring(0, 100);
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_').substring(0, 200);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS
    }
  });
}

function buildNotificationEmail(name, email, company, categories) {
  const catRows = (categories || []).map(c => 
    `<tr><td style="padding:8px 0;color:#9a9590;font-size:14px;">${c.name}</td><td style="padding:8px 0;color:#f5f0e8;font-size:14px;font-weight:bold;">${c.fileCount} file(s)</td></tr>`
  ).join('');

  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#f5f0e8;padding:0;">
<div style="padding:40px 40px 30px;border-bottom:1px solid #1a1a1a;">
<p style="font-size:13px;color:#c9a84c;letter-spacing:2px;margin:0 0 12px;text-transform:uppercase;">The Arena Partners - Portal Alert</p>
<h1 style="font-family:Georgia,serif;color:#f5f0e8;font-size:24px;margin:0;">Company Info Received</h1>
</div>
<div style="padding:30px 40px;">
<div style="background:#111;border-radius:8px;padding:24px;margin:0 0 20px;border-left:3px solid #c9a84c;">
<table cellpadding="0" cellspacing="0" border="0" style="width:100%;">
<tr><td style="padding:8px 0;color:#9a9590;font-size:14px;width:100px;">Contact</td><td style="padding:8px 0;color:#f5f0e8;font-size:14px;font-weight:bold;">${name}</td></tr>
<tr><td style="padding:8px 0;color:#9a9590;font-size:14px;">Email</td><td style="padding:8px 0;color:#d4cfc7;font-size:14px;">${email}</td></tr>
<tr><td style="padding:8px 0;color:#9a9590;font-size:14px;">Company</td><td style="padding:8px 0;color:#d4cfc7;font-size:14px;">${company}</td></tr>
</table>
</div>
<p style="font-family:Georgia,serif;font-size:16px;color:#c9a84c;margin:0 0 12px;">Documents Uploaded:</p>
<div style="background:#111;border-radius:8px;padding:20px;margin:0 0 20px;">
<table cellpadding="0" cellspacing="0" border="0" style="width:100%;">
${catRows}
</table>
</div>
<p style="font-size:14px;color:#9a9590;margin:0;">Contact is now marked as "Company Info Complete" in GHL. Ready for proposal preparation.</p>
</div>
</div>`;
}
