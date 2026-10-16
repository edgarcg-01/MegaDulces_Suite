import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { FaltanteExpressComponent } from './faltante-express.component';
import { FaltantesService, type ReportarPayload } from '../faltantes.service';
import { VerificadorService, type ResultadoBusqueda } from '../verificador.service';

/**
 * `[MOS.1]` / `[MOS.2]` — El buscador del mostrador, montado.
 *
 * Lo que se vigila son las DECISIONES que toma con lo que contesta el catálogo, porque cada una
 * escribe algo (o no) en la lista de Compras:
 *   · Kepler dice «no existe» → se anota `no_en_catalogo` SOLO, sin abrir ninguna ventana.
 *   · existe en otra sucursal → se anota `no_en_sucursal` y NO se muestra el precio de la otra.
 *   · sin red el «no está» viene del respaldo → NO se anota nada (puede ser viejo).
 *   · números + Enter sin flechas → va contra Kepler, no toma el primer parecido de la lista.
 */

const PRODUCTO = {
  codigo: '70001', nombre: 'PAL CHIQUI HUESO', proveedor: 'DULCES ALVHER',
  unidades: [
    { u: 'PZA', precio_con_iva: 3.5, precio_sin_iva: 3.02, factor: 1 },
    { u: 'PAQ', precio_con_iva: 126, precio_sin_iva: 108.62, factor: 40 },
    { u: 'CJA', precio_con_iva: 2380, precio_sin_iva: 2051.72, factor: 800 },
  ],
  iva_pct: 16, ieps_pct: 0, mayoreo: [], contenido: null, product_id: null,
};

describe('FaltanteExpressComponent · lo que hace con cada respuesta del catálogo', () => {
  let reportes: ReportarPayload[];
  let respuesta: Subject<ResultadoBusqueda>;
  let buscarEnCatalogo: ReturnType<typeof vi.fn>;

  const montar = () => {
    const f = TestBed.createComponent(FaltanteExpressComponent);
    f.componentRef.setInput('sucursal', '03');
    f.detectChanges();
    return f.componentInstance;
  };

  const teclearEnter = (c: FaltanteExpressComponent) =>
    c.alTeclear(new KeyboardEvent('keydown', { key: 'Enter' }));

  beforeEach(() => {
    reportes = [];
    respuesta = new Subject<ResultadoBusqueda>();
    buscarEnCatalogo = vi.fn(async () => []);
    TestBed.configureTestingModule({
      imports: [FaltanteExpressComponent],
      providers: [
        {
          provide: VerificadorService,
          useValue: { buscar: () => respuesta, buscarEnCatalogo, descargarSnapshot: () => of(null) },
        },
        {
          provide: FaltantesService,
          useValue: {
            reportar: (p: ReportarPayload) => {
              reportes.push(p);
              return of({ id: 'r1', kind: p.kind, destino: 'catalogo', times_reported: 1, product_name: null,
                on_hand_at_report: null, est_lost_revenue: null, est_source: 'sin_dato', contradice_al_erp: false });
            },
            consultar: () => of({ encontrado: true, termino: '70001', warehouse_code: '03', warehouse_name: null, existencia: 5, veredicto: 'hay_en_tienda' }),
            deshacer: () => of({ id: 'r1', eliminado: true, times_reported: 0 }),
            describir: (_id: string, texto: string) => of({ id: 'r1', product_name: texto }),
          },
        },
      ],
    });
  });

  it('Kepler dice que el código no existe → lo anota en No registrados, sin ventana', () => {
    const c = montar();
    c.alEscribir('7509990000099');
    teclearEnter(c);
    respuesta.next({ estado: 'no_encontrado', origen: 'live', codigo: '7509990000099', snapshotAl: null });

    expect(reportes).toEqual([
      { warehouse_code: '03', kind: 'no_en_catalogo', scanned_code: '7509990000099', source: 'verificador' },
    ]);
    expect(c.noReg()?.anotado?.id).toBe('r1');
    expect(c.ventana()).toBe(false);
  });

  it('⛔ existe en OTRA sucursal → no muestra su precio y lo anota como no dado de alta aquí', () => {
    const c = montar();
    c.alEscribir('7501234500012');
    teclearEnter(c);
    respuesta.next({ estado: 'encontrado', origen: 'live', producto: PRODUCTO, snapshotAl: null, plazaSinDato: true });

    expect(c.ventana()).toBe(false);
    expect(c.elegido()).toBeNull();
    expect(reportes[0]).toMatchObject({ kind: 'no_en_sucursal', sku: '70001', scanned_code: '7501234500012' });
  });

  it('⛔ sin red el «no está» viene del respaldo: NO se anota nada', () => {
    const c = montar();
    c.alEscribir('7509990000099');
    teclearEnter(c);
    respuesta.next({ estado: 'no_encontrado', origen: 'respaldo', codigo: '7509990000099', snapshotAl: null });
    expect(reportes).toEqual([]);
    expect(c.noReg()).toBeNull();
    expect(c.aviso()?.tono).toBe('warn');
  });

  it('encontrado en vivo → abre la ventana con todas las presentaciones y la caja en paquetes', () => {
    const c = montar();
    c.alEscribir('70001');
    teclearEnter(c);
    respuesta.next({ estado: 'encontrado', origen: 'live', producto: PRODUCTO, snapshotAl: null, plazaSinDato: false });

    expect(c.ventana()).toBe(true);
    expect(c.origenPrecio()).toBe('vivo');
    expect(c.presentaciones().map((p) => [p.u, p.trae?.n, p.trae?.u])).toEqual([
      ['PZA', undefined, undefined], ['PAQ', 40, 'PZA'], ['CJA', 20, 'PAQ'],
    ]);
  });

  it('⛔ números + Enter sin flechas van contra Kepler aunque la lista tenga un parecido', async () => {
    const c = montar();
    c.resultados.set([{ codigo: '70014', nombre: 'OTRO', proveedor: null, por: 'sku', exacto: false, unidades: PRODUCTO.unidades, mayoreo: [] }]);
    c.termino.set('700');
    const buscar = vi.spyOn(TestBed.inject(VerificadorService), 'buscar');
    teclearEnter(c);
    expect(buscar).toHaveBeenCalledWith('700', '03');
    expect(c.elegido()).toBeNull();
  });

  it('con letras, Enter toma el renglón resaltado de la lista', () => {
    const c = montar();
    c.resultados.set([{ codigo: '70001', nombre: 'PAL CHIQUI HUESO', proveedor: null, por: 'nombre', exacto: false, unidades: PRODUCTO.unidades, mayoreo: [] }]);
    c.termino.set('chiqui');
    teclearEnter(c);
    expect(c.elegido()?.codigo).toBe('70001');
    expect(c.origenPrecio()).toBe('respaldo');   // hasta que conteste el ODS
  });

  it('la descripción de la cajera se guarda sobre el reporte ya anotado', () => {
    const c = montar();
    c.alEscribir('7509990000099');
    teclearEnter(c);
    respuesta.next({ estado: 'no_encontrado', origen: 'live', codigo: '7509990000099', snapshotAl: null });
    c.descripcion.set('  gomita roja ');
    c.guardarDescripcion();
    expect(c.noReg()?.descrito).toBe('gomita roja');
    expect(reportes).toHaveLength(1);             // describir no suma un reporte
  });
});
