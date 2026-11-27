import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import type { LevantamientoEscaneoRespuesta } from '@megadulces/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { UsoService } from '../../../core/services/uso.service';
import { LevantamientoService } from '../levantamiento.service';
import { LevantamientoComponent } from './levantamiento.component';

/**
 * `[NP.7.L.23]` Al confirmar, la persona elige UNA presentación (viene marcada la del código o la más vendida).
 * Cambiarla suelta la propuesta y pide la elegida; si el servidor no la puede apartar, vuelve al inicio con el aviso.
 */
type Estado = {
  escaneo: { set(v: LevantamientoEscaneoRespuesta | null): void; (): LevantamientoEscaneoRespuesta | null };
  hechas: { set(v: Set<string>): void };
  paso: { set(v: string): void; (): string };
  resultado(): { titulo: string; mensaje: string } | null;
  puedeElegirPresentacion(): boolean;
  cambiarPresentacion(r: string): Promise<void>;
};
const RUNGS = [
  { rung: 'base' as const, label: 'PZA', factor: 1 },
  { rung: 'dos' as const, label: 'PAQ', factor: 12 },
  { rung: 'tres' as const, label: 'CJA', factor: 384 },
];
const respuesta = (o: Partial<LevantamientoEscaneoRespuesta>): LevantamientoEscaneoRespuesta => ({
  action: 'capturar', message: '', code: '7622210571403', sku: '02020', name: 'TRIDENT', scanned: { rung: 'base', label: 'PZA', factor: 1 },
  principal: RUNGS[1], rungs: RUNGS, sheet_id: 'ficha-1', faces: ['frente', 'reverso', 'tabla_nutricional', 'informacion'],
  faces_done: [], faces_skipped: [], reserved_until: null, candidates: [], ...o,
});

describe('[NP.7.L.23] Levantamiento: elegir la presentación', () => {
  let api: { escanear: ReturnType<typeof vi.fn>; soltar: ReturnType<typeof vi.fn> };
  async function montar(): Promise<Estado> {
    api = { escanear: vi.fn(), soltar: vi.fn(() => of({ ok: true })) };
    await TestBed.configureTestingModule({
      imports: [LevantamientoComponent],
      providers: [
        { provide: LevantamientoService, useValue: { ...api, contexto: vi.fn(() => of({})), sugeridos: vi.fn(() => of({ rows: [], total: 0 })) } },
        { provide: AuthService, useValue: {} },
        { provide: UsoService, useValue: { registrarFotoRechazada: vi.fn() } },
      ],
    }).overrideComponent(LevantamientoComponent, { set: { template: '', imports: [] } }).compileComponents();
    const c = TestBed.createComponent(LevantamientoComponent).componentInstance as unknown as Estado;
    c.escaneo.set(respuesta({}));
    c.paso.set('confirmar');
    return c;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('se ofrece con varias presentaciones y antes de la primera foto; no con una sola ni al retomar', async () => {
    const c = await montar();
    expect(c.puedeElegirPresentacion()).toBe(true);
    c.hechas.set(new Set(['frente']));
    expect(c.puedeElegirPresentacion()).toBe(false);
    c.hechas.set(new Set());
    c.escaneo.set(respuesta({ rungs: [RUNGS[0]] }));
    expect(c.puedeElegirPresentacion()).toBe(false);
  });

  it('⭐ elegir la pieza: suelta la propuesta y vuelve a pedir con el mismo código y la pieza', async () => {
    const c = await montar();
    api.escanear.mockReturnValue(of(respuesta({ principal: RUNGS[0] })));
    await c.cambiarPresentacion('base');
    expect(api.soltar).toHaveBeenCalledWith('ficha-1');
    expect(api.escanear).toHaveBeenCalledWith({ code: '7622210571403', rung: 'base' });
    expect(c.escaneo()?.principal?.rung).toBe('base');
    expect(c.paso()).toBe('confirmar');
  });

  it('elegida por el buscador (sin código): se vuelve a pedir por SKU', async () => {
    const c = await montar();
    c.escaneo.set(respuesta({ code: null, scanned: null }));
    api.escanear.mockReturnValue(of(respuesta({ code: null, principal: RUNGS[2] })));
    await c.cambiarPresentacion('tres');
    expect(api.escanear).toHaveBeenCalledWith({ sku: '02020', rung: 'tres' });
  });

  it('⛔ si el servidor no la puede apartar (alguien más lo toma) → al inicio con el aviso, nada a medias', async () => {
    const c = await montar();
    api.escanear.mockReturnValue(of(respuesta({ action: 'apartado_por_otro', message: 'Alguien más lo está levantando en este momento. Escanea otro.', sheet_id: null })));
    await c.cambiarPresentacion('tres');
    expect(c.paso()).toBe('inicio');
    expect(c.escaneo()).toBeNull();
    expect(c.resultado()?.titulo).toBe('Alguien más lo está tomando'); // [NP.7.L.25] en tarjeta, no en un renglón
    expect(c.resultado()?.mensaje).toMatch(/Alguien más/);
  });

  it('tocar la que ya está marcada no hace nada', async () => {
    const c = await montar();
    await c.cambiarPresentacion('dos');
    expect(api.soltar).not.toHaveBeenCalled();
    expect(api.escanear).not.toHaveBeenCalled();
  });
});
