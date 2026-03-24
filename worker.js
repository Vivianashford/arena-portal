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

      // Direct mail - PostGrid (postcards + letters)
      if (path === '/api/mail/postcard' && request.method === 'POST') {
        return await handlePostGridPostcard(request, env);
      }
      if (path === '/api/mail/letter' && request.method === 'POST') {
        return await handlePostGridLetter(request, env);
      }

      // Direct mail - Handwrytten (handwritten cards)
      if (path === '/api/mail/handwritten' && request.method === 'POST') {
        return await handleHandwrytten(request, env);
      }

      // LinkedIn OAuth - authorization redirect
      if (path === '/api/linkedin/auth' && request.method === 'GET') {
        const clientId = env.LINKEDIN_CLIENT_ID;
        const redirectUri = encodeURIComponent('https://arena-api.jean-475.workers.dev/callback');
        const scope = encodeURIComponent('openid profile email w_member_social r_member_social');
        const state = crypto.randomUUID();
        const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}&state=${state}`;
        return Response.redirect(authUrl, 302);
      }

      // LinkedIn OAuth - callback (exchange code for token)
      if ((path === '/api/linkedin/callback' || path === '/callback') && request.method === 'GET') {
        return await handleLinkedInCallback(url, env);
      }

      // LinkedIn API - post comment
      if (path === '/api/linkedin/comment' && request.method === 'POST') {
        return await handleLinkedInComment(request, env);
      }

      // LinkedIn API - create article/newsletter
      if (path === '/api/linkedin/article' && request.method === 'POST') {
        return await handleLinkedInArticle(request, env);
      }

      // LinkedIn API - get profile
      if (path === '/api/linkedin/profile' && request.method === 'GET') {
        return await handleLinkedInProfile(env);
      }

      // LinkedIn API - get recent posts
      if (path === '/api/linkedin/posts' && request.method === 'GET') {
        return await handleLinkedInGetPosts(env);
      }

      // LinkedIn API - list comments on a post
      if (path === '/api/linkedin/comments' && request.method === 'POST') {
        return await handleLinkedInListComments(request, env);
      }

      // LinkedIn API - reply to a specific comment
      if (path === '/api/linkedin/comment/reply' && request.method === 'POST') {
        return await handleLinkedInReplyComment(request, env);
      }

      // LinkedIn API - create post with optional image
      if (path === '/api/linkedin/post' && request.method === 'POST') {
        return await handleLinkedInCreatePost(request, env);
      }

      // LinkedIn delete post
      if (path.startsWith('/api/linkedin/post/') && request.method === 'DELETE') {
        const token = await getLinkedInToken(env);
        if (!token) return jsonResponse({ error: 'No token' }, 401);
        const postUrn = decodeURIComponent(path.replace('/api/linkedin/post/', ''));
        const ugcUrn = postUrn.replace('urn:li:share:', 'urn:li:ugcPost:');
        const res = await fetch(`https://api.linkedin.com/v2/ugcPosts/${encodeURIComponent(ugcUrn)}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Restli-Protocol-Version': '2.0.0',
          },
        });
        let body;
        try { body = await res.json(); } catch(e) { body = null; }
        return jsonResponse({ success: res.ok || res.status === 204, status: res.status, urn: ugcUrn, body }, res.ok || res.status === 204 ? 200 : res.status);
      }

      // LinkedIn API - delete a comment
      if (path === '/api/linkedin/comment/delete' && request.method === 'POST') {
        const token = await getLinkedInToken(env);
        if (!token) return jsonResponse({ error: 'No token' }, 401);
        const { activityUrn, commentId } = await request.json();
        if (!activityUrn || !commentId) return jsonResponse({ error: 'activityUrn and commentId required' }, 400);
        // Get actor URN
        const profileObj = await env.ARENA_FILES.get('config/linkedin-profile.json');
        let actor = '';
        if (profileObj) {
          const profile = JSON.parse(await profileObj.text());
          actor = `urn:li:person:${profile.sub}`;
        }
        const res = await fetch(
          `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(activityUrn)}/comments/${commentId}?actor=${encodeURIComponent(actor)}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Restli-Protocol-Version': '2.0.0',
          },
        });
        let body;
        try { body = await res.json(); } catch(e) { body = null; }
        return jsonResponse({ success: res.ok || res.status === 204, status: res.status, body }, res.ok || res.status === 204 ? 200 : res.status);
      }

      // LinkedIn version probe - find working API version
      if (path === '/api/linkedin/probe' && request.method === 'GET') {
        const token = await getLinkedInToken(env);
        if (!token) return jsonResponse({ error: 'No token' }, 401);
        
        const profileObj = await env.ARENA_FILES.get('config/linkedin-profile.json');
        const profile = JSON.parse(await profileObj.text());
        const authorUrn = `urn:li:person:${profile.sub}`;
        
        const versions = ['202501','202412','202411','202410','202409','202408','202407','202406','202405','202404','202403','202402','202401','202312','202311','202310','202309','202306'];
        const results = [];
        
        for (const v of versions) {
          try {
            const res = await fetch('https://api.linkedin.com/rest/posts', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'LinkedIn-Version': v,
                'X-Restli-Protocol-Version': '2.0.0',
              },
              body: JSON.stringify({
                author: authorUrn,
                commentary: 'version_probe_test',
                visibility: 'PUBLIC',
                distribution: { feedDistribution: 'NONE' },
                lifecycleState: 'DRAFT',
              }),
            });
            const data = await res.json();
            results.push({ version: v, status: res.status, code: data.code || 'OK', message: (data.message || '').substring(0, 80) });
            if (res.ok || res.status === 422 || res.status === 400) {
              // Found a working version (400/422 means version is valid, just bad request data)
              results[results.length - 1].viable = true;
            }
          } catch (e) {
            results.push({ version: v, error: e.message });
          }
        }
        
        return jsonResponse({ results, viable: results.filter(r => r.viable) });
      }

      // Facebook - post to page
      if (path === '/api/facebook/post' && request.method === 'POST') {
        return await handleFacebookPost(request, env);
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

// ============================================================
// POSTGRID - POSTCARDS & LETTERS
// ============================================================

const POSTGRID_BASE = 'https://api.postgrid.com/print-mail/v1';
const ARENA_RETURN_CONTACT = 'contact_u383WyVFKtgrcESeGAeLLt';

async function handlePostGridPostcard(request, env) {
  const pgKey = env.POSTGRID_API_KEY;
  if (!pgKey) return jsonResponse({ error: 'PostGrid API key not configured' }, 500);

  const { to_name, to_company, to_address, to_city, to_state, to_zip, front_html, back_html, size } = await request.json();

  if (!to_name || !to_address || !to_city || !to_state || !to_zip) {
    return jsonResponse({ error: 'Missing required address fields' }, 400);
  }

  // Create recipient contact
  const contactRes = await fetch(`${POSTGRID_BASE}/contacts`, {
    method: 'POST',
    headers: { 'x-api-key': pgKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstName: to_name.split(' ')[0],
      lastName: to_name.split(' ').slice(1).join(' ') || '',
      companyName: to_company || '',
      addressLine1: to_address,
      city: to_city,
      provinceOrState: to_state,
      postalOrZip: to_zip,
      countryCode: 'US',
    }),
  });
  const contact = await contactRes.json();

  if (!contact.id) {
    return jsonResponse({ error: 'Failed to create recipient contact', details: contact }, 400);
  }

  // Send postcard
  const postcardRes = await fetch(`${POSTGRID_BASE}/postcards`, {
    method: 'POST',
    headers: { 'x-api-key': pgKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: contact.id,
      from: ARENA_RETURN_CONTACT,
      frontHTML: front_html || '<div style="padding:40px;font-family:Georgia,serif;"><h1 style="color:#c9a84c;">The Arena Partners</h1><p>Your business. Your legacy. Your terms.</p></div>',
      backHTML: back_html || '<div style="padding:40px;font-family:Georgia,serif;"><p>Ready to talk about your exit strategy?</p><p><strong>713-344-7420</strong></p><p>thearenapartners.com</p></div>',
      size: size || '6x9',
    }),
  });
  const postcard = await postcardRes.json();

  return jsonResponse({
    success: true,
    type: 'postcard',
    id: postcard.id,
    status: postcard.status,
    to: to_name,
    expectedDelivery: postcard.expectedDeliveryDate,
  });
}

async function handlePostGridLetter(request, env) {
  const pgKey = env.POSTGRID_API_KEY;
  if (!pgKey) return jsonResponse({ error: 'PostGrid API key not configured' }, 500);

  const { to_name, to_company, to_address, to_city, to_state, to_zip, letter_html } = await request.json();

  if (!to_name || !to_address || !to_city || !to_state || !to_zip) {
    return jsonResponse({ error: 'Missing required address fields' }, 400);
  }

  // Create recipient
  const contactRes = await fetch(`${POSTGRID_BASE}/contacts`, {
    method: 'POST',
    headers: { 'x-api-key': pgKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstName: to_name.split(' ')[0],
      lastName: to_name.split(' ').slice(1).join(' ') || '',
      companyName: to_company || '',
      addressLine1: to_address,
      city: to_city,
      provinceOrState: to_state,
      postalOrZip: to_zip,
      countryCode: 'US',
    }),
  });
  const contact = await contactRes.json();

  if (!contact.id) {
    return jsonResponse({ error: 'Failed to create recipient', details: contact }, 400);
  }

  // Send letter
  const letterRes = await fetch(`${POSTGRID_BASE}/letters`, {
    method: 'POST',
    headers: { 'x-api-key': pgKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: contact.id,
      from: ARENA_RETURN_CONTACT,
      html: letter_html,
    }),
  });
  const letter = await letterRes.json();

  return jsonResponse({
    success: true,
    type: 'letter',
    id: letter.id,
    status: letter.status,
    to: to_name,
    expectedDelivery: letter.expectedDeliveryDate,
  });
}

// ============================================================
// HANDWRYTTEN - HANDWRITTEN CARDS
// ============================================================

async function handleHandwrytten(request, env) {
  const appKey = env.HANDWRYTTEN_APP_KEY;
  if (!appKey) return jsonResponse({ error: 'Handwrytten app key not configured' }, 500);

  const { to_name, to_company, to_address, to_city, to_state, to_zip, message, card_id } = await request.json();

  if (!to_name || !to_address || !message) {
    return jsonResponse({ error: 'Missing required fields (to_name, to_address, message)' }, 400);
  }

  // Handwrytten singleStepOrder - send card in one API call
  const orderRes = await fetch('https://api.handwrytten.com/v1/orders/singleStepOrder', {
    method: 'POST',
    headers: {
      'app_key': appKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      card_id: card_id || 25, // Classic Script (default)
      message: message,
      sender_first_name: 'Jean',
      sender_last_name: 'Hardy',
      sender_company: 'The Arena Partners',
      sender_address1: '3555 Timmons Ln',
      sender_address2: 'Ste 1140',
      sender_city: 'Houston',
      sender_state: 'TX',
      sender_zip: '77027',
      recipient_first_name: to_name.split(' ')[0],
      recipient_last_name: to_name.split(' ').slice(1).join(' ') || '',
      recipient_company: to_company || '',
      recipient_address1: to_address,
      recipient_city: to_city,
      recipient_state: to_state,
      recipient_zip: to_zip,
      recipient_country: 'US',
    }),
  });

  let order;
  try {
    order = await orderRes.json();
  } catch (e) {
    return jsonResponse({ error: 'Handwrytten API error', details: await orderRes.text() }, 500);
  }

  // If session expired, return helpful error
  if (order.httpCode === 440 || order.httpCode === 401) {
    return jsonResponse({
      error: 'Handwrytten session expired - needs re-authentication',
      details: order.message,
      action: 'Login at app.handwrytten.com and refresh session',
    }, 401);
  }

  return jsonResponse({
    success: !order.status || order.status !== 'error',
    type: 'handwritten_card',
    order: order,
    to: to_name,
    card_id: card_id || 25,
  });
}


// ==================== LinkedIn OAuth & API ====================

async function handleLinkedInCallback(url, env) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  
  if (error) {
    return new Response(`<h1>LinkedIn Auth Failed</h1><p>${error}: ${url.searchParams.get('error_description')}</p>`, {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  if (!code) {
    return jsonResponse({ error: 'No authorization code received' }, 400);
  }

  // Exchange code for access token
  const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: 'https://arena-api.jean-475.workers.dev/callback',
      client_id: env.LINKEDIN_CLIENT_ID,
      client_secret: env.LINKEDIN_CLIENT_SECRET,
    }),
  });

  const tokenData = await tokenRes.json();
  
  if (tokenData.error) {
    return new Response(`<h1>Token Exchange Failed</h1><pre>${JSON.stringify(tokenData, null, 2)}</pre>`, {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // Store token in KV or R2
  const tokenObj = {
    access_token: tokenData.access_token,
    expires_in: tokenData.expires_in,
    refresh_token: tokenData.refresh_token,
    refresh_token_expires_in: tokenData.refresh_token_expires_in,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString(),
  };

  // Store in R2 for persistence
  await env.ARENA_FILES.put('config/linkedin-token.json', JSON.stringify(tokenObj, null, 2));

  // Get profile to confirm
  const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
  });
  const profile = await profileRes.json();

  // Store profile info
  await env.ARENA_FILES.put('config/linkedin-profile.json', JSON.stringify(profile, null, 2));

  return new Response(`
    <html><body style="font-family:sans-serif;background:#0a0a0a;color:#e8e4df;padding:40px;text-align:center;">
    <h1 style="color:#C9A84C;">LinkedIn Connected!</h1>
    <p>Authorized as: <strong>${profile.name || profile.given_name + ' ' + profile.family_name}</strong></p>
    <p>Sub: ${profile.sub}</p>
    <p>Token expires: ${tokenObj.expires_at}</p>
    <p style="color:#888;">You can close this window. Vivian now has LinkedIn API access.</p>
    </body></html>
  `, { headers: { 'Content-Type': 'text/html' } });
}

async function getLinkedInToken(env) {
  const tokenObj = await env.ARENA_FILES.get('config/linkedin-token.json');
  if (!tokenObj) return null;
  const token = JSON.parse(await tokenObj.text());
  
  // Check if expired
  if (new Date(token.expires_at) < new Date()) {
    // Try refresh
    if (token.refresh_token) {
      const refreshRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token.refresh_token,
          client_id: env.LINKEDIN_CLIENT_ID,
          client_secret: env.LINKEDIN_CLIENT_SECRET,
        }),
      });
      const refreshData = await refreshRes.json();
      if (refreshData.access_token) {
        const newToken = {
          ...token,
          access_token: refreshData.access_token,
          expires_in: refreshData.expires_in,
          refresh_token: refreshData.refresh_token || token.refresh_token,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + (refreshData.expires_in * 1000)).toISOString(),
        };
        await env.ARENA_FILES.put('config/linkedin-token.json', JSON.stringify(newToken, null, 2));
        return newToken.access_token;
      }
    }
    return null; // Token expired, no refresh available
  }
  
  return token.access_token;
}

async function handleLinkedInProfile(env) {
  const token = await getLinkedInToken(env);
  if (!token) return jsonResponse({ error: 'No LinkedIn token. Authorize at /api/linkedin/auth' }, 401);

  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const profile = await res.json();
  return jsonResponse(profile);
}

async function handleLinkedInListComments(request, env) {
  const token = await getLinkedInToken(env);
  if (!token) return jsonResponse({ error: 'No LinkedIn token. Authorize at /api/linkedin/auth' }, 401);

  const { postUrn, count } = await request.json();
  if (!postUrn) return jsonResponse({ error: 'postUrn required' }, 400);

  // Convert share URN to activity URN for the socialActions API
  const activityUrn = postUrn.replace('urn:li:share:', 'urn:li:activity:');
  const limit = count || 20;

  // Try both URN formats
  const urns = [activityUrn, postUrn];
  let lastData = {};
  let lastOk = false;

  for (const urn of urns) {
    const res = await fetch(
      `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(urn)}/comments?count=${limit}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Restli-Protocol-Version': '2.0.0',
      },
    });

    const data = await res.json();
    if (res.ok && data.elements && data.elements.length > 0) {
      const comments = data.elements.map(c => ({
        id: c.id || c['$URN'],
        urn: c['$URN'],
        text: c.message ? c.message.text : '',
        actor: c.actor,
        created: c.created ? c.created.time : null,
        likes: c.likesSummary ? c.likesSummary.totalLikes : 0,
      }));
      return jsonResponse({ success: true, total: data.paging ? data.paging.total : comments.length, comments, urnUsed: urn }, 200);
    }
    lastData = data;
    lastOk = res.ok;
  }

  return jsonResponse({ success: lastOk, total: 0, comments: [], raw: lastData }, lastOk ? 200 : 400);
}

