# Arena Portal - Setup Guide

## Overview

This repo contains three components:

1. **index.html** - Admin dashboard (Jean's command center) - pulls live data from GHL
2. **upload.html** - Secure client upload portal - multi-step wizard for document collection
3. **worker.js** - Cloudflare Worker for R2 file storage backend

## Quick Start (GitHub Pages)

The dashboard and upload portal work immediately via GitHub Pages:

```
https://vivianashford.github.io/arena-portal/          -> Dashboard
https://vivianashford.github.io/arena-portal/upload.html -> Upload Portal
```

Or via custom domain:
```
https://thearenapartners.com/arena-portal/
https://thearenapartners.com/arena-portal/upload.html
```

### Dashboard Access
- Default password: `arena2026`
- Change it in index.html at the top: `const DASH_PASSWORD = 'arena2026';`

### Upload Portal URL Parameters
Pre-fill client info via URL params:
```
upload.html?name=John%20Smith&company=Acme%20HVAC&email=john@acme.com&cid=GHL_CONTACT_ID
```

## Cloudflare Worker Deployment (Optional)

The worker handles file storage in R2. Without it, the upload portal still works (updates GHL contacts, sends notifications) but files are not stored server-side.

### Prerequisites
- Cloudflare account with Workers and R2 enabled
- Wrangler CLI: `npm install -g wrangler`

### Steps

1. **Login to Cloudflare:**
```bash
wrangler login
```

2. **Create the R2 bucket:**
```bash
wrangler r2 bucket create arena-docs
```

3. **Create wrangler.toml** in this directory:
```toml
name = "arena-portal"
main = "worker.js"
compatibility_date = "2024-01-01"

[[r2_buckets]]
binding = "ARENA_BUCKET"
bucket_name = "arena-docs"

[vars]
AUTH_TOKEN = "your-secret-admin-token"
GHL_TOKEN = "pit-8db4722a-0d8f-41c0-8cc0-1d17de5bff3d"
GHL_LOCATION_ID = "LSvdgiiT7ManCRx9CCwE"
```

4. **Deploy:**
```bash
wrangler deploy
```

5. **Update WORKER_URL** in upload.html:
```javascript
const WORKER_URL = 'https://arena-portal.your-subdomain.workers.dev';
```

### Worker Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /upload | No | Upload files (multipart form) |
| POST | /submit | No | Final submission (updates GHL) |
| GET | /clients | Yes | List all client folders |
| GET | /clients/{company} | Yes | List files for a company |
| GET | /files/{path} | Yes | Download a specific file |

Auth = `Authorization: Bearer YOUR_AUTH_TOKEN` header.

### Testing the Worker

```bash
# Upload a test file
curl -X POST https://arena-portal.workers.dev/upload \
  -F "company=test-company" \
  -F "category=financial-pnl" \
  -F "contactId=abc123" \
  -F "file=@test.pdf"

# List clients (requires auth)
curl https://arena-portal.workers.dev/clients \
  -H "Authorization: Bearer your-secret-admin-token"
```

## GHL Configuration

### Required Custom Fields (already created)
- NDA Status: `ftQiQO9v7xWoRf7SE6ix`
- Company Info Status: `34Hw5yMzDL7XoXe4z2zK`
- Max Video Watch %: `WTte3IGpNaX0cxVxzAqB`
- VSL Lead Score: `eCWYLWe2vmd6t7J7fM15`
- Video Watch Segment: `IAsnpV5GUycawVqAPCnI`

### Required Tags
- `vsl-lead`, `vsl-watched-25/50/75/100`, `vsl-booked`
- `company-info-submitted`, `nda-signed`, `assessment-complete`, `noshow`

### Pipeline: Arena Lead Pipe
- Pipeline ID: `PdlZRdFi8hty46vcVyx8`
- Stages: New Lead, Contacted, No Show, Proposal Sent, Closed

## Security Notes

- GHL token is embedded client-side (same pattern as other Arena pages)
- Dashboard has password gate (stored in localStorage)
- Worker admin endpoints require auth header
- R2 files are not publicly accessible - only via authenticated worker endpoints
- Upload portal uses HTTPS and all data is encrypted in transit

## Architecture

```
Client Browser                    Cloudflare
     |                                |
     |--- upload.html --------------->|
     |    (file uploads via           |--- Worker.js
     |     multipart POST)            |    |
     |                                |    |--- R2 Bucket
     |--- index.html                  |    |    (file storage)
     |    (dashboard,                 |    |
     |     GHL API calls)             |    |--- GHL API
     |                                |         (contact updates)
     |--- GHL API <-------------------|
          (direct from browser)
```

## File Structure

```
arena-portal/
  index.html      - Admin dashboard
  upload.html     - Client upload portal  
  worker.js       - Cloudflare Worker
  SETUP.md        - This file
```
