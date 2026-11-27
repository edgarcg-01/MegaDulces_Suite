import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import type { LevantamientoBusquedaFila } from '@megadulces/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { UsoService } from '../../../core/services/uso.service';
import { LevantamientoService } from '../levantamiento.service';
import { LevantamientoComponent } from './levantamiento.component';

/**
 * `[NP.7.L.22]` El buscador dice la VERDAD de lo que pasó: una búsqueda que falló es un error («No se pudo
 * buscar»), no «No aparece» (auditoría del 2026-11-26, nivel A). Y cada resultado dice el estado de sus fotos
 * con palabra, no sólo con color.
 */
type Estado = {
  buscarAhora(q: string): Promise<void>;
  resultados(): LevantamientoBusquedaFila[];
  errorBusqueda(): string | null;
  estadoFoto: Record<string, { texto: string }>;
};
const fila = (photo_status: LevantamientoBusquedaFila['photo_status']): LevantamientoBusquedaFila =>
  ({ sku: '02020', name: 'TRIDENT', content: null, barcode: null, photo_status });

describe('[NP.7.L.22] Levantamiento: el buscador', () => {
  let buscar: ReturnType<typeof vi.fn>;
  async function montar(): Promise<Estado> {
    buscar = vi.fn();
    await TestBed.configureTestingModule({
      imports: [LevantamientoComponent],
      providers: [
        { provide: LevantamientoService, useValue: { buscar, contexto: vi.fn(() => of({})), sugeridos: vi.fn(() => of({ rows: [], total: 0 })) } },
        { provide: AuthService, useValue: {} },
        { provide: UsoService, useValue: { registrarFotoRechazada: vi.fn() } },
      ],
    }).overrideComponent(LevantamientoComponent, { set: { template: '', imports: [] } }).compileComponents();
    return TestBed.createComponent(LevantamientoComponent).componentInstance as unknown as Estado;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ sin señal → error «Sin conexión», NO una lista vacía que se lea como «No aparece»', async () => {
    const c = await montar();
    buscar.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 0, error: null })));
    await c.buscarAhora('mazapan');
    expect(c.errorBusqueda()).toMatch(/Sin conexión/);
    expect(c.resultados()).toEqual([]);
  });

  it('al volver la señal, el error viejo se borra (antes se quedaba pegado)', async () => {
    const c = await montar();
    buscar.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 0, error: null })));
    await c.buscarAhora('mazapan');
    buscar.mockReturnValueOnce(of([fila('falta')]));
    await c.buscarAhora('mazapan');
    expect(c.errorBusqueda()).toBeNull();
    expect(c.resultados()).toHaveLength(1);
  });

  it('⛔ negativa: una búsqueda que sí respondió vacía NO es error', async () => {
    const c = await montar();
    buscar.mockReturnValue(of([]));
    await c.buscarAhora('xyzxyz');
    expect(c.errorBusqueda()).toBeNull();
    expect(c.resultados()).toEqual([]);
  });

  it('cada estado se dice con palabras', async () => {
    const c = await montar();
    expect(c.estadoFoto['tiene_foto'].texto).toBe('Tiene foto');
    expect(c.estadoFoto['en_curso'].texto).toBe('Alguien la está tomando');
    expect(c.estadoFoto['falta'].texto).toBe('Falta foto');
  });
});
