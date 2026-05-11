/* ────────────────────────────────────────────────────────────────────────────
   Patel RE Underwriting Suite — Service Worker
   Bump CACHE_VERSION whenever this file changes to bust old caches.
   Strategy:
     - network-first  for HTML (index.html, landing.html) — always get fresh
     - cache-first    for static CDN assets (fonts, pptxgenjs, xlsx, chart.js, pdf.js, mammoth, supabase-js)
     - bypass         for Supabase API + Stripe + internal analytics / api calls
     - bypass         for cross-origin POST/PUT/DELETE (non-GET) — never cache mutations
   ────────────────────────────────────────────────────────────────────────── */

const CACHE_VERSION = 'v1';
const STATIC_CACHE  = `prsuite-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `prsuite-runtime-${CACHE_VERSION}`;
const SCOPE_PREFIX  = '/patel-re-underwriting-suite/';

// Static assets we want available for fast repeat loads.
// We DON'T precache these (their URLs are CDN-hosted with hashes already);
// we just opportunistically cache-first them on first fetch.
const STATIC_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com'
];

// Hosts we MUST bypass — never serve a stale response for these.
const BYPASS_HOSTS = [
  'supabase.co',           // matches *.supabase.co
  'api.stripe.com',
  'checkout.stripe.com',
  'js.stripe.com',         // Stripe.js needs to stay fresh too
  'api.openai.com',
  'api.anthropic.com'
];

self.addEventListener('install', (event) => {
  // Activate this SW as soon as it's installed; no waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Take control of all open clients immediately
    await self.clients.claim();
    // Purge old versioned caches
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('prsuite-') && n !== STATIC_CACHE && n !== RUNTIME_CACHE)
        .map((n) => caches.delete(n))
    );
  })());
});

function isHtmlRequest(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/html');
}

function isStaticAsset(url) {
  return STATIC_HOSTS.some((h) => url.host === h || url.host.endsWith('.' + h));
}

function shouldBypass(url, req) {
  // Bypass anything that mutates data
  if (req.method !== 'GET') return true;
  // Bypass hosts on the explicit list (Supabase / Stripe / etc.)
  if (BYPASS_HOSTS.some((h) => url.host === h || url.host.endsWith('.' + h))) return true;
  // Bypass anything inside /functions/v1/ (Supabase Edge Functions)
  if (url.pathname.includes('/functions/v1/')) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  if (shouldBypass(url, req)) return; // let the browser handle it directly

  // 1) HTML — network-first, fall back to cache if offline
  if (isHtmlRequest(req)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // Cache a clone for offline fallback (only same-origin scoped pages)
        if (fresh.ok && url.origin === self.location.origin && url.pathname.startsWith(SCOPE_PREFIX)) {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        // Last-resort offline shell — serve cached index if available
        const shell = await caches.match(SCOPE_PREFIX + 'index.html');
        if (shell) return shell;
        throw err;
      }
    })());
    return;
  }

  // 2) Static CDN assets — cache-first, fall back to network
  if (isStaticAsset(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(STATIC_CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  // 3) Everything else (same-origin assets like icon-192.png, etc.) — stale-while-revalidate
  if (url.origin === self.location.origin && url.pathname.startsWith(SCOPE_PREFIX)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(req);
      const fetchPromise = fetch(req).then((fresh) => {
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      }).catch(() => cached);
      return cached || fetchPromise;
    })());
  }
});

// Allow the page to ask the SW to skip waiting (for instant updates)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
