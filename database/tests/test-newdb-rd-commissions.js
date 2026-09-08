/* eslint-disable no-console */
/**
 * [RD.6] CANDADO del motor de comisiones de Ruta Directa.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * Esto paga: 13 choferes y 3 supervisores, cada quincena. El Excel que reemplaza tiene al
 * menos diez defectos que mueven dinero (FASE_RD §4), y la migración los corrige en vez de
 * copiarlos — pero un defecto corregido sin prueba negativa vuelve solo en el siguiente
 * cambio de tabulador. Cada corrección de §4 tiene acá su aserción que se rompe si alguien
 * la deshace.
 *
 * ── LO QUE YA SE MIDIÓ, PARA NO REPETIRLO ────────────────────────────────────────────────
 * Alimentando el motor con el SUBTOTAL/VENTA del propio Excel, reproduce **163 de 163**
 * celdas periodo×ruta al centavo, en las cinco columnas (% del tabulador, comisión del
 * chofer, parte del supervisor, nómina de banco y A PAGAR). La aritmética no está en duda.
 * End-to-end contra la venta derivada del ERP baja a 72%, y esa diferencia es del DATO, no
 * del motor: tramo push con subtotal derivado (±1%), 40 celdas que el Excel parchea a mano
 * y 160 sin fuente diaria (FASE_RD §2.2 y §2.4). Por eso este candado verifica la ESCALA y
 * las CORRECCIONES, no vuelve a medir la aritmética.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-commissions.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

/** El mismo criterio que `pickTier` del service: min inclusivo, max exclusivo, NULL = ∞. */
const TIER_SQL = `
  SELECT pct FROM commercial.commission_scale_tiers
   WHERE scale_id = $1 AND deleted_at IS NULL
     AND $2::numeric >= min_amount
     AND (max_amount IS NULL OR $2::numeric < max_amount)
   ORDER BY min_amount DESC LIMIT 1`;

