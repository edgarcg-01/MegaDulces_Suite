import { readFileSync } from 'fs';
import { join } from 'path';
import knexFactory from 'knex';
import { APARTADO_VIVO_SQL, EXISTENCIA_ODS_CON_APARTADO_SQL, EXISTENCIA_ODS_SQL, existenciaOds } from './stock-state';

/**
 * `[CANON.7.2]` Los reportes leen la existencia del ODS, no la copia `commercial.stock` del importer
 * `import-branch-stock-live`. La copia traía el CEDIS congelado desde el 16-oct (205 filas contra el CEDIS
 * entero de Kepler) y `MD-32`, un almacén borrado; en las 8 sucursales era idéntica al renglón (medido el
 * 2026-11-19). Lo que este archivo existe para que no vuelva: que un lector de la lista regrese a la copia.
 */
const LIB = join(__dirname, '..');

/** Las líneas de CÓDIGO que leen la copia (no comentarios, no `commercial.stock_lots` ni otras tablas). */
export function lecturasDeLaCopia(texto: string): string[] {
  return texto.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, '').replace(/\s--\s.*$/, ''))
    .filter((l) => /commercial\.stock(?![_a-z])/.test(l));
}

/**
 * Los lectores clase A del anexo CANON.7 §3, por archivo, y cuántas lecturas de la copia les QUEDAN a
 * propósito. ⚠️ Un número distinto de 0 es deuda con nombre, no un permiso.
 *
 * A6 y A13 leen dentro de un endpoint que ESCRIBE (el conteo de Monitoreo y la bandeja del scanner): por la
 * regla 13 no cambian sin una prueba contra base real con el ODS sembrado, y la que existe
 * (`test-newdb-inventory-monitoring.js`) siembra la copia. Van con los escritores, en `[CANON.7.4]`.
 */
const LECTORES_A: Array<[archivo: string, quedan: number, porque: string]> = [
  ['commercial-analytics/commercial-analytics.service.ts', 0,
    'A1 deadStock · A2 lowStock · A3 sellOut · A4 salidas · B8 rankingOutOfStock ([CANON.7.3])'],
  ['commercial-intelligence/thot-chat/thot-tools.service.ts', 0, 'A5 reorderPolicy'],
  ['commercial-inventory/inventory-monitoring.service.ts', 1, 'A6 recordCount: escribe el conteo → [CANON.7.4]'],
  ['commercial-products/commercial-products.service.ts', 0, 'A7 findById (total de la red)'],
  ['commercial-profitability/commercial-profitability.service.ts', 0, 'A8 overview · A9 breakdown'],
  ['commercial-replenishment/commercial-replenishment.service.ts', 0, 'A10 networkSurplus · A11 criticalStock · A12 summary'],
  ['commercial-replenishment/replenishment-scanner.service.ts', 2, 'A13 scanTenant: escribe la bandeja → [CANON.7.4]'],
];

/**
 * `[CANON.7.3]` Los lectores clase B (deciden «hay / no hay» para el cliente, el bot, el vendedor o Reparto). Cambian
 * de FUENTE, no de regla: «sin fila» sigue leyéndose como 0, igual que con la copia. Decir «sin dato» en vez de
 * «agotado» (la regla de `estadoDeExistencia`) es otra decisión, por pantalla.
 */
const RAIZ = join(__dirname, '../../../../..');
const LECTORES_B: Array<[archivo: string, quedan: number, porque: string]> = [
  ['apps/api/src/composition/commerce-conversation.binding.module.ts', 0, 'B1 bot de WhatsApp (enrichMeta)'],
  ['libs/commercial/src/lib/commercial-catalog-search/commercial-catalog-search.service.ts', 0, 'B2 catálogo del portal · B3 facetas'],
  ['libs/commercial/src/lib/commercial-pricing/commercial-pricing.service.ts', 0, 'B4 lista de precios · B5 más vendidos'],
  ['libs/commercial/src/lib/commercial-orders/commercial-orders.service.ts', 0,
    'B6 detalle de pedido: lee lo mismo con lo que valida reserve() ([CANON.7.4b])'],
  ['libs/commercial/src/lib/commercial-picking/picking.service.ts', 0, 'B7 Reparto › Faltantes y sus sugerencias'],
  ['libs/commercial/src/lib/commercial-intelligence/thot-chat/portal-thot-tools.service.ts', 0, 'B9 · B10 Thot del portal'],
  ['libs/commercial/src/lib/commercial-intelligence/thot-chat/vendor-thot-tools.service.ts', 0, 'B11 Thot del vendedor'],
];

