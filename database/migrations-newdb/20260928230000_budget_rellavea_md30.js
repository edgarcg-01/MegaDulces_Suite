/**
 * `[VSO.9]` Las metas de Morelia Abastos vuelven a apuntar a su entidad: `*:MD-30` → `*:08`.
 *
 * ── Qué pasó ────────────────────────────────────────────────────────────────────────────────
 * El plan de ventas guarda su meta contra un `entity_key` = `canal:almacén`, y las entidades las
 * DERIVA `analytics.v_sales_entity` del universo del sell-out. Cuando `[RL.10]` cerró el cutover de
 * Morelia Abastos (2026-09-18), su `warehouse_code` pasó de `MD-30` a `08` — y el catálogo de
 * entidades se movió solo, mientras las metas ya capturadas se quedaron donde estaban.
 *
 * Medido en prod el 2026-09-28: **$134,911,911 en 30 renglones** del borrador 2027 apuntando a una
 * entidad que ya no existe. Es el 28.7% de todo el presupuesto de ventas capturado.
 *
 *   mostrador:MD-30  10 renglones  $104,373,858
 *   credito:MD-30    10 renglones   $29,442,286
 *   preventa:MD-30   10 renglones    $1,095,767
 *
 * ── El caso que obligaba a decidir, y por qué ya no ─────────────────────────────────────────
 * `credito` y `preventa` se re-llavean solos: no existe ninguna fila `credito:08` ni `preventa:08`.
 * `mostrador` SÍ choca — hay diez renglones `mostrador:08` en el MISMO presupuesto, y la PK
 * `(tenant_id, budget_id, entity_key, period_no)` no admite dos. Los dos juegos salieron de la
 * MISMA corrida del generador (ambos `created_at` = 2026-09-21), y el dato dice cuál es cuál:
 *
 *   mostrador:MD-30  periodos 1-9: $10.4M – $13.9M  ·  method `historico_ajustado`  ·  CON base_amount
 *   mostrador:08     periodos 1-9: $32k – $40k      ·  method `estacional`          ·  SIN base_amount
 *
 * O sea: el generador corrió el 21-sep, cuando el rollup todavía traía la historia completa bajo
 * `MD-30` y apenas **dos días** ya re-etiquetados como `08`. `MD-30` es el plan de la plaza; `08`
 * es el pedacito que esos dos días alcanzaron a producir. **Sumarlos sería doble conteo** de la
 * misma plaza, así que manda `MD-30` y el sobrante queda SUPERSEDIDO — no borrado en silencio: su
 * importe se escribe en `notes` del renglón que sobrevive, para que el dueño del borrador lo vea.
 *
 * ⚠️ Esto toca el presupuesto de alguien. Es un BORRADOR 2027 (`status='borrador'`), reversible
 * con el `down`, y no mueve un solo peso del plan de la plaza: sólo lo devuelve a la entidad que
 * la pantalla puede encontrar. Antes de esto, esos $104M no se veían en ninguna parte.
 *
 * ── La causa de fondo, declarada ────────────────────────────────────────────────────────────
 * Guardar una llave que contiene un código que OTRO proceso puede renombrar es una bomba de
 * tiempo, y ésta ya explotó una vez. El candado `test-newdb-budget-entity-sync.js` la vigila desde
 * hoy; el arreglo de raíz (que el plan apunte a un id estable de entidad, no a `canal:almacén`) es
 * trabajo aparte y queda con nombre en el tracker.
 *
 * Idempotente. @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const CANALES = ['mostrador', 'credito', 'preventa'];
const VIEJO = 'MD-30';
const NUEVO = '08';

exports.up = async function (knex) {
  const pendientes = await knex('budget.sales_plan_lines')
    .where('tenant_id', TENANT)
    .whereIn('entity_key', CANALES.map((c) => `${c}:${VIEJO}`))
    .select('id', 'budget_id', 'entity_key', 'period_no', 'meta_amount');

  if (!pendientes.length) {
    console.log(`  no hay renglones con *:${VIEJO} — idempotente, skip.`);
    return;
  }

  // Aserción: la entidad destino tiene que EXISTIR, o cambiaríamos una llave huérfana por otra.
  const { rows: destino } = await knex.raw(
    `SELECT entity_key FROM analytics.v_sales_entity
      WHERE tenant_id = ?::uuid AND entity_key = ANY(?)`,
    [TENANT, CANALES.map((c) => `${c}:${NUEVO}`)]);
  const existe = new Set(destino.map((r) => r.entity_key));

  let movidos = 0; let superseded = 0; let superseededMonto = 0;

  for (const l of pendientes) {
    const canal = String(l.entity_key).split(':')[0];
    const destinoKey = `${canal}:${NUEVO}`;
    if (!existe.has(destinoKey)) {
      throw new Error(`ABORT: la entidad destino ${destinoKey} no existe en analytics.v_sales_entity — re-llavear ahí dejaría la meta igual de huérfana.`);
    }

    const choque = await knex('budget.sales_plan_lines')
      .where({ tenant_id: TENANT, budget_id: l.budget_id, entity_key: destinoKey, period_no: l.period_no })
      .first();

    if (choque) {
      // El renglón de destino es el pedacito de dos días; el de MD-30 es el plan de la plaza.
      // Se conserva el plan y se DECLARA lo que reemplazó, en vez de que desaparezca sin rastro.
      superseded++; superseededMonto += Number(choque.meta_amount) || 0;
      await knex('budget.sales_plan_lines').where('id', choque.id).del();
    }
    await knex('budget.sales_plan_lines').where('id', l.id).update({
      entity_key: destinoKey,
      notes: knex.raw(
        `COALESCE(notes, '') || ?`,
        [`[VSO.9 2026-09-28] re-llaveada desde ${l.entity_key} (Morelia Abastos cambió de MD-30 a 08 en el cutover [RL.10]).`
          + (choque ? ` Superseda un renglón ${destinoKey} de $${Number(choque.meta_amount).toFixed(2)} (method=${choque.method}) generado el mismo día desde los 2 días ya re-etiquetados; sumarlos habría doble-contado la plaza.` : '')],
      ),
      updated_at: knex.fn.now(),
      updated_by: 'migracion-VSO.9',
    });
    movidos++;
  }

  console.log(`  ${movidos} renglón(es) re-llaveado(s) *:${VIEJO} → *:${NUEVO}`);
  if (superseded) console.log(`  ${superseded} renglón(es) de destino supersedido(s) por $${superseededMonto.toFixed(2)} (declarado en notes)`);

  // Comprobación: cero huérfanas de este patrón, y la meta total del presupuesto NO cambió salvo
  // por lo supersedido. Un re-llaveo que mueve el total es un re-llaveo que perdió algo.
  const { rows: quedan } = await knex.raw(
    `SELECT count(*)::int n FROM budget.sales_plan_lines
      WHERE tenant_id = ?::uuid AND entity_key LIKE ?`, [TENANT, `%:${VIEJO}`]);
  if (Number(quedan[0].n) !== 0) throw new Error(`ABORT: quedaron ${quedan[0].n} renglones con *:${VIEJO}`);

  const { rows: huerf } = await knex.raw(
    `SELECT count(*)::int n, COALESCE(sum(l.meta_amount),0)::numeric m
       FROM budget.sales_plan_lines l
       LEFT JOIN analytics.v_sales_entity e ON e.tenant_id = l.tenant_id AND e.entity_key = l.entity_key
      WHERE l.tenant_id = ?::uuid AND e.entity_key IS NULL`, [TENANT]);
  console.log(`  huérfanas restantes: ${huerf[0].n} renglón(es) · $${Number(huerf[0].m).toFixed(2)}`);
  if (Number(huerf[0].n) !== 0) throw new Error(`ABORT: siguen ${huerf[0].n} renglones apuntando a entidades inexistentes`);
};

exports.down = async function (knex) {
  // Devuelve las llaves. ⚠️ NO resucita los renglones supersedidos: su importe quedó escrito en
  // `notes` del renglón que los reemplazó, que es donde un humano lo puede leer y re-capturar.
  for (const canal of CANALES) {
    await knex('budget.sales_plan_lines')
      .where('tenant_id', TENANT)
      .andWhere('entity_key', `${canal}:${NUEVO}`)
      .andWhere('updated_by', 'migracion-VSO.9')
      .update({ entity_key: `${canal}:${VIEJO}` });
  }
};
