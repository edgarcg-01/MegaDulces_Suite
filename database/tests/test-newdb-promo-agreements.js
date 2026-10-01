/**
 * `[MKT.1]` — **El acuerdo con el proveedor: lo que las tablas tienen que impedir.**
 *
 * `commercial.promo_agreements` guarda el formato MKTN001 — lo que se le negoció a un proveedor y
 * qué plazas participan. Es dato propio (HITL): no sale de ningún feed, porque una negociación no
 * deja rastro en `kepler_ods`. Lo que se afirma acá NO es "se puede insertar una fila" —eso es lo
 * fácil— sino **las seis maneras de que el expediente mienta**, cada una rota a propósito:
 *
 *  1. **Un folio antes de la autorización.** El folio es el número con el que se le habla al
 *     proveedor; si un borrador ya lo tiene, se puede citar un compromiso que nadie aprobó.
 *  2. **Una autorización sin autor.** `authorized_at` sin `authorized_by` deja un acuerdo
 *     aprobado por "alguien": no se puede auditar quién comprometió el dinero.
 *  3. **Un monto en 0.** Indistinguible de "no se pactó". Si no se pactó, va NULL (ADR-056).
 *  4. **Una vigencia que no termina** (o que termina dos veces). Sin fin, el acuerdo no se puede
 *     cerrar ni reportar, y queda aplicando para siempre.
 *  5. **Evidencia que no se puede atribuir.** Una foto de ejecución sin plaza no dice quién
 *     ejecutó, y la cobertura ("6 de 10") deja de significar algo. Al revés también: el correo de
 *     la negociación no es de ninguna plaza.
 *  6. **La misma plaza dos veces en un acuerdo**, que infla el denominador de esa cobertura.
 *
 * Y por encima de todo, el candado que el módulo hereda: **RLS forzado**. El monto negociado con
 * un proveedor es de UN tenant; que se filtre al de al lado es el peor defecto posible acá.
 *
 * ⚠️ Un candado sin prueba negativa es una intención: cada CHECK se rompe y se verifica el rojo.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-promo-agreements.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

/** Marca propia: se limpia sólo lo de esta corrida, nunca la tabla. */
const MARCA = `SMOKE-MKT-${Date.now()}`;

/** Inserta rompiendo lo que se le pida; devuelve el error de Postgres, o null si PASÓ. */
async function intentar(tabla, fila) {
  try { await knex(tabla).insert(fila); return null; }
  catch (e) { return e.message || String(e); }
}

/** Carátula válida mínima, para romperle un campo por vez. */
const caratula = (extra = {}) => ({
  tenant_id: T,
  empresa: MARCA,
  apoyo: 'sell_out',
  proveedor: MARCA,
  fecha_negociacion: '2026-09-22',
  vigencia_desde: '2026-10-01',
  vigencia_hasta: '2026-10-31',
  mecanica: '3% de descuento',
  presupuesto_tipo: 'topado',
  recurso: 'proveedor_sin_cargo',
  status: 'borrador',
  ...extra,
});