describe('[CANON.7.2] la existencia del ODS con la forma de la copia', () => {
  it('lee SÓLO la vista canónica y da las cinco columnas que leían de la copia', () => {
    expect(EXISTENCIA_ODS_SQL).toContain('FROM analytics.v_erp_stock_on_hand e');
    expect(EXISTENCIA_ODS_SQL).not.toMatch(/commercial\.stock(?![_a-z])/);
    for (const col of ['e.tenant_id', 'e.warehouse_id', 'e.product_id', 'e.qty_stock_units AS quantity']) {
      expect(EXISTENCIA_ODS_SQL).toContain(col);
    }
  });

  it('⚠️ los apartados son 0 y lo dice: la vista no los tiene (misma regla que leerExistencia)', () => {
    expect(EXISTENCIA_ODS_SQL).toContain('0::numeric AS reserved_quantity');
  });

  it('existenciaOds pone el alias y truena con uno que se pudiera inyectar (se interpola en SQL)', () => {
    const k = knexFactory({ client: 'pg' });
    expect(existenciaOds(k, 's').toString()).toBe(`${EXISTENCIA_ODS_SQL} AS s`);
    expect(k.from(existenciaOds(k, 'st')).where('st.product_id', 'x').toString())
      .toMatch(/^select \* from \(SELECT e\.tenant_id[\s\S]+\) AS st where "st"\."product_id" = 'x'$/);
    expect(() => existenciaOds(k, 's; DROP TABLE x')).toThrow(/alias inválido/);
    expect(() => existenciaOds(k, 'S')).toThrow(/alias inválido/);
  });
});

describe('[CANON.7.2] el detector de lecturas de la copia (control: tiene que ver las formas reales)', () => {
  it('ve las cuatro formas en que se leía la copia', () => {
    const viejo = [
      `const base = trx('commercial.stock as s')`,
      `        .leftJoin('commercial.stock as s', (j) =>`,
      `        .from({ st: 'commercial.stock' })`,
      `               FROM commercial.stock st`,
    ].join('\n');
    expect(lecturasDeLaCopia(viejo)).toHaveLength(4);
  });

  it('no cuenta comentarios, ni otras tablas del mismo prefijo', () => {
    const ok = [
      `   * Productos en el top del ERP pero con stock=0 en commercial.stock.`,
      `      // [RA.VA.2] commercial.stock ya NO se une acá`,
      `                -- [RA.VA.2] commercial.stock ya NO se une acá: la existencia sale de rpl.`,
      `      const lot = await trx('commercial.stock_lots').where({ id })`,
      `      const x = trx.from(existenciaOds(trx, 's')) // antes: commercial.stock`,
    ].join('\n');
    expect(lecturasDeLaCopia(ok)).toEqual([]);
  });
});

describe('[CANON.7.2] los lectores clase A ya no leen la copia', () => {
  it.each(LECTORES_A)('%s', (archivo, quedan, porque) => {
    const lecturas = lecturasDeLaCopia(readFileSync(join(LIB, archivo), 'utf8'));
    expect(lecturas.map((l) => l.trim()), porque).toHaveLength(quedan);
  });
});

