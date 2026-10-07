#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[RL.11]` Pone al día la SUSCRIPCIÓN de cada réplica Kepler: suscribe las tablas que el
 * publicador ya publica y el suscriptor todavía no escucha — creándolas primero si en la réplica
 * ni siquiera existen.
 *
 * ── El problema que resuelve ────────────────────────────────────────────────────────────────
 * La publicación de los POS es `ods_pub_pilot FOR TABLES IN SCHEMA md`: una tabla nueva en el
 * origen **entra sola a la publicación**. Pero el suscriptor NO se entera hasta que alguien corre
 * `ALTER SUBSCRIPTION … REFRESH PUBLICATION`. Y Kepler crea una tabla de póliza **por mes**
 * (`kdc2YYMM`).
 *
 * O sea: cada 1° de mes la contabilidad del mes nuevo deja de replicarse, y **nada se pone rojo** —
 * la suscripción sigue `enabled`, el apply worker sano, el lag en segundos. La tabla simplemente
 * no está en `pg_subscription_rel`, así que no hay nada que pueda fallar.
 *
 * Es un modo de falla DISTINTO al de `kepler-pos-grant-ods.js` (§4.2b), aunque se parezcan:
 *   · §4.2b        → la tabla SÍ está suscrita, pero `ods_repl` no la puede leer → queda en
 *                    `srsubstate='d'` reintentando para siempre. **Se ve** en pg_subscription_rel.
 *   · éste (RL.11) → la tabla NO está suscrita. **No se ve en ningún lado.**
 * Los dos pegaron a la vez en septiembre 2026, y el primero tapaba al segundo.
 *
 * Medido el 2026-09-18, después de cerrar §4.2b (13 tablas trabadas → 0):
 *   · `kdc22609` (septiembre) sin suscribir en `md_06` Canindo → 6,322 documentos de septiembre
 *     con CERO renglones de póliza replicados, mientras agosto sí tenía 1,971.
 *   · `kdc22610` (octubre) sin suscribir en **7 de 9 ramas** → el 1-oct se repetía completo.
 *
 * ── ⛔ La tercera capa: REFRESH es atómico y aborta por una tabla que no existe acá ──────────
 * Si el origen publica una tabla que la réplica no tiene, el `REFRESH` entero falla con
 * `relation "md.X" does not exist` y **no suscribe ninguna** — ni las que sí podía. Medido: 14
 * tablas así en `md_00`, `md_02` y `md_06` (RH, nómina CFDI, y dos pólizas viejas), heredadas de
 * instalaciones de Kepler con versiones distintas entre plazas.
 *
 * Por eso el script crea la tabla que falta y reintenta. El DDL sale de **otra réplica que sí la
 * tenga** (donante), no del origen: las contraseñas de los POS no son uniformes (lección de
 * `kepler-pos-grant-ods.js`) y acá no hace falta tocarlos. Antes de copiar, compara la firma
 * (columnas + tipos + NOT NULL + PK) en **todas** las réplicas que la tengan: si no son idénticas,
 * NO adivina — declara la tabla y sigue. Verificado el 2026-09-18: las 8 tablas huérfanas con
 * donante tenían firma idéntica en las 2-4 ramas que las tenían.
 *
 * ⚠️ Y si el DDL igual estuviera mal, el modo de falla es VISIBLE: el tablesync de esa tabla no
 * llega a 'r'. Por eso el veredicto de acá es el ESTADO re-medido, no que el comando no falle.
 *
 * ── ⚠️ Los permisos de la tabla nueva salen de una hermana, no del default ──────────────────
 * El `pg_default_acl` del schema `md` en la réplica otorga a `platform_ro` y `dev_ro` pero **no a
 * `app_runtime`** — el mismo cable cruzado que causó §4.2b, de este lado. Una tabla creada a secas
 * nacería invisible para la app. Así que se copian los grants de una tabla de referencia de la
 * MISMA réplica (`md.kdm1`), que es lo que de verdad consumen los carriles.
 *
 *   node database/scripts/kepler-replica-refresh.js --dry        # reporta, no toca nada
 *   node database/scripts/kepler-replica-refresh.js              # aplica
 *   node database/scripts/kepler-replica-refresh.js --branch=06
 *
 * Se corre contra el contenedor de réplicas (`KEPLER_REPLICA_BASE`, hoy `md` :5433), NO contra los
 * POS. No pide contraseña: la credencial de la réplica ya vive en `kepler-branches`.
 */
