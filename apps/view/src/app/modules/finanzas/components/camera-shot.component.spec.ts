import { TestBed } from '@angular/core/testing';
import { CameraShotComponent } from './camera-shot.component';

/**
 * `[NP.7.L.8a]` Qué resolución se le pide a la cámara.
 *
 * Medido en prod el 2026-11-04: las 40 fotos de la primera captura del levantamiento salieron a
 * 1080×1920 porque el componente pedía siempre 1920×1080, y la foto es un cuadro del video. El
 * levantamiento ahora pide `maxima`; los tickets de Finanzas siguen con `estandar`.
 *
 * Las pruebas cuidan las dos puntas: que Finanzas NO cambie (mismo pedido de siempre) y que pedir el
 * máximo nunca rompa la captura (un teléfono que rechaza el ajuste sigue con la cámara abierta).
 */
describe('CameraShotComponent · resolución pedida a la cámara', () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  let track: { getCapabilities?: () => unknown; applyConstraints: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

  const stream = () => ({ getVideoTracks: () => [track], getTracks: () => [track] });

  beforeEach(() => {
    track = {
      getCapabilities: () => ({ width: { max: 4032 }, height: { max: 3024 } }),
      applyConstraints: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
    getUserMedia = vi.fn().mockImplementation(async () => stream());
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    TestBed.configureTestingModule({ imports: [CameraShotComponent] });
  });

  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'mediaDevices', original);
    else delete (navigator as unknown as Record<string, unknown>)['mediaDevices'];
  });

  const crear = (resolucion?: 'estandar' | 'maxima') => {
    const f = TestBed.createComponent(CameraShotComponent);
    if (resolucion) f.componentRef.setInput('resolucion', resolucion);
    return f.componentInstance;
  };

  it('por defecto (los tickets de Finanzas) pide 1920×1080 y no toca el ajuste de la pista', async () => {
    const c = crear();
    await c.abrir();
    const video = getUserMedia.mock.calls[0][0].video;
    expect(video.width).toEqual({ ideal: 1920 });
    expect(video.height).toEqual({ ideal: 1080 });
    expect(track.applyConstraints).not.toHaveBeenCalled();
    expect(c.error()).toBeNull();
    c.cerrar();
  });

  it('con `maxima` pide 4:3 grande y después sube al máximo que declara la cámara', async () => {
    const c = crear('maxima');
    await c.abrir();
    const video = getUserMedia.mock.calls[0][0].video;
    expect(video.width).toEqual({ ideal: 4096 });
    expect(video.height).toEqual({ ideal: 3072 });
    expect(track.applyConstraints).toHaveBeenCalledWith({ width: { ideal: 4032 }, height: { ideal: 3024 } });
    expect(c.error()).toBeNull();
    c.cerrar();
  });

  it('si el teléfono rechaza el ajuste, la cámara sigue abierta (nunca rompe la captura)', async () => {
    track.applyConstraints.mockRejectedValue(new Error('OverconstrainedError'));
    const c = crear('maxima');
    await c.abrir();
    expect(c.error()).toBeNull();
    expect(c.abierto()).toBe(true);
    expect(c.arrancando()).toBe(false);
    c.cerrar();
  });

  it('sin `getCapabilities` (navegadores viejos) abre igual, con lo que dio el `ideal`', async () => {
    delete track.getCapabilities;
    const c = crear('maxima');
    await c.abrir();
    expect(track.applyConstraints).not.toHaveBeenCalled();
    expect(c.error()).toBeNull();
    expect(c.abierto()).toBe(true);
    c.cerrar();
  });
});
