#!/usr/bin/env node
/**
 * `[RE.28]` — **El rol de cada hoja, que es lo que hace posible la hoja interna.**
 *
 * La regresión que este smoke existe para que no vuelva: `/compras/entradas` —la worklist que
 * RE.13 volvió el camino principal de captura— **fijaba `role: 'factura'`**. El selector de rol y
 * el checklist de documentos vivían sólo en el otro wizard, como miembros privados de su clase.
 *
 * Resultado medido en prod el 2026-09-07, con la partición en el 27-ago (el día que la worklist
 * se volvió el camino principal):
 *
 *   · hasta el 27-ago: 129 comprobantes · **93 con hoja interna** · 63 con folio leído
 *   · desde el 27-ago:  56 comprobantes · **0** con hoja interna · **0** folio
 *
 * O sea que los dos controles de `[RE.25]` y `[RE.26]` —`paquete_ok` y `folio_interno`— quedaron
 * **muertos en origen durante 11 días**, y no por el OCR: la pantalla no podía declarar el rol.
 *
 * Lo que se fija acá:
 *   1. Que la worklist NO vuelva a clavar el rol.
 *   2. Que las reglas (`ROLE_TO_TYPE`, `REQUIRED_BY_SOURCE`) vivan en el módulo compartido y no
 *      dentro de un componente — que es *por qué* la otra pantalla no las tenía.
 *   3. Que todo rol que exista en los datos sea un rol que el módulo sepa traducir. Un rol que el
 *      mapa no conoce no rompe nada visible: simplemente deja de contar para `paquete_ok`, en
 *      silencio.
 *
 * Correr: node database/tests/test-newdb-receipt-roles.js
 *         DATABASE_URL_NEW=<prod> node database/tests/test-newdb-receipt-roles.js
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const RAIZ = path.resolve(__dirname, '../../apps/view/src/app/modules/compras');
const F_WORKLIST = path.join(RAIZ, 'pages/compras-entradas-pendientes.component.ts');
const F_LISTADO = path.join(RAIZ, 'pages/compras-entradas.component.ts');
const F_REGLAS = path.join(RAIZ, 'receipt-roles.ts');
/** El día que la worklist se volvió el camino principal de captura (RE.13). */
const CORTE = '2026-08-27';

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
};
const leer = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

