'use strict';
/* eslint-disable no-console */
/**
 * `[SN.15]` — Qué tan lejos está «Mi trabajo» de cómo funcionan de verdad usuarios y roles.
 *
 * READ-ONLY, contra PROD. Cinco mediciones, y cada una decide un paso del plan:
 *
 *   1. ¿MIENTE la pantalla? `me-work.ts` (10-sep) dice que las tablas de asignación nominal están
 *      en CERO; `libs/contracts/src/work/task.contract.ts` (11-sep) dice 22+119+18+2 = 161 filas.
 *      Una de las dos está vencida. Mientras no se sepa cuál, la landing afirma
 *      «Nadie te asignó trabajo hoy» sobre una medición que puede estar muerta.
 *   2. ¿A CUÁNTA GENTE le toca algo? Si son 3 de 126, «A tu nombre» sigue vacío para casi todos y
 *      la pantalla tiene que decirlo así, no fingir un reparto que no existe.
 *   3. ¿Cuántas tareas llevan a un 403? Una fila asignada a alguien que NO tiene el permiso que
 *      abre su ruta. El bloque 4 de `test-newdb-me-context.js` ya vigila esto para las bandejas.
 *   4. ¿Hay GOD-MODE INVISIBLE? El backend evalúa `isPlatformAdminRole` sobre los roles frescos
 *      (unión de `identity.user_roles`); el front sobre `role_name` del JWT, que es sólo el perfil
 *      base. Y el trigger `sync_primary_role_from_user` DEGRADA en vez de borrar. Un ex-superadmin
 *      conservaría god-mode en la API sin que la UI lo muestre.
 *   5. ⭐ ¿A quién CIEGO si acoto las bandejas por sucursal? `scope.service.ts:34-35` midió 83 de
 *      117 usuarios sin `warehouse_code`. Acotar a `own` sin mirar esto convierte «no tenés
 *      sucursal en tu ficha» en «no tenés trabajo», que es la clase de default que ADR-056 prohíbe.
 *
 * ⛔ La URL NO se imprime nunca. `DATABASE_URL_NEW` del `.env` apunta a la RÉPLICA DE PRUEBAS
 * (`.245/platform_test`), no a prod — por eso acá se resuelve `FLEET_DB_URL` DENTRO de node y se
 * verifica el destino antes de medir (`server_version` 18.6 + una cuenta conocida).
 *
 * Uso:  node database/scripts/or-landing-gap-report.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { Client } = require('pg');

const DST = process.env.FLEET_DB_URL;
if (!DST) {
  console.error(
    'Falta FLEET_DB_URL en .env (es la URL de PROD; DATABASE_URL_NEW apunta a platform_test).',
  );
  process.exit(1);
}

/** Las 4 fuentes de tarea, con el mapeo que declara `libs/contracts/src/work/task.contract.ts`. */
const FUENTES = [
  {
    fuente: 'finance.recon_tasks',
    asignado_a: 'assigned_to',
    estado: 'status',
    abiertos: ['pendiente', 'en_proceso'],
  },
  {
    fuente: 'commercial.supervisor_tasks',
    asignado_a: 'assigned_to_user',
    estado: 'status',
    abiertos: ['pending'],
  },
  {
    // Sin estado propio: el ciclo vive en `commercial.inventory_counts.status`.
    fuente: 'commercial.inventory_count_assignments',
    asignado_a: 'user_id',
    estado: null,
    abiertos: null,
  },
  {
    // Su `status` es decoración (119/119 en 'pendiente', sin CHECK) — así lo declara el adaptador.
    fuente: 'trade.daily_assignments',
    asignado_a: 'user_id',
    estado: 'status',
    abiertos: ['pendiente'],
  },
];

/** Las 8 bandejas de `me-work.ts`, con su clave en `identity.responsibilities`. El mapeo NO existe
 *  en código todavía: son dos vocabularios para las mismas colas. Acá se usa para medir la brecha. */