async function handleLinkedInReplyComment(request, env) {
  const token = await getLinkedInToken(env);
  if (!token) return jsonResponse({ error: 'No LinkedIn token. Authorize at /api/linkedin/auth' }, 401);

  const { postUrn, parentCommentUrn, comment } = await request.json();
  if (!postUrn || !parentCommentUrn || !comment) {
    return jsonResponse({ error: 'postUrn, parentCommentUrn, and comment required' }, 400);
  }

  // Get actor
  const profileObj = await env.ARENA_FILES.get('config/linkedin-profile.json');
  let actor = '';
  if (profileObj) {
    const profile = JSON.parse(await profileObj.text());
    actor = `urn:li:person:${profile.sub}`;
  }

  // Convert share URN to activity URN
  const activityUrn = postUrn.replace('urn:li:share:', 'urn:li:activity:');

  const res = await fetch(
    `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(activityUrn)}/comments`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      actor: actor,
      message: { text: comment },
      parentComment: parentCommentUrn,
    }),
  });

  const data = await res.json();
  return jsonResponse({ success: res.ok, status: res.status, data }, res.ok ? 200 : res.status);
}

async function handleLinkedInComment(request, env) {
  const token = await getLinkedInToken(env);
  if (!token) return jsonResponse({ error: 'No LinkedIn token. Authorize at /api/linkedin/auth' }, 401);

  const { postUrn, comment, authorUrn } = await request.json();
  
  if (!postUrn || !comment) {
    return jsonResponse({ error: 'postUrn and comment required' }, 400);
  }

  // Get author URN from stored profile if not provided
  let actor = authorUrn;
  if (!actor) {
    const profileObj = await env.ARENA_FILES.get('config/linkedin-profile.json');
    if (profileObj) {
      const profile = JSON.parse(await profileObj.text());
      actor = `urn:li:person:${profile.sub}`;
    }
  }

  // Convert share URN to activity URN for socialActions API
  const activityUrn = postUrn.replace('urn:li:share:', 'urn:li:activity:');

  const res = await fetch(`https://api.linkedin.com/v2/socialActions/${encodeURIComponent(activityUrn)}/comments`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      actor: actor,
      message: { text: comment },
    }),
  });

  const data = await res.json();
  return jsonResponse({ success: res.ok, status: res.status, data }, res.ok ? 200 : res.status);
}

