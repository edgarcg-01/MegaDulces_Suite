/**
 * ⭐⭐ `[ICR.M8]` Prueba de **INTEGRACIÓN** de la cola de racks, contra Postgres real.
 *
 * ## Por qué tiene que ser contra una base de verdad
 *
 * Lo que esta cola promete —**un rack tiene un solo dueño a la vez**— vive en dos piezas que un
 * doble en memoria **no puede ejercer**: el índice único con `NULLS NOT DISTINCT` y el
 * `FOR UPDATE ... SKIP LOCKED`. Una prueba con un `trx` falso diría verde con un `if` en
 * JavaScript, que es exactamente la implementación que esta fase prohíbe. Y la carrera que se
 * quiere probar —dos personas apretando «dame el siguiente» a la vez— necesita **dos conexiones
 * de verdad**: dentro de una sola transacción no hay carrera que simular.
 *
 * ## Lo que se ejerce, una por una
 *
 *  1. ⭐ **La carrera**: 6 personas piden a la vez sobre 6 lugares → 6 racks DISTINTOS, ninguno
 *     repetido, nadie esperando.
 *  2. **El orden de la cola es el RECORRIDO**, no el alfabético, y el montón «sin rack» va al final.
 *  3. **NEGATIVA — la segunda vuelta de un rack NUNCA cae en quien hizo la primera.**
 *  4. **NEGATIVA — liberar no borra lo capturado**, y quien lo toma ve QUÉ se contó ahí (sin
 *     cantidades: el conteo es ciego).
 *  5. **NEGATIVA — nadie tiene dos racks**, ni con dos peticiones simultáneas.
 *  6. **El catálogo vacío** (Yurécuaro al 2026-11-27): sin racks, la cola tiene UN elemento, el
 *     montón, y al segundo que llega se le ofrece **unirse**.
 *  7. ⛔ **ROTO A PROPÓSITO — sin el índice único la carrera SÍ entrega el mismo rack dos veces.**
 *     Es lo que prueba que el verde de (1) lo produce el candado y no la suerte del reloj.
 *  8. ⛔ **ROTO A PROPÓSITO — el CHECK no deja escribir un rack tomado sin dueño.**
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el
 * `system_identifier`). Sin la variable se salta y lo DICE.
 *
 * ⚠️ A diferencia de las otras `.it.spec`, acá **no cabe todo en una transacción revertida**: una
 * carrera necesita transacciones que se vean entre sí. Por eso cada caso arma su propio almacén
 * —`commercial_inv_counts_one_open_per_wh_ritmo` sólo admite un folio abierto por almacén— y todo
 * se limpia en `afterAll`, acotado a lo que esta suite creó.
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';
import { InventoryRackQueueService, SIN_RACK } from './inventory-rack-queue.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const MIG = (f: string) => `../../../../../database/migrations-newdb/${f}`;

async function migUp(rel: string, k: Knex): Promise<void> {
  const m = createRequire(__filename)(resolvePath(__dirname, rel)) as { up: (k: Knex) => Promise<void> };
  await m.up(k);
}

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[ICR.M8] NO MEDIDO: sin TP_IT_DB la cola de racks no se ejerce contra base real.');

/** Un escenario: su almacén, sus racks y su folio abierto. */
interface Escenario {
  folio: string;
  wh: string;
  rack: Record<string, string>;
}

