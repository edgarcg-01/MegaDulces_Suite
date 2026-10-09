import { readFileSync } from 'fs';
import { join } from 'path';
import type { AndenLineaOffline, AndenLlegadaLote } from '@megadulces/contracts';
import {
  aLote,
  armarLlegada,
  estadoLlegada,
  estadoRenglon,
  renglonesDeKepler,
  renglonesDeVale,
  resumir,
  unidadesPorSku,
} from './receiving-arrivals';

/**
 * `[WMS-REC.22]` — **Llegadas al andén**: el estado de cada camión y de cada renglón.
 *
 * Lo que más importa probar es que las dos ausencias no se confundan: un renglón que se declaró
 * SIN caducidad es un hecho capturado (cuenta como listo), y un camión SIN vale no tiene nada
 * capturado (nadie lo fechó). Contra la base real lo prueba la prueba local; acá van las reglas.
 */
const CONTROLLER = readFileSync(join(__dirname, 'receiving-session.controller.ts'), 'utf8');

const lote = (p: Partial<AndenLlegadaLote> = {}): AndenLlegadaLote => ({
  lote: 'L1', caducidad: '2027-03-31', cantidad: 10, semaforo: 'green', estatus: 'accepted', ...p,
});

describe('[WMS-REC.22] el lote', () => {
  it('sin caducidad queda en null y sin lote queda NA, como lo guarda el alta de inventario', () => {
    const l = aLote({ quantity: '4.000', confirmed_lot: null, confirmed_expiry: null, verdict: 'green', status: 'accepted' });
    expect(l).toEqual({ lote: 'NA', caducidad: null, cantidad: 4, semaforo: 'green', estatus: 'accepted' });
  });

  it('la caducidad llega como texto YYYY-MM-DD, sin hora', () => {
    expect(aLote({ quantity: 1, confirmed_lot: 'A', confirmed_expiry: '2027-01-31', verdict: 'yellow', status: 'accepted' }).caducidad)
      .toBe('2027-01-31');
  });
});

describe('[WMS-REC.22] el renglón', () => {
  it('lo que el vale todavía espera es «falta» aunque ya traiga un lote', () => {
    expect(estadoRenglon(true, [lote()])).toBe('falta');
  });

  it('con un lote con fecha es «fechado»', () => {
    expect(estadoRenglon(false, [lote()])).toBe('fechado');
  });

  it('con todos sus lotes sin fecha es «sin caducidad», no «no llegó»', () => {
    expect(estadoRenglon(false, [lote({ caducidad: null, lote: 'NA' })])).toBe('sin_caducidad');
  });

  it('un lote con fecha y otro sin ella cuenta como fechado', () => {
    expect(estadoRenglon(false, [lote({ caducidad: null }), lote()])).toBe('fechado');
  });

  it('cerrado sin lotes es «no llegó»', () => {
    expect(estadoRenglon(false, [])).toBe('no_llego');
  });

  it('lo rechazado no cuenta como recibido', () => {
    expect(estadoRenglon(false, [lote({ estatus: 'rejected' })])).toBe('no_llego');
  });
});

describe('[WMS-REC.22] el camión', () => {
  const r = (estado: 'falta' | 'fechado' | 'sin_caducidad') => ({ estado });

  it('con vale y algo por fechar está a medias', () => {
    expect(estadoLlegada({ tipo: 'compra', vale: { status: 'open' }, recibidoKepler: null, renglones: [r('fechado'), r('falta')] }))
      .toBe('a_medias');
  });

  it('con vale y nada por fechar está completo, aunque el vale siga abierto', () => {
    expect(estadoLlegada({ tipo: 'compra', vale: { status: 'open' }, recibidoKepler: null, renglones: [r('fechado'), r('sin_caducidad')] }))
      .toBe('completa');
  });

  it('un vale manual sin renglones está a medias hasta que se cierra', () => {
    expect(estadoLlegada({ tipo: 'manual', vale: { status: 'open' }, recibidoKepler: null, renglones: [] })).toBe('a_medias');
    expect(estadoLlegada({ tipo: 'manual', vale: { status: 'closed' }, recibidoKepler: null, renglones: [] })).toBe('completa');
  });

  it('una orden de entrada sin vale está sin abrir: Kepler ya le dio entrada', () => {
    expect(estadoLlegada({ tipo: 'compra', vale: null, recibidoKepler: null, renglones: [] })).toBe('sin_abrir');
  });

  it('un traspaso que Kepler no recibe y sin vale va en camino', () => {
    expect(estadoLlegada({ tipo: 'traspaso', vale: null, recibidoKepler: null, renglones: [] })).toBe('en_camino');
  });

  it('un traspaso que Kepler ya recibió y nadie abrió está sin abrir', () => {
    expect(estadoLlegada({ tipo: 'traspaso', vale: null, recibidoKepler: '2026-10-09', renglones: [] })).toBe('sin_abrir');
  });

  it('un traspaso con vale lo decide el vale, aunque Kepler todavía no lo reciba', () => {
    expect(estadoLlegada({ tipo: 'traspaso', vale: { status: 'open' }, recibidoKepler: null, renglones: [r('fechado')] }))
      .toBe('completa');
  });
});