async function handleLinkedInArticle(request, env) {
  const token = await getLinkedInToken(env);
  if (!token) return jsonResponse({ error: 'No LinkedIn token. Authorize at /api/linkedin/auth' }, 401);

  const { title, description, url, commentary, imageUrn } = await request.json();
  
  if (!title || !url) {
    return jsonResponse({ error: 'title and url required' }, 400);
  }

  const profileObj = await env.ARENA_FILES.get('config/linkedin-profile.json');
  let authorUrn = '';
  if (profileObj) {
    const profile = JSON.parse(await profileObj.text());
    authorUrn = `urn:li:person:${profile.sub}`;
  }

  const articleContent = {
    source: url,
    title: title,
  };
  if (description) articleContent.description = description;
  if (imageUrn) articleContent.thumbnail = imageUrn;

  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': '202503',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      author: authorUrn,
      commentary: commentary || title,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: { article: articleContent },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });

  const postId = res.headers.get('x-restli-id');
  const data = res.ok ? { id: postId } : await res.json();
  return jsonResponse({ success: res.ok, status: res.status, data }, res.ok ? 201 : res.status);
}

async function handleLinkedInGetPosts(env) {
  const token = await getLinkedInToken(env);
  if (!token) return jsonResponse({ error: 'No LinkedIn token' }, 401);

  const profileObj = await env.ARENA_FILES.get('config/linkedin-profile.json');
  const profile = JSON.parse(await profileObj.text());
  const authorUrn = `urn:li:person:${profile.sub}`;

  // Try v2 UGC posts API (no version header needed)
  const res = await fetch(`https://api.linkedin.com/v2/ugcPosts?q=authors&authors=List(${encodeURIComponent(authorUrn)})&count=10`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Restli-Protocol-Version': '2.0.0',
    },
  });

  const data = await res.json();
  return jsonResponse({ success: res.ok, status: res.status, authorUrn, raw: data, posts: data.elements || [], total: data.paging?.total }, res.ok ? 200 : res.status);
}

