import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { RespuestaMatrizCostos } from '@megadulces/contracts';
import { CostoEstandarService } from '../costo-estandar.service';
import { ComprasCostosMatrizComponent } from './compras-costos-matriz.component';

const R: RespuestaMatrizCostos = {
  disponible: true,
  tipo: 'estandar',
  fecha: '2026-10-15',
  primera_fecha: '2025-01-09',
  calculado_al: '2026-10-15T12:20:00.000Z',
  tolerancia_pct: 0.5,
  sucursales: [
    { codigo: '00', nombre: 'CEDIS', desde: '2025-01-09' },
    { codigo: '01', nombre: 'Padre Hidalgo', desde: '2025-01-09' },
    { codigo: '08', nombre: 'Morelia Abastos', desde: '2026-12-01' },
  ],
  resumen: { distinto: 1, sin_mayoria: 0, unidad_distinta: 0, igual: 3, una_plaza: 0 },
  proveedores: [{ id: 'p1', nombre: 'DISTRIBUIDORA DE LA ROSA', productos: 1 }],
  total: 1,
  filas: [{
    sku: '70056',
    nombre: 'LA ROSA MAZAPAN GIGANTE',
    proveedor_id: 'p1',
    proveedor: 'DISTRIBUIDORA DE LA ROSA',
    venta_30d: 181228.41,
    mayoria: 78.66,
    coincidencia_pct: 50,
    diferencia_pct: 5.2,
    veredicto: 'distinto',
    celdas: [
      { sucursal: '00', costo: 78.66, desde: '2026-09-04', fuente: 'ficha', referencia: null, unidad: 'PAQ', fuera: false, desviacion_pct: 0 },
      { sucursal: '01', costo: 82.75, desde: '2026-02-03', fuente: 'venta', referencia: null, unidad: 'PAQ', fuera: true, desviacion_pct: 5.2 },
    ],
  }],
};

describe('[CAT-COSTO.10] ComprasCostosMatrizComponent', () => {
  let fix: ComponentFixture<ComprasCostosMatrizComponent>;
  let api: { matriz: ReturnType<typeof vi.fn> };

  async function montar(respuesta: unknown = of(R), tipo: 'estandar' | 'promedio' | 'ultimo' = 'estandar') {
    api = { matriz: vi.fn(() => respuesta) };
    await TestBed.configureTestingModule({
      imports: [ComprasCostosMatrizComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CostoEstandarService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(ComprasCostosMatrizComponent);
    fix.componentRef.setInput('tipo', tipo);
    fix.detectChanges();
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
    return fix.nativeElement as HTMLElement;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('abre con la respuesta: cuántos productos tienen un almacén que se sale, ese día', async () => {
    const el = await montar();
    expect(el.querySelector('.cm-titular')?.textContent).toContain('1 productos tienen un almacén con costo estándar distinto');
    expect(el.querySelector('app-metric-strip')).not.toBeNull();
  });

  it('una columna por almacén, con la mayoría y la coincidencia; la celda que se sale va marcada', async () => {
    const el = await montar();
    const ths = [...el.querySelectorAll('thead th')].map((t) => t.textContent?.trim());
    expect(ths).toEqual(['Producto', '00', '01', '08', 'Mayoría', 'Coincidencia', 'Resultado']);
    const fuera = el.querySelectorAll('td.cm-celda.is-fuera');
    expect(fuera.length).toBe(1);
    expect(fuera[0].textContent).toContain('$82.75');
    expect(el.querySelector('tbody')?.textContent).toContain('50 %');
  });

  it('NEGATIVA: un almacén que ese día no estaba en Kepler dice «sin dato», nunca un costo ni un cero', async () => {
    const el = await montar();
    const celdas = [...el.querySelectorAll('tbody tr:first-child td')].map((t) => t.textContent?.trim());
    expect(celdas[3]).toBe('sin dato');
  });

  it('el estándar deducido de la venta se distingue del de la ficha', async () => {
    const el = await montar();
    expect(el.querySelectorAll('td.cm-celda.is-deducido').length).toBe(1);
  });

  it('pide el costo de su tipo y la fecha de hoy; las flechas cambian de día', async () => {
    await montar(of(R), 'promedio');
    const primera = api.matriz.mock.calls[0][0];
    expect(primera.tipo).toBe('promedio');
    expect(primera.fecha).toBe(fix.componentInstance.hoy);
    fix.componentInstance.moverDia(-1);
    fix.detectChanges();
    await fix.whenStable();
    expect(api.matriz.mock.calls.at(-1)?.[0].fecha < fix.componentInstance.hoy).toBe(true);
  });

  it('NEGATIVA: no se puede ir a un día futuro', async () => {
    await montar();
    const antes = fix.componentInstance.fecha();
    fix.componentInstance.moverDia(1);
    expect(fix.componentInstance.fecha()).toBe(antes);
  });

  it('NEGATIVA: con la historia sin calcular no hay tabla con ceros, hay un vacío que lo explica', async () => {
    const el = await montar(of({ ...R, disponible: false, filas: [], total: 0 }));
    expect(el.textContent).toContain('La historia de costos todavía no se ha calculado');
    expect(el.querySelector('.cm-titular')).toBeNull();
  });

  it('un error de red se ve como error, no como vacío', async () => {
    const el = await montar(throwError(() => new Error('500')));
    expect(el.textContent).toContain('No se pudo cargar la matriz de costos.');
  });
});
