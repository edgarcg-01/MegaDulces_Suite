import { captureFileName, formatClock, pickRecorderMime } from './media-capture.component';

/** `[DEV.7]` Lo que se puede probar de la cámara sin cámara: formato, nombre y reloj. */
describe('[DEV.7] captura de foto y video', () => {
  it('elige el mejor formato que el navegador sepa grabar', () => {
    expect(pickRecorderMime(() => true)).toBe('video/webm;codecs=vp9,opus');
    // Safari: no graba webm, sí mp4.
    expect(pickRecorderMime((t) => t === 'video/mp4')).toBe('video/mp4');
  });

  it('⛔ si no sabe grabar ninguno, devuelve vacío (y se usa el default del navegador)', () => {
    expect(pickRecorderMime(() => false)).toBe('');
  });

  it('el nombre dice qué es y cuándo se tomó', () => {
    const d = new Date(2026, 9, 1, 9, 5, 7);
    expect(captureFileName('foto', 'image/jpeg', d)).toBe('foto-2026-10-01-090507.jpg');
    expect(captureFileName('video', 'video/webm', d)).toBe('video-2026-10-01-090507.webm');
    expect(captureFileName('video', 'video/mp4', d)).toBe('video-2026-10-01-090507.mp4');
  });

  it('reloj de grabación mm:ss', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(65)).toBe('01:05');
    expect(formatClock(-3)).toBe('00:00');
  });
});
