import {
  CRITERIO_FLUJO,
  DatosPlaza,
  armarTransito,
  juzgarPlaza,
  motivoTransito,
  periodos,
  resumirProducto,
  type TransitoFila,
} from './product-flow';
import * as SQL from './product-flow.sql';
import { EXISTENCIA_KEPLER_SQL } from './new-products.sql';
import { escaleraDeFicha } from './new-products';
import { ProductFlowService } from './product-flow.service';

/**
 * `[PF.13]` Lo que ya viene en órdenes de compra · `[PF.15]` lo que sale por camioneta · `[PF.UI.1/3/5]`.
 * Observaciones de diseño del plan (2026-10-26) resueltas en el motor, donde la pantalla ya pinta los motivos.
 */
const HOY = '2026-11-03';
const P = periodos(HOY);
const ESC = escaleraDeFicha({ u1: 'PZA', u3: 'CJA', f3: '12', uxc: '12' });
const NOMBRES = new Map([['00', 'CEDIS'], ['01', 'Padre Hidalgo'], ['06', 'Canindo']]);

/** Una sucursal que vende `diaria` piezas a $10 cada día. */
const plaza = (codigo: string, diaria: number, existencia: number | null, over: Partial<DatosPlaza> = {}) => juzgarPlaza(P, {
  plaza: codigo, nombre: NOMBRES.get(codigo) ?? null,
  mes: diaria * 10 * P.dias, mes_anterior_mismo: diaria * 10 * P.dias, mes_anterior_total: diaria * 10 * 30,
  monto30: diaria * 10 * 30, unidades30: diaria * 30, ultima: diaria > 0 ? HOY : null,
  existencia, duda: null, escalera: ESC, costo: null, ...over,
});
const oc = (plazaCode: string, folio: string, dias: number, unidad: string, q: number): TransitoFila => ({ plaza: plazaCode, folio, dias, unidad, q });

describe('[PF.13] armarTransito — lo que ya viene, en la unidad de la ficha', () => {
  it('⭐ junta las órdenes, pasa cada renglón a la base con la escalera y lo escribe en cajas y piezas', () => {
    const t = armarTransito([oc('00', 'A-1', 3, 'PZA', 24), oc('00', 'A-1', 3, 'CJA', 2), oc('01', 'B-9', 70, 'PZA', 6)], ESC, NOMBRES);
    expect(t.ordenes).toBe(2);
    expect(t.ordenes_recientes).toBe(1);
    expect(t.unidades).toBe(24 + 24 + 6);
    expect(t.unidades_recientes).toBe(48);
    expect(t.texto).toBe('4 CJA 6 PZA');
    expect(t.dias_mas_vieja).toBe(70);
    expect(t.folios.map((f) => f.folio)).toEqual(['A-1', 'B-9']);
    expect(t.plazas).toEqual([{ plaza: '00', nombre: 'CEDIS', ordenes: 1 }, { plaza: '01', nombre: 'Padre Hidalgo', ordenes: 1 }]);
  });

  it('⛔ un rótulo que no está en la escalera NO se suma con un factor inventado: unidades NULL y el texto lo dice tal cual', () => {
    const t = armarTransito([oc('00', 'A-1', 3, 'PZA', 24), oc('00', 'A-1', 3, 'BTO', 1)], ESC, NOMBRES);
    expect(t.unidades).toBeNull();
    expect(t.texto).toBe('24 PZA + 1 BTO');
  });

  it('sin escalera sólo suma si todo viene en una sola unidad', () => {
    expect(armarTransito([oc('00', 'A', 1, 'PZA', 5), oc('00', 'B', 2, 'PZA', 7)], null, NOMBRES).unidades).toBe(12);
    expect(armarTransito([oc('00', 'A', 1, 'PZA', 5), oc('00', 'B', 2, 'KG', 7)], null, NOMBRES).unidades).toBeNull();
  });

  it('sin órdenes: cero órdenes, sin texto', () => {
    const t = armarTransito([], ESC, NOMBRES);
    expect(t).toMatchObject({ ordenes: 0, unidades: 0, texto: null, dias_mas_vieja: null });
  });
});

