import { WAREHOUSE_ORDER_ABIERTOS, WAREHOUSE_ORDER_ABIERTOS_SQL, estatusVigenteSql } from '@megadulces/contracts';
import { VIENE_DOCS_SQL } from './autoabasto-pedido.service';
import { PEDIDOS_SUCURSAL_SQL, PEDIDOS_SUCURSAL_RED_SQL } from './ya-pedido-sucursal';

/**
 * `[PQ.136]` · `[PQ.137]` **Qué cuenta como pedido abierto, y de dónde sale el estatus.**
 *
 * Las dos reglas que cambiaron con ADR-127, en un solo lugar:
 *  · `CREADO` cuenta como abierto — el pedido que la Suite escribe nace así, y si no contara, la
 *    sucursal volvería a pedir al día siguiente lo que acaba de pedir.
 *  · El estatus se lee VIGENTE (`c43='C'` → `CANCELADO`), no por el `c11` que Kepler conserva al
 *    cancelar. *Medido el 2026-11-22: de 111 documentos que «Lo que te va a llegar» pintaba para
 *    Morelia Madero, 82 estaban cancelados.*
 *
 * Acá se prueba que las tres consultas usan LA MISMA pieza (ADR-056) y no una copia. El efecto
 * sobre datos reales lo mide `database/tests/test-newdb-pq137-cancelado-no-viene.js`.
 */
describe('[PQ.136] los estatus en que un pedido sigue abierto', () => {
  it('CREADO cuenta como abierto', () => {
    expect(WAREHOUSE_ORDER_ABIERTOS).toContain('CREADO');
  });

  it('CONTROL: EMBARCADO y CANCELADO NO son «abierto» (el embarque lo cuenta su propio documento)', () => {
    expect(WAREHOUSE_ORDER_ABIERTOS).not.toContain('EMBARCADO');
    expect(WAREHOUSE_ORDER_ABIERTOS as readonly string[]).not.toContain('CANCELADO');
  });

  it('la forma SQL se deriva de la lista: no se pueden desincronizar', () => {
    expect(WAREHOUSE_ORDER_ABIERTOS_SQL).toBe(`(${WAREHOUSE_ORDER_ABIERTOS.map((e) => `'${e}'`).join(',')})`);
    expect(WAREHOUSE_ORDER_ABIERTOS_SQL).toBe(`('CREADO','AUTORIZADO','SURTIDO','CHECADO')`);
  });
});

describe('[PQ.137] el estatus vigente, con el alias de cada consulta', () => {
  it('pisa el estatus de un cancelado, sea cual sea el c11 que Kepler le dejó', () => {
    expect(estatusVigenteSql('k')).toContain(`btrim(coalesce(k.c43::text, '')) = 'C'`);
    expect(estatusVigenteSql('k')).toContain(`THEN 'CANCELADO'`);
  });

  it('el alias viaja: la misma regla sirve para `h` (surtido) y para `k` (Autoabasto)', () => {
    expect(estatusVigenteSql('h')).toContain('h.c43');
    expect(estatusVigenteSql('h')).not.toContain('k.c43');
    expect(estatusVigenteSql()).toBe(estatusVigenteSql('h'));
  });
});

describe('las tres consultas de Autoabasto usan la pieza compartida, no una copia', () => {
  const consultas: ReadonlyArray<[string, string]> = [
    ['«Lo que te va a llegar» (VIENE_DOCS_SQL)', VIENE_DOCS_SQL],
    ['«ya pedido» por sucursal', PEDIDOS_SUCURSAL_SQL],
    ['«ya pedido» de toda la red', PEDIDOS_SUCURSAL_RED_SQL],
  ];

  it.each(consultas)('%s lee el estatus VIGENTE', (_nombre, sql) => {
    expect(sql).toContain(estatusVigenteSql('k'));
  });

  it.each(consultas)('%s filtra por la lista compartida de abiertos', (_nombre, sql) => {
    expect(sql).toContain(WAREHOUSE_ORDER_ABIERTOS_SQL);
  });

  /**
   * NEGATIVA: el defecto exacto que se corrigió. Si alguien vuelve a leer `c11` a secas o a
   * escribir la lista de estados a mano, estas dos fallan.
   */
  it.each(consultas)('⛔ %s ya no decide por el c11 crudo', (_nombre, sql) => {
    expect(sql).not.toMatch(/upper\(btrim\(k\.c11::text\)\)\s+AS\s+est/);
  });

  /**
   * ⚠️ La lista compartida ES `('CREADO','AUTORIZADO','SURTIDO','CHECADO')`, así que buscar
   * «'AUTORIZADO','SURTIDO'» encuentra la buena y la mala por igual (la primera versión de esta
   * prueba se equivocó justo ahí). Lo que no puede volver a aparecer es la lista VIEJA: la que
   * empieza en AUTORIZADO y deja fuera el estado con el que nace el pedido de la Suite.
   */
  it.each(consultas)('⛔ %s no trae la lista VIEJA (sin CREADO) escrita a mano', (_nombre, sql) => {
    expect(sql).not.toMatch(/\(\s*'AUTORIZADO'\s*,\s*'SURTIDO'\s*,\s*'CHECADO'\s*\)/);
  });
});
