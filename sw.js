/**
 * sw.js — service worker приложения «Сила и КБЖУ».
 *
 * Стратегия: network-first.
 *  - Сначала пробуем сеть, при успехе обновляем копию в кэше и отдаём свежий файл.
 *  - Если сети нет — отдаём файл из кэша (полный офлайн-режим).
 *
 * Поэтому правки подхватываются сами: после каждого обновления кода менять
 * CACHE_VERSION НЕ нужно. Версию поднимают только чтобы принудительно выкинуть
 * весь кэш (например, если изменился набор файлов и старые записи мешают).
 * Новые файлы не забывайте добавлять в APP_FILES — они кэшируются при установке.
 */
const CACHE_VERSION = 'v5';
const CACHE_NAME = `sila-kbzhu-${CACHE_VERSION}`;

/** Все файлы приложения — кэшируются при установке. */
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './version.js',
  './product-catalog.js',
  './ui.js',
  './targets.js',
  './workouts.js',
  './nutrition.js',
  './foods.js',
  './stats.js',
  './profile.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* --------------------------- установка --------------------------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll падает целиком, если хотя бы один файл недоступен,
    // поэтому кэшируем по одному и не роняем установку из-за иконки.
    await Promise.all(
      APP_FILES.map(async (file) => {
        try {
          await cache.add(new Request(file, { cache: 'reload' }));
        } catch (error) {
          console.warn('[sw] Не удалось закэшировать', file, error);
        }
      })
    );
    await self.skipWaiting();
  })());
});

/* --------------------------- активация --------------------------- */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

/* ---------------------------- запросы ---------------------------- */

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Кэшируем только GET и только свои файлы
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Запросы диапазона (Range) не кэшируем: ответ 206 — это кусок файла,
  // а не файл целиком, и он испортил бы копию в кэше.
  if (request.headers.has('range')) return;

  event.respondWith(networkFirst(request));
});

/**
 * network-first: сеть -> обновление кэша -> фолбэк на кэш.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    // Перепроверяем файл на сервере (по ETag/Last-Modified): GitHub Pages отдаёт
    // статику с Cache-Control: max-age=600, и без этой перепроверки после
    // публикации можно до 10 минут видеть старую версию из HTTP-кэша браузера.
    let networkRequest = request;
    try {
      networkRequest = new Request(request, { cache: 'no-cache' });
    } catch (error) {
      // Некоторые версии Safari не дают пересобрать навигационный запрос —
      // тогда запрашиваем как есть, сеть всё равно остаётся первой.
      console.warn('[sw] Не удалось перепроверить запрос', request.url, error);
    }

    const response = await fetch(networkRequest);

    // Успешный ответ — обновляем кэш (кроме частичных ответов 206)
    if (response && response.ok && response.status !== 206) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;

    // Переход на страницу (навигация) — отдаём оболочку приложения
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }

    return new Response('Офлайн: файл не найден в кэше', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
