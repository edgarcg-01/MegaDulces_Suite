import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Observable, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { CatalogoProductosService, FichaProducto } from '../catalogo-productos.service';
import { ProductoFichaComponent, armarFicha } from './producto-ficha.component';

// Mazapán: base PAQ, caja de 20 PAQ.
const FICHA: FichaProducto = {
  id: 'p-1', sku: '70001', nombre: 'MAZAPAN DE LA ROSA 30G', descripcion: null, activo: true,
  proveedor: { id: 'pr-1', nombre: 'DULCES DE LA ROSA SA DE CV' },
  codigos: ['7501234567890', '7509999999999'],
  unidadBase: 'PAQ',
  unidades: [
    { unidad: 'PAQ', equivale: null, factorBase: 1, precio: 84.5, mayoreo: { precio: 80.47, desde: 3 } },
    { unidad: 'CJA', equivale: { cantidad: 20, unidad: 'PAQ' }, factorBase: 20, precio: null, mayoreo: null },
  ],
  precioRed: { sucursales: 8, min: 84.5, max: 84.5 },
  sucursales: [
    { codigo: '01', nombre: 'PADRE HIDALGO', vendidoMes: { monto: 12000, unidadesBase: 142 }, existenciaBase: 1305 },
    { codigo: '04', nombre: 'YURECUARO', vendidoMes: { monto: 3000, unidadesBase: 35 }, existenciaBase: 0 },
    { codigo: '06', nombre: 'CANINDO', vendidoMes: null, existenciaBase: null },
  ],
  corteVenta: '2026-10-25',
  ultimaEntrada: { sucursal: '01', nombreSucursal: 'PADRE HIDALGO', fecha: '2026-10-21', cantidad: 40, unidad: 'CJA', costo: null },
  costo_visible: false,
  calculado_al: '2026-10-26T15:00:00.000Z',
};

const tick = async (fix: ComponentFixture<unknown>) => {
  for (let i = 0; i < 3; i++) { fix.detectChanges(); await fix.whenStable(); }
  fix.detectChanges();
};

async function montar(ficha: (id: string, suc?: string | null) => Observable<FichaProducto>) {
  await TestBed.configureTestingModule({
    imports: [ProductoFichaComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: CatalogoProductosService, useValue: { ficha: vi.fn(ficha), lista: vi.fn() } }],
  }).compileComponents();
  const fix = TestBed.createComponent(ProductoFichaComponent);
  fix.componentRef.setInput('productId', 'p-1');
  await tick(fix);
  return fix;
}
const texto = (fix: ComponentFixture<unknown>) => (fix.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '';

describe('ficha de producto (Sencillo)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('pinta la identidad: SKU copiable, estado, todos los códigos con el principal, proveedor legible', async () => {
    const fix = await montar(() => of(FICHA));
    const t = texto(fix);
    expect(t).toContain('70001');
    expect(t).toContain('copiar');
    expect(t).toContain('Activo');
    expect(t).toContain('Códigos de barras');
    expect(t).toContain('7501234567890 principal');
    expect(t).toContain('7509999999999');
    expect(t).toContain('Dulces de la Rosa');
    expect(t).not.toMatch(/SA DE CV/i);
    expect(t).not.toContain('Descripción');
  });

  it('unidades: precio, mayoreo «desde» y «Sin precio» donde no hay lista (nunca $0)', async () => {
    const fix = await montar(() => of(FICHA));
    const t = texto(fix);
    expect(t).toContain('unidad base');
    expect(t).toContain('20 PAQ');
    expect(t).toMatch(/\$84\.50/);
    expect(t).toMatch(/\$80\.47\s*desde 3/);
    expect(t).toContain('Sin precio');
    expect(t).not.toMatch(/\$0\.00/);
    expect(t).toContain('Mismo precio en las 8 sucursales');
  });

  it('existencia compuesta, Agotado si vendió sin existencia, Sin dato si no se midió', async () => {
    const fix = await montar(() => of(FICHA));
    const t = texto(fix);
    expect(t).toMatch(/65 CJA\s*5 PAQ/);
    expect(t).toMatch(/7 CJA\s*2 PAQ/); // vendido 142 PAQ
    expect(t).toContain('Agotado');
    expect(t).toContain('Sin dato');
    expect(t).toContain('Total');
    expect(t).toContain('La existencia total no incluye 1 sucursal sin dato: Canindo');
    expect(t).toContain('Agotado en 1 sucursal que sí lo vende');
  });

  it('oculta el costo de la última entrada si no llega; lo muestra con su candado si llega', async () => {
    const fix = await montar(() => of(FICHA));
    expect(texto(fix)).toContain('Última entrada');
    expect(texto(fix)).toContain('40 CJA');
    expect(texto(fix)).not.toContain('Costo por');
    TestBed.resetTestingModule();
    const fix2 = await montar(() => of({ ...FICHA, costo_visible: true, ultimaEntrada: { ...FICHA.ultimaEntrada!, costo: 312.4 } }));
    expect(texto(fix2)).toContain('Costo por CJA');
    expect(texto(fix2)).toMatch(/\$312\.40/);
    expect(texto(fix2)).toContain('sólo con permiso de costo');
  });

  it('estado de error: lo dice y ofrece reintentar, sin pintar una ficha vacía', async () => {
    const fix = await montar(() => throwError(() => ({ status: 500, error: { message: 'boom' } })));
    const t = texto(fix);
    expect(t).toContain('No se pudo cargar la ficha del producto');
    expect(t).toContain('Reintentar');
    expect(t).not.toContain('Unidades y precio');
  });

  it('armarFicha: precio que varía, inactivo, sin código y sin entrada', () => {
    const v = armarFicha({ ...FICHA, activo: false, codigos: [], ultimaEntrada: null, precioRed: { sucursales: 8, min: 80, max: 90 } });
    expect(v.activo).toBe(false);
    expect(v.codigos).toEqual([]);
    expect(v.entrada).toBeNull();
    expect(v.red.tipo).toBe('varia');
    expect(v.red.texto).toMatch(/Varía entre sucursales: \$80\.00 a \$90\.00/);
  });
});
