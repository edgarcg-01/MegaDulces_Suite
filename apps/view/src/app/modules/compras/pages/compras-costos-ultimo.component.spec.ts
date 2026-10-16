import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { FilaContraUltimo, RespuestaContraUltimo } from '@megadulces/contracts';
import { CostoEstandarService } from '../costo-estandar.service';
import { ComprasCostosUltimoComponent } from './compras-costos-ultimo.component';

const cero = { filas: 0, venta_30d: 0 };

const fila = (over: Partial<FilaContraUltimo>): FilaContraUltimo => ({
  sucursal: '01',
  sku: '70001',
  nombre: 'LA ROSA MAZAPAN /30',
  proveedor_id: 'p1',
  proveedor: 'DULCES DE LA ROSA',
  unidad_base: 'PAQ',
  costo_estandar: 66.52,
  costo_ultimo: 69.98,
  ultimo_fecha: '2026-10-12',
  ultimo_folio: '0000687',
  ultimo_proveedor: 'DULCES DE LA ROSA',
  ultimo_origen: 'propia',
  ultimo_sucursal: '01',
  ultimo_unidad: 'PAQ',
  antiguedad: 'hasta_90',
  costo_promedio: 69.75,
  diferencia_pct: 5.2,
  venta_30d: 143072,
  veredicto: 'estandar_abajo',
  motivo: null,
  ...over,
});

const R: RespuestaContraUltimo = {
  disponible: true,
  calculado_al: '2026-10-15T12:20:00.000Z',
  venta_al: '2026-10-15',
  tolerancia_pct: 1,
  resumen: {
    estandar_abajo: { filas: 1, venta_30d: 143072 },
    estandar_arriba: cero,
    igual: { filas: 3, venta_30d: 1000 },
    sin_compra: cero,
    unidad_no_clara: { filas: 1, venta_30d: 50 },
    sin_estandar: cero,
  },
  abajo_por_antiguedad: { hasta_90: { filas: 1, venta_30d: 143072 }, de_90_a_180: cero, mas_de_180: cero },
  sucursales: [{ codigo: '01', nombre: 'Padre Hidalgo' }, { codigo: '07', nombre: 'Morelia Madero' }],
  proveedores: [{ id: 'p1', nombre: 'DULCES DE LA ROSA', productos: 2 }],
  total: 2,
  filas: [
    fila({}),
    fila({
      sucursal: '07', sku: '96087', nombre: 'PRODUCTO SIN UNIDAD', costo_ultimo: null, ultimo_fecha: null,
      ultimo_folio: null, ultimo_origen: null, ultimo_unidad: null, antiguedad: null, diferencia_pct: null, venta_30d: 50,
      veredicto: 'unidad_no_clara', motivo: 'unidad_no_resuelta',
    }),
  ],
};

describe('[CAT-COSTO.7] ComprasCostosUltimoComponent', () => {
  let fix: ComponentFixture<ComprasCostosUltimoComponent>;
  let api: { contraUltimo: ReturnType<typeof vi.fn> };

  async function montar(respuesta: unknown = of(R)) {
    api = { contraUltimo: vi.fn(() => respuesta) };
    await TestBed.configureTestingModule({
      imports: [ComprasCostosUltimoComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: CostoEstandarService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(ComprasCostosUltimoComponent);
    fix.detectChanges();
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
    return fix.nativeElement as HTMLElement;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('abre con la respuesta: cuántos productos tienen el estándar abajo de su última compra', async () => {
    const el = await montar();
    expect(el.querySelector('.cu-titular')?.textContent).toContain('1 productos por sucursal');
    expect(el.querySelector('app-metric-strip')).not.toBeNull();
  });

  it('pinta los tres costos y la compra con su folio XA2001', async () => {
    const el = await montar();
    const txt = el.querySelector('p-table')?.textContent ?? '';
    expect(txt).toContain('$66.52');
    expect(txt).toContain('$69.98');
    expect(txt).toContain('$69.75');
    expect(txt).toContain('XA2001-0000687');
    expect(txt).toContain('+5.2 %');
  });

  it('NEGATIVA: lo que no se puede comparar se DICE, no se pinta un costo ni una diferencia', async () => {
    const el = await montar();
    const txt = el.querySelector('p-table')?.textContent ?? '';
    expect(txt).toContain('Compra en una unidad que la ficha no declara');
    expect(txt).toContain('Unidad no clara');
  });

  it('unidad no clara CON compra: dice en qué unidad vino la compra y en cuál está la ficha', async () => {
    const el = await montar(of({ ...R, filas: [fila({ unidad_base: 'KG', ultimo_unidad: 'PAQ', costo_ultimo: null, diferencia_pct: null, veredicto: 'unidad_no_clara', motivo: 'unidad_no_resuelta' })] }));
    const txt = el.querySelector('p-table')?.textContent ?? '';
    expect(txt).toContain('La compra vino en PAQ y la ficha está en KG');
    expect(txt).toContain('XA2001-0000687');
  });

  it('NEGATIVA: con la fuente sin calcular NO hay tabla con ceros: hay un vacío que lo explica', async () => {
    const el = await montar(of({ ...R, disponible: false, filas: [], total: 0 }));
    expect(el.textContent).toContain('Los costos todavía no se han calculado');
    expect(el.querySelector('.cu-titular')).toBeNull();
  });

  it('un error de red se ve como error, no como vacío', async () => {
    const el = await montar(throwError(() => new Error('500')));
    expect(el.textContent).toContain('No se pudo cargar la comparación de costos.');
    expect(el.textContent).not.toContain('Los costos todavía no se han calculado');
  });

  it('el chip de resultado filtra en el servidor y regresa a la página 1', async () => {
    await montar();
    fix.componentInstance.pagina.set(3);
    fix.componentInstance.onVeredicto('unidad_no_clara');
    fix.detectChanges();
    await fix.whenStable();
    const ultima = api.contraUltimo.mock.calls.at(-1)?.[0];
    expect(ultima.veredicto).toBe('unidad_no_clara');
    expect(ultima.desplazamiento).toBe(0);
  });
});
