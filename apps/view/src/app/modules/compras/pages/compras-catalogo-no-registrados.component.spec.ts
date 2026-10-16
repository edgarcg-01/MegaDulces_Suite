import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it, beforeEach } from 'vitest';
import { ComprasCatalogoNoRegistradosComponent } from './compras-catalogo-no-registrados.component';
import { FaltantesService, type NoRegistrado } from '../../tienda/faltantes.service';

/**
 * `[MOS.2]` — Catálogo › No registrados: los filtros trabajan sobre la lista COMPLETA, y un código
 * que no existe en Kepler (sin proveedor) sólo se ve con «Todos los proveedores».
 */

const fila = (o: Partial<NoRegistrado>): NoRegistrado => ({
  cosa: o.cosa ?? Math.random().toString(), warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
  scanned_code: null, sku: null, nombre: null, nombre_escrito: false, proveedor: null,
  veces: 1, ultima_vez: '2026-10-16T17:00:00.000Z', ...o,
});

const FILAS = [
  fila({ cosa: 'a', sku: '71077', nombre: 'TAMARINDO LUPITA', proveedor: 'DULCES LUPITA', warehouse_code: '05', warehouse_name: 'Zamora' }),
  fila({ cosa: 'b', scanned_code: '7502233440017', nombre: 'gomita roja', nombre_escrito: true }),
  fila({ cosa: 'c', sku: '14099', nombre: 'MAZAPAN MINI', proveedor: 'DULCES DE LA ROSA' }),
];

describe('ComprasCatalogoNoRegistradosComponent', () => {
  let respuesta: () => ReturnType<FaltantesService['noRegistrados']>;

  beforeEach(() => {
    respuesta = () => of({ filas: FILAS, recortado: false });
    TestBed.configureTestingModule({
      imports: [ComprasCatalogoNoRegistradosComponent],
      providers: [
        provideRouter([]),
        { provide: FaltantesService, useValue: { noRegistrados: () => respuesta() } },
      ],
    });
  });

  const montar = () => {
    const f = TestBed.createComponent(ComprasCatalogoNoRegistradosComponent);
    f.detectChanges();
    return f.componentInstance;
  };

  it('carga la lista completa y arma las opciones de sucursal y proveedor', () => {
    const c = montar();
    expect(c.total()).toBe(3);
    expect(c.opcionesSucursal().map((o) => o.value)).toEqual(['01', '05']);
    expect(c.opcionesProveedor().map((o) => o.value)).toEqual(['DULCES DE LA ROSA', 'DULCES LUPITA']);
  });

  it('filtra por sucursal, por proveedor y por SKU o nombre', () => {
    const c = montar();
    c.sucursal.set('05');
    expect(c.filas().map((f) => f.cosa)).toEqual(['a']);
    c.sucursal.set('');
    c.proveedor.set('DULCES DE LA ROSA');
    expect(c.filas().map((f) => f.cosa)).toEqual(['c']);
    c.proveedor.set('');
    c.busqueda.set('gomita');
    expect(c.filas().map((f) => f.cosa)).toEqual(['b']);
    c.busqueda.set('71077');
    expect(c.filas().map((f) => f.cosa)).toEqual(['a']);
  });

  it('⛔ un código sin proveedor desaparece al elegir un proveedor (no tiene a quién pertenecer)', () => {
    const c = montar();
    c.proveedor.set('DULCES LUPITA');
    expect(c.filas().some((f) => f.cosa === 'b')).toBe(false);
  });

  it('un error de lectura se dice; no se pinta como lista vacía', () => {
    respuesta = () => throwError(() => ({ error: { message: 'sin conexión' } }));
    const c = montar();
    expect(c.error()).toBe('sin conexión');
    expect(c.datos()).toBeNull();
  });

  it('declara cuando el servidor recortó la lista', () => {
    respuesta = () => of({ filas: FILAS, recortado: true });
    const c = montar();
    expect(c.recortado()).toBe(true);
  });
});