const BANDEJAS = [
  { id: 'conteos-asignados', responsabilidad: 'almacen.conteo', anyOf: ['COMMERCIAL_INVENTORY_CONTAR'] },
  { id: 'caducidades-mias', responsabilidad: 'tienda.caducidades', anyOf: ['COMMERCIAL_EXPIRY_VER', 'COMMERCIAL_EXPIRY_CAPTURAR'] },
  { id: 'cuadre', responsabilidad: 'almacen.cuadre', anyOf: ['RECONCILIATION_VER'] },
  { id: 'finanzas-hallazgos', responsabilidad: 'finanzas.hallazgos', anyOf: ['FINANCE_AI_CHAT'] },
  { id: 'maat-acciones', responsabilidad: 'finanzas.acciones', anyOf: ['FINANCE_AI_CHAT'] },
  { id: 'thot-acciones', responsabilidad: 'comercial.thot', anyOf: ['COMMERCIAL_THOT_GESTIONAR'] },
  { id: 'compras-hallazgos', responsabilidad: 'compras.reabasto', anyOf: ['COMPRAS_HALLAZGOS_VER'] },
  { id: 'flota-alertas', responsabilidad: 'logistica.flota', anyOf: ['LOGISTICS_FLEET_VER'] },
];

/** Las 3 bandejas cuya tabla SÍ tiene columna de sucursal (medido en la mig 20260911140000). */
const ACOTABLES = new Set(['conteos-asignados', 'caducidades-mias', 'compras-hallazgos']);

const PLATFORM_ADMIN = ['superadmin', 'admin'];

const n = (v) => Number(v ?? 0).toLocaleString('es-MX');

async function existe(c, rel) {
  const r = await c.query('SELECT to_regclass($1) AS t', [rel]);
  return r.rows[0].t !== null;
}