async function handleLinkedInCreatePost(request, env) {
  const token = await getLinkedInToken(env);
  if (!token) return jsonResponse({ error: 'No LinkedIn token' }, 401);

  const profileObj = await env.ARENA_FILES.get('config/linkedin-profile.json');
  const profile = JSON.parse(await profileObj.text());
  const authorUrn = `urn:li:person:${profile.sub}`;

  const { text, imageUrl, imageData } = await request.json();
  if (!text) return jsonResponse({ error: 'text required' }, 400);

  let mediaAsset = null;

  // If image provided, register upload via v2 API
  if (imageData || imageUrl) {
    // Step 1: Register image upload
    const regRes = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
          owner: authorUrn,
          serviceRelationships: [{
            relationshipType: 'OWNER',
            identifier: 'urn:li:userGeneratedContent',
          }],
        },
      }),
    });

    const regData = await regRes.json();
    if (!regRes.ok) {
      return jsonResponse({ error: 'Image upload registration failed', details: regData }, regRes.status);
    }

    const uploadUrl = regData.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
    mediaAsset = regData.value.asset;

    // Step 2: Upload the image binary
    let imageBytes;
    if (imageData) {
      imageBytes = Uint8Array.from(atob(imageData), c => c.charCodeAt(0));
    } else if (imageUrl) {
      const imgRes = await fetch(imageUrl);
      imageBytes = new Uint8Array(await imgRes.arrayBuffer());
    }

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: imageBytes,
    });

    if (!uploadRes.ok) {
      return jsonResponse({ error: 'Image upload failed', status: uploadRes.status, details: await uploadRes.text() }, 400);
    }
  }

  // Build UGC post body
  const shareContent = {
    shareCommentary: { text: text },
    shareMediaCategory: mediaAsset ? 'IMAGE' : 'NONE',
  };

  if (mediaAsset) {
    shareContent.media = [{
      status: 'READY',
      media: mediaAsset,
    }];
  }

  const ugcBody = {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': shareContent,
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  };

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(ugcBody),
  });

  const postId = res.headers.get('x-linkedin-id') || res.headers.get('x-restli-id');
  let resBody;
  try {
    resBody = await res.json();
  } catch(e) {
    resBody = { postId };
  }
  
  return jsonResponse({ 
    success: res.ok, 
    status: res.status, 
    postId: postId || resBody.id,
    postUrn: postId || resBody.id,
    data: resBody 
  }, res.ok ? 201 : res.status);
}