describe('[PF.UI.1] el veredicto dice lo que ya viene, y NO lo resta (misma política que el Pedido)', () => {
  const plazas = [plaza('01', 10, 50)]; // 5 días de cobertura → comprar
  const transito = armarTransito([oc('00', 'A-1', 3, 'CJA', 10), oc('01', 'B-9', 80, 'PZA', 60)], ESC, NOMBRES);

  it('⭐ dice cuánto viene, en cuántas órdenes, qué tan viejas y para cuántos días alcanzaría', () => {
    const c = resumirProducto('p', P, plazas, { transito }).compra;
    expect(c.veredicto).toBe('comprar');
    const m = c.motivos.find((x) => x.startsWith('Ya vienen'));
    expect(m).toBe('Ya vienen 15 CJA en 2 órdenes de compra abiertas de Kepler; 1 de 14 días o menos, la más vieja de hace 80 días: '
      + 'con eso alcanzaría para 23 días. Este veredicto no las resta, igual que el Pedido: muchas órdenes no se surten');
    expect(c.transito).toBe(transito);
  });

  it('[negativa] el tránsito NO cambia el veredicto ni la cobertura (no se resta)', () => {
    const sin = resumirProducto('p', P, plazas).compra;
    const con = resumirProducto('p', P, plazas, { transito }).compra;
    expect(con.veredicto).toBe(sin.veredicto);
    expect(con.cobertura_dias).toBe(sin.cobertura_dias);
    expect(con.titulo).toBe(sin.titulo);
  });

  it('⛔ si no se pudo leer (NULL) lo DECLARA; si no se buscó (la lista) no dice nada', () => {
    const nulo = resumirProducto('p', P, plazas, { transito: null }).compra;
    expect(nulo.motivos).toContain('No se pudo leer lo que ya viene en órdenes de compra de Kepler: revísalo en OC abiertas antes de pedir');
    const lista = resumirProducto('p', P, plazas).compra;
    expect(lista.motivos.some((x) => /órdenes de compra/.test(x))).toBe(false);
    expect('transito' in lista).toBe(false);
  });

  it('sin órdenes abiertas lo dice (no es lo mismo que «no se pudo leer»)', () => {
    const c = resumirProducto('p', P, plazas, { transito: armarTransito([], ESC, NOMBRES) }).compra;
    expect(c.motivos).toContain('No hay órdenes de compra abiertas en Kepler para este producto');
  });

  it('sólo donde decide algo: en «le sobra» no se habla de lo que viene', () => {
    const c = resumirProducto('p', P, [plaza('01', 1, 500)], { transito }).compra;
    expect(c.veredicto).toBe('sobra');
    expect(c.motivos.some((x) => x.startsWith('Ya vienen'))).toBe(false);
  });

  it('⭐ el umbral dice que es propuesta sin calibrar, en comprar y esperar; no en sobra', () => {
    expect(resumirProducto('p', P, plazas).compra.motivos.at(-1))
      .toBe(`Criterio: comprar con menos de ${CRITERIO_FLUJO.coberturaComprar} días de inventario. Es una propuesta todavía sin calibrar con Compras`);
    const esperar = resumirProducto('p', P, [plaza('01', 10, 300)]).compra;
    expect(esperar.veredicto).toBe('esperar');
    expect(esperar.motivos.at(-1)).toMatch(/propuesta todavía sin calibrar/);
    expect(resumirProducto('p', P, [plaza('01', 1, 500)]).compra.motivos.join(' ')).not.toMatch(/sin calibrar/);
  });

  it('motivoTransito: sin ritmo no inventa días', () => {
    expect(motivoTransito(transito, { existencia: 0, unidadesDia: 0 })).not.toMatch(/alcanzaría/);
  });
});

