import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CALIDAD_VERSION, UMBRAL_CONTRASTE, UMBRAL_NITIDEZ } from '@megadulces/ui-web';
import { AuthService } from '../../../core/services/auth.service';
import { UsoService } from '../../../core/services/uso.service';
import { LevantamientoService } from '../levantamiento.service';
import { LevantamientoComponent } from './levantamiento.component';

/**
 * `[NP.7.L.21]` La guía de fotos sale UNA vez por teléfono: antes de la primera foto, hasta que la persona la
 * cierra o toma una foto buena. Quien ya la vio no la vuelve a leer en cada producto.
 */
type Estado = {
  mostrarGuia(): boolean;
  cerrarGuia(): void;
  paso: { set(v: string): void };
  escaneo: { set(v: unknown): void };
  caras: { set(v: string[]): void };
  hechas: { set(v: Set<string>): void };
  alTomar(d: string): Promise<void>;
};
const CLAVE = 'np7-guia-fotos-vista';
const CARAS = ['frente', 'reverso', 'tabla_nutricional', 'informacion'];

describe('[NP.7.L.21] Levantamiento: la guía de fotos', () => {
  async function montar(): Promise<Estado> {
    await TestBed.configureTestingModule({
      imports: [LevantamientoComponent],
      providers: [
        {
          provide: LevantamientoService,
          useValue: {
            contexto: vi.fn(() => of({ missing: 0, week: { published: 0, in_review: 0 } })), sugeridos: vi.fn(() => of({ rows: [], total: 0 })),
            subirFoto: vi.fn(() => of({ face: 'frente', status: 'en_captura', complete: false, faces_done: ['frente'], faces_skipped: [], details_done: [] })),
          },
        },
        { provide: AuthService, useValue: {} },
        { provide: UsoService, useValue: { registrarFotoRechazada: vi.fn() } },
      ],
    }).overrideComponent(LevantamientoComponent, { set: { template: '', imports: [] } }).compileComponents();
    const c = TestBed.createComponent(LevantamientoComponent).componentInstance as unknown as Estado;
    c.escaneo.set({ sheet_id: 'ficha-1', faces: CARAS });
    c.caras.set(CARAS);
    c.paso.set('captura');
    return c;
  }

  beforeEach(() => localStorage.removeItem(CLAVE));
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ se ve antes de la primera foto; «Entendido» la cierra y el teléfono la recuerda', async () => {
    const c = await montar();
    expect(c.mostrarGuia()).toBe(true);
    c.cerrarGuia();
    expect(c.mostrarGuia()).toBe(false);
    expect(localStorage.getItem(CLAVE)).toBe('1');
    TestBed.resetTestingModule();
    expect((await montar()).mostrarGuia()).toBe(false); // el siguiente producto ya no la muestra
  });

  it('una foto BUENA también la da por vista', async () => {
    const c = await montar();
    (c as unknown as { medir: () => Promise<unknown> }).medir = () =>
      Promise.resolve({ blob: new Blob(['x']), ancho: 1600, alto: 1200, medicion: { nitidez: UMBRAL_NITIDEZ + 50, contraste: UMBRAL_CONTRASTE + 10 } });
    await c.alTomar('data:image/jpeg;base64,AA==');
    expect(localStorage.getItem(CLAVE)).toBe('1');
    expect(CALIDAD_VERSION).toBeTruthy();
  });

  it('⛔ negativa: con una foto ya tomada en este producto, no estorba aunque no se haya cerrado', async () => {
    const c = await montar();
    c.hechas.set(new Set(['frente']));
    expect(c.mostrarGuia()).toBe(false);
    expect(localStorage.getItem(CLAVE)).toBeNull();
  });
});
