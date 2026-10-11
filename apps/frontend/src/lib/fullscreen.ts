export function getFullscreenElement(): Element | null {
  if (typeof document === 'undefined') return null;
  return document.fullscreenElement || (document as any).webkitFullscreenElement || null;
}

export function isFullscreenApiEnabled(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(document.fullscreenEnabled || (document as any).webkitFullscreenEnabled);
}

export function isStandaloneDisplayMode(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}

export function isAppleTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent || '';
  const platform = navigator.platform || '';
  return /iP(ad|hone|od)/.test(userAgent) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function shouldUseCssFullscreenFallback(): boolean {
  return isStandaloneDisplayMode() || isAppleTouchDevice();
}

export async function requestElementFullscreen(el: HTMLElement): Promise<void> {
  if (el.requestFullscreen) {
    await el.requestFullscreen();
    return;
  }
  if ((el as any).webkitRequestFullscreen) {
    await (el as any).webkitRequestFullscreen();
  }
}

export async function exitDocumentFullscreen(): Promise<void> {
  if (document.exitFullscreen) {
    await document.exitFullscreen();
    return;
  }
  if ((document as any).webkitExitFullscreen) {
    await (document as any).webkitExitFullscreen();
  }
}
