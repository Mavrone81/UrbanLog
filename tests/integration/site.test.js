// Integration tests: serve the real static files over HTTP (the way nginx does) and
// verify the "connections" this site actually has — asset serving + outbound links.
// No backend/DB exists, so the integration surface is: the HTTP server, local assets,
// and the external link contracts (WhatsApp deep links, CDN resources).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

let server;
let base;

function startStaticServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

beforeAll(async () => {
  server = await startStaticServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server && server.close());

describe('static file serving (HTTP layer)', () => {
  it('serves index.html at / with 200 and text/html', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<title>Urban Werkz Delivery');
  });

  it('serves the stylesheet with 200 and a css content-type', async () => {
    const res = await fetch(`${base}/css/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('css');
  });

  it('serves the script with 200', async () => {
    const res = await fetch(`${base}/js/main.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('initScrollReveal');
  });

  it('returns 404 for a missing path', async () => {
    const res = await fetch(`${base}/does-not-exist.html`);
    expect(res.status).toBe(404);
  });
});

describe('link & asset integrity (parsed from index.html)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  it('every local asset referenced by index.html exists on disk', () => {
    const refs = [...html.matchAll(/(?:href|src)="((?:css|js)\/[^"]+)"/g)].map(m => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(fs.existsSync(path.join(ROOT, ref)), `missing asset: ${ref}`).toBe(true);
    }
  });

  it('every WhatsApp link is a well-formed wa.me deep link to the SG number', () => {
    const links = [...html.matchAll(/https:\/\/wa\.me\/(\d+)/g)].map(m => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const num of links) {
      expect(num).toMatch(/^65\d{8}$/);            // Singapore country code + 8 digits
      expect(num).toBe('6589968390');              // current published number
    }
  });

  it('has tel + mailto contact links with the right targets', () => {
    expect(html).toMatch(/href="tel:\+6589968390"/);
    expect(html).toMatch(/href="mailto:Urbanfleet@gmail\.com/i);
  });

  it('references the favicon assets', () => {
    expect(html).toMatch(/rel="icon"[^>]*href="favicon\.png"/);
    expect(fs.existsSync(path.join(ROOT, 'favicon.png'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'apple-touch-icon.png'))).toBe(true);
  });

  it('external resource links use https', () => {
    const ext = [...html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
    for (const url of ext) {
      expect(url.startsWith('https://'), `non-https external url: ${url}`).toBe(true);
    }
  });
});
