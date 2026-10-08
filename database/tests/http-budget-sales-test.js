/* eslint-disable no-console */
/**
 * `[PU.V]` Verificación **POR HTTP** de la pestaña de Ventas de Presupuestos
 * (ADR-044 · ADR-056 · `docs/VERDAD_ABSOLUTA.md` §23).
 *
 * Hermano de `test-newdb-sellout-budget-rollup.js`, que mide lo mismo contra la base. Éste existe
 * porque **medir la base no prueba que el número llegue a la pantalla**: entre la matvista y el
 * navegador hay un guard, un servicio que arma el payload y una serialización, y cada uno puede
 * perder el dato sin que nadie se entere. Lo que se verifica acá es exactamente lo que la
 * medición DB-direct NO puede:
 *
 *   · que el gate cierre y abra donde debe,
 *   · que los $314M recuperados **viajen en el JSON**, no sólo en la matvista,
 *   · que los tiempos sean los del extremo a extremo (servicio + serialización), no los del SQL,
 *   · y que la procedencia (frescura, cobertura) llegue DECLARADA y no inventada.
 *
 * ── ⛔ SÓLO LECTURA, y por qué ───────────────────────────────────────────────────────────────
 * Los tests HTTP de este repo empiezan sembrando usuarios. Éste **no escribe una sola fila**:
 * firma un token para un usuario que YA existe y sólo hace `GET`. La razón está documentada en
 * `http-budget-assumption-test.js`: la API local de pruebas corre contra la base de PRODUCCIÓN, y
 * sembrar ahí es lo que el 2026-08-29 dejó 5 cuentas y 2 tenants de prueba en el padrón real.
 *
 * ⚠️ **Queda SIN verificar el flujo de escritura** —crear ejercicio, re-armar, materializar— y se
 * declara en vez de fingir que está cubierto. Para eso hace falta una base que no sea producción.
 *
 * ⚠️ El token se firma acá en vez de pedirlo por `/auth/login` porque eso exige la contraseña de
 * una persona real. El guard NO se saltea: `RolesGuard` relee los permisos de la base en cada
 * request, así que el token sólo dice **quién** es, nunca qué puede. Por eso la prueba negativa
 * tiene valor.
 *
 * ⭐ Se prueba con el permiso **MÍNIMO** (`finanzas`), no con superadmin: con god-mode un gate mal
 * puesto pasa en verde — es el error que costó `[LC.6.2]`.
 *
 * ── Cómo correrlo ───────────────────────────────────────────────────────────────────────────
 *
 *     node database/tests/http-budget-sales-test.js
 *
 * Necesita: el API arriba en `localhost:3334` (o `TM_TEST_PORT`), `JWT_SECRET` y
 * `DATABASE_URL_NEW` en el `.env` (la base se usa para IDENTIFICAR al usuario, no para escribir).
 * Si falta cualquiera de los tres, reporta **NO MEDIDO**, nunca verde ni falla.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const jwt = require('jsonwebtoken');
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const BASE = `http://localhost:${process.env.TM_TEST_PORT || 3334}/api`;
const URL_DB = process.env.DATABASE_URL_NEW || process.env.DST_URL;
/** Rol con la clave `PRESUPUESTOS_VER` pero SIN god-mode: el gate se prueba donde puede fallar. */
const ROL_CON = 'finanzas';
const ROL_SIN = 'cajero';
/** El gate del proyecto. Acá se mide el extremo a extremo, que incluye armar y serializar. */
const GATE_MS = 500;
/** Las tres plazas que el join roto dejaba en $0 sobre $208M (VERDAD_ABSOLUTA §23). */
const MAYOREO = ['mayoreo:01', 'mayoreo:06', 'mayoreo:08'];

let ok = 0, fail = 0, skip = 0;
const chk = (c, m, extra) => {
  if (c) { ok++; console.log(`  ✔ ${m}`); } else { fail++; console.log(`  ✖ ${m}${extra ? ` — ${extra}` : ''}`); }
};
const nm = (m) => { skip++; console.log(`  ◻ NO MEDIDO — ${m}`); };
const mx = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