describe('[CANON.7.3] los lectores clase B ya no leen la copia', () => {
  it.each(LECTORES_B)('%s', (archivo, quedan, porque) => {
    const lecturas = lecturasDeLaCopia(readFileSync(join(RAIZ, archivo), 'utf8'));
    expect(lecturas.map((l) => l.trim()), porque).toHaveLength(quedan);
  });

  it('«sin fila» se sigue leyendo como antes: la tabla derivada no tiene `id`, se pregunta por `product_id`', () => {
    for (const archivo of ['libs/commercial/src/lib/commercial-catalog-search/commercial-catalog-search.service.ts',
      'libs/commercial/src/lib/commercial-pricing/commercial-pricing.service.ts']) {
      const f = readFileSync(join(RAIZ, archivo), 'utf8');
      expect(f).not.toMatch(/\bs\.id IS (NOT )?NULL/);
      expect(f).toContain('CASE WHEN s.product_id IS NULL THEN NULL');
    }
  });
});

describe('[CANON.7.4a] la portada de Almacén: la existencia del ODS + el apartado de la app', () => {
  it('la cantidad sale del ODS y el apartado, que es dato propio, del libro de movimientos ([CANON.7.4b]): nada de la copia', () => {
    expect(EXISTENCIA_ODS_CON_APARTADO_SQL).toContain(`FROM ${EXISTENCIA_ODS_SQL} o`);
    expect(EXISTENCIA_ODS_CON_APARTADO_SQL).toContain('o.quantity');
    expect(EXISTENCIA_ODS_CON_APARTADO_SQL).toContain('COALESCE(ap.reserved_quantity, 0)');
    expect(EXISTENCIA_ODS_CON_APARTADO_SQL).toContain(`LEFT JOIN ${APARTADO_VIVO_SQL} ap`);
    expect(EXISTENCIA_ODS_CON_APARTADO_SQL).not.toMatch(/ap\.quantity/);
    expect(lecturasDeLaCopia(EXISTENCIA_ODS_CON_APARTADO_SQL)).toEqual([]);
  });

  it('listStock la usa y ya no lee la cantidad de la copia', () => {
    const f = readFileSync(join(LIB, 'commercial-inventory/commercial-inventory.service.ts'), 'utf8').split('\r\n').join('\n');
    const i = f.indexOf('async listStock(');
    const cuerpo = f.slice(i, f.indexOf('\n  async ', i + 10));
    expect(cuerpo).toContain('EXISTENCIA_ODS_CON_APARTADO_SQL');
    expect(lecturasDeLaCopia(cuerpo)).toEqual([]);
  });

  it('D-EX3: la portada ya no ajusta (0 llamadas en 60 días; el ajuste es de Kepler) y no se llama «Ajustes»', () => {
    const c = readFileSync(join(RAIZ, 'apps/view/src/app/modules/comercial/pages/comercial-inventory.component.ts'), 'utf8');
    expect(c).not.toMatch(/adjustStock|openAdjust|<p-dialog/);
    expect(c).toContain('<h1>Existencia y apartados</h1>');
  });

  // Probado en local el 2026-11-19: las tarjetas sumaban en el navegador `listStock(pageSize: 9999)`, que el servidor
  // topa a 500, y en la red decían 500 líneas, $475,940 y «1 almacén» contra 33,530, $70.4 M y 9.
  it('el resumen lo agrega el servidor sobre TODA la selección, del mismo universo que el listado', () => {
    const f = readFileSync(join(LIB, 'commercial-inventory/commercial-inventory.service.ts'), 'utf8').split('\r\n').join('\n');
    const i = f.indexOf('async stockSummary(');
    expect(i).toBeGreaterThan(0);
    const cuerpo = f.slice(i, f.indexOf('\n  async ', i + 10));
    expect(cuerpo).toContain('EXISTENCIA_ODS_CON_APARTADO_SQL');
    expect(cuerpo).toContain('analytics.v_erp_unit_cost'); // el mismo costo arbitrado que valúa cada renglón
    expect(cuerpo).toMatch(/groupBy\('s\.warehouse_id'/);
    expect(cuerpo).toContain('without_cost'); // sin costo se CUENTA, no se suma como cero
    expect(cuerpo).not.toMatch(/\.limit\(/); // un tope aquí volvería a resumir sólo una parte
    expect(lecturasDeLaCopia(cuerpo)).toEqual([]);
  });

  it('la ruta del resumen pide el mismo permiso que el listado y va antes de la ruta con parámetros', () => {
    const ctl = readFileSync(join(LIB, 'commercial-inventory/commercial-inventory.controller.ts'), 'utf8').split('\r\n').join('\n');
    const r = ctl.indexOf("@Get('stock/summary')");
    expect(r).toBeGreaterThan(0);
    expect(ctl.slice(r, r + 120)).toContain('Permission.COMMERCIAL_INVENTORY_VER');
    expect(r).toBeLessThan(ctl.indexOf("@Get('stock/:warehouse_id/:product_id')"));
  });

  it('la pantalla pinta el resumen del servidor (no suma una página) y las cantidades con un solo formato', () => {
    const c = readFileSync(join(RAIZ, 'apps/view/src/app/modules/comercial/pages/comercial-inventory.component.ts'), 'utf8');
    expect(c).not.toMatch(/listStock\(\{[^}]*pageSize:\s*9999/);
    expect(c).toContain('this.api.stockSummary(');
    for (const campo of ['s.on_hand', 's.reserved', 's.available']) expect(c).toContain(`{{ ${campo} | number:'1.0-3' }}`);
  });

  // check-dense-tables acepta la PALABRA dt-stack en cualquier parte (un comentario basta); esto exige la clase de verdad.
  it('en el teléfono cada renglón se apila: clase real (no styleClass, muerto en PrimeNG 22), rótulo por celda y la barra en ::after', () => {
    const c = readFileSync(join(RAIZ, 'apps/view/src/app/modules/comercial/pages/comercial-inventory.component.ts'), 'utf8').split('\r\n').join('\n');
    const tabla = c.slice(c.indexOf('<p-table'), c.indexOf('</p-table>'));
    expect(tabla).toMatch(/\n\s+class="dt-stack"\n/);
    expect(c).toMatch(/class="cell cell-span-12 is-flush dt-scope"/);
    const celdas = tabla.slice(tabla.indexOf('#body'), tabla.indexOf('#emptymessage')).match(/<td\b[^>]*>/g) ?? [];
    expect(celdas.length).toBe(9);
    for (const td of celdas) {
      expect(td).toContain('role="cell"');
      if (!td.includes('dt-id')) expect(td).toMatch(/data-label="[^"]+"/);
    }
    expect(c).toMatch(/tr\.in-row-low td:first-child::after/);
    expect(c).not.toMatch(/tr\.in-row-(low|zero) td:first-child::before/);
  });
});

/**
 * `[CANON.7.4b]` Los pedidos apartan, entregan y liberan sin tocar la copia. La copia exige
 * `quantity >= reserved_quantity`: apartar contra el ODS con la copia rezagada (el CEDIS desde el 16-oct; toda la red
 * en `[CANON.7.5]`) la rompería u obligaría a escribir la cantidad en la copia. El apartado se DERIVA del libro de
 * movimientos; medido en prod el 2026-11-20, da lo mismo que la columna (un apartado vivo, 15 piezas).
 */
describe('[CANON.7.4b] los pedidos: existencia del ODS, apartado del libro de movimientos', () => {
  const leer = (rel: string) => readFileSync(join(LIB, rel), 'utf8').split('\r\n').join('\n');
  const cuerpoDe = (f: string, firma: string) => {
    const i = f.indexOf(firma);
    expect(i, firma).toBeGreaterThan(0);
    const fin = f.indexOf('\n  async ', i + 10);
    return f.slice(i, fin > 0 ? fin : undefined);
  };

  it('el apartado vivo sale SÓLO del libro: apartado − liberado por referencia, sin bajar de cero, de pedidos y reservas vivos', () => {
    expect(lecturasDeLaCopia(APARTADO_VIVO_SQL)).toEqual([]);
    expect(APARTADO_VIVO_SQL).toContain('FROM commercial.stock_movements m');
    expect(APARTADO_VIVO_SQL).toContain(`m.movement_type IN ('reserve', 'release')`);
    expect(APARTADO_VIVO_SQL).toMatch(/GREATEST\(sum\(CASE WHEN m\.movement_type = 'reserve' THEN m\.quantity ELSE -m\.quantity END\), 0\)/);
    expect(APARTADO_VIVO_SQL).toMatch(/GROUP BY m\.tenant_id, m\.warehouse_id, m\.product_id, m\.reference_type, m\.reference_id/);
    expect(APARTADO_VIVO_SQL).toContain(`po.status NOT IN ('fulfilled', 'cancelled')`);
    expect(APARTADO_VIVO_SQL).toContain('pr.released_at IS NULL');
  });

  it('apartar, entregar y liberar no leen ni escriben la copia, ni el cron que vence las reservas del bot', () => {
    for (const rel of ['commercial-orders/order-stock.service.ts', 'commercial-stock-reservation/stock-reservation-cron.service.ts']) {
      expect(lecturasDeLaCopia(leer(rel)).map((l) => l.trim()), rel).toEqual([]);
    }
  });

  it('apartar valida existencia del ODS − apartado, con candado por (almacén, producto)', () => {
    const r = cuerpoDe(leer('commercial-orders/order-stock.service.ts'), 'async reserve(');
    expect(r).toContain('await bloquearExistencia(trx, warehouseId, productId)');
    expect(r).toContain('existenciaYApartado(trx, warehouseId, productId)');
    expect(r).toMatch(/if \(existencia - apartado < quantity\)/);
    expect(r).toContain(`tipo: 'reserve'`);
  });

  it('entregar valida contra el ODS y NO resta nada (la venta la descuenta Kepler)', () => {
    const c = cuerpoDe(leer('commercial-orders/order-stock.service.ts'), 'async consume(');
    expect(c).toContain('await bloquearExistencia(trx, warehouseId, productId)');
    expect(c).toMatch(/if \(existencia < quantity\)/);
    expect(c).not.toMatch(/\.update\(/);
    expect(c).not.toMatch(/stock_lot_movements/); // la traza por lote decía siempre NA (8 de 8 en 90 días)
    expect(c).toContain(`tipo: 'sale'`);
  });

  it('liberar topa en lo que ESA referencia apartó (antes: lo apartado en todo el almacén)', () => {
    const l = cuerpoDe(leer('commercial-orders/order-stock.service.ts'), 'async release(');
    expect(l).toContain('apartadoDeReferencia(trx, referenceType, orderId, warehouseId, productId)');
    expect(l).toContain('Math.min(propio, quantity)');
    const cron = leer('commercial-stock-reservation/stock-reservation-cron.service.ts');
    expect(cron).toContain(`apartadoDeReferencia(trx, 'reservation', r.id, l.warehouse_id, l.product_id)`);
  });

  it('sólo se aparta con referencia «order» o «reservation», las dos que el apartado vivo sabe cuándo mueren', () => {
    const llamadas = [
      ...leer('commercial-orders/commercial-orders.service.ts').matchAll(/this\.stock\.reserve\(([^;]*?)\);/g),
      ...leer('commercial-stock-reservation/stock-reservation.service.ts').matchAll(/this\.stock\.reserve\(([^;]*?)\);/g),
    ].map((m) => m[1].split(',').map((s) => s.trim()));
    expect(llamadas.length).toBe(5); // confirmar, tomar en campo, entregar ya, editar renglón; y la reserva del bot
    for (const args of llamadas) expect([5, 6]).toContain(args.length);
    for (const args of llamadas.filter((a) => a.length === 6)) expect(args[5]).toBe(`'reservation'`);
  });

  it('el detalle de pedido (B6) lee lo mismo con lo que valida reserve(), acotado con constantes a lo del pedido', () => {
    const f = readFileSync(join(RAIZ, 'libs/commercial/src/lib/commercial-orders/commercial-orders.service.ts'), 'utf8').split('\r\n').join('\n');
    expect(f).toContain('FROM ${EXISTENCIA_ODS_CON_APARTADO_SQL} x');
    expect(f).toContain('WHERE x.warehouse_id = ANY(?::uuid[]) AND x.product_id = ANY(?::uuid[])) AS s');
    expect(f).toContain('.leftJoin(existenciaDelPedido, function () {');
  });
});