const { Client } = require('pg');
const { BRANCHES, replicaDbName, stockMap } = require('../importers/lib/kepler-branches');
const hb = require('../importers/lib/cron-heartbeat');

// ⚠️ DOS destinos distintos y no se pueden confundir (GOTCHAS §17/§18): las réplicas salen de
// `KEPLER_REPLICA_BASE` (el contenedor :5433 de `md`) y el LATIDO va a prod por
// `DATABASE_URL_NEW`, que es lo que lee `cron-heartbeat`. Si se cruzan, el tablero de prod nunca
// se entera de que este carril existe — que es exactamente el modo de falla que el carril combate.
// Override de la llave del latido, mismo idioma que `CONTPAQI_HB_KEY` en el carril de ContPAQi:
// sirve para ejercer el camino de FALLA sin escribirle `error` al sensor real del tablero.
const HB_KEY = process.env.RL11_HB_KEY || 'kepler_replica_refresh';

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];
const DRY = process.argv.includes('--dry');
const SOLO = arg('branch', '');
// El cluster de RÉPLICAS. `ODS_SOURCE_BASE` es la var que ya significa exactamente eso dentro del
// contenedor de feeds de `md` (la usan los carriles del ODS), así que se acepta como respaldo en vez
// de repartir un secreto nuevo. ⚠️ Nunca `DATABASE_URL_NEW`: ésa es PROD, y acá se hace DDL.
const BASE = process.env.KEPLER_REPLICA_BASE || process.env.ODS_SOURCE_BASE
  || 'postgresql://postgres:superoot@localhost:5433/postgres';
const REF = 'md.kdm1'; // tabla de referencia para dueño y grants — existe en las 9 réplicas
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function conectar(code, extra = {}) {
  const u = new URL(BASE);
  u.pathname = `/${replicaDbName(code)}`;
  return new Client({ connectionString: u.toString(), connectionTimeoutMillis: 15000, statement_timeout: 300000, ...extra });
}

/** Firma comparable de una tabla: columnas con tipo y NOT NULL, más la PK. Vacío si no existe. */
const SQL_FIRMA = `
  SELECT string_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
                    ', ' ORDER BY a.attnum) cols,
         (SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p') pk
    FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   WHERE ns.nspname='md' AND c.relname=$1 GROUP BY c.oid`;

/** Roles que pueden leer la tabla de referencia EN ESA MISMA réplica. Derivado, no supuesto. */
const SQL_LECTORES = `
  SELECT r.rolname FROM pg_roles r
   WHERE r.rolname <> 'postgres' AND NOT r.rolsuper
     AND has_table_privilege(r.rolname, $1, 'SELECT') ORDER BY 1`;

/**
 * `[AUD-DAT.9]` Último recurso: el DDL sale del **ORIGEN** cuando NINGUNA réplica lo tiene.
 *
 * ── Por qué esto contradice la cabecera, y por qué igual va ─────────────────────────────────
 * El encabezado dice que el DDL sale de otra réplica «no del origen: las contraseñas de los POS
 * no son uniformes … y acá no hace falta tocarlos». Las dos mitades eran ciertas cuando se
 * escribió y una dejó de serlo:
 *
 *   · «no hace falta tocarlos» valía mientras la tabla existiera en ALGUNA réplica. El
 *     2026-09-25 el POS estrenó `md_prom_comb` y `md_prom_comb2` en las 8 sucursales A LA VEZ,
 *     así que no hubo donante posible y el carril quedó en rojo con las 9 ramas trabadas.
 *   · «las contraseñas no son uniformes» sigue siendo cierto — y por eso NO se inventa una
 *     conexión: se usa el MISMO mapa que ya usan los importers (`stockMap()` /
 *     `STOCK_BRANCH_MAP`), que alcanza a las 8 ramas todos los días desde `feeds-cron`.
 *
 * ⛔ LO QUE ESTO EVITABA NO ERA UN ROJO COSMÉTICO. `REFRESH PUBLICATION` es ATÓMICO: una tabla
 * publicada que la réplica no tiene aborta el refresh ENTERO y no suscribe ninguna. Kepler crea
 * una tabla de póliza POR MES (`kdc2YYMM`), así que el bloqueo del 25-sep se habría comido la
 * suscripción de `kdc22610` el 1-oct **en las nueve ramas**: la contabilidad de octubre, sin
 * replicar. Medido al destrabarlo a mano: +18 tablas suscritas (2 × 9).
 *
 * Misma disciplina que el donante, sin excepciones: se compara la firma en TODOS los orígenes
 * alcanzables y si difieren **no se adivina**. Verificado el 2026-09-28 en las dos tablas: firma
 * idéntica en las 8 ramas, 0 filas en todas.
 *
 * Devuelve {cols, pk, donantes} · {motivo} · o null si el mapa no está disponible.
 */
