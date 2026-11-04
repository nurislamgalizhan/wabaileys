// Минимальный service worker: нужен для установки как приложения.
// Ничего не кэширует — переписка и медиа не остаются в кэше браузера.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