(async () => {
  let knex = null;
  try {
    // ── 1. La worklist declara el rol ────────────────────────────────────────
    console.log('\n═══ 1. La worklist no clava el rol ═══');
    const worklist = leer(F_WORKLIST);
    assert(!!worklist, 'se encontró la pantalla de captura');

    // Las dos líneas exactas del defecto viven dentro de `guardar()`: el rol que se manda al
    // subir y el que viaja en el `ProofFile`. Se acota el recorte a ese método porque
    // `role: 'factura'` como **default de la hoja nueva** es legítimo y deseable — el 90% de lo
    // que se sube es una factura y no debe costar un clic. Lo que no puede pasar es que el
    // payload lo clave, ignorando lo que el capturista eligió.
    const ini = (worklist || '').indexOf('\n  guardar(): void {');
    const fin = (worklist || '').indexOf('\n  }\n', ini + 10);
    assert(ini > 0 && fin > ini, 'se localizó el cuerpo de `guardar()` para inspeccionarlo');
    // Si el ancla falla el bloque queda VACÍO, y un regex sobre vacío no matchea nunca: los dos
    // asserts de abajo se pondrían verdes sin haber mirado nada. Por eso el ancla se afirma antes
    // y el bloque se deja en `null` para que el resto falle en vez de mentir.
    const guardar = ini > 0 && fin > ini ? (worklist || '').slice(ini, fin) : null;
    assert(
      guardar !== null && !/uploadFile\(\s*[^,)]+,\s*'[a-z_]+'\s*\)/.test(guardar),
      '`uploadFile()` no manda un rol literal — sale de la hoja',
    );
    assert(
      guardar !== null && !/\.\.\.up,\s*role:\s*'[a-z_]+'/.test(guardar),
      'el `ProofFile` no clava el rol — sale de la hoja',
    );
    assert(
      guardar !== null && /role:\s*h\.role/.test(guardar),
      'el payload usa `h.role` (lo que el capturista declaró)',
    );

    // ── 2. Las reglas viven afuera ───────────────────────────────────────────
    console.log('\n═══ 2. Las reglas son compartidas, no privadas de una pantalla ═══');
    const reglas = leer(F_REGLAS);
    assert(!!reglas, '`receipt-roles.ts` existe (al lado de `receipt-verdict.ts`)');
    for (const clave of ['ROLE_TO_TYPE', 'REQUIRED_BY_SOURCE', 'ROLE_OPTS_KEPLER', 'ROLE_OPTS_WINCAJA']) {
      assert(new RegExp(`export const ${clave}\\b`).test(reglas || ''), `\`${clave}\` se exporta del módulo compartido`);
    }
    // El invariante de fondo: que NO estén definidas dentro de un componente. Si
    // alguien las vuelve a declarar ahí, la otra pantalla vuelve a quedarse sin ellas.
    const listado = leer(F_LISTADO);
    for (const clave of ['ROLE_TO_TYPE', 'REQUIRED_BY_SOURCE']) {
      const definidaEnComponente = new RegExp(`(readonly|private|const)\\s+${clave}\\s*:`).test(listado || '');
      assert(!definidaEnComponente, `\`${clave}\` NO vuelve a definirse dentro del componente del listado`);
    }
    assert(
      /from '\.\.\/receipt-roles'/.test(worklist || '') && /from '\.\.\/receipt-roles'/.test(listado || ''),
      'las DOS pantallas importan las reglas del mismo módulo',
    );

    // ── 3. Contra los datos ──────────────────────────────────────────────────
    const DST = process.env.DATABASE_URL_NEW;
    if (!DST) {
      console.log('\n  ⚠️  sin DATABASE_URL_NEW — los bloques de datos quedan SIN VERIFICAR');
    } else {
      knex = require('knex')({
        client: 'pg',
        connection: /localhost|127\.0\.0\.1|192\.168/.test(DST) ? DST : { connectionString: DST, ssl: { rejectUnauthorized: false } },
        pool: { min: 0, max: 3 },
      });

      console.log('\n═══ 3. Todo rol de los datos es un rol que el módulo traduce ═══');
      const { rows: enDatos } = await knex.raw(
        `SELECT DISTINCT f->>'role' AS rol
           FROM finance.goods_receipt_proofs p, jsonb_array_elements(p.files) f
          WHERE f->>'role' IS NOT NULL`);
      const roles = enDatos.map((r) => r.rol);
      if (!roles.length) {
        console.log('  ⚠️  no hay evidencia con rol en este ambiente — SIN VERIFICAR');
      } else {
        // El invariante es que el módulo CONOZCA el rol, no que lo mapee a un tipo. `evidencia`
        // es deliberadamente un cajón sin tipo —"otra evidencia" no cumple ningún requisito del
        // checklist y así debe ser—, pero sí es una opción declarada del selector.
        //
        // Lo que sí es un defecto silencioso es un rol que el módulo no conoce por ningún lado:
        // no rompe nada visible, simplemente deja de contar para `paquete_ok` sin avisar.
        const mapa = (reglas || '').slice((reglas || '').indexOf('ROLE_TO_TYPE'), (reglas || '').indexOf('export const DOC_LABEL'));
        const opciones = (reglas || '').slice((reglas || '').indexOf('ROLE_OPTS_KEPLER'));
        const conocido = (r) => new RegExp(`\\b${r}\\s*:`).test(mapa) || new RegExp(`value:\\s*'${r}'`).test(opciones);
        const huerfanos = roles.filter((r) => !conocido(r));
        assert(
          huerfanos.length === 0,
          `los ${roles.length} roles de los datos los conoce el módulo (huérfanos: ${huerfanos.join(',') || 'ninguno'})`,
        );
        // Y el que importa para los controles de RE.25/RE.26 sí tiene que mapear.
        assert(
          /orden_entrada:\s*'aplica_orden_entrada'/.test(mapa) && /\bvale:\s*'vale'/.test(mapa),
          'los roles de la HOJA INTERNA (`orden_entrada`, `vale`) mapean a su tipo — son los que alimentan `paquete_ok`',
        );
      }

      // ── 4. El hecho histórico que motiva todo esto ─────────────────────────
      console.log('\n═══ 4. La regresión medida (histórico, no cambia) ═══');
      const { rows: [h] } = await knex.raw(`
        SELECT
          count(DISTINCT p.id) FILTER (WHERE p.created_at::date <= ?)::int AS antes,
          count(DISTINCT p.id) FILTER (WHERE p.created_at::date <= ? AND f->>'role' IN ('orden_entrada','vale'))::int AS antes_hoja,
          count(DISTINCT p.id) FILTER (WHERE p.created_at::date >  ?)::int AS despues,
          count(DISTINCT p.id) FILTER (WHERE p.created_at::date >  ? AND f->>'role' IN ('orden_entrada','vale'))::int AS despues_hoja
        FROM finance.goods_receipt_proofs p
        LEFT JOIN LATERAL jsonb_array_elements(p.files) f ON true`,
        [CORTE, CORTE, CORTE, CORTE]);
      console.log(`     hasta ${CORTE}: ${h.antes} comprobantes · ${h.antes_hoja} con hoja interna`);
      console.log(`     desde ${CORTE}: ${h.despues} comprobantes · ${h.despues_hoja} con hoja interna`);
      assert(
        Number(h.antes_hoja) > 0,
        `antes del corte SÍ se declaraba la hoja interna (${h.antes_hoja} de ${h.antes}) — o sea que el flujo servía`,
      );

      // Lo que NO se puede afirmar todavía: que la corrección funcionó. Eso se
      // sabe cuando haya evidencia subida DESPUÉS del arreglo, y hasta entonces
      // se DECLARA en vez de dibujarse como verde (ADR-056).
      const { rows: [post] } = await knex.raw(`
        SELECT count(DISTINCT p.id)::int n,
               count(DISTINCT p.id) FILTER (WHERE f->>'role' NOT IN ('factura'))::int con_otro_rol
          FROM finance.goods_receipt_proofs p
          LEFT JOIN LATERAL jsonb_array_elements(p.files) f ON true
         WHERE p.created_at > now() - interval '7 days'`);
      if (Number(post.n) === 0) {
        console.log('  ⚠️  sin evidencia de los últimos 7 días — la adopción del rol queda NO MEDIDA');
      } else if (Number(post.con_otro_rol) === 0) {
        console.log(`  ⚠️  ${post.n} comprobante(s) en 7 días y NINGUNO con rol distinto de \`factura\`.`);
        console.log('      Si el arreglo ya está desplegado, esto es la regresión todavía viva.');
        console.log('      Si no lo está, es lo esperado. NO MEDIDO hasta el redeploy.');
      } else {
        assert(true, `la evidencia reciente ya declara otros roles (${post.con_otro_rol} de ${post.n} en 7 días)`);
      }
    }

    console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`} — ${pass} aserción(es)`);
  } catch (e) {
    console.error('  ✗ ERROR', e.message);
    fail++;
  } finally {
    if (knex) await knex.destroy();
  }
  process.exit(fail === 0 ? 0 : 1);
})();