describe('[PF.15] lo que sale por camioneta no es «estancado» ni «no se vende» (PF.UI.2)', () => {
  const sinVenta = { mes: 0, mes_anterior_mismo: 0, mes_anterior_total: 0, monto30: 0, unidades30: 0, ultima: '2026-09-01' };

  it('⭐ con existencia, sin venta de mostrador y una carga a camioneta hace 3 días: se mueve, y dice por qué', () => {
    const x = plaza('06', 0, 200, { ...sinVenta, ruta: { q: 120, ultima: '2026-10-31' } });
    expect(x.estado).toBe('se_mueve');
    expect(x.motivo).toBe('Sale por camioneta (última carga: 31 de octubre); lo que vende la camioneta no está en Kepler');
    expect(x.por_camioneta).toEqual({ q: 120, ultima: '2026-10-31' });
  });

  it('[negativa] sin carga, o con la última carga más vieja que los días del estancado, sigue siendo estancado', () => {
    expect(plaza('06', 0, 200, sinVenta).estado).toBe('estancado');
    const vieja = plaza('06', 0, 200, { ...sinVenta, ruta: { q: 120, ultima: '2026-10-10' } });
    expect(vieja.estado).toBe('estancado');
    expect('por_camioneta' in vieja).toBe(false);
  });

  it('⭐ un producto que sólo sale por camioneta no es «No comprar: no se vende»: espera y lo dice', () => {
    const r = resumirProducto('p', P, [plaza('06', 0, 200, { ...sinVenta, ruta: { q: 120, ultima: '2026-10-31' } })]);
    expect(r.compra.veredicto).toBe('esperar');
    expect(r.compra.titulo).toBe('Sale por camioneta: su venta no está en Kepler');
    expect(r.compra.motivos).toContain('Sale por camioneta desde Canindo: lo que vende la camioneta no está en Kepler y no cuenta en el ritmo de venta');
    expect(r.estancadas).toEqual([]);
    // [negativa] el mismo producto sin la carga: no se vende.
    expect(resumirProducto('p', P, [plaza('06', 0, 200, sinVenta)]).compra.veredicto).toBe('no_comprar');
  });

  it('⛔ la sucursal sin nombre en la base se NOMBRA con el resolvedor común, no «Sucursal 06»', () => {
    const r = resumirProducto('p', P, [plaza('01', 10, 500), juzgarPlaza(P, {
      plaza: '06', nombre: null, mes: 300, mes_anterior_mismo: 300, mes_anterior_total: 900, monto30: 900, unidades30: 90,
      ultima: HOY, existencia: 0, duda: null, escalera: ESC, costo: null,
    })]);
    expect(r.compra.motivos.join(' ')).toContain('Agotado en Canindo');
    expect(r.compra.motivos.join(' ')).not.toMatch(/Sucursal 06/);
  });
});

// ───────────────────────── el servicio, con las consultas reales enrutadas ─────────────────────────

type Ruteo = Map<string, (binds: unknown[]) => unknown[] | Promise<unknown[]>>;

function montar(rutas: Ruteo) {
  const sqls: string[] = [];
  const trx = {
    raw: vi.fn(async (sql: string, binds: unknown[] = []) => {
      sqls.push(sql);
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql.trim())) return { rows: [] };
      for (const [k, f] of rutas) if (sql === k || sql.includes(k)) return { rows: await f(binds) };
      return { rows: [] };
    }),
  };
  const tk = { run: vi.fn(async (a: unknown, b?: unknown) => (typeof a === 'function' ? (a as (t: unknown) => unknown)(trx) : (b as (t: unknown) => unknown)(trx))) };
  const tenantCtx = { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' };
  const svc = new ProductFlowService(tk as never, tenantCtx as never, {} as never);
  return { svc, sqls, trx };
}

