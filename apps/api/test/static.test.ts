import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers.js';

// A stand-in for the built web app.
const dist = mkdtempSync(join(tmpdir(), 'dta-web-'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');

const ctx = useTestApp({ env: { WEB_DIST_DIR: dist } });

describe('serving the web app', () => {
  it('serves the app, its assets, and the app for client-side routes', async () => {
    const home = await ctx.app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('id="root"');
    expect(home.headers['content-security-policy']).toContain("script-src 'self'");

    const asset = await ctx.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.headers['cache-control']).toContain('immutable');

    const route = await ctx.app.inject({ method: 'GET', url: '/some/page', headers: { accept: 'text/html' } });
    expect(route.body).toContain('id="root"');
  });

  it('keeps API routes and unknown API paths as JSON', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/health' })).json().status).toBe('ok');
    const missing = await ctx.app.inject({ method: 'GET', url: '/nope', headers: { accept: 'application/json' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found', message: 'Not found' });
    expect((await ctx.app.inject({ method: 'GET', url: '/portfolio', headers: { accept: 'text/html' } })).statusCode).toBe(401);
  });
});
