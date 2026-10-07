import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { CostoEstandarService, RespuestaHistorial } from '../costo-estandar.service';
import { ComprasCostosHistorialComponent } from './compras-costos-historial.component';

const entrada = (over: Partial<RespuestaHistorial['entradas'][number]>) => ({
  fecha: '2026-09-22',
  sucursal_registro: '01',
  plaza: '01',
  folio: 'XA2001-0004312',
  proveedor: 'Proveedor A',
  unidad: 'CJA',
  cantidad: 2,
  costo: 1511.6,
  factor: 20,
  costo_base: 75.58,
  antes: 73.67,
  cambio: true,
  cambio_pct: 2.59,
  estandar_vigente: 71.84,
  vs_estandar_pct: 5.21,
  veredicto: 'arriba' as const,
  motivo: null,
  plaza_sin_kepler: null,
  ...over,
});

const R: RespuestaHistorial = {
  sku: '70001',
  nombre: 'CHOCOLATE TABLETA 20 PZ',
  proveedor: 'Proveedor A',
  desde: '2025-10-01',
  hasta: '2026-09-30',
  sucursales: [{ codigo: '01', nombre: 'PADRE HIDALGO' }, { codigo: '03', nombre: '8 ESQUINAS' }],
  estandar_hoy: [{ sucursal: '01', costo: 71.84, unidad: 'PZA' }],
  estandar_al_inicio: { '01': 69.9, '03': 69.9 },
  cambios_estandar: [{ sucursal: '01', fecha: '2026-06-14', antes: 69.9, despues: 71.84, cambio_pct: 2.78 }],
  entradas: [
    entrada({}),
    entrada({
      fecha: '2026-09-02', folio: 'XA2001-0004207', plaza: '03', antes: undefined, cambio: true, cambio_pct: null,
      costo_base: 69.9, estandar_vigente: 69.9, vs_estandar_pct: 0, veredicto: 'apegada',
    }),
  ],
};

describe('[CAT-COSTO.5] ComprasCostosHistorialComponent', () => {
  let fix: ComponentFixture<ComprasCostosHistorialComponent>;
  let api: { historial: ReturnType<typeof vi.fn>; listar: ReturnType<typeof vi.fn> };

  async function montar(sku: string | null, respuesta: unknown = of(R)) {
    api = { historial: vi.fn(() => respuesta), listar: vi.fn(() => of({ filas: [], total: 0 })) };
    await TestBed.configureTestingModule({
      imports: [ComprasCostosHistorialComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CostoEstandarService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(ComprasCostosHistorialComponent);
    fix.componentRef.setInput('sku', sku);
    fix.detectChanges();
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
    return fix.nativeElement as HTMLElement;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('sin producto elegido no consulta nada y pide buscar uno', async () => {
    const el = await montar(null);
    expect(api.historial).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Busca un producto');
  });

  it('con producto: pinta los dos tipos de cambio con su sucursal y su documento', async () => {
    const el = await montar('70001');
    expect(api.historial).toHaveBeenCalledWith('70001', expect.any(String), expect.any(String));
    const filas = Array.from(el.querySelectorAll('tbody tr')).map((tr) => tr.textContent?.replace(/\s+/g, ' ') ?? '');
    expect(filas).toHaveLength(3);
    expect(filas[0]).toContain('Costo de entrada');
    expect(filas[0]).toContain('XA2001-0004312');
    expect(filas[0]).toContain('arriba +5.2 %');
    expect(filas.some((f) => f.includes('Costo estándar') && f.includes('Ficha de Kepler'))).toBe(true);
    expect(filas.some((f) => f.includes('Primera entrada'))).toBe(true);
  });

  it('cuenta las entradas arriba del estándar en la cabecera', async () => {
    const el = await montar('70001');
    expect(el.querySelector('.ch-kpis dd.is-bad')?.textContent?.trim()).toBe('1');
  });

  it('el filtro de sucursal se aplica en la pantalla, sin volver a consultar', async () => {
    const el = await montar('70001');
    fix.componentInstance.sucursal.set('03');
    fix.detectChanges();
    expect(api.historial).toHaveBeenCalledTimes(1);
    const filas = Array.from(el.querySelectorAll('tbody tr')).map((tr) => tr.textContent ?? '');
    expect(filas).toHaveLength(1);
    expect(filas[0]).toContain('XA2001-0004207');
  });

  it('[negativa] si el servidor falla dice que no pudo, no pinta una tabla vacía', async () => {
    const el = await montar('70001', throwError(() => new Error('500')));
    expect(el.querySelector('.ch-error')?.textContent).toContain('No se pudo cargar');
    expect(el.querySelector('tbody')).toBeNull();
  });
});