(async () => {
  let agreementId = null;
  try {
    const existe = (await knex.raw(`SELECT to_regclass('commercial.promo_agreements') AS t`)).rows[0]?.t;
    if (!existe) {
      console.log('  ⚠️  sin las tablas de acuerdos (¿migración 20260928120000 pendiente?) — NO MEDIDO');
      process.exit(2);
    }

    const wh = await knex('commercial.warehouses')
      .select('id', 'code', 'name').where({ tenant_id: T }).whereNull('deleted_at').orderBy('code');
    if (wh.length < 2) {
      console.log('  ⚠️  hacen falta 2 sucursales para probar la cobertura — NO MEDIDO');
      process.exit(2);
    }
    const autor = await knex('identity.users').select('id').where('tenant_id', T).first();

    console.log('\n[MKT.1] Acuerdos con proveedor — candados de la tabla\n');

    // ───────────────────────── 1. El folio nace con la autorización ─────────────────────────
    console.log('1. El folio no existe antes de que alguien autorice');
    ok(
      await intentar('commercial.promo_agreements', caratula({ folio: 'SMOKE-F1' })),
      'NEGATIVA: un BORRADOR con folio se rechaza',
    );
    ok(
      await intentar('commercial.promo_agreements', caratula({
        status: 'vigente', folio: null, authorized_at: knex.fn.now(), authorized_by: autor?.id,
      })),
      'NEGATIVA: un acuerdo VIGENTE sin folio se rechaza',
    );

    // ───────────────────── 2. Una autorización sin autor no se audita ─────────────────────
    console.log('\n2. Quién autorizó no puede quedar en blanco');
    ok(
      await intentar('commercial.promo_agreements', caratula({
        status: 'autorizado', folio: 'SMOKE-F2', authorized_at: knex.fn.now(), authorized_by: null,
      })),
      'NEGATIVA: `authorized_at` sin `authorized_by` se rechaza',
    );
    ok(
      // Un CANCELADO sí puede no tener autor: se canceló justamente sin autorizarse nunca.
      !(await intentar('commercial.promo_agreements', caratula({
        status: 'cancelado', folio: 'SMOKE-F2b',
      }))),
      'CONTROL: un CANCELADO sí pasa sin autor — nunca llegó a autorizarse',
    );

    // ───────────────────────────── 3. El cero que miente ─────────────────────────────
    console.log('\n3. Un monto en 0 es indistinguible de "no se midió" (ADR-056)');
    ok(
      await intentar('commercial.promo_agreements', caratula({ monto: 0 })),
      'NEGATIVA: `monto = 0` se rechaza',
    );
    ok(
      !(await intentar('commercial.promo_agreements', caratula({ folio: null, monto: null, empresa: MARCA + '-N' }))),
      'CONTROL POSITIVO: `monto = NULL` (no se pactó) sí pasa',
    );

    // ───────────────────────── 4. La vigencia siempre termina ─────────────────────────
    console.log('\n4. La vigencia termina en una fecha O en una condición — nunca en las dos ni en ninguna');
    ok(
      await intentar('commercial.promo_agreements', caratula({
        vigencia_hasta: '2026-10-31', vigencia_hasta_texto: 'hasta agotar',
      })),
      'NEGATIVA: fecha Y texto a la vez se rechaza',
    );
    ok(
      await intentar('commercial.promo_agreements', caratula({
        vigencia_hasta: null, vigencia_hasta_texto: null,
      })),
      'NEGATIVA: sin ninguna de las dos se rechaza',
    );
    ok(
      await intentar('commercial.promo_agreements', caratula({
        vigencia_hasta: null, vigencia_hasta_texto: '   ',
      })),
      'NEGATIVA: un texto en blanco no cuenta como condición',
    );
    ok(
      !(await intentar('commercial.promo_agreements', caratula({
        vigencia_hasta: null, vigencia_hasta_texto: 'hasta agotar', empresa: MARCA + '-V',
      }))),
      'CONTROL POSITIVO: «hasta agotar» solo sí pasa',
    );

    // «otros» sin especificar es la línea que el papel deja en blanco.
    ok(
      await intentar('commercial.promo_agreements', caratula({ recurso: 'otros', recurso_otros: null })),
      'NEGATIVA: recurso «otros» sin decir cuál se rechaza',
    );

    // ───────────────── Fila base real para las tablas hijas ─────────────────
    const [creada] = await knex('commercial.promo_agreements')
      .insert(caratula({ empresa: MARCA, proveedor: MARCA })).returning('id');
    agreementId = creada.id ?? creada;
    ok(!!agreementId, 'CONTROL POSITIVO: una carátula válida se guarda');

    // ─────────────────── 5. La evidencia se tiene que poder atribuir ───────────────────
    console.log('\n5. Una foto de ejecución sin plaza no dice quién ejecutó');
    const [canal] = await knex('commercial.promo_agreement_channels').insert({
      tenant_id: T, agreement_id: agreementId,
      warehouse_id: wh[0].id, warehouse_code: wh[0].code, warehouse_name: wh[0].name,
      evidence_required: 2,
    }).returning('id');
    const canalId = canal.id ?? canal;

    const archivo = (extra) => ({
      tenant_id: T, agreement_id: agreementId,
      file_name: 'x.jpg', file_url: 'https://x/x.jpg', ...extra,
    });
    ok(
      await intentar('commercial.promo_agreement_files', archivo({ kind: 'evidencia', channel_id: null })),
      'NEGATIVA: evidencia de ejecución SIN canal se rechaza',
    );
    ok(
      await intentar('commercial.promo_agreement_files', archivo({ kind: 'negociacion', channel_id: canalId })),
      'NEGATIVA: el correo de la negociación NO pertenece a una plaza',
    );
    ok(
      await intentar('commercial.promo_agreement_files', archivo({
        kind: 'evidencia', channel_id: canalId, size_bytes: 0,
      })),
      'NEGATIVA: un archivo de 0 bytes se rechaza — subió vacío, no subió',
    );
    ok(
      !(await intentar('commercial.promo_agreement_files', archivo({ kind: 'evidencia', channel_id: canalId }))),
      'CONTROL POSITIVO: evidencia con su canal sí entra',
    );

    // ───────────────────── 6. Una plaza participa UNA vez ─────────────────────
    console.log('\n6. La misma plaza no puede participar dos veces (infla la cobertura)');
    ok(
      await intentar('commercial.promo_agreement_channels', {
        tenant_id: T, agreement_id: agreementId,
        warehouse_id: wh[0].id, warehouse_code: wh[0].code,
      }),
      'NEGATIVA: el mismo almacén dos veces en el mismo acuerdo se rechaza',
    );
    ok(
      !(await intentar('commercial.promo_agreement_channels', {
        tenant_id: T, agreement_id: agreementId,
        warehouse_id: wh[1].id, warehouse_code: wh[1].code,
      })),
      'CONTROL POSITIVO: otra plaza sí entra',
    );

    // ───────────────────── La cobertura se DERIVA de los archivos ─────────────────────
    console.log('\n7. La cobertura sale de los archivos, no de un contador a mano');
    const cobertura = await knex.raw(
      `SELECT c.evidence_required AS req,
              (SELECT count(*) FROM commercial.promo_agreement_files f
                WHERE f.channel_id = c.id AND f.kind = 'evidencia' AND f.deleted_at IS NULL) AS reales
         FROM commercial.promo_agreement_channels c WHERE c.id = ?`, [canalId]);
    const { req, reales } = cobertura.rows[0];
    ok(Number(reales) === 1 && Number(req) === 2,
      `el expediente lleva ${reales} de ${req} — incompleto, y se ve sin preguntarle a nadie`);

    // ───────────────────────────── 8. RLS forzado ─────────────────────────────
    console.log('\n8. RLS: el monto negociado con un proveedor es de UN tenant');
    const rls = await knex.raw(`
      SELECT relname, relrowsecurity AS activo, relforcerowsecurity AS forzado
        FROM pg_class WHERE relnamespace = 'commercial'::regnamespace
         AND relkind = 'r'                       -- ⚠️ sin esto entran los índices y el test se
         AND relname LIKE 'promo_agreement%'     --    pone rojo por filas que no son tablas
       ORDER BY relname`);
    for (const t of rls.rows) {
      ok(t.activo && t.forzado, `${t.relname}: RLS activo y FORZADO (el dueño tampoco se salta)`);
    }
    const grants = await knex.raw(`
      SELECT count(*)::int AS n FROM information_schema.role_table_grants
       WHERE grantee = 'app_runtime' AND table_schema = 'commercial'
         AND table_name LIKE 'promo_agreement%' AND privilege_type = 'SELECT'`);
    ok(grants.rows[0].n >= 4, `app_runtime puede leer las 4 tablas (${grants.rows[0].n} grants)`);

    // ⭐ La prueba que de verdad importa: con el tenant puesto, un tenant AJENO no ve nada.
    const otro = await knex('identity.tenants').select('id').whereNot('id', T).first();
    if (otro) {
      // ⚠️ Dos detalles que ya costaron un rojo falso acá:
      //   · el GUC se llama `app.tenant_id` (lo lee `public.current_tenant_id()`), no
      //     `app.current_tenant_id`;
      //   · `SET` **no acepta parámetros** (`$1` es error de sintaxis), va interpolado — por eso
      //     el valor se valida como UUID antes, en vez de concatenar lo que venga.
      //   · y sobre todo: esta conexión es `postgres`, **superusuario, que SE SALTA RLS aunque
      //     esté FORZADO**. Sin el `SET LOCAL ROLE`, este bloque se pondría verde midiendo nada.
      const uuid = String(otro.id);
      if (!/^[0-9a-f-]{36}$/i.test(uuid)) throw new Error('tenant ajeno con id inesperado');
      const vistas = await knex.transaction(async (trx) => {
        await trx.raw(`SET LOCAL ROLE app_runtime`);
        await trx.raw(`SET LOCAL app.tenant_id = '${uuid}'`);
        const r = await trx('commercial.promo_agreements').count('* as n').where('empresa', MARCA);
        return Number(r[0].n);
      }).catch((e) => e.message);
      ok(vistas === 0, `⭐ NEGATIVA: con otro tenant puesto, el acuerdo NO se ve (vio: ${vistas})`);

      // CONTROL POSITIVO del control: con el tenant CORRECTO y el mismo rol, sí se ve. Sin esto,
      // un `0` de arriba podría venir de que la consulta esté rota, no de que RLS corte.
      const propias = await knex.transaction(async (trx) => {
        await trx.raw(`SET LOCAL ROLE app_runtime`);
        await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
        const r = await trx('commercial.promo_agreements').count('* as n').where('empresa', MARCA);
        return Number(r[0].n);
      }).catch((e) => e.message);
      ok(propias >= 1, `CONTROL: con su propio tenant sí lo ve (${propias}) — el 0 de arriba es RLS, no una consulta rota`);
    } else {
      console.log('  ⚠️  no hay un segundo tenant con qué probar el corte — NO MEDIDO');
    }

    // ───────────────────────── 9. Borrar el acuerdo se lleva el expediente ─────────────────────────
    console.log('\n9. El expediente no sobrevive a su acuerdo');
    await knex('commercial.promo_agreements').where('id', agreementId).del();
    agreementId = null;
    const huerfanos = await knex.raw(`
      SELECT (SELECT count(*) FROM commercial.promo_agreement_channels WHERE warehouse_code = ?) AS c,
             (SELECT count(*) FROM commercial.promo_agreement_files WHERE file_name = 'x.jpg') AS f`,
      [wh[0].code]);
    // Se cuenta sólo lo que quedó colgando del acuerdo borrado: el resto de la base sigue igual.
    const colgados = await knex.raw(`
      SELECT count(*)::int AS n FROM commercial.promo_agreement_channels c
       WHERE NOT EXISTS (SELECT 1 FROM commercial.promo_agreements a WHERE a.id = c.agreement_id)`);
    ok(colgados.rows[0].n === 0, 'CASCADE: no quedan canales colgando de un acuerdo inexistente');
    void huerfanos;

  } catch (e) {
    console.error('\n  ❌ ERROR:', e.message);
    fail++;
  } finally {
    // Limpieza de lo de ESTA corrida. Nunca un `DELETE FROM` sin filtro.
    if (agreementId) await knex('commercial.promo_agreements').where('id', agreementId).del().catch(() => {});
    await knex('commercial.promo_agreements').where('empresa', 'like', `${MARCA}%`).del().catch(() => {});
    await knex.destroy();
  }

  console.log(fail === 0 ? '\n✅ Todo verde\n' : `\n❌ ${fail} fallo(s)\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
