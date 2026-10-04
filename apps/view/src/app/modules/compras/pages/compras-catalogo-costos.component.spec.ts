import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import {
  ConsultaEntreSucursales,
  CostoEstandarService,
  RespuestaEntreSucursales,
} from '../costo-estandar.service';
import { ComprasCatalogoCostosComponent } from './compras-catalogo-costos.component';

const RESPUESTA: RespuestaEntreSucursales = {
  sucursales: [
    { codigo: '01', nombre: 'PADRE HIDALGO' },
    { codigo: '02', nombre: 'LA PIEDAD' },
    { codigo: '03', nombre: '8 ESQUINAS' },
  ],
  resumen: { distinto: 7, sin_mayoria: 2, unidad_distinta: 1, igual: 40, una_plaza: 5 },
  proveedores: [{ id: 'p-a', nombre: 'Proveedor A', productos: 3 }],
  tolerancia_pct: 0.5,
  actividad_al: '2026-10-03',
  total: 1,
  filas: [
    {
      sku: '70001',
      nombre: 'CHOCOLATE TABLETA 20 PZ',
      proveedor_id: 'p-a',
      proveedor: 'Proveedor A',
      venta_30d: 12345.6,
      veredicto: 'distinto',
      mayoria: 71.84,
      diferencia_pct: 2.7,
      sucursales_fuera: ['03'],
      celdas: [
        { sucursal: '01', costo: 71.84, unidad: 'PZA', vende: true, comparada: true, fuera: false, desviacion_pct: 0 },
        { sucursal: '03', costo: 69.9, unidad: 'PZA', vende: false, comparada: true, fuera: true, desviacion_pct: -2.7 },
      ],
    },
  ],
};

const tick = async (fix: ComponentFixture<unknown>) => {
  fix.detectChanges();
  await fix.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fix.detectChanges();
};

describe('[CAT-COSTO.4] ComprasCatalogoCostosComponent', () => {
  let fix: ComponentFixture<ComprasCatalogoCostosComponent>;
  let api: { entreSucursales: ReturnType<typeof vi.fn> };

  async function montar(respuesta: unknown) {
    api = { entreSucursales: vi.fn(() => respuesta) };
    await TestBed.configureTestingModule({
      imports: [ComprasCatalogoCostosComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CostoEstandarService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(ComprasCatalogoCostosComponent);
    await tick(fix);
    return fix.nativeElement as HTMLElement;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('pide por defecto sólo los productos con diferencia', async () => {
    await montar(of(RESPUESTA));
    const consulta = api.entreSucursales.mock.calls[0][0] as ConsultaEntreSucursales;
    expect(consulta.solo_diferencias).toBe(true);
    expect(consulta.veredicto).toBeUndefined();
  });

  it('el titular dice cuántos productos tienen una plaza fuera, y los chips suman lo que hay que revisar', async () => {
    const el = await montar(of(RESPUESTA));
    expect(el.querySelector('.cc-titular')?.textContent).toContain('7 productos');
    const chips = Array.from(el.querySelectorAll('.cc-chip')).map((b) => [
      b.querySelector('span')?.textContent?.trim(),
      b.querySelector('.cc-chip-n')?.textContent?.trim(),
    ]);
    // «Con diferencia» = distinto + sin_mayoria + unidad_distinta = 7 + 2 + 1
    expect(chips[0]).toEqual(['Con diferencia', '10']);
    expect(chips).toContainEqual(['Iguales', '40']);
  });

  it('pinta una columna por sucursal y marca la que se sale; sin ficha es un guion, no un cero', async () => {
    const el = await montar(of(RESPUESTA));
    const encabezados = Array.from(el.querySelectorAll('th')).map((th) => th.textContent?.trim());
    expect(encabezados).toEqual(expect.arrayContaining(['01', '02', '03']));
    const fuera = el.querySelectorAll('td.cc-celda.is-fuera');
    expect(fuera.length).toBe(1);
    expect(fuera[0].textContent).toContain('69.90');
    expect(el.querySelector('td.cc-celda.is-fuera')?.classList.contains('is-sin-venta')).toBe(true);
    // La 02 no trae celda: guion declarado.
    expect(el.querySelectorAll('td.cc-vacia').length).toBe(1);
  });

  it('elegir un chip pide ese resultado y vuelve a la página 1', async () => {
    const el = await montar(of(RESPUESTA));
    const iguales = Array.from(el.querySelectorAll<HTMLButtonElement>('.cc-chip')).find((b) => b.textContent?.includes('Iguales'));
    iguales?.click();
    await tick(fix);
    const ultima = api.entreSucursales.mock.calls.at(-1)?.[0] as ConsultaEntreSucursales;
    expect(ultima.veredicto).toBe('igual');
    expect(ultima.desplazamiento).toBe(0);
  });

  it('[negativa] si el servidor falla NO pinta ceros: no hay titular y sí un aviso', async () => {
    const el = await montar(throwError(() => new Error('500')));
    expect(el.querySelector('.cc-titular')).toBeNull();
    expect(el.querySelector('.cc-error')?.textContent).toContain('No se pudo cargar');
  });
});
