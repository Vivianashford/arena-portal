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