async function handleFacebookPost(request, env) {
  const pageToken = env.FB_PAGE_TOKEN;
  const pageId = env.FB_PAGE_ID || '103908865130039';
  
  if (!pageToken) return jsonResponse({ error: 'No Facebook page token configured' }, 401);

  const { text, imageData, imageUrl, link } = await request.json();
  if (!text) return jsonResponse({ error: 'text required' }, 400);

  let endpoint = `https://graph.facebook.com/v19.0/${pageId}/feed`;
  let body = new URLSearchParams();
  body.append('message', text);
  body.append('access_token', pageToken);
  if (link) body.append('link', link);

  // If image, use /photos endpoint instead
  if (imageData || imageUrl) {
    endpoint = `https://graph.facebook.com/v19.0/${pageId}/photos`;
    body = new FormData();
    body.append('message', text);
    body.append('access_token', pageToken);
    
    if (imageData) {
      const bytes = Uint8Array.from(atob(imageData), c => c.charCodeAt(0));
      body.append('source', new Blob([bytes], { type: 'image/png' }), 'graphic.png');
    } else if (imageUrl) {
      body.append('url', imageUrl);
    }
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    body: body,
  });

  const data = await res.json();
  return jsonResponse({
    success: res.ok,
    status: res.status,
    postId: data.id || data.post_id,
    data,
  }, res.ok ? 201 : res.status);
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