(async () => {
  const db = new Client({
    connectionString: URL,
    statement_timeout: 60000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  await db.query('SET default_transaction_read_only = on');
  await db.query(`SET app.tenant_id = '${TENANT}'`);
  console.log(`\n=== [RD.6] motor de comisiones · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  const { rows: [scale] } = await db.query(
    `SELECT * FROM commercial.commission_scales
      WHERE tenant_id = $1 AND code = 'RD-2026' AND deleted_at IS NULL`, [TENANT]);

  if (!scale) {
    noMedido('escala RD-2026', 'no está sembrada en este destino (falta 20260908120100)');
    console.log(`\n=== ${ok} OK · ${fail} fallas · ${nm} NO MEDIDOS ===\n`);
    await db.end();
    process.exit(fail ? 1 : 0);
  }

  // ── 1. La escala ─────────────────────────────────────────────────────────────────────
  console.log('\n1) La escala y su base de cálculo');
  check('la comisión se calcula sobre SUBTOTAL', scale.base_field === 'subtotal', `base_field=${scale.base_field}`);
  check('la compuerta la abre TOTAL VENTA', scale.gate_field === 'venta', `gate_field=${scale.gate_field}`);
  check('el supervisor se lleva 20%', Number(scale.share_supervisor_pct) === 20, `${scale.share_supervisor_pct}`);

  const { rows: tiers } = await db.query(
    `SELECT min_amount::float8 min, max_amount::float8 max, pct::float8 pct
       FROM commercial.commission_scale_tiers
      WHERE scale_id = $1 AND deleted_at IS NULL ORDER BY min_amount`, [scale.id]);

  console.log('\n2) Los escalones');
  check(`hay escalones (${tiers.length})`, tiers.length >= 2);
  // Contiguos: el techo de uno es el piso del siguiente. Un hueco es una venta que no paga
  // nada sin que nadie lo haya decidido.
  const huecos = tiers.slice(0, -1).filter((t, i) => t.max !== tiers[i + 1].min);
  check('los escalones son contiguos (sin huecos ni traslapes)', huecos.length === 0,
    `${huecos.length} cortes no empatan`);
  // §4.6 — el Excel cerraba con IF(venta<400000,"5%") sin else: 400,000 devolvía FALSE y
  // pagaba CERO en la venta más alta.
  check('el escalón de arriba NO tiene techo (§4.6)', tiers[tiers.length - 1].max === null,
    'con techo, una venta por encima no paga nada y nadie lo nota');

  // ── 3. Las correcciones, probadas por su NEGATIVO ────────────────────────────────────
  console.log('\n3) Las correcciones del Excel, cada una con su prueba');
  const pctPara = async (monto) => {
    const { rows } = await db.query(TIER_SQL, [scale.id, monto]);
    return rows.length ? Number(rows[0].pct) : null;
  };

  // §4.6 — la prueba que el Excel reprueba.
  check('una venta de $400,000 paga 5% (el Excel pagaba 0)', (await pctPara(400000)) === 5,
    `devolvió ${await pctPara(400000)}`);
  check('una venta de $1,000,000 sigue pagando 5%', (await pctPara(1000000)) === 5);

  // §4.4 — un solo umbral. El Excel usaba 169,999.99 en las rutas 22 y 23.
  check('$175,000 NO paga: está bajo el único umbral (§4.4)', (await pctPara(175000)) === null,
    'volvió el umbral de 169,999.99 que el Excel tenía sólo en las rutas 22 y 23');
  check('$189,999.99 paga (el piso es inclusivo)', (await pctPara(189999.99)) === 3.75);
  check('$189,999.98 no paga', (await pctPara(189999.98)) === null);

  // Los cuatro escalones, en su valor exacto.
  for (const [monto, esperado] of [[190000, 3.75], [195000, 4.25], [200000, 4.562], [216000, 5]]) {
    const got = await pctPara(monto);
    check(`$${monto.toLocaleString()} → ${esperado}%`, got === esperado, `devolvió ${got}`);
  }

  // ── 4. Las rutas ─────────────────────────────────────────────────────────────────────
  console.log('\n4) La configuración por ruta');
  const { rows: cfg } = await db.query(
    `SELECT route_code, nomina_banco::float8 nomina, zona, chofer_nombre, supervisor_nombre
       FROM commercial.commission_route_config
      WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY route_code`, [TENANT]);
  check(`están las 13 rutas (${cfg.length})`, cfg.length === 13);
  // §4.7 — el Excel tenía SEIS valores para el mismo concepto repartidos entre hojas.
  // Medido contra la hoja COMISIONES, que es la que produce A PAGAR: 3,484.96 en PH y
  // Morelia, 5,000 en Canindo. Dos valores, uno por zona, y ninguna ruta sin él.
  const nominas = [...new Set(cfg.map((c) => c.nomina))].sort((a, b) => a - b);
  check(`la nómina de banco tiene UN valor por zona, no seis (${nominas.join(' / ')})`,
    nominas.length === 2 && nominas[0] === 3484.96 && nominas[1] === 5000,
    `valores distintos: ${nominas.join(', ')}`);
  check('ninguna ruta se quedó sin nómina', cfg.every((c) => c.nomina > 0));
  // §4.8 — la ruta 28 se caía de la suma del supervisor por vivir fuera de un rango.
  check('la ruta 28 tiene supervisor (§4.8)',
    cfg.some((c) => c.route_code === '28' && !!c.supervisor_nombre));
  // §4.2 — la 322 se quedaba sin factor de supervisor y su chofer cobraba el 100%.
  check('la ruta 322 tiene supervisor (§4.2)',
    cfg.some((c) => c.route_code === '322' && !!c.supervisor_nombre));
  // El Excel tiene la celda del chofer de la 505 vacía. No se inventa un nombre.
  check('la ruta 505 queda SIN chofer, declarado y no inventado',
    cfg.some((c) => c.route_code === '505' && c.chofer_nombre === null));

  // ── 5. Los bonos ─────────────────────────────────────────────────────────────────────
  console.log('\n5) Los bonos');
  const { rows: bon } = await db.query(
    `SELECT beneficiario, comparador, count(*)::int n
       FROM commercial.commission_bonuses
      WHERE scale_id = $1 AND deleted_at IS NULL GROUP BY 1,2 ORDER BY 1,2`, [scale.id]);
  const chofer = bon.find((b) => b.beneficiario === 'chofer');
  const sup = bon.find((b) => b.beneficiario === 'supervisor');
  check('hay 3 bonos de chofer (Lavadas, Lonche, Chalán)', chofer?.n === 3, `${chofer?.n ?? 0}`);
  check('los bonos del chofer comparan con >= como el Excel', chofer?.comparador === 'gte');
  check('los del supervisor comparan con > como el Excel', sup?.comparador === 'gt');
  const { rows: [sinGate] } = await db.query(
    `SELECT count(*)::int n FROM commercial.commission_bonuses
      WHERE scale_id = $1 AND beneficiario = 'supervisor' AND gate_venta_min IS NULL AND deleted_at IS NULL`, [scale.id]);
  check('todo bono de supervisor lleva su compuerta de venta mínima', sinGate.n === 0, `${sinGate.n} sin compuerta`);

  // ── 6. Los periodos ──────────────────────────────────────────────────────────────────
  console.log('\n6) Las quincenas');
  const { rows: [per] } = await db.query(
    `SELECT count(*)::int n,
            count(*) FILTER (WHERE date_to - date_from <> 13)::int no_quincenales,
            min(date_from)::text d0, max(date_to)::text d1
       FROM commercial.commission_periods WHERE tenant_id = $1 AND anio = 2026 AND deleted_at IS NULL`, [TENANT]);
  check(`hay 27 periodos de 2026 (${per.n})`, per.n === 27);
  check('todos duran 14 días', per.no_quincenales === 0, `${per.no_quincenales} no`);
  check(`arrancan el 2026-01-01 (${per.d0})`, per.d0 === '2026-01-01');
  // Ningún día del año puede quedar en dos periodos ni fuera de todos.
  const { rows: [solape] } = await db.query(
    `SELECT count(*)::int n FROM commercial.commission_periods a
       JOIN commercial.commission_periods b
         ON b.tenant_id = a.tenant_id AND b.id <> a.id
        AND b.date_from <= a.date_to AND b.date_to >= a.date_from
      WHERE a.tenant_id = $1 AND a.deleted_at IS NULL AND b.deleted_at IS NULL`, [TENANT]);
  check('los periodos no se traslapan', solape.n === 0, `${solape.n} pares traslapados`);

  // ── 7. RLS ───────────────────────────────────────────────────────────────────────────
  console.log('\n7) Aislamiento por tenant');
  const { rows: rls } = await db.query(`
    SELECT c.relname, c.relrowsecurity AS en, c.relforcerowsecurity AS forced,
           (SELECT count(*) FROM pg_policies p WHERE p.schemaname='commercial' AND p.tablename=c.relname)::int pol
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='commercial' AND c.relkind='r' AND c.relname LIKE 'commission%'`);
  check(`las 7 tablas existen (${rls.length})`, rls.length === 7);
  check('todas con RLS FORZADO y su política', rls.every((r) => r.en && r.forced && r.pol >= 1),
    rls.filter((r) => !(r.en && r.forced && r.pol >= 1)).map((r) => r.relname).join(', '));

  // ── 8. El permiso REPARTIDO, no sólo declarado ───────────────────────────────────────
  // Lección LC.6.2: un módulo no está entregado hasta que su permiso llegó a un rol. El
  // par FISCAL_PURCHASE_BOOK_* vivió en el enum sin repartirse y nadie pudo abrir la
  // pantalla en prod.
  console.log('\n8) El permiso llegó a alguien (lección LC.6.2)');
  const { rows: [perm] } = await db.query(`
    SELECT count(*) FILTER (WHERE permissions->'COMMERCIAL_COMMISSIONS_VER' = 'true'::jsonb)::int ven,
           count(*) FILTER (WHERE permissions->'COMMERCIAL_COMMISSIONS_GESTIONAR' = 'true'::jsonb)::int gestionan,
           count(*) FILTER (WHERE permissions->'COMMERCIAL_COMMISSIONS_VER' IS NOT NULL)::int con_clave
      FROM role_permissions`);
  check(`algún rol VE comisiones (${perm.ven})`, perm.ven >= 1,
    'el módulo nacería inaccesible salvo para ALL_PERMS');
  check(`algún rol las GESTIONA (${perm.gestionan})`, perm.gestionan >= 1);
  // Es nómina: si medio catálogo de roles la ve, el reparto se fue de las manos.
  check(`el reparto es acotado, no masivo (${perm.ven} de ${perm.con_clave} roles con la clave)`,
    perm.ven <= 8, 'demasiados roles ven sueldos');

  await db.end();
  console.log(`\n=== ${ok} OK · ${fail} fallas · ${nm} NO MEDIDOS ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
