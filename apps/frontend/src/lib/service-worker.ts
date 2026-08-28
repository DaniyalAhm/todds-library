export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  // Only register in production — avoids stale SW caches while developing
  // and keeps HMR fast. next-pwa also sets disable: dev via next.config.js.
  if (process.env.NODE_ENV !== 'production') return;

  const register = () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Registration failure must never block the app; the keepalive
      // fallback covers browsers without a service worker.
    });
  };

  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register);
  }
}