suite('[ICR.M8] La cola de racks contra Postgres real: un rack, un dueño', () => {
  let knex: Knex;
  const folios: string[] = [];
  const almacenes: string[] = [];
  const pasillos: string[] = [];
  /** Las personas de la prueba, creadas acá y borradas al final. */
  const quien: Record<string, string> = {};

  /** Un servicio que actúa COMO esa persona. Es el único doble: el resto es Postgres. */
  const svc = (uid: string) => {
    const tk = {
      run: <T>(fn: (t: Knex.Transaction) => Promise<T>) =>
        knex.transaction(async (trx) => {
          await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
          return fn(trx);
        }),
    };
    const ctx = { requireTenantId: () => M, get: () => ({ tenantId: M, userId: uid }) };
    return new InventoryRackQueueService(tk as never, ctx as never);
  };

  const sufijo = () => Math.random().toString(36).slice(2, 9);

  /**
   * Arma un escenario entero. `racks` es `[código, orden de recorrido]`: el orden se captura a
   * propósito AL REVÉS del alfabético, porque si la cola entregara por código la prueba del orden
   * pasaría igual y no mediría nada.
   */
  async function escenario(racks: [string, number | null][], opts: { blind?: boolean } = {}): Promise<Escenario> {
    const s = sufijo();
    const [w] = await knex('commercial.warehouses')
      .insert({ tenant_id: M, code: `IM8${s}`.slice(0, 10), name: `ICR.M8 ${s}` })
      .returning('id');
    almacenes.push(w.id as string);

    const rack: Record<string, string> = {};
    for (const [code, walk] of racks) {
      const [a] = await knex('commercial.warehouse_aisles')
        .insert({ tenant_id: M, warehouse_id: w.id, code, name: `Rack ${code}`, walk_sequence: walk })
        .returning('id');
      rack[code] = a.id as string;
      pasillos.push(a.id as string);
    }

    const [f] = await knex('commercial.inventory_counts')
      .insert({
        tenant_id: M,
        warehouse_id: w.id,
        folio: `ICRM8-${s}`,
        type: 'full',
        status: 'counting',
        blind_double_count: opts.blind !== false,
      })
      .returning('id');
    folios.push(f.id as string);
    return { folio: f.id as string, wh: w.id as string, rack };
  }

  async function persona(username: string): Promise<string> {
    const [u] = await knex('identity.users')
      .insert({ tenant_id: M, username, nombre: username, password_hash: 'x', role_name: 'admin' })
      .returning('id');
    quien[username] = u.id as string;
    return u.id as string;
  }

  /**
   * Un renglón del folio. Va por `product_sku` y no por `product_id` a propósito: `public.products`
   * es una VISTA (shim del cutover) y el renglón admite las dos formas — lo que se prueba acá es la
   * cola, no el catálogo.
   */
  async function renglon(countId: string, aisleId: string | null): Promise<string> {
    const [i] = await knex('commercial.inventory_count_items')
      .insert({
        tenant_id: M,
        count_id: countId,
        product_sku: `ICRM8-${sufijo()}`,
        aisle_id: aisleId,
        expected_qty: 10,
        status: 'pending',
      })
      .returning('id');
    return i.id as string;
  }

  /** Una captura viva en ese rack, como la deja `submitCount` tras `[ICR.M3]`. */
  async function captura(countId: string, itemId: string, aisleId: string | null, uid: string, pass: number, qty: number) {
    await knex('commercial.inventory_count_scan_log').insert({
      tenant_id: M,
      count_id: countId,
      scan_uuid: knex.raw('gen_random_uuid()'),
      item_id: itemId,
      slot: `count_${pass}`,
      applied_by: uid,
      quantity: qty,
      quantity_native: qty,
      aisle_id: aisleId,
    });
  }

  const estado = (countId: string) =>
    knex('commercial.inventory_count_rack_state')
      .where({ count_id: countId })
      .select('aisle_id', 'pass', 'status', 'holder_id', 'held_by');

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 12 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS sid FROM pg_control_system()');
    if (rows[0].sid === PROD_SYSTEM_ID) throw new Error('⛔ TP_IT_DB apunta a PRODUCCIÓN. Abortado.');

    // Las tres en orden: `[IC.F24]` pone `count_N_unit`/`count_N_factor`, de las que depende el
    // backfill de `[ICR.M3]`; `[ICR.M3]` pone `aisle_id`/`quantity_native` en la bitácora, que es
    // lo que esta cola lee para decir qué se contó ya en un rack.
    //
    // ⚠️ `[IC.F24]` **no es idempotente**: se guarda con `knex.schema.hasColumn('commercial.
    // inventory_count_items', …)`, y knex NO parte el nombre por el punto — busca una tabla
    // llamada literalmente «commercial.inventory_count_items», no la encuentra, contesta `false`
    // y el `ADD COLUMN` revienta en la segunda corrida. Acá se la salta si ya está; el arreglo
    // es de su dueño (regla 17).
    const { rows: yaTieneUnidad } = await knex.raw(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'commercial' AND table_name = 'inventory_count_items'
          AND column_name = 'count_1_unit'`,
    );
    if (!yaTieneUnidad.length) await migUp(MIG('20261127102512_ic_f24_unidad_del_conteo.js'), knex);
    await migUp(MIG('20261127171256_icr_m3_captura_por_rack_en_la_bitacora.js'), knex);
    await migUp(MIG('20261127181143_icr_m8_cola_de_racks.js'), knex);

    for (const n of ['ana', 'beto', 'cata', 'dani', 'elsa', 'fredo', 'gael']) await persona(`icrm8_${n}_${sufijo()}`);
  });

  afterAll(async () => {
    if (!knex) return;
    if (folios.length) {
      await knex('commercial.inventory_count_rack_state').whereIn('count_id', folios).del();
      await knex('commercial.inventory_count_scan_log').whereIn('count_id', folios).del();
      await knex('commercial.inventory_count_items').whereIn('count_id', folios).del();
      await knex('commercial.inventory_counts').whereIn('id', folios).del();
    }
    if (pasillos.length) await knex('commercial.warehouse_aisles').whereIn('id', pasillos).del();
    if (almacenes.length) await knex('commercial.warehouses').whereIn('id', almacenes).del();
    if (Object.keys(quien).length) await knex('identity.users').whereIn('id', Object.values(quien)).del();
    await knex.destroy();
  });

  /** Las personas, por su nombre corto (el username lleva un sufijo para no chocar entre corridas). */
  const p = (corto: string) => quien[Object.keys(quien).find((k) => k.startsWith(`icrm8_${corto}_`))!];

  // ─────────────────────────────────────────────────────────────────────────────────────────
  it('⭐⭐ LA CARRERA: seis personas piden a la vez y se llevan seis racks DISTINTOS', async () => {
    const e = await escenario([
      ['Z-01', 1],
      ['M-02', 2],
      ['A-03', 3],
      ['B-04', 4],
      ['C-05', 5],
    ]);
    const gente = ['ana', 'beto', 'cata', 'dani', 'elsa', 'fredo'].map(p);

    // Las seis peticiones salen juntas: 5 racks del catálogo + el montón «sin rack» = 6 lugares.
    const rs = await Promise.all(gente.map((uid) => svc(uid).takeNext(e.folio)));

    const asignados = rs.filter((r) => r.estado === 'asignado');
    expect(asignados).toHaveLength(6);
    const llaves = asignados.map((r) => `${r.rack!.aisle_id ?? 'SIN'}|${r.rack!.pass}`);
    expect(new Set(llaves).size).toBe(6); // ⭐ ni uno repetido

    // Y la base dice lo mismo: seis filas tomadas, seis dueños distintos.
    const filas = (await estado(e.folio)).filter((r) => r.status === 'taken');
    expect(filas).toHaveLength(6);
    expect(new Set(filas.map((r) => r.holder_id)).size).toBe(6);
  });

  it('el orden de la cola es el RECORRIDO, no el alfabético, y el montón «sin rack» va al final', async () => {
    const e = await escenario([
      ['Z-01', 1],
      ['M-02', 2],
      ['A-03', 3],
    ]);
    const orden: string[] = [];
    // Una persona no puede tener dos racks, así que cada tirón lo da alguien distinto.
    for (const n of ['ana', 'beto', 'cata', 'dani']) {
      const r = await svc(p(n)).takeNext(e.folio);
      orden.push(r.rack!.code);
    }
    expect(orden).toEqual(['Z-01', 'M-02', 'A-03', SIN_RACK]);
  });

  it('⛔ NEGATIVA: la segunda vuelta de un rack NUNCA se le da a quien hizo la primera', async () => {
    const e = await escenario([['U-01', 1]], { blind: true });
    const ana = p('ana');

    const t = await svc(ana).takeNext(e.folio);
    expect(t.rack!.code).toBe('U-01');
    expect(t.rack!.pass).toBe(1);

    // Al terminarlo, la vuelta 2 de ESE rack nace libre…
    const fin = await svc(ana).finish(e.folio, { aisle_id: e.rack['U-01'] });
    const v2 = (await estado(e.folio)).filter((r) => Number(r.pass) === 2);
    expect(v2).toHaveLength(1);
    expect(v2[0].status).toBe('free');

    // …y el siguiente que la cola le da a Ana NO es ésa: es el montón, que no ha tocado.
    expect(fin.siguiente.rack!.aisle_id).toBeNull();
    await svc(ana).finish(e.folio, { aisle_id: null });

    // Ya sin nada de la vuelta 1 para ella, la cola no le ofrece la vuelta 2 de su propio rack.
    const otra = await svc(ana).takeNext(e.folio);
    expect(otra.rack?.aisle_id ?? null).not.toBe(e.rack['U-01']);

    // Beto sí la puede tomar: es el segundo testigo, que es de lo que vive el doble conteo ciego.
    const deBeto = await svc(p('beto')).takeNext(e.folio);
    expect(deBeto.estado).toBe('asignado');
    expect(deBeto.rack!.aisle_id).toBe(e.rack['U-01']);
    expect(deBeto.rack!.pass).toBe(2);

    // Y unirse tampoco es una puerta trasera: a Ana se le niega con su razón.
    await expect(svc(ana).join(e.folio, { aisle_id: e.rack['U-01'] })).rejects.toThrow(/primera vuelta/i);
  });

  it('⛔ NEGATIVA: liberar NO borra lo capturado, y quien lo toma ve QUÉ se contó ahí', async () => {
    const e = await escenario([['L-01', 1]], { blind: false });
    const ana = p('ana');
    const t = await svc(ana).takeNext(e.folio);
    const suyo = t.rack!.aisle_id!;
    expect(suyo).toBe(e.rack['L-01']);
    const item = await renglon(e.folio, suyo);
    await captura(e.folio, item, suyo, ana, 1, 24);

    const antes = await knex('commercial.inventory_count_scan_log').where({ count_id: e.folio }).count('* as n').first();

    const r = await svc(p('gael')).release(e.folio, { aisle_id: suyo, reason: 'se le murió el teléfono' });
    expect(r.capturas_conservadas).toBe(1);

    const despues = await knex('commercial.inventory_count_scan_log').where({ count_id: e.folio }).count('* as n').first();
    expect(Number(despues!.n)).toBe(Number(antes!.n)); // ⭐ ni una captura menos
    expect(Number(antes!.n)).toBe(1); // y el control de que la prueba medía algo

    // Quien lo tome después ve QUÉ se contó ahí — y NO cuánto: el conteo es ciego (§4.3).
    const deBeto = await svc(p('beto')).takeNext(e.folio);
    expect(deBeto.rack!.aisle_id).toBe(suyo);
    expect(deBeto.rack!.ya_contado).toHaveLength(1);
    expect(JSON.stringify(deBeto.rack!.ya_contado)).not.toContain('24');

    // ⛔ Y a Ana la cola NO se lo devuelve sola: sigue anotada en `held_by`.
    const otra = await svc(ana).takeNext(e.folio);
    expect(otra.rack?.aisle_id ?? null).not.toBe(suyo);
  });

  it('⛔ NEGATIVA: nadie tiene dos racks, ni apretando dos veces al mismo tiempo', async () => {
    const e = await escenario([
      ['D-01', 1],
      ['D-02', 2],
    ]);
    const ana = p('ana');
    const [a, b] = await Promise.all([svc(ana).takeNext(e.folio), svc(ana).takeNext(e.folio)]);
    expect(a.rack!.aisle_id ?? 'SIN').toBe(b.rack!.aisle_id ?? 'SIN');
    const mios = (await estado(e.folio)).filter((r) => r.holder_id === ana);
    expect(mios).toHaveLength(1);
  });

  it('con el catálogo VACÍO (Yurécuaro hoy) la cola tiene UN elemento: el montón «sin rack»', async () => {
    const e = await escenario([]);

    const r = await svc(p('ana')).takeNext(e.folio);
    expect(r.estado).toBe('asignado');
    expect(r.rack!.aisle_id).toBeNull();
    expect(r.rack!.code).toBe(SIN_RACK);
    expect(await estado(e.folio)).toHaveLength(1);

    // Y el siguiente que llega no se queda sin respuesta: se le ofrece unirse (§4.6).
    const r2 = await svc(p('beto')).takeNext(e.folio);
    expect(r2.estado).toBe('sin_libres');
    expect(r2.puedes_unirte.map((x) => x.code)).toEqual([SIN_RACK]);
    const j = await svc(p('beto')).join(e.folio, { aisle_id: null });
    expect(j.rack.code).toBe(SIN_RACK);
    // Unirse NO cambia de dueño: el rack sigue siendo de quien lo tomó.
    const fila = (await estado(e.folio))[0];
    expect(fila.holder_id).toBe(p('ana'));
    expect((fila.held_by as string[]).sort()).toEqual([p('ana'), p('beto')].sort());
  });

  it('el tablero del supervisor dice quién tiene qué, desde hace cuánto y qué falta', async () => {
    const e = await escenario([
      ['T-01', 1],
      ['T-02', 2],
    ]);
    await svc(p('ana')).takeNext(e.folio);
    const b = await svc(p('gael')).board(e.folio);
    expect(b.resumen).toEqual({ libres: 2, tomados: 1, terminados: 0 });
    const tomado = b.racks.find((r) => r.status === 'taken')!;
    expect(tomado.code).toBe('T-01');
    expect(tomado.holder!.user_id).toBe(p('ana'));
    expect(tomado.minutos_tomado).not.toBeNull();
    expect(b.sin_orden_de_recorrido).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // ⭐⭐ LA PRUEBA DEL CANDADO: un gate sin prueba negativa es una intención.
  // ─────────────────────────────────────────────────────────────────────────────────────────
  it('⛔ ROTO A PROPÓSITO: sin el índice único, la carrera entrega el MISMO rack dos veces', async () => {
    const e = await escenario([['R-01', 1]]);
    const ana = p('ana');
    const beto = p('beto');

    await svc(ana).takeNext(e.folio); // crea la cola
    await knex('commercial.inventory_count_rack_state')
      .where({ count_id: e.folio })
      .update({ status: 'free', holder_id: null, taken_at: null });
    // Se deja SÓLO el rack (sin el montón), para que los dos apunten al mismo lugar.
    await knex('commercial.inventory_count_rack_state').where({ count_id: e.folio }).whereNull('aisle_id').del();

    // Se rompe el candado y se duplica la fila: es exactamente lo que el índice impedía.
    await knex.raw('DROP INDEX commercial.commercial_inv_rack_state_unica');
    try {
      await knex.raw(
        `INSERT INTO commercial.inventory_count_rack_state (tenant_id, count_id, aisle_id, pass, status)
         SELECT tenant_id, count_id, aisle_id, pass, 'free'
           FROM commercial.inventory_count_rack_state WHERE count_id = ?`,
        [e.folio],
      );
      const [a, b] = await Promise.all([svc(ana).takeNext(e.folio), svc(beto).takeNext(e.folio)]);
      // El ROJO que se esperaba: los dos se llevan R-01. Sin el índice, no hay regla madre.
      expect(a.rack!.code).toBe('R-01');
      expect(b.rack!.code).toBe('R-01');
      expect(a.rack!.aisle_id).toBe(b.rack!.aisle_id);
    } finally {
      await knex('commercial.inventory_count_rack_state').where({ count_id: e.folio }).del();
      await knex.raw(
        `CREATE UNIQUE INDEX commercial_inv_rack_state_unica
           ON commercial.inventory_count_rack_state (tenant_id, count_id, aisle_id, pass) NULLS NOT DISTINCT`,
      );
    }

    // Y con el candado repuesto, duplicar la fila REVIENTA: vuelve a ser imposible de representar.
    await svc(ana).takeNext(e.folio);
    await expect(
      knex.raw(
        `INSERT INTO commercial.inventory_count_rack_state (tenant_id, count_id, aisle_id, pass, status)
         SELECT tenant_id, count_id, aisle_id, pass, 'free'
           FROM commercial.inventory_count_rack_state WHERE count_id = ? AND aisle_id IS NOT NULL`,
        [e.folio],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('⛔ ROTO A PROPÓSITO: el CHECK no deja escribir un rack tomado sin dueño', async () => {
    const e = await escenario([['K-01', 1]]);
    await svc(p('ana')).takeNext(e.folio);
    await expect(
      knex('commercial.inventory_count_rack_state')
        .where({ count_id: e.folio, status: 'taken' })
        .update({ status: 'taken', holder_id: null }),
    ).rejects.toThrow(/ck_rack_state_dueno_coherente/);
  });
});