(async () => {
  const c = new Client({ connectionString: DST, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    // ── Verificación de destino ────────────────────────────────────────────────────────────────
    const ver = await c.query(
      `SELECT current_database() AS db, current_user AS usr,
              current_setting('server_version') AS v`,
    );
    const { db, usr, v } = ver.rows[0];
    console.log(`\n═══ [SN.15] Brecha entre «Mi trabajo» y el padrón real ═══`);
    console.log(`destino: db=${db} · usuario=${usr} · PG ${v}`);
    if (db !== 'railway') {
      console.error(
        `\n✗ ABORTADO: se esperaba la base de PROD (db='railway') y se encontró '${db}'.\n` +
          `  Medir la brecha contra la réplica de pruebas daría cifras que no son de nadie.`,
      );
      process.exit(2);
    }

    const usuarios = await c.query(
      `SELECT count(*)::int AS n FROM identity.users WHERE deleted_at IS NULL AND activo = true`,
    );
    const vivos = usuarios.rows[0].n;
    console.log(`usuarios activos: ${n(vivos)}`);
    if (vivos === 0) {
      console.error(
        `\n✗ ABORTADO: 0 usuarios visibles. Probablemente RLS está filtrando (identity.users tiene\n` +
          `  FORCE ROW LEVEL SECURITY y este rol no es superusuario). Sin padrón no hay medición.`,
      );
      process.exit(2);
    }

    // ── 1. ¿Miente la pantalla? ───────────────────────────────────────────────────────────────
    console.log(`\n── 1. Las 4 fuentes de tarea (la contradicción 0 vs 161) ──`);
    console.log(`   ${'fuente'.padEnd(42)} ${'filas'.padStart(7)} ${'abiertas'.padStart(9)} ${'c/dueño vivo'.padStart(13)}`);
    let totalAsignadasVivas = 0;
    const disponibles = [];
    for (const f of FUENTES) {
      if (!(await existe(c, f.fuente))) {
        console.log(`   ${f.fuente.padEnd(42)} ${'—'.padStart(7)}  (la tabla NO existe en prod)`);
        continue;
      }
      disponibles.push(f);
      const filtroAbierto = f.estado
        ? `AND t.${f.estado} = ANY($1::text[])`
        : '';
      const args = f.estado ? [f.abiertos] : [];
      const r = await c.query(
        `SELECT count(*)::int AS filas,
                count(*) FILTER (WHERE true ${f.estado ? `AND t.${f.estado} = ANY($1::text[])` : ''})::int AS abiertas,
                count(*) FILTER (WHERE u.id IS NOT NULL ${f.estado ? `AND t.${f.estado} = ANY($1::text[])` : ''})::int AS con_dueno
           FROM ${f.fuente} t
           LEFT JOIN identity.users u
             ON u.id = t.${f.asignado_a} AND u.deleted_at IS NULL AND u.activo = true`,
        args,
      );
      const { filas, abiertas, con_dueno } = r.rows[0];
      totalAsignadasVivas += con_dueno;
      console.log(
        `   ${f.fuente.padEnd(42)} ${n(filas).padStart(7)} ${n(abiertas).padStart(9)} ${n(con_dueno).padStart(13)}`,
      );
      void filtroAbierto;
    }
    console.log(`\n   → tareas ABIERTAS con dueño activo: ${n(totalAsignadasVivas)}`);
    console.log(
      totalAsignadasVivas > 0
        ? `   ⚠️  La pantalla dice «Nadie te asignó trabajo hoy». Con ${n(totalAsignadasVivas)} tareas vivas, MIENTE.`
        : `   ✓ Cero tareas vivas: el texto actual de la pantalla es cierto HOY.`,
    );

    // ── 2. ¿A cuánta gente le toca algo? ──────────────────────────────────────────────────────
    console.log(`\n── 2. Personas con trabajo a su nombre ──`);
    if (disponibles.length) {
      const union = disponibles
        .map(
          (f) =>
            `SELECT t.${f.asignado_a} AS uid FROM ${f.fuente} t
              WHERE t.${f.asignado_a} IS NOT NULL
              ${f.estado ? `AND t.${f.estado} IN (${f.abiertos.map((x) => `'${x}'`).join(',')})` : ''}`,
        )
        .join(' UNION ALL ');
      const r = await c.query(
        `WITH asignadas AS (${union})
         SELECT count(DISTINCT a.uid)::int AS personas
           FROM asignadas a
           JOIN identity.users u ON u.id = a.uid AND u.deleted_at IS NULL AND u.activo = true`,
      );
      const personas = r.rows[0].personas;
      const pct = vivos ? ((personas / vivos) * 100).toFixed(1) : '0.0';
      console.log(`   ${n(personas)} de ${n(vivos)} usuarios activos (${pct}%) tienen ≥1 tarea abierta.`);
      console.log(
        `   → para los otros ${n(vivos - personas)}, «A tu nombre» sigue vacío y la pantalla lo tiene que declarar.`,
      );
    }

    // ── 3. Tareas que llevan a un 403 ─────────────────────────────────────────────────────────
    console.log(`\n── 3. Tareas cuyo dueño NO tiene el permiso que abre su ruta ──`);
    console.log(
      `   (sólo se mide donde la fuente tiene bandeja con ruta declarada en me-work.ts;\n` +
        `    las demás se DECLARAN sin medir, en vez de contarse como 0)`,
    );
    const permisoEfectivo = `
      WITH roles AS (
        SELECT u.id AS user_id, u.tenant_id, r.role_name
          FROM identity.users u
          JOIN identity.user_roles r ON r.user_id = u.id AND r.tenant_id = u.tenant_id
         WHERE u.deleted_at IS NULL AND u.activo = true
         UNION
        SELECT u.id, u.tenant_id, u.role_name
          FROM identity.users u
         WHERE u.deleted_at IS NULL AND u.activo = true
      ),
      efectivo AS (
        SELECT ro.user_id, ro.tenant_id, k.key AS permiso
          FROM roles ro
          JOIN identity.role_permissions rp
            ON rp.tenant_id = ro.tenant_id AND lower(rp.role_name) = lower(ro.role_name)
           AND rp.deleted_at IS NULL
          CROSS JOIN LATERAL jsonb_each(rp.permissions) AS k(key, val)
         WHERE k.val = 'true'::jsonb
         UNION
        SELECT up.user_id, up.tenant_id, up.permission_key
          FROM identity.user_permissions up WHERE up.allow = true
      )`;
    const conteoTabla = 'commercial.inventory_count_assignments';
    if (await existe(c, conteoTabla)) {
      const r = await c.query(
        `${permisoEfectivo}
         SELECT count(*)::int AS sin_permiso
           FROM ${conteoTabla} t
           JOIN identity.users u ON u.id = t.user_id AND u.deleted_at IS NULL AND u.activo = true
          WHERE NOT EXISTS (
                  SELECT 1 FROM efectivo e
                   WHERE e.user_id = u.id AND e.permiso = 'COMMERCIAL_INVENTORY_CONTAR')
            AND lower(u.role_name) <> ALL($1::text[])`,
        [PLATFORM_ADMIN],
      );
      console.log(
        `   conteos-asignados → COMMERCIAL_INVENTORY_CONTAR: ${n(r.rows[0].sin_permiso)} asignación(es) a gente sin el permiso.`,
      );
    }
    console.log(`   recon_tasks / supervisor_tasks / daily_assignments: NO MEDIDO (su ruta no está declarada como bandeja).`);

    // ── 4. God-mode invisible ─────────────────────────────────────────────────────────────────
    console.log(`\n── 4. God-mode que la UI no muestra ──`);
    const gm = await c.query(
      `SELECT u.username, u.role_name AS perfil_base, r.role_name AS complemento
         FROM identity.user_roles r
         JOIN identity.users u ON u.id = r.user_id AND u.tenant_id = r.tenant_id
        WHERE r.is_primary = false
          AND lower(r.role_name) = ANY($1::text[])
          AND lower(u.role_name) <> ALL($1::text[])
          AND u.deleted_at IS NULL AND u.activo = true
        ORDER BY u.username`,
      [PLATFORM_ADMIN],
    );
    if (gm.rows.length) {
      console.log(
        `   ⚠️  ${gm.rows.length} cuenta(s) con rol de plataforma COMO COMPLEMENTO:\n` +
          `       la API les da god-mode (roles frescos) y la landing les dibuja sólo su perfil base.`,
      );
      for (const g of gm.rows) {
        console.log(`       ${g.username.padEnd(24)} base=${g.perfil_base.padEnd(20)} complemento=${g.complemento}`);
      }
    } else {
      console.log(`   ✓ Ninguna: no hay rol de plataforma colgando como complemento.`);
    }

    const ovr = await c.query(
      `SELECT count(DISTINCT user_id)::int AS personas, count(*)::int AS filas
         FROM identity.user_permissions`,
    );
    const complementos = await c.query(
      `SELECT count(*)::int AS filas,
              count(*) FILTER (WHERE lower(r.role_name) = lower(u.role_name))::int AS espejo
         FROM identity.user_roles r
         JOIN identity.users u ON u.id = r.user_id AND u.tenant_id = r.tenant_id`,
    );
    console.log(
      `   overrides por persona (user_permissions): ${n(ovr.rows[0].filas)} filas sobre ${n(ovr.rows[0].personas)} persona(s).`,
    );
    console.log(
      `   user_roles: ${n(complementos.rows[0].filas)} filas, de las cuales ${n(complementos.rows[0].espejo)} repiten el perfil base.`,
    );
    console.log(
      `   → el reporte de visibilidad simula con role_permissions CRUDO: no ve ninguna de estas dos cosas.`,
    );

    // ── 5. A quién ciego si acoto por sucursal ────────────────────────────────────────────────
    console.log(`\n── 5. Cobertura de sucursal entre quienes ven las 3 bandejas acotables ──`);
    for (const b of BANDEJAS.filter((x) => ACOTABLES.has(x.id))) {
      const r = await c.query(
        `${permisoEfectivo}
         SELECT count(DISTINCT u.id)::int AS ven,
                count(DISTINCT u.id) FILTER (WHERE u.warehouse_code IS NULL OR u.warehouse_code = '')::int AS sin_sucursal
           FROM identity.users u
          WHERE u.deleted_at IS NULL AND u.activo = true
            AND (lower(u.role_name) = ANY($2::text[])
                 OR EXISTS (SELECT 1 FROM efectivo e
                             WHERE e.user_id = u.id AND e.permiso = ANY($1::text[])))`,
        [b.anyOf, PLATFORM_ADMIN],
      );
      const { ven, sin_sucursal } = r.rows[0];
      const pct = ven ? ((sin_sucursal / ven) * 100).toFixed(0) : '0';
      const flag = sin_sucursal > 0 ? '⚠️ ' : '✓  ';
      console.log(
        `   ${flag}${b.id.padEnd(20)} la ven ${n(ven).padStart(4)} · sin warehouse_code ${n(sin_sucursal).padStart(4)} (${pct}%)`,
      );
    }
    console.log(
      `   → los «sin warehouse_code» NO deben ver 0 al acotar: van a no_medido con motivo (ADR-056).`,
    );

    // ── 6. El estado del eje de responsabilidad ───────────────────────────────────────────────
    console.log(`\n── 6. Eje de responsabilidad (lo que OR.1 dejó listo y vacío) ──`);
    if (await existe(c, 'identity.responsibilities')) {
      const cat = await c.query(`SELECT count(*)::int AS n FROM identity.responsibilities`);
      const pos = await c.query(
        `SELECT count(*)::int AS n FROM identity.position_responsibilities WHERE deleted_at IS NULL`,
      );
      const usr2 = await c.query(
        `SELECT count(*)::int AS n FROM identity.user_responsibilities WHERE deleted_at IS NULL`,
      );
      console.log(`   catálogo: ${n(cat.rows[0].n)} · puesto→responsabilidad: ${n(pos.rows[0].n)} · excepciones por persona: ${n(usr2.rows[0].n)}`);
      console.log(
        pos.rows[0].n === 0
          ? `   → sigue VACÍO a propósito: «es tuyo» no se puede calcular. La pantalla lo declara.`
          : `   → ya hay mapa: «es tuyo» se puede empezar a calcular.`,
      );
      const faltantes = await c.query(
        `SELECT key FROM identity.responsibilities WHERE key <> ALL($1::text[]) ORDER BY orden`,
        [BANDEJAS.map((b) => b.responsabilidad)],
      );
      const huerfanas = BANDEJAS.filter((b) => b.responsabilidad).map((b) => b.responsabilidad);
      const enCat = (await c.query(`SELECT key FROM identity.responsibilities`)).rows.map((x) => x.key);
      const sinCatalogo = huerfanas.filter((k) => !enCat.includes(k));
      console.log(
        `   biyección bandeja↔responsabilidad: ${sinCatalogo.length === 0 && faltantes.rows.length === 0 ? '✓ 8↔8' : `✗ sin catálogo: [${sinCatalogo.join(', ')}] · sin bandeja: [${faltantes.rows.map((x) => x.key).join(', ')}]`}`,
      );
    } else {
      console.log(`   identity.responsibilities NO existe en prod (¿la migración OR.1b no llegó?).`);
    }

    // ── 7. `[SN.16]` Trabajo CÍCLICO: los periodos y a cuánta gente le tocan ──────────────────
    console.log(`\n── 7. Ciclos por periodo (SN.16) ──`);
    const CICLOS = [
      { id: 'conciliacion-bancaria', anyOf: ['FINANCE_BANK_VER'] },
      { id: 'libro-de-compras', anyOf: ['FISCAL_PURCHASE_BOOK_VER'] },
    ];
    for (const cic of CICLOS) {
      const r = await c.query(
        `${permisoEfectivo}
         SELECT count(DISTINCT u.id)::int AS ven
           FROM identity.users u
          WHERE u.deleted_at IS NULL AND u.activo = true
            AND (lower(u.role_name) = ANY($2::text[])
                 OR EXISTS (SELECT 1 FROM efectivo e
                             WHERE e.user_id = u.id AND e.permiso = ANY($1::text[])))`,
        [cic.anyOf, PLATFORM_ADMIN],
      );
      console.log(`   ${cic.id.padEnd(24)} lo verían ${n(r.rows[0].ven)} persona(s)`);
    }

    /*
     * La consulta REAL del ciclo A, cronometrada. La landing es la primera pantalla de todos:
     * si esto no es barato, el bloque no puede ir ahí. Es UNA pasada con FILTER, no 12 consultas.
     */
    console.log(`\n   Ciclo A · conciliación bancaria (egresos por mes, últimos 12):`);
    const t0 = Date.now();
    const banco = await c.query(
      `SELECT st.period,
              count(*) FILTER (WHERE bm.amount_out > 0)::int AS egresos,
              count(*) FILTER (WHERE bm.amount_out > 0 AND bm.recon_status = 'matched')::int AS casados,
              count(*) FILTER (WHERE bm.amount_out > 0 AND bm.recon_status = 'unmatched')::int AS sin_casar,
              count(*) FILTER (WHERE bm.category_id IS NULL)::int AS sin_clasificar
         FROM finance.bank_movements bm
         JOIN finance.bank_statements st ON st.id = bm.statement_id
        WHERE bm.deleted_at IS NULL
          AND st.period >= to_char((now() AT TIME ZONE 'America/Mexico_City') - interval '11 months', 'YYYY-MM')
        GROUP BY st.period ORDER BY st.period`,
    );
    const msA = Date.now() - t0;
    console.table(banco.rows);
    console.log(`   → ${msA} ms${msA > 150 ? '  ⚠️ pasa de 150 ms: acotar la ventana o diferir el bloque' : '  ✓ barato'}`);

    /*
     * ⚠️ Ciclo B: la versión que contaba los CFDIs de cada mes para decir "faltan N facturas"
     * cuesta **9,144 ms de ejecución en el servidor** (`EXPLAIN ANALYZE`, no ida y vuelta):
     * `fiscal.cfdis` son 167k filas y ni el `Index Only Scan` sobre `ix_fiscal_cfdis_fecha` la
     * salva. Se retiró. El universo de meses lo arma el CALENDARIO en el service y acá sólo se
     * lee el estado — que son 3 filas y tarda 0.9 ms. El número de facturas se DECLARA ausente
     * en vez de pagar 9 s en la primera pantalla que todos abren (ADR-056).
     */
    console.log(`\n   Ciclo B · libro de compras (estado por mes, sin contar CFDIs):`);
    const t1 = Date.now();
    const libro = await c.query(
      `SELECT anio_mes AS periodo, estado, tipo, facturas, renglones
         FROM finance.purchase_book_runs
        WHERE deleted_at IS NULL AND tipo = 'libro'
          AND anio_mes >= to_char((now() AT TIME ZONE 'America/Mexico_City') - interval '11 months', 'YYYY-MM')
        ORDER BY anio_mes`,
    );
    const msB = Date.now() - t1;
    console.table(libro.rows);
    console.log(`   → ${msB} ms de ida y vuelta (latencia base a Railway ≈ 154 ms; la consulta son 0.9 ms)`);
    console.log(
      `   ⚠️ Los meses que NO aparecen arriba no son "sin conciliar": son SIN DATOS. El universo\n` +
        `      de 12 meses se genera en el service y lo ausente se declara (ADR-056).`,
    );

    console.log(`\n═══ fin ═══\n`);
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