describe('[WMS-REC.22] los renglones', () => {
  it('del vale: lo que falta va primero, con la unidad que manda Kepler', () => {
    const filas = [
      { id: 'a', sku: '70056', nombre: 'MAZAPAN', expected_qty: '20.000', pendiente: false },
      { id: 'b', sku: '70011', nombre: 'BOMBON', expected_qty: '24', pendiente: true },
    ];
    const lotes = new Map([['a', [lote()]]]);
    const out = renglonesDeVale(filas, lotes, new Map([['70056', 'PAQ'], ['70011', 'PAQ']]));
    expect(out.map((x) => [x.sku, x.estado, x.cantidad, x.unidad])).toEqual([
      ['70011', 'falta', 24, 'PAQ'],
      ['70056', 'fechado', 20, 'PAQ'],
    ]);
  });

  it('del vale: un producto que no venía en el documento toma lo que se declaró', () => {
    const out = renglonesDeVale(
      [{ id: 'x', sku: '1', nombre: 'SUELTO', expected_qty: 0, pendiente: false }],
      new Map([['x', [lote({ cantidad: 3 }), lote({ cantidad: 2 }), lote({ cantidad: 9, estatus: 'rejected' })]]]),
      new Map(),
    );
    expect(out[0].cantidad).toBe(5);
    expect(out[0].unidad).toBeNull();
  });

  it('de Kepler: todos sin vale, con el nombre del catálogo si lo hay', () => {
    const e: AndenLineaOffline[] = [
      { expected_sku: '9', expected_name: 'KEPLER', expected_qty: 3, expected_unit: 'PZA', product_id: 'p', sku: '9', product_name: 'CATALOGO' },
      { expected_sku: 'X', expected_name: 'SIN CATALOGO', expected_qty: 1, expected_unit: null, product_id: null, sku: null, product_name: null },
    ];
    expect(renglonesDeKepler(e).map((x) => [x.sku, x.nombre, x.estado])).toEqual([
      ['9', 'CATALOGO', 'sin_vale'],
      ['X', 'SIN CATALOGO', 'sin_vale'],
    ]);
  });

  it('la unidad se busca por el SKU del catálogo y por el de Kepler', () => {
    const u = unidadesPorSku([
      { expected_sku: 'K1', expected_name: null, expected_qty: 1, expected_unit: 'CJA', product_id: 'p', sku: 'C1', product_name: null },
    ]);
    expect(u.get('C1')).toBe('CJA');
    expect(u.get('K1')).toBe('CJA');
  });
});

describe('[WMS-REC.22] el resumen', () => {
  it('cuenta listos, faltan, sin caducidad y el semáforo de los lotes con fecha', () => {
    const r = resumir([
      { sku: '1', nombre: null, cantidad: 1, unidad: null, estado: 'fechado', lotes: [lote(), lote({ semaforo: 'yellow' })] },
      { sku: '2', nombre: null, cantidad: 1, unidad: null, estado: 'fechado', lotes: [lote({ semaforo: 'red', estatus: 'pending_authorization' })] },
      { sku: '3', nombre: null, cantidad: 1, unidad: null, estado: 'sin_caducidad', lotes: [lote({ caducidad: null })] },
      { sku: '4', nombre: null, cantidad: 1, unidad: null, estado: 'falta', lotes: [] },
      { sku: '5', nombre: null, cantidad: 1, unidad: null, estado: 'no_llego', lotes: [lote({ estatus: 'rejected', semaforo: 'red' })] },
    ]);
    expect(r).toEqual({
      renglones: 5, listos: 4, faltan: 1, sin_caducidad: 1,
      verdes: 1, amarillos: 1, rojos: 1, por_autorizar: 1,
    });
  });

  it('PRUEBA NEGATIVA: un lote sin caducidad no se cuenta como verde aunque el motor lo califique así', () => {
    // El motor de reglas califica de verde una captura sin fecha (no hay vida que medir). Si el
    // resumen la sumara a los verdes, un camión de puro "sin caducidad" se vería impecable.
    const r = resumir([{ sku: '1', nombre: null, cantidad: 1, unidad: null, estado: 'sin_caducidad', lotes: [lote({ caducidad: null })] }]);
    expect(r.verdes).toBe(0);
    expect(r.sin_caducidad).toBe(1);
  });

  it('un camión sin vale no tiene ningún renglón listo', () => {
    const r = resumir(renglonesDeKepler([
      { expected_sku: '1', expected_name: null, expected_qty: 1, expected_unit: null, product_id: null, sku: null, product_name: null },
    ]));
    expect(r.listos).toBe(0);
    expect(r.faltan).toBe(1);
  });
});

describe('[WMS-REC.22] armar la llegada', () => {
  it('le pone el estado y el resumen a lo que juntó el servicio', () => {
    const x = armarLlegada({
      clave: '01/1', tipo: 'compra', dia: '2026-10-09',
      warehouse_id: 'w', warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
      documento: '01/1', proveedor: 'P', origen_code: null, origen_nombre: null, salio: null, recibido_kepler: null,
      importe: 10, vale: null,
      renglones: renglonesDeKepler([
        { expected_sku: '1', expected_name: 'A', expected_qty: 2, expected_unit: 'PAQ', product_id: null, sku: null, product_name: null },
      ]),
    });
    expect(x.estado).toBe('sin_abrir');
    expect(x.resumen.faltan).toBe(1);
  });
});

describe('[WMS-REC.22] la ruta', () => {
  it('pide su propio permiso y va antes de :id (si no, Nest la toma como un id)', () => {
    const i = CONTROLLER.indexOf("@Get('arrivals')");
    expect(i).toBeGreaterThan(-1);
    // Se busca el DECORADOR al inicio de línea: los comentarios también nombran `@Get(':id')`.
    const id = CONTROLLER.search(/\n {2}@Get\(':id'\)/);
    expect(id).toBeGreaterThan(-1);
    expect(i).toBeLessThan(id);
    expect(CONTROLLER.slice(i, i + 200)).toContain('Permission.ALMACEN_LLEGADAS_VER');
  });
});
