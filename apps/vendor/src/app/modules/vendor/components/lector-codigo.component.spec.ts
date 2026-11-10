import { TestBed } from '@angular/core/testing';
import { abrirLectorCodigos } from '@megadulces/ui-web';
import { LectorCodigoComponent } from './lector-codigo.component';

/**
 * `[VTK.17]` `[VTK.18]` La cáscara del lector: el permiso se pide al tocar, sin cámara se dice por
 * qué, lo leído sale una sola vez, y la cámara SIEMPRE se apaga (al leer, al cancelar, al salir).
 *
 * zxing no corre en jsdom: se simula `abrirLectorCodigos` (la lógica real tiene su spec en
 * `libs/ui-web/src/camara/lector-codigos.spec.ts`).
 */
vi.mock('@megadulces/ui-web', async (original) => ({
  ...(await original<typeof import('@megadulces/ui-web')>()),
  abrirLectorCodigos: vi.fn(),
}));

const abrirMock = vi.mocked(abrirLectorCodigos);

function conCamara(hay: boolean) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: hay ? { getUserMedia: vi.fn() } : undefined,
  });
}

function montar() {
  TestBed.configureTestingModule({ imports: [LectorCodigoComponent] });
  const fix = TestBed.createComponent(LectorCodigoComponent);
  fix.detectChanges();
  const cmp = fix.componentInstance;
  const leidos: string[] = [];
  const avisos: string[] = [];
  cmp.leido.subscribe((c) => leidos.push(c));
  cmp.sinCamara.subscribe((t) => avisos.push(t));
  const el = fix.nativeElement as HTMLElement;
  const capa = () => el.querySelector('.lc-ov');
  /** Toca el botón y deja que se pinte la capa y abra la cámara (simulada). */
  const tocar = async () => {
    const p = cmp.abrir();
    fix.detectChanges();
    await p;
    fix.detectChanges();
  };
  return { fix, cmp, el, capa, leidos, avisos, tocar };
}

describe('LectorCodigoComponent · leer un código con la cámara', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    abrirMock.mockReset();
  });

  it('el botón dice qué hace y NO pide la cámara hasta que se toca', () => {
    conCamara(true);
    const { el } = montar();
    expect(el.querySelector('button')?.getAttribute('aria-label')).toBe('Leer código de barras con la cámara');
    expect(abrirMock).not.toHaveBeenCalled();
  });

  it('⛔ [negativa] navegador sin acceso a la cámara: lo dice y no abre la capa', async () => {
    conCamara(false);
    const { tocar, avisos, capa } = montar();
    await tocar();
    expect(avisos[0]).toContain('no da acceso a la cámara');
    expect(capa()).toBeNull();
    expect(abrirMock).not.toHaveBeenCalled();
  });

  it('⭐ permiso negado: cierra la capa y dice por qué (con la salida de escribir)', async () => {
    conCamara(true);
    abrirMock.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    const { tocar, avisos, capa } = montar();
    await tocar();
    expect(capa()).toBeNull();
    expect(avisos[0]).toContain('No se dio permiso para usar la cámara');
    expect(avisos[0]).toContain('escribir');
  });

  it('⭐ lee un código: lo entrega UNA vez y apaga la cámara', async () => {
    conCamara(true);
    const stop = vi.fn();
    let alLeer: (c: string) => void = () => undefined;
    abrirMock.mockImplementationOnce(async (_v, cb) => { alLeer = cb; return { stop } as never; });
    const { tocar, leidos, capa, fix } = montar();
    await tocar();
    expect(capa()).not.toBeNull();
    alLeer('7501234567890');
    alLeer('7501234567890'); // zxing a veces llama otra vez antes de detenerse
    fix.detectChanges();
    expect(leidos).toEqual(['7501234567890']);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(capa()).toBeNull();
  });

  it('«Cancelar», Esc y salir de la pantalla apagan la cámara', async () => {
    conCamara(true);
    const stop = vi.fn();
    abrirMock.mockResolvedValue({ stop } as never);
    const { tocar, el, fix, capa, cmp } = montar();
    await tocar();
    (el.querySelector('.lc-x') as HTMLButtonElement).click();
    fix.detectChanges();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(capa()).toBeNull();

    await tocar();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fix.detectChanges();
    expect(stop).toHaveBeenCalledTimes(2);

    await tocar();
    expect(cmp.abierta()).toBe(true);
    fix.destroy();
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it('⛔ [negativa] «Cancelar» mientras la cámara abría: la que llega tarde se apaga y no queda prendida', async () => {
    conCamara(true);
    const stop = vi.fn();
    let soltar: (v: unknown) => void = () => undefined;
    abrirMock.mockImplementationOnce(() => new Promise((r) => { soltar = r; }) as never);
    const { cmp, fix } = montar();
    const p = cmp.abrir();
    fix.detectChanges();
    await new Promise((r) => setTimeout(r, 40)); // la capa ya se pintó y se pidió la cámara
    cmp.cerrar();
    soltar({ stop });
    await p;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cmp.abierta()).toBe(false);
  });
});