const get = async (ruta, token) => {
  const t0 = Date.now();
  const r = await fetch(`${BASE}${ruta}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let cuerpo = null;
  try { cuerpo = await r.json(); } catch { /* puede no traer JSON */ }
  return { status: r.status, cuerpo, ms: Date.now() - t0 };
};
/** Mide en caliente: la primera llamada paga el arranque del pool y no es lo que vive un usuario. */
const medir = async (ruta, token) => { await get(ruta, token); return get(ruta, token); };

(async () => {
  if (!URL_DB) return noMedido('falta DATABASE_URL_NEW (identifica al usuario; no se escribe nada)');
  if (!process.env.JWT_SECRET) return noMedido('falta JWT_SECRET: sin él no se arma una sesión');

  try {
    const h = await fetch(`${BASE}/health`);
    if (!h.ok) return noMedido(`el API responde ${h.status} en ${BASE}/health`);
  } catch (e) {
    return noMedido(`el API no está arriba en ${BASE} (${e.message})`);
  }

  const c = new Client({
    connectionString: URL_DB,
    ssl: /rlwy\.net|railway|amazonaws/i.test(URL_DB) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000,
  });
  try { await c.connect(); } catch (e) {
    if (esFaltaDeAcceso(e)) return noMedido(`sin acceso a la base: ${e.message}`);
    throw e;
  }

  let tokCon = null, tokSin = null, budget = null;
  try {
    const firmar = async (rol) => {
      const { rows } = await c.query(
        `SELECT id, username, role_name, tenant_id FROM identity.users
          WHERE role_name = $1 AND status = 'active' ORDER BY username LIMIT 1`, [rol]);
      if (!rows.length) return null;
      const u = rows[0];
      return jwt.sign(
        { sub: u.id, tenant_id: u.tenant_id, username: u.username, role_name: u.role_name },
        process.env.JWT_SECRET, { expiresIn: '10m' },
      );
    };
    tokCon = await firmar(ROL_CON);
    tokSin = await firmar(ROL_SIN);
    // ⚠️ El ejercicio con MÁS líneas de plan, no «el último»: hay ejercicios de prueba con el
    //    mismo año fiscal, y medir contra uno vacío daría verde sin haber probado nada.
    const { rows: bs } = await c.query(`
      SELECT b.id, b.name, b.fiscal_year, count(l.*)::int AS lineas
        FROM budget.budgets b
        LEFT JOIN budget.sales_plan_lines l ON l.budget_id = b.id
       WHERE b.name NOT ILIKE '%prueba%' AND b.name NOT ILIKE '%no usar%'
       GROUP BY b.id ORDER BY lineas DESC, b.fiscal_year DESC LIMIT 1`);
    budget = bs[0] ?? null;
  } finally {
    await c.end().catch(() => undefined);
  }

  if (!tokCon) return noMedido(`no hay un usuario activo con rol ${ROL_CON}: sin él no se puede probar nada`);
  if (!budget) return noMedido('no hay ningún ejercicio de presupuesto con líneas de plan');
  console.log(`\nEjercicio bajo prueba: «${budget.name}» FY${budget.fiscal_year} · ${budget.lineas} líneas de plan`);

  const R_COMP = `/finance/budget/budgets/${budget.id}/sales-comparison`;
  const R_IND = `/finance/budget/budgets/${budget.id}/sales-indicators`;
  const R_REC = '/finance/budget/sales-reconciliation';

  // ── [1] El gate ───────────────────────────────────────────────────────────────────────────
  console.log('\n[1] El gate, probado con el permiso MÍNIMO (no con superadmin)');
  for (const [nombre, ruta] of [['comparación', R_COMP], ['indicadores', R_IND], ['conciliación', R_REC]]) {
    const sin = await get(ruta);
    chk(sin.status === 401, `${nombre}: sin token cierra (${sin.status})`);
  }
  const mal = await get(R_COMP, 'no-soy-un-token');
  chk(mal.status === 401, `con un token inválido cierra (${mal.status})`);
  if (!tokSin) nm(`no hay usuario activo con rol ${ROL_SIN} para la prueba negativa del rol`);
  else {
    const neg = await get(R_COMP, tokSin);
    chk(neg.status === 403 || neg.status === 401,
      `un rol SIN la clave cierra (${ROL_SIN} → ${neg.status})`, `devolvió ${neg.status}`);
  }

  // ── [2] ⭐ EL NÚMERO, por la ruta ──────────────────────────────────────────────────────────
  // Esto es lo que la medición contra la base no puede probar: que los $314M que el join roto
  // tiraba lleguen DENTRO del JSON. El join unía el canal CRUDO del sell-out contra el CANÓNICO
  // del catálogo, y las tres plazas de mayoreo publicaban $0 sobre $208M.
  console.log('\n[2] El número llega por la ruta (VERDAD_ABSOLUTA §23)');
  const comp = await medir(R_COMP, tokCon);
  if (comp.status !== 200) {
    chk(false, `la comparación responde 200`, `devolvió ${comp.status}`);
  } else {
    const cells = comp.cuerpo?.cells ?? [];
    chk(Array.isArray(cells) && cells.length > 0, 'la comparación entrega celdas', `${cells.length}`);

    // Cada plaza de mayoreo tiene que traer real del año anterior. Se mide `real_prior` y NO
    // `real`, a propósito: `real` del ejercicio en curso puede ser legítimamente nulo si el año
    // fiscal no empezó, y entonces la aserción diría verde sin probar el arreglo.
    for (const ek of MAYOREO) {
      const suyas = cells.filter((x) => x.entity_key === ek);
      const prior = suyas.reduce((s, x) => s + Number(x.real_prior ?? 0), 0);
      chk(suyas.length > 0 && prior > 10000000,
        `${ek} trae real del año anterior en el payload (valía $0; mide ${mx(prior)})`,
        suyas.length ? `sólo ${mx(prior)}` : 'sin celdas');
    }

    // ⭐ CONTROL: si TODAS las entidades vinieran con real_prior, la aserción de arriba no
    //    distinguiría el arreglo de «el payload trae todo siempre». Mostrador ya funcionaba
    //    antes del arreglo, así que tiene que traerlo también — y eso es lo esperado, no un bug.
    const conPrior = new Set(cells.filter((x) => Number(x.real_prior ?? 0) > 0).map((x) => x.entity_key));
    chk(conPrior.size >= MAYOREO.length + 3,
      `el real del año anterior cubre más que mayoreo (${conPrior.size} entidades)`);

    // ── Contrato ADR-056: lo que no se midió se DECLARA, nunca se dibuja ──
    const t = comp.cuerpo.totals ?? {};
    chk(t.real === null || Number(t.real) > 0,
      'el total real es NULL cuando no hay año corrido — nunca $0 dibujado', `real = ${t.real}`);
    chk(Number(t.real_prior) > 0, `el total del año anterior viaja (${mx(t.real_prior)})`);
    chk(cells.every((x) => x.real != null || x.crec_pct == null),
      'sin real actual el CREC va NULL, no −100 %');
    chk(cells.every((x) => x.real != null || x.part_pct == null),
      'sin real actual la PART va NULL');
    chk(!!comp.cuerpo.freshness && typeof comp.cuerpo.freshness === 'object',
      'declara `freshness` (procedencia emitida por el SERVER, no por el navegador)');
    chk(comp.cuerpo.coverage && typeof comp.cuerpo.coverage.measured === 'boolean',
      'declara `coverage.measured` — «no se pudo medir» ≠ 0 %');
    chk(typeof comp.cuerpo.data_as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(comp.cuerpo.data_as_of),
      `declara hasta qué día tiene datos (${comp.cuerpo.data_as_of})`);

    // ⭐ [PU.V6] CUÁNTO AÑO cubre el total. Medido en prod: el plan 2027 publicaba $604.8M y eran
    // **10 de 13 períodos** — los tres que faltaban (nov–ene) valieron $166.6M en 2025 y son los
    // MEJORES del año. El motor hizo bien en no inventarlos (`sin_base_declarado`), pero escribió
    // el aviso en `method` y un **$0** en `meta_amount`, que es el campo que el encabezado suma.
    const per = comp.cuerpo.periodos;
    chk(per && typeof per.completo === 'boolean' && Number(per.del_anio) > 0,
      'declara cuántos períodos del ejercicio cubre el total');
    if (per) {
      // Partición: lo que tiene meta más lo que no, tiene que dar el año entero. Si no cerrara,
      // habría períodos que no caen en ninguna de las dos categorías y nadie los vería.
      chk(Number(per.con_meta) + (per.sin_meta?.length ?? 0) === Number(per.del_anio),
        `las dos categorías particionan el año (${per.con_meta} + ${per.sin_meta?.length} = ${per.del_anio})`);
      chk(per.completo === ((per.sin_meta?.length ?? 0) === 0),
        '`completo` concuerda con la lista de períodos sin meta — no son dos verdades distintas');
      if (!per.completo) {
        // La MAGNITUD de lo que falta. `null` es aceptable sólo si no hay un año completo con qué
        // dimensionarlo: «no se pudo medir» ≠ $0 (ADR-056). Lo que NO se acepta es un 0 numérico.
        chk(per.referencia === null || Number(per.referencia.monto) > 0,
          `dimensiona lo que falta, o lo declara sin medir — nunca $0`,
          `referencia = ${JSON.stringify(per.referencia)}`);
        chk(typeof per.nota === 'string' && /\d+ de \d+/.test(per.nota),
          `la nota dice la cobertura en palabras: «${per.nota}»`);
        // ⭐ CONTROL: los períodos que el servidor llama «sin meta» tienen que ser exactamente los
        //    que no tienen meta en las celdas. Si no coincidieran, el aviso hablaría de otra cosa.
        const conMetaEnCeldas = new Set(cells.filter((x) => Number(x.meta ?? 0) > 0).map((x) => x.period_no));
        chk(per.sin_meta.every((p) => !conMetaEnCeldas.has(p)),
          'los períodos declarados sin meta no tienen meta en ninguna celda');
      }
    }
  }

  // ── [3] Indicadores y conciliación ────────────────────────────────────────────────────────
  console.log('\n[3] Indicadores y conciliación');
  const ind = await medir(R_IND, tokCon);
  if (ind.status !== 200) chk(false, 'los indicadores responden 200', `devolvió ${ind.status}`);
  else {
    chk(Array.isArray(ind.cuerpo?.years_available) && ind.cuerpo.years_available.length > 1,
      `entrega los años con historia (${(ind.cuerpo?.years_available ?? []).join(', ')})`);
    chk(Array.isArray(ind.cuerpo?.by_entity) && ind.cuerpo.by_entity.length > 0,
      `entrega el eje por entidad (${ind.cuerpo?.by_entity?.length ?? 0})`);
    chk((ind.cuerpo?.by_entity ?? []).some((e) => MAYOREO.includes(e.entity_key)),
      'el mayoreo aparece entre las entidades del tablero');
    chk((ind.cuerpo?.by_entity ?? []).every((e) => e.label && e.label !== e.entity_key),
      'cada entidad trae su nombre de plaza, no sólo la llave');
  }

  const rec = await medir(R_REC, tokCon);
  if (rec.status !== 200) chk(false, 'la conciliación responde 200', `devolvió ${rec.status}`);
  else {
    chk(Array.isArray(rec.cuerpo?.annual) && rec.cuerpo.annual.length > 0,
      `entrega el cuadre anual (${rec.cuerpo?.annual?.length ?? 0} filas)`);
    // La pierna de sell-out pasó a un snapshot nocturno ([PU.V2]/[PU.V3]) y eso cambia la
    // frescura: tiene que estar DICHO en la respuesta, no sólo en el código.
    chk((rec.cuerpo?.notes ?? []).some((n) => /rollup mensual|snapshot|nocturno/i.test(n)),
      'declara que el sell-out sale de un snapshot nocturno (cambio de frescura, ADR-056)');
  }

  // ── [4] ⭐ EL TIEMPO, extremo a extremo ────────────────────────────────────────────────────
  // Medido en el borde HTTP, no en el SQL: incluye guard, armado del payload y serialización.
  // Es la diferencia entre «la consulta es rápida» y «la pantalla carga».
  console.log(`\n[4] El tiempo de extremo a extremo (gate ${GATE_MS} ms)`);
  const antes = { [R_COMP]: 56397, [R_IND]: 61182, [R_REC]: 120007 };
  for (const [nombre, ruta, r] of [['/sales-comparison', R_COMP, comp], ['/sales-indicators', R_IND, ind], ['/sales-reconciliation', R_REC, rec]]) {
    if (r.status !== 200) { nm(`${nombre}: no respondió 200, no se mide el tiempo`); continue; }
    chk(r.ms < GATE_MS, `${nombre}: ${r.ms} ms (medía ${antes[ruta].toLocaleString('es-MX')} ms)`, `${r.ms} ms`);
  }
  // El eje de columnas, que fue el 97 % del costo una vez arreglado el real ([PU.V5]).
  const ent = await medir('/finance/budget/sales-entities', tokCon);
  if (ent.status !== 200) nm(`/sales-entities respondió ${ent.status}`);
  else chk(ent.ms < GATE_MS, `/sales-entities: ${ent.ms} ms (medía 659 ms)`, `${ent.ms} ms`);

  // ── [5] Lo que este archivo NO cubre, dicho ───────────────────────────────────────────────
  console.log('\n[5] Alcance declarado');
  console.log('  ◻ El flujo de ESCRITURA (crear ejercicio, re-armar, materializar) queda sin');
  console.log('    verificar por HTTP: sembrar contra la base de producción es lo que esta');
  console.log('    familia de pruebas tiene prohibido. Se cubre cuando haya una base que no');
  console.log('    sea prod — está declarado, no olvidado.');

  console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
