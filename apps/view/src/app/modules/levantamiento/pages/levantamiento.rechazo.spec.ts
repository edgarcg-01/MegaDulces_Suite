import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { LEVANTAMIENTO_CARAS, type LevantamientoCara } from '@megadulces/contracts';
import { CALIDAD_VERSION, UMBRAL_CONTRASTE, UMBRAL_NITIDEZ } from '@megadulces/ui-web';
import { AuthService } from '../../../core/services/auth.service';
import { UsoService } from '../../../core/services/uso.service';
import { LevantamientoService } from '../levantamiento.service';
import { LevantamientoComponent } from './levantamiento.component';

/**
 * `[NP.7.L.19]` Cada foto que el medidor rechaza deja constancia en la telemetría (`foto_rechazada`), para
 * calibrar los umbrales con datos. Una foto que PASA no se registra como rechazo (prueba negativa).
 * Se prueba la lógica con la plantilla vacía; `medir()` se sustituye porque jsdom no decodifica imágenes.
 */
type Estado = {
  paso: { set(v: string): void; (): string };
  escaneo: { set(v: unknown): void };
  caras: { set(v: LevantamientoCara[]): void };
  alTomar(d: string): Promise<void>;
  medir: unknown;
};

describe('[NP.7.L.19] Levantamiento: la foto rechazada deja constancia', () => {
  let uso: { registrarFotoRechazada: ReturnType<typeof vi.fn> };
  let api: { subirFoto: ReturnType<typeof vi.fn> };

  async function montar(medicion: { nitidez: number; contraste: number } | Error): Promise<Estado> {
    uso = { registrarFotoRechazada: vi.fn() };
    api = { subirFoto: vi.fn(() => of({ face: 'frente', status: 'en_captura', complete: false, faces_done: ['frente'], faces_skipped: [], details_done: [] })) };
    await TestBed.configureTestingModule({
      imports: [LevantamientoComponent],
      providers: [
        { provide: LevantamientoService, useValue: { ...api, contexto: vi.fn(() => of({ missing: 0, week: { published: 0, in_review: 0 } })), sugeridos: vi.fn(() => of({ rows: [], total: 0 })), sucursales: vi.fn(() => of([])) } },
        { provide: AuthService, useValue: {} },
        { provide: UsoService, useValue: uso },
      ],
    }).overrideComponent(LevantamientoComponent, { set: { template: '', imports: [] } }).compileComponents();
    const c = TestBed.createComponent(LevantamientoComponent).componentInstance as unknown as Estado;
    c.escaneo.set({ sheet_id: 'ficha-1', faces: [...LEVANTAMIENTO_CARAS] });
    c.caras.set([...LEVANTAMIENTO_CARAS]);
    c.paso.set('captura');
    (c as unknown as { medir: () => Promise<unknown> }).medir = medicion instanceof Error
      ? () => Promise.reject(medicion)
      : () => Promise.resolve({ blob: new Blob(['x']), ancho: 1600, alto: 1200, medicion });
    return c;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('⭐ borrosa → se registra con su medición, su cara y la versión del medidor', async () => {
    const c = await montar({ nitidez: UMBRAL_NITIDEZ - 40, contraste: UMBRAL_CONTRASTE + 10 });
    await c.alTomar('data:image/jpeg;base64,AA==');
    expect(c.paso()).toBe('repetir');
    expect(uso.registrarFotoRechazada).toHaveBeenCalledWith({
      motivo: 'borrosa', cara: LEVANTAMIENTO_CARAS[0], version: CALIDAD_VERSION,
      nitidez: UMBRAL_NITIDEZ - 40, contraste: UMBRAL_CONTRASTE + 10, ancho: 1600, alto: 1200,
    });
  });

  it('opaca → motivo «opaca»', async () => {
    const c = await montar({ nitidez: UMBRAL_NITIDEZ + 50, contraste: UMBRAL_CONTRASTE - 5 });
    await c.alTomar('data:image/jpeg;base64,AA==');
    expect(uso.registrarFotoRechazada).toHaveBeenCalledWith(expect.objectContaining({ motivo: 'opaca' }));
  });

  it('la imagen no se pudo leer → motivo «ilegible», sin medición inventada', async () => {
    const c = await montar(new Error('decode'));
    await c.alTomar('data:image/jpeg;base64,AA==');
    expect(uso.registrarFotoRechazada).toHaveBeenCalledWith(expect.objectContaining({ motivo: 'ilegible', nitidez: null, contraste: null }));
  });

  it('⛔ negativa: una foto que pasa NO se registra como rechazo y sí se sube', async () => {
    const c = await montar({ nitidez: UMBRAL_NITIDEZ + 50, contraste: UMBRAL_CONTRASTE + 10 });
    await c.alTomar('data:image/jpeg;base64,AA==');
    expect(uso.registrarFotoRechazada).not.toHaveBeenCalled();
    expect(api.subirFoto).toHaveBeenCalledTimes(1);
  });
});