const dia = (k: number) => new Date(Date.parse(`${HOY}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);

function rutasDetalle(transito: (b: unknown[]) => unknown[] | Promise<unknown[]>): Ruteo {
  return new Map<string, (b: unknown[]) => unknown[] | Promise<unknown[]>>([
    [SQL.CORTE_SQL, () => [{ hoy: HOY, corte: HOY }]],
    ['nombre FROM catalog.products', () => [{ id: '11111111-1111-1111-1111-111111111111', sku: '70001', nombre: 'MAZAPAN' }]],
    // 10 piezas ($100) diarias en Padre Hidalgo; caen 29 en la ventana del ritmo (290 / 30 = 9.67 al día); 50 en
    // existencia → 5 días: comprar. Con 120 en camino: (50 + 120) / 9.67 = 17.6 → 18 días.
    [SQL.HISTORIA_DIARIA_SQL, () => Array.from({ length: 30 }, (_, i) => ({ plaza: '01', fecha: dia(-30 + i), monto: '100', unidades: '10' }))],
    [EXISTENCIA_KEPLER_SQL, () => [{ product_id: '11111111-1111-1111-1111-111111111111', plaza: '01', sucursal: '01', cantidad: '50' }]],
    ['FROM commercial.warehouses', () => [{ plaza: '00', name: 'CEDIS' }, { plaza: '01', name: 'Padre Hidalgo' }]],
    [SQL.TRANSITO_SQL, transito],
  ]);
}

describe('[PF.13] el detalle lee lo que ya viene (lectura opcional en SAVEPOINT)', () => {
  const ID = '11111111-1111-1111-1111-111111111111';

  it('⭐ con órdenes abiertas, el veredicto las nombra y viajan en la respuesta', async () => {
    const { svc } = montar(rutasDetalle(() => [{ plaza: '00', folio: '0007265', dias: 3, unidad: 'PZA', q: '120' }]));
    const d = await svc.detail(ID, { puedeVerCosto: false });
    expect(d.resumen.compra.veredicto).toBe('comprar');
    expect(d.resumen.compra.transito).toMatchObject({ ordenes: 1, unidades: 120, texto: '120 PZA' });
    expect(d.resumen.compra.motivos.join(' ')).toContain('Ya vienen 120 PZA en 1 orden de compra abierta de Kepler, todas de 14 días o menos: con eso alcanzaría para 18 días');
  });

  it('[negativa] si la lectura truena, NO tumba el detalle: revierte al SAVEPOINT y lo declara', async () => {
    const { svc, sqls } = montar(rutasDetalle(() => { throw new Error('relation "analytics.erp_purchase_orders" does not exist'); }));
    const d = await svc.detail(ID, { puedeVerCosto: false });
    expect(sqls).toContain('ROLLBACK TO SAVEPOINT pf_transito');
    expect(d.resumen.compra.veredicto).toBe('comprar');
    expect(d.resumen.compra.transito).toBeNull();
    expect(d.resumen.compra.motivos).toContain('No se pudo leer lo que ya viene en órdenes de compra de Kepler: revísalo en OC abiertas antes de pedir');
  });
});

describe('[PF.UI.3]/[PF.15] «No se venden»: el total dice si es un mínimo y no cuenta lo que sale por camioneta', () => {
  const fila = (i: number) => ({
    product_id: `p-${i}`, sku: `S${i}`, nombre: `PRODUCTO ${i}`, existencia: 10, valor: 100 - i / 100, sin_costo: false,
    plazas: ['06'], ultima: null, dias: null,
  });
  it('⭐ el que su sucursal cargó a camioneta sale de la lista, de su total y de su dinero, y se cuenta aparte', async () => {
    const { svc, trx } = montar(new Map<string, (b: unknown[]) => unknown[]>([
      [SQL.NUEVOS_POBLADA_SQL, () => [{ poblada: true }]],
      [SQL.NO_SE_VENDEN_SQL, () => [fila(1), fila(2)]],
      [SQL.SALIDAS_RUTA_SQL, () => [{ sku: 'S2', plaza: '06', q: '24', ultima: dia(-5) }]],
    ]));
    const r = (await (svc as unknown as { noSeVenden: (...a: unknown[]) => Promise<Map<boolean, Record<string, unknown>>> })
      .noSeVenden(trx, P, HOY, [true], new Map())).get(true)!;
    expect(r['total']).toBe(1);
    expect(r['por_camioneta']).toBe(1);
    expect(r['valor_total']).toBe(99.99);
    expect((r['productos'] as Array<{ sku: string }>).map((x) => x.sku)).toEqual(['S1']);
    expect(r['total_es_minimo']).toBe(false);
  });

  it('[negativa] si las cargas no se pudieron leer, no saca nada (como antes) y no inventa un conteo', async () => {
    const { svc, trx } = montar(new Map<string, (b: unknown[]) => unknown[]>([
      [SQL.NUEVOS_POBLADA_SQL, () => [{ poblada: true }]],
      [SQL.NO_SE_VENDEN_SQL, () => [fila(1), fila(2)]],
      [SQL.SALIDAS_RUTA_SQL, () => { throw new Error('boom'); }],
    ]));
    const r = (await (svc as unknown as { noSeVenden: (...a: unknown[]) => Promise<Map<boolean, Record<string, unknown>>> })
      .noSeVenden(trx, P, HOY, [true], new Map())).get(true)!;
    expect(r['total']).toBe(2);
    expect(r['por_camioneta']).toBe(0);
  });

  it('⛔ si la consulta llegó a su tope, el total es un MÍNIMO y lo dice', async () => {
    const tope = CRITERIO_FLUJO.limiteNoSeVenden * 4;
    const { svc, trx } = montar(new Map<string, (b: unknown[]) => unknown[]>([
      [SQL.NUEVOS_POBLADA_SQL, () => [{ poblada: true }]],
      [SQL.NO_SE_VENDEN_SQL, () => Array.from({ length: tope }, (_, i) => fila(i))],
    ]));
    const r = (await (svc as unknown as { noSeVenden: (...a: unknown[]) => Promise<Map<boolean, Record<string, unknown>>> })
      .noSeVenden(trx, P, HOY, [true], new Map())).get(true)!;
    expect(r['total']).toBe(tope);
    expect(r['total_es_minimo']).toBe(true);
  });
});