async function buscarEnOrigen(tabla) {
  let MAP;
  try {
    MAP = process.env.STOCK_BRANCH_MAP ? JSON.parse(process.env.STOCK_BRANCH_MAP) : stockMap();
  } catch { return null; }
  if (!Array.isArray(MAP) || !MAP.length) return null;

  const vistas = new Map();
  for (const m of MAP) {
    const suc = (String(m.url).match(/md_(\d{2})\b/) || [])[1] || m.code;
    const c = new Client({ connectionString: m.url, connectionTimeoutMillis: 6000, statement_timeout: 20000 });
    try { await c.connect(); } catch { continue; } // una plaza sin red no es un error DE ESTA TABLA
    try {
      const r = (await c.query(SQL_FIRMA, [tabla])).rows[0];
      if (r) {
        const k = `${r.pk || '(sin pk)'}|${r.cols}`;
        if (!vistas.has(k)) vistas.set(k, { cols: r.cols, pk: r.pk, ramas: [] });
        vistas.get(k).ramas.push(suc);
      }
    } catch { /* la rama no contesta: no vota */ }
    finally { await c.end().catch(() => {}); }
  }
  if (!vistas.size) return null;
  if (vistas.size > 1) {
    return { motivo: `el DDL DIFIERE entre ORÍGENES (${[...vistas.values()].map((v) => v.ramas.join('+')).join(' vs ')}) — no se adivina` };
  }
  const v = [...vistas.values()][0];
  return { cols: v.cols, pk: v.pk, donantes: v.ramas.map((x) => `origen:${x}`) };
}

/** Busca el DDL de una tabla en las demás réplicas. Devuelve {cols, pk, donantes} o {motivo}. */
async function buscarDonante(tabla, excluir) {
  const vistas = new Map();
  for (const b of BRANCHES) {
    if (b.code === excluir) continue;
    const c = conectar(b.code, { statement_timeout: 30000 });
    try { await c.connect(); } catch { continue; }
    try {
      const r = (await c.query(SQL_FIRMA, [tabla])).rows[0];
      if (!r) continue;
      const k = `${r.pk || '(sin pk)'}|${r.cols}`;
      if (!vistas.has(k)) vistas.set(k, { cols: r.cols, pk: r.pk, ramas: [] });
      vistas.get(k).ramas.push(b.code);
    } catch { /* la rama no contesta: no es donante, y no es un error de esta tabla */ }
    finally { await c.end().catch(() => {}); }
  }
  if (!vistas.size) {
    // Ninguna réplica la tiene: se le pregunta al ORIGEN antes de rendirse (ver `[AUD-DAT.9]`).
    const org = await buscarEnOrigen(tabla);
    if (org) return org;
    return { motivo: 'ninguna réplica ni origen alcanzable la tiene — hace falta el DDL del POS' };
  }
  if (vistas.size > 1) {
    return { motivo: `el DDL DIFIERE entre réplicas (${[...vistas.values()].map((v) => v.ramas.join('+')).join(' vs ')}) — no se adivina` };
  }
  const v = [...vistas.values()][0];
  return { cols: v.cols, pk: v.pk, donantes: v.ramas };
}

