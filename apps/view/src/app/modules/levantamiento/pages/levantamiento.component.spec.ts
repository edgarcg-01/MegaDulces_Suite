import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { LEVANTAMIENTO_CARAS, type LevantamientoCara, type LevantamientoFotoRespuesta } from '@megadulces/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { LevantamientoService } from '../levantamiento.service';
import { LevantamientoComponent } from './levantamiento.component';

/**
 * `[NP.7.L.18]` «Enviado» pinta el aviso (lo usan los detalles). Un aviso VIEJO —el «Sin conexión» de un salto
 * que después sí pasó, o el «No se pudo subir» de una foto que el reintento ya subió— no puede quedarse junto
 * al éxito: la pantalla verde diría «Enviado» y, debajo, que algo falló. Con fotos todavía fallidas el aviso
 * sigue valiendo y se conserva.
 *
 * Se prueba la LÓGICA del componente con la plantilla vacía (la cámara y el lector no hacen falta aquí).
 */
type Estado = {
  paso: { set(v: string): void; (): string };
  aviso: { set(v: string | null): void; (): string | null };
  escaneo: { set(v: unknown): void };
  caras: { set(v: LevantamientoCara[]): void };
  hechas: { set(v: Set<LevantamientoCara>): void };
  fallidas: { set(v: unknown[]): void };
  saltar(m: string): Promise<void>;
  reintentar(): Promise<void>;
};

const CARAS = [...LEVANTAMIENTO_CARAS];
const ULTIMA: LevantamientoCara = 'codigo_barras';
const SIN_ULTIMA = CARAS.filter((c) => c !== ULTIMA);
const respuesta = (p: Partial<LevantamientoFotoRespuesta>): LevantamientoFotoRespuesta => ({
  face: ULTIMA, status: 'fotos_tomadas', complete: true, faces_done: SIN_ULTIMA, faces_skipped: [], details_done: [], ...p,
} as LevantamientoFotoRespuesta);
const sinRed = (): HttpErrorResponse => new HttpErrorResponse({ status: 0, error: null });

describe('[NP.7.L.18] Levantamiento: «Enviado» no arrastra avisos ya resueltos', () => {
  let api: { saltar: ReturnType<typeof vi.fn>; subirFoto: ReturnType<typeof vi.fn>; contexto: ReturnType<typeof vi.fn>; sugeridos: ReturnType<typeof vi.fn>; sucursales: ReturnType<typeof vi.fn> };

  async function montar(): Promise<Estado> {
    api = {
      saltar: vi.fn(), subirFoto: vi.fn(),
      contexto: vi.fn(() => of({ missing: 0, week: { published: 0, in_review: 0 } })),
      sugeridos: vi.fn(() => of({ rows: [], total: 0 })),
      sucursales: vi.fn(() => of([])),
    };
    await TestBed.configureTestingModule({
      imports: [LevantamientoComponent],
      providers: [{ provide: LevantamientoService, useValue: api }, { provide: AuthService, useValue: {} }],
    }).overrideComponent(LevantamientoComponent, { set: { template: '', imports: [] } }).compileComponents();
    const c = TestBed.createComponent(LevantamientoComponent).componentInstance as unknown as Estado;
    c.escaneo.set({ sheet_id: 'ficha-1', faces: CARAS });
    c.caras.set(CARAS);
    c.paso.set('captura');
    return c;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('⭐ el salto del último acercamiento falla sin señal y al reintentarlo pasa → «Enviado» SIN el «Sin conexión»', async () => {
    const c = await montar();
    c.hechas.set(new Set(SIN_ULTIMA));
    api.saltar.mockReturnValueOnce(throwError(sinRed)).mockReturnValueOnce(of(respuesta({ faces_skipped: [ULTIMA] })));

    await c.saltar('no_tiene_esa_cara');
    expect(c.paso()).toBe('captura');
    expect(c.aviso()).toMatch(/Sin conexión/); // control: el aviso sí se puso

    await c.saltar('no_tiene_esa_cara');
    expect(api.saltar).toHaveBeenLastCalledWith('ficha-1', ULTIMA, 'no_tiene_esa_cara');
    expect(c.paso()).toBe('listo');
    expect(c.aviso()).toBeNull();
  });

  it('⭐ una foto que falló y el reintento sube → «Enviado» SIN el «No se pudo subir»', async () => {
    const c = await montar();
    c.hechas.set(new Set(CARAS)); // las 7 que subieron + la fallida, que espera en memoria
    c.fallidas.set([{ face: ULTIMA, blob: new Blob(['x']), calidad: { sharpness: 1, contrast: 1, version: 'v' }, ancho: 1, alto: 1 }]);
    c.aviso.set('No se pudo subir la foto. Sigue con la siguiente; al final la reintentas.');
    c.paso.set('listo');
    api.subirFoto.mockReturnValueOnce(of(respuesta({ faces_done: CARAS })));

    await c.reintentar();
    expect(api.subirFoto).toHaveBeenCalledTimes(1);
    expect(c.paso()).toBe('listo');
    expect(c.aviso()).toBeNull();
  });

  it('con una foto TODAVÍA fallida el aviso se conserva (sigue siendo cierto)', async () => {
    const c = await montar();
    c.hechas.set(new Set(CARAS));
    c.fallidas.set([
      { face: 'informacion', blob: new Blob(['x']), calidad: { sharpness: 1, contrast: 1, version: 'v' }, ancho: 1, alto: 1 },
      { face: ULTIMA, blob: new Blob(['y']), calidad: { sharpness: 1, contrast: 1, version: 'v' }, ancho: 1, alto: 1 },
    ]);
    c.paso.set('listo');
    // La primera vuelve a fallar; la segunda sube.
    api.subirFoto
      .mockReturnValueOnce(throwError(sinRed))
      .mockReturnValueOnce(of(respuesta({ complete: false, status: 'en_captura', faces_done: CARAS.filter((x) => x !== 'informacion') })));

    await c.reintentar();
    expect(c.paso()).toBe('listo');
    expect(c.aviso()).toMatch(/Sin conexión/);
  });
});
