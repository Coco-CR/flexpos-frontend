/* ══════════════════════════════════════════════════════════
   FlexPOS · Service Worker v1.0
   Estrategia:
   - App Shell (HTML/CSS/fonts) → Cache First
   - Supabase API calls → Network First, fallback a cache
   - Cola offline → IndexedDB, sincroniza al reconectar
══════════════════════════════════════════════════════════ */

const CACHE_NAME  = 'flexpos-v1';
const SHELL_CACHE = 'flexpos-shell-v1';
const SYNC_TAG    = 'flexpos-sync';

/* Archivos del App Shell a cachear en instalación */
const SHELL_FILES = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
];

/* ── INSTALL ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== SHELL_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── FETCH ── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  /* Fuentes de Google y CDN → Cache First */
  if (url.hostname === 'fonts.googleapis.com' ||
      url.hostname === 'fonts.gstatic.com'    ||
      url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  /* Supabase API → Network First con fallback offline */
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(networkFirstSupabase(event.request));
    return;
  }

  /* App Shell (la propia página) → Cache First */
  if (event.request.mode === 'navigate' ||
      event.request.destination === 'document') {
    event.respondWith(
      caches.match('./').then(cached => cached || fetch(event.request))
    );
    return;
  }

  /* Todo lo demás → Network con fallback a cache */
  event.respondWith(
    fetch(event.request)
      .then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});

/* ── BACKGROUND SYNC ── */
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(processSyncQueue());
  }
});

/* Notificar a la app cuando se recupera la conexión */
self.addEventListener('message', event => {
  if (event.data?.type === 'CHECK_SYNC') {
    processSyncQueue().then(count => {
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'SYNC_DONE', synced: count }))
      );
    });
  }
});

/* ═════════════════════════════════
   HELPERS DE CACHE
═════════════════════════════════ */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp && resp.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, resp.clone());
    }
    return resp;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirstSupabase(request) {
  try {
    const resp = await fetch(request.clone());
    /* Solo cachear GETs exitosos de Supabase (lecturas de inventario/clientes) */
    if (resp.status === 200 && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, resp.clone());
    }
    return resp;
  } catch {
    /* Sin conexión: devolver cache si existe */
    const cached = await caches.match(request);
    if (cached) return cached;
    /* Para escrituras fallidas (POST/PATCH/DELETE) → encolar */
    return new Response(
      JSON.stringify({ error: 'offline', queued: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/* ═════════════════════════════════
   COLA OFFLINE (IndexedDB)
   Procesa operaciones pendientes
   cuando se restaura la conexión
═════════════════════════════════ */
async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('flexpos-offline', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = e => reject(e.target.error);
  });
}

async function processSyncQueue() {
  let db, synced = 0;
  try {
    db = await openDB();
    const tx    = db.transaction('queue', 'readonly');
    const store = tx.objectStore('queue');
    const items = await new Promise((res, rej) => {
      const req = store.getAll();
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });

    for (const item of items) {
      try {
        const resp = await fetch(item.url, {
          method:  item.method,
          headers: item.headers,
          body:    item.body,
        });
        if (resp.ok || resp.status === 201 || resp.status === 204) {
          /* Eliminar de la cola */
          const delTx    = db.transaction('queue', 'readwrite');
          const delStore = delTx.objectStore('queue');
          delStore.delete(item.id);
          synced++;
        }
      } catch {
        /* Sigue offline, dejar en cola */
        break;
      }
    }
  } catch (e) {
    console.error('[SW] Error procesando cola:', e);
  }
  return synced;
}
