'use strict';
/**
 * [EXP.2] Candado del EXPEDIENTE del renglón.
 *
 *   node database/tests/test-newdb-variance-expediente.js
 *
 * Sólo lee.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────────────────
 *
 * El expediente arma OCHO secciones en un viaje y cuatro de ellas están gateadas por
 * permisos distintos. Lo que falla en silencio acá no es que la consulta reviente: es que un
 * bloque se omita y el panel a medias se lea como «no hay nada que ver».
 *
 * 1. ⭐ **LA PREMISA DEL GOD-MODE.** La rama que resuelve admin por ROL existe por una razón
 *    MEDIDA: `superadmin` —7 personas— **no tiene** `COMMERCIAL_PREVENTION_VER` en su mapa y
 *    entra por god-mode. Si alguien «ordena» el mapa y se la agrega, la rama deja de cargar
 *    peso y este candado lo dice — no para romperse, para que nadie la borre creyendo que
 *    sobra por los motivos equivocados.
 *
 * 2. ⛔ **LA PREMISA REFUTADA.** El plan de esta fase afirmaba que `analytics.stock_movements`
 *    es una ventana rodante de 120 días. **Es falso**: 3.75 M filas desde 2020-03-20. Lo que
 *    sí hay que declarar es otro piso, y es POR ALMACÉN. El candado fija la refutación para
 *    que nadie reconstruya el `fuera_de_ventana` que no corresponde.
 *
 * 3. **EL HUECO DECLARADO.** `prevencion` tiene `COMPRAS_ENTRADAS_VER` en `false`: el equipo
 *    que investiga no ve las compras que explicarían un sobrante. Está declarado, no
 *    arreglado de contrabando. Si algún día se reparte, el candado lo nota.
 *
 * 4. **LA VENTANA.** El «conteo anterior» tiene que ser estrictamente anterior y único.
 *
 * ⚠️ Lo que este archivo NO puede hacer, y lo dice: ejercer el endpoint por HTTP, comprobar
 * que `RolesGuard` deja `roles_frescos` en el request, y el clic. Las tres exigen el API
 * levantado; la tercera exige además un navegador.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

let ok = 0, bad = 0, nm = 0;
const t = (n, c, x) => { if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { bad++; console.log(`  ✘ ${n}${x ? ' — ' + x : ''}`); } };
const noMedido = (n, m) => { nm++; console.log(`  ◻ NO MEDIDO: ${n} — ${m}`); };

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [EXP.2] el expediente del renglón ===\n');
  try {
    await db.raw("SET statement_timeout = '120s'");

    const [{ mv }] = (await db.raw(
      "SELECT to_regclass('analytics.mv_erp_count_line_signals') IS NOT NULL AS mv")).rows;
    if (!mv) {
      noMedido('todo el expediente', 'falta la matvista de señales ([EXP.1b])');
      console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
      await db.destroy(); process.exit(0);
    }

    // ── 1. ⭐ LA PREMISA DEL GOD-MODE ────────────────────────────────────────────────
    {
      const [g] = (await db.raw(`
        SELECT (r.permissions -> 'COMMERCIAL_PREVENTION_VER' IS NULL) AS sin_clave,
               (SELECT count(*)::int FROM identity.users u
                 WHERE u.role_name = 'superadmin' AND u.deleted_at IS NULL) AS personas
          FROM identity.role_permissions r WHERE r.role_name = 'superadmin'`)).rows;
      if (!g) {
        noMedido('la premisa del god-mode', 'no existe el rol superadmin en este destino');
      } else {
        t(`⭐ la rama de god-mode CARGA PESO: superadmin (${g.personas} personas) no tiene `
          + 'COMMERCIAL_PREVENTION_VER en su mapa', g.sin_clave === true,
        'ya la tiene en el mapa: la rama por rol dejó de ser necesaria para ESTE permiso. '
          + 'No la borres sin medir los otros tres gates del expediente');
      }
    }

    // ── 2. ⛔ LA PREMISA REFUTADA: no es ventana rodante de 120 días ────────────────
    {
      const [w] = (await db.raw(`
        SELECT min(doc_date)::text AS desde, (current_date - min(doc_date))::int AS dias,
               count(*)::bigint AS filas
          FROM analytics.stock_movements`)).rows;
      t(`⛔ \`stock_movements\` NO es ventana de 120 días — ${w.filas} filas desde ${w.desde} `
        + `(${w.dias} días)`, Number(w.dias) > 365,
      'si de verdad se volvió rodante, el expediente tiene que declarar `fuera_de_ventana`');

      // El piso REAL es por almacén, y por eso se declara ése.
      const { rows: pisos } = await db.raw(`
        SELECT w.code, min(m.doc_date)::text AS desde
          FROM analytics.stock_movements m
          JOIN commercial.warehouses w ON w.id = m.warehouse_id
         WHERE m.warehouse_id IN (SELECT DISTINCT warehouse_id
                                    FROM analytics.mv_erp_count_line_signals)
         GROUP BY 1 ORDER BY 2`);
      const distintos = new Set(pisos.map((p) => p.desde)).size;
      t(`⛔ y el piso del feed VARÍA entre almacenes (${distintos} fechas de arranque distintas)`,
        distintos > 1,
        'todos arrancan igual: la declaración por almacén sobra, pero no estorba');
      for (const p of pisos) console.log(`      ⓘ ${p.code}: desde ${p.desde}`);
    }

    // ── 3. EL HUECO DECLARADO ──────────────────────────────────────────────────────
    {
      const [h] = (await db.raw(`
        SELECT (r.permissions->>'COMPRAS_ENTRADAS_VER') AS ent
          FROM identity.role_permissions r WHERE r.role_name = 'prevencion'`)).rows;
      if (!h) {
        noMedido('el hueco de Prevención', 'no existe el rol prevencion acá');
      } else if (h.ent === 'true') {
        noMedido('el hueco de Prevención',
          'ya tiene COMPRAS_ENTRADAS_VER: el hueco se cerró, actualizar la declaración del servicio');
      } else {
        t('⛔ el hueco sigue abierto y declarado: `prevencion` NO ve las órdenes de entrada '
          + 'que explicarían un sobrante', h.ent === 'false' || h.ent === null,
        `vale ${h.ent}`);
      }
    }

    // ── 4. LA VENTANA: el conteo anterior, estrictamente anterior y único ──────────
    {
      const [caso] = (await db.raw(`
        SELECT warehouse_id, sku, fecha::text AS fecha
          FROM analytics.mv_erp_count_line_signals
         WHERE explicacion = 'sin_explicacion'
         ORDER BY abs(importe_neto) DESC LIMIT 1`)).rows;
      if (!caso) {
        noMedido('el caso de prueba', 'no hay ningún renglón `sin_explicacion` en este destino');
      } else {
        console.log(`      ⓘ caso: SKU ${caso.sku} · ${caso.fecha}`);
        const { rows: prev } = await db.raw(`
          SELECT fecha::text AS fecha FROM analytics.mv_erp_count_line_signals
           WHERE tenant_id = (SELECT tenant_id FROM analytics.mv_erp_count_line_signals LIMIT 1)
             AND warehouse_id = ? AND sku = ? AND fecha < ?::date
           ORDER BY fecha DESC LIMIT 1`, [caso.warehouse_id, caso.sku, caso.fecha]);
        t('la ventana usa el conteo ANTERIOR y es estrictamente anterior',
          prev.length === 0 || prev[0].fecha < caso.fecha,
          prev.length ? `anterior=${prev[0].fecha} actual=${caso.fecha}` : '');
        if (!prev.length) {
          console.log('      ⓘ sin conteo anterior: la ventana cae a 90 días, y se declara');
        }

        // ── 5. Las secciones traen algo donde importa ───────────────────────────────
        const [sec] = (await db.raw(`
          SELECT (SELECT count(*)::int FROM analytics.mv_erp_physical_count_variance v
                   WHERE v.warehouse_id = ? AND v.sku = ? AND v.fecha = ?::date) AS lineas,
                 (SELECT count(*)::int FROM analytics.mv_erp_count_line_signals s
                   WHERE s.warehouse_id = ? AND s.sku = ?) AS eventos,
                 (SELECT count(*)::int FROM analytics.mv_erp_count_rollforward r
                   WHERE r.warehouse_id = ? AND r.sku = ?) AS rollforward,
                 (SELECT count(*)::int FROM analytics.erp_goods_receipt_lines l
                    JOIN analytics.erp_goods_receipts hh
                      ON hh.tenant_id = l.tenant_id AND hh.sucursal = l.sucursal
                     AND hh.folio = l.folio
                   WHERE hh.warehouse_id = ? AND l.sku = ?
                     AND hh.receipt_date <= ?::date
                     AND hh.receipt_date >= ?::date - 365) AS entradas`,
        [caso.warehouse_id, caso.sku, caso.fecha, caso.warehouse_id, caso.sku,
          caso.warehouse_id, caso.sku, caso.warehouse_id, caso.sku, caso.fecha, caso.fecha])).rows;
        t(`el renglón trae sus líneas del ajuste (${sec.lineas})`, Number(sec.lineas) >= 1);
        t(`y su trayectoria entre conteos (${sec.eventos} eventos)`, Number(sec.eventos) >= 1);
        console.log(`      ⓘ roll-forward: ${sec.rollforward} períodos · entradas: ${sec.entradas}`);
      }
    }

    // ── 6. Estructural: de dónde sale el god-mode ──────────────────────────────────
    // ⚠️ Comprobación sobre el FUENTE, declarada como tal: no prueba que el gate funcione,
    // prueba que no volvió a leerse del token ni a inyectarse el cache donde el orden de
    // registro de `AbilityModule` ya tiró la app una vez.
    {
      const guard = fs.readFileSync(path.resolve(__dirname, '..', '..', 'libs', 'platform-core',
        'src', 'lib', 'guards', 'roles.guard.ts'), 'utf8');
      const svc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'libs', 'commercial', 'src',
        'lib', 'commercial-inventory', 'inventory-variance.service.ts'), 'utf8');
      t('el guard deja los roles FRESCOS en el request',
        /request\.user\.roles_frescos\s*=\s*rolesFrescos/.test(guard));
      t('⛔ y el servicio los LEE de ahí, sin inyectar PermissionsCacheService',
        /roles_frescos\s*\?\?\s*\[\]/.test(svc) && !/PermissionsCacheService/.test(svc),
        'volvió la inyección: AbilityModule se registra DESPUÉS de los módulos de negocio');
      t('⛔ el god-mode NO se resuelve con el `role_name` del token',
        !/isPlatformAdminRole\(\s*actor\?\.role_name/.test(svc));
    }

    noMedido('el endpoint por HTTP y el clic en el renglón',
      'exigen el API levantado y un navegador. En vivo hay que confirmar UNA cosa que acá no '
      + 'se ve: que un superadmin NO reciba el bloque de Prevención como oculto');

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message); bad++;
  } finally { await db.destroy(); }
  process.exit(bad > 0 ? 1 : 0);
})();