async function unaRama(b) {
  const out = { rama: b.code, nombre: b.name, creadas: [], declaradas: [], agregadas: 0 };
  const c = conectar(b.code);
  try { await c.connect(); } catch (e) {
    out.error = (e.message || '').split('\n')[0].slice(0, 80); return out;
  }
  try {
    // ⚠️ `pg_subscription` es un catálogo COMPARTIDO del cluster: desde CUALQUIER base lista las 9
    // suscripciones. Sin el filtro por `subdbid`, un `LIMIT 1` devuelve la primera alfabética
    // (`sub_md_00`) y el REFRESH se lanza contra la rama equivocada. Pasó al primer intento.
    const sub = (await c.query(
      `SELECT subname FROM pg_subscription
        WHERE subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0];
    if (!sub) { out.error = 'la réplica no tiene suscripción propia'; return out; }
    out.sub = sub.subname;
    out.antes = Number((await c.query(`SELECT count(*)::int n FROM pg_subscription_rel`)).rows[0].n);

    // Lo que ya está acá y no está suscrito: lo ÚNICO que se puede saber sin intentar el REFRESH.
    out.localesSinSuscribir = (await c.query(`
      SELECT c.relname t FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
       WHERE ns.nspname='md' AND c.relkind='r'
         AND NOT EXISTS (SELECT 1 FROM pg_subscription_rel sr WHERE sr.srrelid=c.oid) ORDER BY 1`)).rows.map((r) => r.t);

    if (DRY) { out.despues = out.antes; return out; }

    const lectores = (await c.query(SQL_LECTORES, [REF])).rows.map((r) => r.rolname);
    const dueno = (await c.query(`SELECT pg_get_userbyid(relowner) d FROM pg_class WHERE oid=$1::regclass`, [REF])).rows[0].d;

    // Reintenta: cada REFRESH fallido nombra UNA tabla ausente. El tope corta un lazo infinito.
    for (let intento = 0; intento < 25; intento++) {
      try { await c.query(`ALTER SUBSCRIPTION ${out.sub} REFRESH PUBLICATION`); break; } catch (e) {
        const m = /relation "(?:md\.)?([^".]+)" does not exist/.exec(e.message || '');
        if (!m || e.code !== '42P01') { out.error = (e.message || '').split('\n')[0].slice(0, 90); return out; }
        const tabla = m[1];
        if (out.declaradas.some((d) => d.tabla === tabla)) {
          out.error = `el REFRESH sigue pidiendo '${tabla}' después de declararla — se corta`; return out;
        }
        const d = await buscarDonante(tabla, b.code);
        if (d.motivo) { out.declaradas.push({ tabla, motivo: d.motivo }); break; }
        await c.query(`CREATE TABLE md.${tabla} (${d.cols}${d.pk ? `, ${d.pk}` : ''})`);
        await c.query(`ALTER TABLE md.${tabla} OWNER TO "${dueno}"`);
        for (const rol of lectores) await c.query(`GRANT SELECT ON md.${tabla} TO "${rol}"`);
        out.creadas.push(`${tabla}<-${d.donantes.join('/')}`);
      }
    }

    out.despues = Number((await c.query(`SELECT count(*)::int n FROM pg_subscription_rel`)).rows[0].n);
    out.agregadas = out.despues - out.antes;

    // El veredicto es el ESTADO re-medido, no que el comando no haya fallado.
    if (out.agregadas > 0) {
      for (let i = 0; i < 40; i++) {
        await espera(3000);
        const p = (await c.query(`SELECT c.relname t, sr.srsubstate s FROM pg_subscription_rel sr
                                    JOIN pg_class c ON c.oid=sr.srrelid WHERE sr.srsubstate<>'r' ORDER BY 1`)).rows;
        out.pendientes = p.map((x) => `${x.t}(${x.s})`);
        if (!p.length) { out.segundos = (i + 1) * 3; break; }
      }
    }
    // ⛔⛔ EL VEREDICTO QUE FALTABA (2026-09-21). Todo lo de arriba puede estar verde con la rama
    // MUERTA: si el origen creó una tabla después del último REFRESH y alguien le escribió una
    // fila, el apply worker recibe un cambio para una relación que no existe acá, **muere**, y
    // Postgres lo relanza cada 60 s para siempre. No se pierde esa tabla: se pierde la sucursal.
    // Medido en `sub_md_08`: 2 días caída (929 documentos) con `srsubstate<>'r'` en CERO, el
    // REFRESH devolviendo `+0` y `subenabled = true`. Los tres ciertos, los tres inútiles.
    // El único catálogo que lo ve es `pg_stat_subscription`: worker sin `pid`.
    const w = (await c.query(
      `SELECT pid, latest_end_time,
              round(extract(epoch FROM (now() - latest_end_time)))::int AS seg
         FROM pg_stat_subscription WHERE subname = $1`, [out.sub])).rows[0];
    if (!w || w.pid == null) out.sinWorker = 'la suscripción NO tiene apply worker (rama muerta)';
    else if (w.seg != null && w.seg > 600) out.sinWorker = `el worker no aplica nada hace ${Math.round(w.seg / 60)} min`;
    else out.lagSeg = w.seg;

    return out;
  } catch (e) {
    out.error = (e.message || '').split('\n')[0].slice(0, 90); return out;
  } finally { await c.end().catch(() => {}); }
}

(async () => {
  const ramas = BRANCHES.filter((b) => !SOLO || b.code === SOLO);
  console.log(`\n[RL.11] REFRESH PUBLICATION de las réplicas Kepler · ${DRY ? 'ENSAYO' : 'APLICA'}`);
  console.log(`  ramas: ${ramas.map((b) => b.code).join(', ')}\n`);

  // El ensayo NO late: un latido de un ensayo le dice al tablero que el carril entregó cuando
  // sólo ensayó, y eso es peor que no medir (ADR-056).
  if (!DRY) await hb.begin(HB_KEY, 'Suscripción de réplicas Kepler al día con su publicación');

  const res = [];
  for (const b of ramas) res.push(await unaRama(b));

  let fallaron = 0;
  const motivos = [];
  for (const r of res) {
    const cab = `  ${r.rama} ${String(r.nombre).padEnd(18)}`;
    if (r.error) { console.log(`${cab} ⛔ ${r.error}`); motivos.push(`${r.rama}: ${r.error}`); fallaron++; continue; }
    if (DRY) {
      const l = r.localesSinSuscribir;
      console.log(`${cab} suscritas ${r.antes} · en la réplica sin suscribir: ${l.length ? l.join(' ') : '(ninguna)'}`);
      continue;
    }
    console.log(`${cab} suscritas ${r.antes} -> ${r.despues} (+${r.agregadas})`
      + (r.segundos != null ? ` · todas en 'r' en ${r.segundos}s` : '')
      + (r.lagSeg != null ? ` · worker vivo, ${r.lagSeg}s` : ''));
    if (r.sinWorker) {
      console.log(`       ⛔ ${r.sinWorker} — ver el motivo con:`);
      console.log('          docker logs --since 30m pgvector-md 2>&1 | grep -iE "ERROR|does not exist" | tail');
      motivos.push(`${r.rama}: ${r.sinWorker}`); fallaron++;
    }
    if (r.creadas.length) console.log(`       creadas en la réplica: ${r.creadas.join(' ')}`);
    for (const d of r.declaradas) {
      console.log(`       ⛔ NO se pudo suscribir '${d.tabla}': ${d.motivo}`);
      motivos.push(`${r.rama}/${d.tabla}: ${d.motivo}`); fallaron++;
    }
    if (r.pendientes && r.pendientes.length) {
      console.log(`       ⛔ siguen fuera de 'r': ${r.pendientes.join(' ')}`);
      motivos.push(`${r.rama}: fuera de 'r' ${r.pendientes.join(' ')}`); fallaron++;
    }
  }

  console.log('');
  if (DRY) {
    console.log('⚠️ El ensayo sólo ve lo que YA existe en la réplica sin suscribir. Las tablas que');
    console.log('   existen SÓLO en el origen no se pueden enumerar sin intentar el REFRESH — se');
    console.log('   descubren de a una al aplicar. No se dibujan acá como cero.');
    process.exit(0);
  }

  const agregadas = res.reduce((a, r) => a + (r.agregadas || 0), 0);
  const creadas = res.reduce((a, r) => a + r.creadas.length, 0);
  if (fallaron) {
    console.log(`⛔ ${fallaron} pendiente(s). Lo declarado necesita el DDL del POS (ver el motivo de cada una).`);
  } else {
    console.log('✅ las réplicas, al día con su publicación.');
  }

  // El latido reporta ENTREGA, no "el script corrió": `ok` sólo si TODAS las ramas quedaron con
  // su publicación cubierta y nada fuera de 'r'. Una rama inalcanzable es `error`, no silencio.
  await hb.end(HB_KEY, {
    status: fallaron ? 'error' : 'ok',
    rows: agregadas,
    note: `${res.length} ramas · +${agregadas} tablas suscritas · ${creadas} creadas desde donante`,
    error: fallaron ? motivos.join(' | ').slice(0, 500) : null,
  });
  process.exit(fallaron ? 1 : 0);
})();
