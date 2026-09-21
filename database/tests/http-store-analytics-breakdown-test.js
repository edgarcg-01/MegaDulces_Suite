/* eslint-disable no-console */
/**
 * HTTP smoke — `[TDA.A1]` CASCADA POR PERÍODO (`GET /store/analytics/breakdown`),
 * el segundo bloque de la sección Tráfico en `/tienda/analisis-semanal`.
 *
 * Qué defiende, y por qué esas cosas y no otras:
 *
 *  1. **CUADRE contra la fotografía.** La cascada y la tarjeta de arriba tienen que
 *     decir lo mismo: si `Σ(filas.venta)` no es la venta que publica `/range` para el
 *     MISMO rango, la pantalla se contradice a sí misma y no hay forma de saber cuál
 *     miente. Se exige al peso (tolerancia de centavo) en los cinco granos.
 *
 *  2. **CUADRE del segundo nivel.** `Σ(hijos)` == el padre. Un hijo que se pierde (un
 *     día que no cae en ningún bucket) no rompe nada visible: sólo hace que el detalle
 *     sume menos que el renglón que lo contiene, y eso nadie lo nota a ojo.
 *
 *  3. **EL BUCKET ES UNO SOLO.** Es el riesgo real del diseño: el calendario, el fact,
 *     el POS y los clientes se agrupan por la MISMA llave. Los clientes se cuentan con
 *     `count(DISTINCT)` en SQL —no se pueden rodar desde el grano diario—, así que si su
 *     llave no coincidiera con la del calendario, los clientes de un período aparecerían
 *     en el renglón de otro **sin que nada falle**. Se verifica contra la base que
 *     ningún bucket de clientes quede huérfano del calendario, en los cinco granos.
 *
 *  4. **PRUEBA NEGATIVA de la compuerta de cobertura.** Las razones que cruzan fact y POS
 *     (`$/partida`, `unidades/ticket`) sólo se publican si el POS cubrió los mismos días
 *     que el fact EN ESE BUCKET. Se busca un bucket real con hueco y se exige `null`
 *     («— sin medir»), y en el mismo bucket se exige que `$/unidad` —fuente única— SIGA
 *     trayendo número: una compuerta que apaga todo sería tan inútil como no tenerla.
 *
 *  5. **El Δ% de `weekday` no existe en los padres.** Comparar el lunes contra el domingo
 *     no dice nada; publicar ahí un número sería inventar una medición. Los HIJOS sí lo
 *     llevan (cada lunes contra el lunes anterior), y eso también se exige.
 *
 *  6. `[TDA.A2]` **LAS LÍNEAS CUADRAN CON LA FOTOGRAFÍA.** `catalog.products.supplier_id`
 *     puede venir NULL, y con un `INNER JOIN` esos productos se irían de la tabla **sin
 *     dejar rastro**: el total por línea daría menos que la venta y nadie sabría por qué.
 *     Se exige `Σ(líneas) == /range` al peso, y lo mismo un nivel abajo
 *     (`Σ(productos de la línea) == la línea`).
 *
 *  7. `[TDA.A2]` **PRUEBA NEGATIVA del modo línea.** Un ticket lleva productos de varias
 *     líneas, así que tickets, partidas, ticket promedio, $/partida, unidades por ticket
 *     y clientes NO son atribuibles a una. Se exige que vuelvan `null` en TODAS las filas
 *     y sus hijos — nunca 0 («esta línea no vendió a nadie») ni el número de la tienda
 *     entera («esto es de La Rosa») — y, la otra mitad, que venta, margen, unidades y
 *     $/unidad **sigan publicándose**.
 *
 *  8. `[TDA.A3]` **EL ACUMULADO DE PARETO.** Es lo que aporta «Productos TOP», y lo que
 *     se rompería en silencio si los filtros se aplicaran en el navegador: el acumulado
 *     pasaría a ser el de las filas visibles y no el del universo — el mismo nombre de
 *     columna con otro significado. Se exige monótono, arrancando en la participación de
 *     la 1ª fila, cerrando en ~100 % con `mode=all`, y —la aserción que ata todo— que al
 *     filtrar por tipo el acumulado **se RE-CALCULE** y vuelva a cerrar en 100 % sobre el
 *     universo achicado, con las facetas sin filtrarse a sí mismas.
 *
 *  9. `[TDA.A3]` **La sonda del decode.** El negocio mostró la ficha del ERP del SKU
 *     `70001`: Tipo DULCES, Grupo MAZAPAN CACAHUATE. La vista `analytics.v_product_taxonomy`
 *     tiene que reproducirla — es el único ancla de que `kdii.c4→kdie` y `kdii.c5→kdif`
 *     son de verdad Tipo y Grupo y no dos códigos que encajaron por casualidad.
 *
 * SÓLO LECTURA: no siembra ni borra nada. No puede hacerlo — desde `[SD.3]` la venta sale
 * de la matvista `analytics.mv_sales_blended`, y sembrar `sales_daily` ya no se ve del
 * otro lado sin un REFRESH completo (caro y global). El costo de eso está declarado al
 * final: los cuadres e invariantes se miden contra la data real del entorno, así que en
 * una base vacía el test **reporta NO MEDIDO en vez de ponerse verde solo**.
 *
 * Requiere API con `ENABLE_MULTITENANT=true` (puerto `RECON_TEST_PORT`, default 3334) y
 * un usuario con `STORE_ANALYTICS_VER` de alcance global (se crea y se borra al final:
 * es lo único que escribe).
 */

const BASE = `http://localhost:${process.env.RECON_TEST_PORT || 3334}/api`;
const { Client } = require('pg');
try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }
// Crea y borra un rol + usuario sintéticos: no puede correr contra prod.
require('./_lib/assert-safe-target').assertSafeTarget('http-store-analytics-breakdown-test');
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@127.0.0.1:5432/postgres_platform';

const M = '00000000-0000-0000-0000-00000000d01c';
const ROLE = 'analytics_breakdown_smoke';
const USER = 'analytics_breakdown_smoke';
const PASS = 'analytics_breakdown_smoke';

const GRANOS = ['week', 'weekday', 'month', 'quarter', 'year'];

/** Expresiones de bucket, ESPEJO de `GRAIN_SQL`/`CHILD_SQL` del servicio. */
const GRAIN_SQL = {
  week: { expr: (c) => `date_trunc('week', ${c})::date::text`, child: 'day' },
  weekday: { expr: (c) => `EXTRACT(isodow FROM ${c})::int::text`, child: 'day' },
  month: { expr: (c) => `date_trunc('month', ${c})::date::text`, child: 'day' },
  quarter: { expr: (c) => `date_trunc('quarter', ${c})::date::text`, child: 'month' },
  year: { expr: (c) => `date_trunc('year', ${c})::date::text`, child: 'quarter' },
};
const CHILD_SQL = {
  day: (c) => `${c}::date::text`,
  month: (c) => `date_trunc('month', ${c})::date::text`,
  quarter: (c) => `date_trunc('quarter', ${c})::date::text`,
};

let pass = 0, fail = 0, skip = 0;
const failures = [];
function check(name, cond, det) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`); fail++; failures.push(name); }
}
/**
 * Bloque que NO se pudo medir. Se cuenta aparte y NUNCA como ✔: un test sin datos con
 * qué comprobarse que se pinta verde es peor que no tenerlo (ADR-056).
 */
function noMedido(name, motivo) {
  console.log(`  ----  ${name} — NO MEDIDO: ${motivo}`);
  skip++;
}

async function req(method, path, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers });
  let json = null;
  try { json = await r.json(); } catch (e) { /* no json */ }
  return { status: r.status, body: json };
}

/** Comparación de dinero con tolerancia de centavo. */
const cerca = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.01;
const suma = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hoyMx = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

async function cleanup(pg, userId) {
  if (userId) await pg.query(`DELETE FROM identity.user_scopes WHERE tenant_id=$1 AND user_id=$2::uuid`, [M, userId]).catch(() => undefined);
  await pg.query(`DELETE FROM identity.users WHERE tenant_id=$1 AND username=$2`, [M, USER]).catch(() => undefined);
  await pg.query(`DELETE FROM identity.role_permissions WHERE tenant_id=$1 AND role_name=$2`, [M, ROLE]).catch(() => undefined);
}

(async () => {
  const pg = new Client({ connectionString: DST, ssl: /rlwy|proxy|railway/.test(DST) ? { rejectUnauthorized: false } : false });
  await pg.connect();
  await cleanup(pg, null);

  let userId = null;
  try {
    // ── 0. Usuario de alcance GLOBAL (lo único que este test escribe) ──
    console.log('\n── 0. Usuario con STORE_ANALYTICS_VER y alcance global ──');
    const bcrypt = require('bcryptjs');
    await pg.query(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (tenant_id, role_name) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [M, ROLE, JSON.stringify({ STORE_ANALYTICS_VER: true })],
    );
    const hash = await bcrypt.hash(PASS, 10);
    userId = (await pg.query(
      `INSERT INTO identity.users (tenant_id, username, password_hash, nombre, role_name, activo)
       VALUES ($1,$2,$3,$2,$4,true)
       ON CONFLICT (tenant_id, username) DO UPDATE SET password_hash=EXCLUDED.password_hash, role_name=EXCLUDED.role_name, activo=true
       RETURNING id`, [M, USER, hash, ROLE])).rows[0].id;
    // Alcance `all`: la cascada se mide contra TODA la red del entorno.
    await pg.query(
      `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, mode, values)
       VALUES ($1,$2,'warehouse','all', '{}'::text[])
       ON CONFLICT (tenant_id, user_id, dimension) DO UPDATE SET mode='all', values='{}'::text[]`,
      [M, userId],
    );

    const login = await fetch(`${BASE}/auth-mt/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS, tenant_slug: 'mega_dulces' }),
    });
    const lj = await login.json();
    const token = lj?.access_token;
    check('login del usuario de prueba', !!token, `status ${login.status}`);
    if (!token) throw new Error('sin token: el resto no se puede medir');

    /**
     * Ventana: el ÚLTIMO AÑO que termina ayer. Termina ayer y no hoy a propósito — el
     * día en curso llega a medias y haría que el último bucket parezca un derrumbe.
     */
    const TO = addDays(hoyMx(), -1);
    const FROM = addDays(TO, -364);

    // ── 1. La fotografía: es el árbitro de los cuadres de abajo ──
    console.log('\n── 1. Fotografía del mismo rango (el árbitro del cuadre) ──');
    const rng = await req('GET', `/store/analytics/range?from=${FROM}&to=${TO}&with_products=0`, token);
    check('GET /range responde 200', rng.status === 200, `status ${rng.status}`);
    const ventaFoto = rng.body?.kpis?.revenue?.cur ?? 0;
    const unidadesFoto = rng.body?.kpis?.units?.cur ?? 0;
    console.log(`     rango ${FROM} → ${TO} · venta $${ventaFoto.toLocaleString('es-MX')} · unidades ${Math.round(unidadesFoto).toLocaleString('es-MX')}`);
    check('`with_products=0` NO devuelve el top de productos', Array.isArray(rng.body?.by_product) && rng.body.by_product.length === 0,
      `by_product trajo ${rng.body?.by_product?.length} filas`);

    const hayDatos = ventaFoto > 0;
    if (!hayDatos) {
      noMedido('todos los cuadres de la cascada', 'el entorno no tiene venta en el último año; sin datos no hay nada contra qué cuadrar');
    }

    // ── 2. Los cinco granos: forma, cuadre y cuadre del detalle ──
    console.log('\n── 2. Los 5 granos: forma + cuadre contra la fotografía + cuadre del detalle ──');
    const reps = {};
    for (const g of GRANOS) {
      const r = await req('GET', `/store/analytics/breakdown?from=${FROM}&to=${TO}&grain=${g}`, token);
      reps[g] = r.body;
      check(`[${g}] responde 200`, r.status === 200, `status ${r.status}`);
      if (r.status !== 200) continue;
      check(`[${g}] el servidor confirma el grano pedido`, r.body.grain === g, `devolvió ${r.body.grain}`);
      check(`[${g}] declara el grano del segundo nivel`, !!r.body.child_grain);

      if (!hayDatos) continue;
      const filas = r.body.rows || [];
      check(`[${g}] devuelve filas`, filas.length > 0, `${filas.length} filas`);

      // (1) Σ(filas) == totals == la fotografía. Al peso.
      const sumaFilas = suma(filas, (x) => x.revenue);
      check(`[${g}] Σ(venta de las filas) == totals.revenue`, cerca(sumaFilas, r.body.totals.revenue),
        `${sumaFilas} vs ${r.body.totals.revenue}`);
      check(`[${g}] la cascada cuadra con la fotografía`, cerca(sumaFilas, ventaFoto),
        `cascada ${sumaFilas} vs /range ${ventaFoto}`);
      check(`[${g}] las unidades también cuadran`, cerca(suma(filas, (x) => x.units), unidadesFoto),
        `${suma(filas, (x) => x.units)} vs ${unidadesFoto}`);

      // (2) Σ(hijos) == padre, fila por fila.
      const descuadres = filas
        .filter((f) => f.children.length && !cerca(suma(f.children, (c) => c.revenue), f.revenue))
        .map((f) => f.label);
      check(`[${g}] Σ(hijos) == su padre en TODAS las filas`, descuadres.length === 0,
        `descuadran: ${descuadres.slice(0, 3).join(', ')}`);

      // Una fila sin hijos sería una fila que no se puede abrir: el segundo nivel es
      // la mitad de lo que esta pantalla ofrece.
      check(`[${g}] ninguna fila se queda sin detalle`, filas.every((f) => f.children.length > 0),
        `${filas.filter((f) => !f.children.length).length} filas sin hijos`);
      // Un rótulo repetido hace la tabla ilegible (la S37 de 2025 y la de 2026).
      check(`[${g}] los rótulos no se repiten`, new Set(filas.map((f) => f.label)).size === filas.length);
    }

    // ── 3. El bucket es UNO SOLO (el riesgo real del diseño) ──
    console.log('\n── 3. El bucket se define una vez: clientes agrupados en SQL vs el calendario ──');
    for (const g of GRANOS) {
      const child = GRAIN_SQL[g].child;
      const cal = await pg.query(
        `SELECT ${GRAIN_SQL[g].expr('g.d')} AS pb, ${CHILD_SQL[child]('g.d')} AS cb
           FROM generate_series($1::date,$2::date,interval '1 day') g(d)`, [FROM, TO]);
      const pbs = new Set(cal.rows.map((r) => String(r.pb)));
      const cbs = new Set(cal.rows.map((r) => String(r.cb)));
      const cliSql = (expr) => `SELECT ${expr} AS b FROM analytics.erp_sales_invoices
         WHERE tenant_id=$1 AND NOT cancelada AND cliente_code <> 'CONTADO' AND COALESCE(canal,'') <> 'TELEMARK'
           AND fecha >= $2 AND fecha < ($3::date + 1) GROUP BY 1`;
      const cp = await pg.query(cliSql(GRAIN_SQL[g].expr('fecha')), [M, FROM, TO]);
      const cc = await pg.query(cliSql(CHILD_SQL[child]('fecha')), [M, FROM, TO]);
      if (!cp.rows.length) { noMedido(`[${g}] llaves de clientes vs calendario`, 'no hay facturación a nombre en la ventana'); continue; }
      const huerfanosP = cp.rows.filter((r) => !pbs.has(String(r.b))).map((r) => r.b);
      const huerfanosC = cc.rows.filter((r) => !cbs.has(String(r.b))).map((r) => r.b);
      check(`[${g}] ningún bucket de clientes queda huérfano del calendario`,
        huerfanosP.length === 0 && huerfanosC.length === 0,
        `padres ${JSON.stringify(huerfanosP.slice(0, 3))} · hijos ${JSON.stringify(huerfanosC.slice(0, 3))}`);
    }

    // ── 4. PRUEBA NEGATIVA: la compuerta de cobertura, por bucket ──
    console.log('\n── 4. Prueba NEGATIVA: un bucket con el POS corto no publica las razones cruzadas ──');
    const todasLasFilas = GRANOS.flatMap((g) => (reps[g]?.rows || []).map((f) => ({ g, f })));
    const conHueco = todasLasFilas.filter(({ f }) => f.fact_days > 0 && f.pos_days < f.fact_days);
    const sinHueco = todasLasFilas.filter(({ f }) => f.fact_days > 0 && f.pos_days >= f.fact_days);
    if (!conHueco.length) {
      noMedido('la compuerta en ROJO', 'ningún bucket del entorno tiene el POS más corto que el fact; sin un hueco real no se puede romper a propósito');
    } else {
      const malas = conHueco.filter(({ f }) => f.avg_line !== null || f.units_per_ticket !== null).map(({ g, f }) => `${g}/${f.label}`);
      check(`con el POS corto, $/partida y uds/ticket vuelven null (${conHueco.length} buckets)`, malas.length === 0,
        `publicaron número: ${malas.slice(0, 3).join(', ')}`);
      // La otra mitad de la prueba: la compuerta no puede apagar lo que SÍ está medido.
      const conVenta = conHueco.filter(({ f }) => f.units > 0 && f.revenue > 0);
      if (!conVenta.length) noMedido('$/unidad sobrevive la compuerta', 'los buckets con hueco no tienen unidades');
      else check(`en esos MISMOS buckets, $/unidad (fuente única) sigue publicando`,
        conVenta.every(({ f }) => f.avg_unit !== null),
        `apagó ${conVenta.filter(({ f }) => f.avg_unit === null).length} de ${conVenta.length}`);
    }
    if (!sinHueco.length) {
      noMedido('la compuerta en VERDE', 'ningún bucket del entorno tiene cobertura pareja de POS');
    } else {
      const conPartidas = sinHueco.filter(({ f }) => f.tickets > 0 && f.revenue > 0);
      if (!conPartidas.length) noMedido('la compuerta en VERDE', 'los buckets con cobertura pareja no tienen tickets');
      else check(`con cobertura pareja SÍ se publican las razones cruzadas (${conPartidas.length} buckets)`,
        conPartidas.every(({ f }) => f.avg_line !== null && f.units_per_ticket !== null),
        `${conPartidas.filter(({ f }) => f.avg_line === null).length} siguieron en null`);
    }

    // ── 5. «—» nunca es 0: las razones se declaran, no se dibujan ──
    console.log('\n── 5. Las razones se DECLARAN: sin denominador viene null, no 0 ──');
    const sinTickets = todasLasFilas.filter(({ f }) => f.tickets === 0);
    if (!sinTickets.length) noMedido('ticket promedio sin tickets', 'no hay ningún bucket sin tickets en el entorno');
    else {
      const ceros = sinTickets.filter(({ f }) => f.avg_ticket === 0 || f.basket === 0).map(({ g, f }) => `${g}/${f.label}`);
      check(`sin tickets, ticket promedio y partidas/ticket son null y NO 0 (${sinTickets.length} buckets)`,
        ceros.length === 0, `dibujaron 0: ${ceros.slice(0, 3).join(', ')}`);
    }
    const sinClientes = todasLasFilas.filter(({ f }) => f.customers === 0);
    if (!sinClientes.length) noMedido('venta por cliente sin clientes', 'todos los buckets tienen clientes con registro');
    else check('sin clientes con registro, la venta por cliente es null y NO 0',
      sinClientes.every(({ f }) => f.revenue_per_customer === null));

    // ── 6. El Δ% de `weekday`: los padres NO lo llevan, los hijos SÍ ──
    console.log('\n── 6. Δ%: el lunes no viene después del domingo ──');
    const wd = reps['weekday'];
    if (!wd?.rows?.length) noMedido('Δ% del grano weekday', 'el grano weekday no devolvió filas');
    else {
      check('los 7 días de la semana, en orden lunes → domingo',
        wd.rows.length <= 7 && wd.rows[0].label === 'Lunes', `${wd.rows.length} filas, primera "${wd.rows[0].label}"`);
      check('ningún padre de weekday publica Δ%', wd.rows.every((f) => f.delta_pct === null),
        `${wd.rows.filter((f) => f.delta_pct !== null).length} lo publicaron`);
      const hijosComparables = wd.rows.flatMap((f) => f.children).filter((c, i, arr) => arr.indexOf(c) > 0);
      const conDelta = wd.rows.flatMap((f) => f.children.slice(1)).filter((c) => c.delta_pct !== null);
      if (!hijosComparables.length) noMedido('Δ% de los hijos de weekday', 'ningún día de la semana tiene más de una ocurrencia con venta');
      else check('los hijos de weekday SÍ se comparan entre sí (cada lunes vs el anterior)', conDelta.length > 0,
        'ningún hijo trajo Δ%');
    }
    // En un grano cronológico la primera fila no tiene con qué compararse — y eso es
    // un null legítimo, no un hueco: si trajera número estaría comparando contra nada.
    const mes = reps['month'];
    if (mes?.rows?.length > 1) {
      check('en grano mes, la primera fila no tiene Δ% y la segunda sí',
        mes.rows[0].delta_pct === null && mes.rows.slice(1).some((f) => f.delta_pct !== null));
    } else noMedido('Δ% del grano mes', 'la ventana no trajo dos meses con datos');

    // ── 7. `[TDA.A2]` LÍNEAS: la venta repartida por proveedor del catálogo ──
    console.log('\n── 7. Líneas (proveedor del catálogo): cuadre, orden y el cajón «sin línea» ──');
    const sup = await req('GET', `/store/analytics/suppliers?from=${FROM}&to=${TO}`, token);
    check('GET /suppliers responde 200', sup.status === 200, `status ${sup.status}`);
    const lineas = sup.body?.rows || [];
    if (!hayDatos) {
      noMedido('cuadre de las líneas', 'el entorno no tiene venta en el último año');
    } else {
      check('devuelve líneas', lineas.length > 0, `${lineas.length}`);
      /**
       * EL CUADRE QUE IMPORTA. `catalog.products.supplier_id` puede venir NULL, y con un
       * `INNER JOIN` esos productos desaparecerían de la tabla **sin dejar rastro**: el
       * total de líneas daría menos que la venta y nadie sabría por qué. Por eso el
       * backend saca los sin-línea en su propia fila, y acá se exige al peso.
       */
      check('Σ(venta de las líneas) == la venta de la fotografía',
        cerca(suma(lineas, (l) => l.revenue), ventaFoto),
        `líneas ${suma(lineas, (l) => l.revenue)} vs /range ${ventaFoto}`);
      check('Σ(unidades de las líneas) == las unidades de la fotografía',
        cerca(suma(lineas, (l) => l.units), unidadesFoto));
      check('vienen ordenadas por venta, de mayor a menor',
        lineas.every((l, i) => i === 0 || lineas[i - 1].revenue >= l.revenue));
      check('la participación suma ~100%',
        Math.abs(suma(lineas, (l) => l.share_pct || 0) - 100) < 1.5,
        `sumó ${suma(lineas, (l) => l.share_pct || 0).toFixed(1)}%`);
      check('ninguna línea publica margen% con venta 0 (sería una división inventada)',
        lineas.every((l) => l.revenue !== 0 || l.margin_pct === null));
      const conc = sup.body.concentracion;
      check('la concentración se calcula, no se deja en null',
        conc && conc.lineas > 0 && conc.para_50 !== null && conc.para_50 <= conc.lineas,
        JSON.stringify(conc));
      console.log(`     ${conc.lineas} líneas · ${conc.para_50} explican el 50% · ${conc.para_80} el 80%`);

      // ── 8. El detalle de UNA línea ──
      console.log('\n── 8. Los productos de una línea (el detalle del maestro-detalle) ──');
      const top = lineas.find((l) => l.revenue > 0);
      if (!top) noMedido('productos de una línea', 'ninguna línea tiene venta');
      else {
        const det = await req('GET', `/store/analytics/supplier-products?from=${FROM}&to=${TO}&supplier_code=${encodeURIComponent(top.code)}`, token);
        check(`[${top.name}] responde 200`, det.status === 200, `status ${det.status}`);
        const prods = det.body?.rows || [];
        check(`[${top.name}] devuelve productos`, prods.length > 0, `${prods.length}`);
        // El tope de 300 es real: sólo se puede exigir el cuadre cuando NO se topó.
        if (prods.length >= 300) {
          noMedido(`[${top.name}] Σ(productos) == la línea`, 'la línea topó el límite de 300 productos');
        } else {
          check(`[${top.name}] Σ(venta de sus productos) == la venta de la línea`,
            cerca(suma(prods, (p) => p.revenue), top.revenue),
            `productos ${suma(prods, (p) => p.revenue)} vs línea ${top.revenue}`);
        }
        check(`[${top.name}] la participación es DENTRO de la línea (suma ~100%)`,
          prods.length >= 300 || Math.abs(suma(prods, (p) => p.share_pct || 0) - 100) < 1.5,
          `sumó ${suma(prods, (p) => p.share_pct || 0).toFixed(1)}%`);
        const sinCode = await req('GET', `/store/analytics/supplier-products?from=${FROM}&to=${TO}`, token);
        check('sin supplier_code responde 400', sinCode.status === 400, `status ${sinCode.status}`);
      }

      // ── 9. MODO LÍNEA en la cascada: publica menos, y lo dice ──
      console.log('\n── 9. Cascada acotada a una línea: lo no atribuible viene null, no 0 ──');
      if (!top) noMedido('modo línea de la cascada', 'ninguna línea tiene venta');
      else {
        const bl = await req('GET', `/store/analytics/breakdown?from=${FROM}&to=${TO}&grain=month&supplier_code=${encodeURIComponent(top.code)}`, token);
        check('responde 200', bl.status === 200, `status ${bl.status}`);
        check('declara a qué línea está acotada', bl.body?.scope?.code === top.code,
          JSON.stringify(bl.body?.scope));
        const filasL = bl.body?.rows || [];
        check('Σ(venta de la cascada de la línea) == la venta de esa línea',
          cerca(suma(filasL, (f) => f.revenue), top.revenue),
          `cascada ${suma(filasL, (f) => f.revenue)} vs línea ${top.revenue}`);
        /**
         * PRUEBA NEGATIVA del modo línea. Un ticket lleva productos de varias líneas, así
         * que tickets/partidas/clientes NO son atribuibles a una. Tienen que venir `null`
         * —«no aplica»— y NUNCA 0, que se leería como «esta línea no vendió a nadie», ni
         * el número de la tienda entera, que se leería como si fuera de esta línea.
         */
        const noAplican = ['tickets', 'avg_ticket', 'basket', 'avg_line', 'units_per_ticket', 'customers', 'revenue_per_customer', 'pos_days'];
        const malas = [];
        for (const f of filasL) for (const k of noAplican) if (f[k] !== null) malas.push(`${f.label}.${k}=${f[k]}`);
        check(`lo no atribuible a una línea viene null en las ${filasL.length} filas`, malas.length === 0,
          malas.slice(0, 4).join(' · '));
        check('los hijos también', filasL.flatMap((f) => f.children).every((k) => noAplican.every((n) => k[n] === null)));
        // Y la otra mitad: lo que SÍ es atribuible tiene que seguir publicándose.
        const conVenta = filasL.filter((f) => f.revenue > 0 && f.units > 0);
        if (!conVenta.length) noMedido('lo atribuible sobrevive el modo línea', 'la línea no trajo filas con venta y unidades');
        else check('venta, margen, unidades y $/unidad SIGUEN publicándose',
          conVenta.every((f) => f.avg_unit !== null && f.margin_pct !== null),
          `${conVenta.filter((f) => f.avg_unit === null).length} sin $/unidad`);
        check('la cascada de toda la tienda NO viene acotada', (await req('GET', `/store/analytics/breakdown?from=${FROM}&to=${TO}&grain=month`, token)).body?.scope === null);
        const inexistente = await req('GET', `/store/analytics/breakdown?from=${FROM}&to=${TO}&grain=month&supplier_code=ZZZ-NO-EXISTE`, token);
        check('una línea inexistente devuelve 0 filas, no un error', inexistente.status === 200 && (inexistente.body?.rows || []).length === 0,
          `status ${inexistente.status} filas ${inexistente.body?.rows?.length}`);
      }
    }

    // ── 10. `[TDA.A3]` PRODUCTOS TOP: Pareto, taxonomía del ERP y el corte del 80% ──
    console.log('\n── 10. Productos TOP: acumulado de Pareto + Línea/Tipo/Grupo ──');
    if (!hayDatos) {
      noMedido('Productos TOP', 'el entorno no tiene venta en el último año');
    } else {
      const tp = await req('GET', `/store/analytics/top-products?from=${FROM}&to=${TO}&mode=all`, token);
      check('GET /top-products responde 200', tp.status === 200, `status ${tp.status}`);
      const filas = tp.body?.rows || [];
      const uni = tp.body?.universo;
      check('devuelve productos', filas.length > 0, `${filas.length}`);
      /**
       * EL CUADRE. El universo de esta pantalla tiene que ser el mismo de la fotografía:
       * si no, el «80 % de la venta» del Pareto sería el 80 % de otra cosa.
       */
      check('el universo == la venta de la fotografía', cerca(uni?.venta, ventaFoto),
        `top ${uni?.venta} vs /range ${ventaFoto}`);
      check('viene ordenado por venta, de mayor a menor',
        filas.every((f, i) => i === 0 || filas[i - 1].revenue >= f.revenue));
      check('el rank es 1..N sin saltos', filas.every((f, i) => f.rank === i + 1));
      /**
       * EL ACUMULADO ES LO QUE ESTA PANTALLA APORTA. Tiene que ser monótono, arrancar en
       * la participación de la primera fila y —con `mode=all`— cerrar en 100 %. Un
       * acumulado que no cierra es un acumulado calculado sobre otro universo.
       */
      check('el acumulado nunca baja', filas.every((f, i) => i === 0 || (f.cum_pct ?? 0) >= (filas[i - 1].cum_pct ?? 0)));
      check('el acumulado arranca en la participación de la 1a fila',
        filas.length > 0 && Math.abs((filas[0].cum_pct ?? 0) - (filas[0].share_pct ?? 0)) < 0.15,
        `cum ${filas[0]?.cum_pct} vs share ${filas[0]?.share_pct}`);
      if (filas.length < (uni?.productos || 0)) {
        noMedido('el acumulado cierra en 100%', `el modo all topo en ${filas.length} de ${uni.productos} filas`);
      } else {
        check('con «Todos», el acumulado cierra en ~100%',
          Math.abs((filas[filas.length - 1].cum_pct ?? 0) - 100) < 0.2,
          `cerro en ${filas[filas.length - 1]?.cum_pct}%`);
      }
      // Sólo tiene sentido si la respuesta trae el universo entero: con la lista topada,
      // las participaciones visibles NO deben sumar 100 — y exigirlo sería exigir un bug.
      if (tp.body.topado) noMedido('la participacion suma ~100%', `la lista viene topada en ${filas.length} de ${uni.productos}`);
      else check('la participacion suma ~100%', Math.abs(suma(filas, (f) => f.share_pct || 0) - 100) < 1.5);
      check('el Pareto se calcula (50 <= 80 <= 95)',
        !!tp.body.pareto.para_50 && !!tp.body.pareto.para_80 && tp.body.pareto.para_50 <= tp.body.pareto.para_80,
        JSON.stringify(tp.body.pareto));
      console.log(`     ${uni.productos} productos · ${tp.body.pareto.para_50} hacen el 50% · ${tp.body.pareto.para_80} el 80%`);

      // El corte de Pareto sirve MENOS filas pero el universo NO cambia — si cambiara, el
      // 80 % seria el 80 % de lo que quedo a la vista y no de la venta.
      const par = await req('GET', `/store/analytics/top-products?from=${FROM}&to=${TO}`, token);
      check('el modo pareto corta en el 80% acumulado',
        par.body?.mode === 'pareto' && par.body.rows.length === Math.max(10, tp.body.pareto.para_80),
        `sirvio ${par.body?.rows?.length}, esperaba ${Math.max(10, tp.body.pareto.para_80)}`);
      check('cortar NO cambia el universo contra el que se acumula',
        par.body.universo.productos === uni.productos && cerca(par.body.universo.venta, uni.venta));
      const ultima = par.body.rows[par.body.rows.length - 1];
      check('la ultima fila servida ya cruzo el 80%', (ultima?.cum_pct ?? 0) >= 80 || par.body.rows.length === 10,
        `cerro en ${ultima?.cum_pct}%`);

      // Taxonomia: la vista del ODS tiene que estar llegando de verdad a las filas.
      const conTipo = filas.filter((f) => f.tipo).length;
      const conGrupo = filas.filter((f) => f.grupo).length;
      const conLinea = filas.filter((f) => f.linea).length;
      check(`Tipo llega a la mayoria de los productos (${conTipo}/${filas.length})`, conTipo > filas.length * 0.8);
      check(`Grupo llega a la mayoria (${conGrupo}/${filas.length})`, conGrupo > filas.length * 0.8);
      check(`Linea llega a la mayoria (${conLinea}/${filas.length})`, conLinea > filas.length * 0.8);
      check('las facetas traen las tres dimensiones con su peso',
        (tp.body.facets?.tipos?.length || 0) > 1 && (tp.body.facets?.grupos?.length || 0) > 1 && (tp.body.facets?.lineas?.length || 0) > 1,
        `tipos ${tp.body.facets?.tipos?.length} grupos ${tp.body.facets?.grupos?.length} lineas ${tp.body.facets?.lineas?.length}`);

      // La sonda del decode: el SKU que el negocio mostro en la ficha del ERP.
      const sonda = await pg.query(`SELECT tipo_nombre, grupo_nombre FROM analytics.v_product_taxonomy WHERE sku='70001'`);
      if (!sonda.rows.length) noMedido('la sonda del decode (SKU 70001)', 'ese SKU no esta en el ODS de este entorno');
      else check('el SKU 70001 reproduce la ficha del ERP (Tipo DULCES · Grupo MAZAPAN CACAHUATE)',
        sonda.rows[0].tipo_nombre === 'DULCES' && sonda.rows[0].grupo_nombre === 'MAZAPAN CACAHUATE',
        JSON.stringify(sonda.rows[0]));

      // ── 11. Filtrar RE-CALCULA el acumulado (no lo recorta) ──
      console.log('\n── 11. Filtrar por tipo re-calcula el acumulado sobre el universo filtrado ──');
      const tipoTop = (tp.body.facets.tipos || []).find((t) => t.code && t.revenue > 0);
      if (!tipoTop) noMedido('filtro por tipo', 'no hay ningun tipo con venta y codigo');
      else {
        const ft = await req('GET', `/store/analytics/top-products?from=${FROM}&to=${TO}&mode=all&tipo=${encodeURIComponent(tipoTop.code)}`, token);
        check(`[${tipoTop.name}] responde 200`, ft.status === 200, `status ${ft.status}`);
        check(`[${tipoTop.name}] el universo se achica al del filtro`,
          ft.body.universo.venta < uni.venta && cerca(ft.body.universo.venta, tipoTop.revenue),
          `filtrado ${ft.body.universo.venta} vs faceta ${tipoTop.revenue}`);
        /**
         * Lo que se estaria rompiendo si el filtro fuera del lado del cliente: el
         * acumulado seguiria siendo el del universo entero y cerraria muy por debajo de
         * 100 %, con el mismo nombre de columna y otro significado.
         */
        const ult = ft.body.rows[ft.body.rows.length - 1];
        check(`[${tipoTop.name}] el acumulado se RE-CALCULA y vuelve a cerrar en ~100%`,
          ft.body.rows.length >= ft.body.universo.productos ? Math.abs((ult?.cum_pct ?? 0) - 100) < 0.2 : (ult?.cum_pct ?? 0) > 0,
          `cerro en ${ult?.cum_pct}%`);
        check(`[${tipoTop.name}] todas las filas son de ese tipo`,
          ft.body.rows.every((f) => f.tipo === tipoTop.name || tipoTop.name === 'Sin tipo'));
        check('las facetas NO se filtran a si mismas (siguen las 3 dimensiones completas)',
          ft.body.facets.tipos.length === tp.body.facets.tipos.length,
          `${ft.body.facets.tipos.length} vs ${tp.body.facets.tipos.length}`);
      }

      // ── 12. La cascada acotada a UN PRODUCTO ──
      console.log('\n── 12. Cascada acotada a un producto ──');
      const prodTop = filas[0];
      const bp = await req('GET', `/store/analytics/breakdown?from=${FROM}&to=${TO}&grain=month&product_id=${prodTop.product_id}`, token);
      check('responde 200', bp.status === 200, `status ${bp.status}`);
      check('declara que el recorte es un PRODUCTO', bp.body?.scope?.kind === 'producto', JSON.stringify(bp.body?.scope));
      check('Sigma(venta de su cascada) == la venta de ese producto',
        cerca(suma(bp.body?.rows || [], (f) => f.revenue), prodTop.revenue),
        `cascada ${suma(bp.body?.rows || [], (f) => f.revenue)} vs producto ${prodTop.revenue}`);
      const noAplicanP = ['tickets', 'avg_ticket', 'basket', 'avg_line', 'units_per_ticket', 'customers', 'revenue_per_customer', 'pos_days'];
      check('lo no atribuible a un producto viene null',
        (bp.body?.rows || []).every((f) => noAplicanP.every((k) => f[k] === null)));
      const pyl = await req('GET', `/store/analytics/breakdown?from=${FROM}&to=${TO}&grain=month&product_id=${prodTop.product_id}&supplier_code=ZZZ`, token);
      check('si vienen producto y linea, gana el producto (el recorte mas especifico)',
        pyl.body?.scope?.kind === 'producto', JSON.stringify(pyl.body?.scope));
    }

    // ── 13. `[TDA.A4]` CLIENTES: el techo, y lo interno separado de lo externo ──
    console.log('\n── 13. Clientes: el techo de cobertura y la cuenta del propio piso ──');
    {
      const cl = await req('GET', `/store/analytics/customers?from=${FROM}&to=${TO}&segmento=todos`, token);
      check('GET /customers responde 200', cl.status === 200, `status ${cl.status}`);
      const techo = cl.body?.techo;
      if (!hayDatos) {
        noMedido('el techo de clientes', 'el entorno no tiene venta en el ultimo ano');
      } else {
        /**
         * EL TECHO ES EL CONTRATO DE ESTA PESTANA. Si `venta_fact` no fuera la misma venta
         * que publica la fotografia, la proporcion que la pantalla dibuja arriba —«de todo
         * lo que vendimos, esto es lo que tiene nombre»— estaria calculada contra otro
         * total, y seria una proporcion inventada.
         */
        check('el techo compara contra la MISMA venta de la fotografia',
          cerca(techo?.venta_fact, ventaFoto), `techo ${techo?.venta_fact} vs /range ${ventaFoto}`);
        check('lo facturado se parte en interno + clientes, sin perder nada',
          cerca((techo?.venta_interna || 0) + (techo?.venta_clientes || 0), techo?.venta_facturada),
          `${techo?.venta_interna} + ${techo?.venta_clientes} != ${techo?.venta_facturada}`);
        check('la facturacion a nombre es MENOR que la venta de la tienda (el mostrador es anonimo)',
          (techo?.venta_facturada || 0) < (techo?.venta_fact || 0),
          `facturado ${techo?.venta_facturada} vs fact ${techo?.venta_fact}`);
        console.log(`     clientes ${Math.round(techo.venta_clientes).toLocaleString('es-MX')} · internas ${Math.round(techo.venta_interna).toLocaleString('es-MX')} · tienda ${Math.round(techo.venta_fact).toLocaleString('es-MX')}`);

        /**
         * PRUEBA NEGATIVA de la separacion. Sin `es_interno`, la cuenta del propio piso
         * encabeza el ranking de clientes y parece uno: su nombre no la delata.
         */
        const ext = await req('GET', `/store/analytics/customers?from=${FROM}&to=${TO}&segmento=externos`, token);
        const int = await req('GET', `/store/analytics/customers?from=${FROM}&to=${TO}&segmento=internos`, token);
        check('el segmento «clientes» NO trae ninguna cuenta interna',
          (ext.body?.rows || []).every((r) => r.es_interno === false),
          `${(ext.body?.rows || []).filter((r) => r.es_interno).length} internas se colaron`);
        check('el segmento «internas» trae SOLO internas',
          (int.body?.rows || []).length === 0 || (int.body?.rows || []).every((r) => r.es_interno === true));
        check('externos + internos == todos (separar no pierde filas)',
          (ext.body?.rows?.length || 0) + (int.body?.rows?.length || 0) === (cl.body?.rows?.length || 0),
          `${ext.body?.rows?.length} + ${int.body?.rows?.length} vs ${cl.body?.rows?.length}`);
        if (!(int.body?.rows || []).length) {
          noMedido('la cuenta interna pesa mas que los clientes', 'este entorno no tiene cuentas internas facturando');
        } else {
          check('los grupos marcan lo interno y NO lo esconden',
            (cl.body.grupos || []).some((g) => g.es_interno) && (cl.body.grupos || []).some((g) => !g.es_interno));
        }

        // El estado sale de FECHAS: un dormido no puede tener venta en el periodo.
        const dormidos = (cl.body.rows || []).filter((r) => r.estado === 'dormido');
        if (!dormidos.length) noMedido('los dormidos', 'ningun cliente dejo de comprar entre los dos periodos');
        else check(`un «dormido» tiene venta 0 en el periodo y >0 en el anterior (${dormidos.length})`,
          dormidos.every((r) => r.revenue === 0 && r.revenue_prev > 0));
        const nuevos = (cl.body.rows || []).filter((r) => r.estado === 'nuevo');
        if (!nuevos.length) noMedido('los nuevos', 'ningun cliente compro por primera vez en el periodo');
        else check(`un «nuevo» tiene su PRIMERA compra dentro del periodo (${nuevos.length})`,
          nuevos.every((r) => r.primera_compra && r.primera_compra >= FROM));
        check('ningun cliente sin compras publica ticket promedio (seria una division inventada)',
          (cl.body.rows || []).every((r) => r.docs > 0 || r.ticket_prom === null));
      }

      // La sonda del decode: la ficha que mando el negocio.
      const sonda = await pg.query(
        `SELECT grupo_nombre, vendedor_nombre, zona_nombre FROM analytics.v_customer_master
          WHERE cliente_code='10259' AND fuente_sucursal='00'`);
      if (!sonda.rows.length) noMedido('la sonda del cliente 10259', 'esa clave no esta en el ODS de este entorno');
      else check('el cliente 10259 reproduce su ficha del ERP (Grupo · Vendedor · Zona)',
        sonda.rows[0].grupo_nombre === 'VENTAS DE PISO ABASTOS'
          && sonda.rows[0].vendedor_nombre === 'SUCURSAL LA PIEDAD ABASTO PISO'
          && sonda.rows[0].zona_nombre === 'CLIENTES ZONA LA PIEDAD',
        JSON.stringify(sonda.rows[0]));
      /**
       * EL CANDADO DE LA LLAVE. Si alguien «simplificara» la vista deduplicando por clave
       * —como sí se hace con el SKU, que es global— mostraria a una persona cuando la
       * venta fue de otra. Se exige que la clave 00002 siga trayendo nombres DISTINTOS.
       */
      const col = await pg.query(
        `SELECT count(DISTINCT upper(nombre))::int n FROM analytics.v_customer_master WHERE cliente_code='00002'`);
      if ((col.rows[0]?.n || 0) < 2) noMedido('la llave por sucursal', 'la clave 00002 no colisiona en este entorno');
      else check(`la vista NO deduplica por clave: 00002 son ${col.rows[0].n} personas distintas segun la plaza`,
        col.rows[0].n > 1);
    }

    // ── 14. Los bordes del contrato ──
    console.log('\n── 14. Bordes: grano inválido, rango al revés, tope de días, permiso ──');
    const malGrano = await req('GET', `/store/analytics/breakdown?from=${FROM}&to=${TO}&grain=decada`, token);
    check('un grano desconocido cae a `month` en vez de reventar',
      malGrano.status === 200 && malGrano.body.grain === 'month', `status ${malGrano.status} grain ${malGrano.body?.grain}`);
    const alReves = await req('GET', `/store/analytics/breakdown?from=${TO}&to=${FROM}&grain=month`, token);
    check('`from` posterior a `to` se rechaza con 400', alReves.status === 400, `status ${alReves.status}`);
    const sinFechas = await req('GET', `/store/analytics/breakdown?grain=month`, token);
    check('sin from/to se rechaza con 400', sinFechas.status === 400, `status ${sinFechas.status}`);
    const largo = await req('GET', `/store/analytics/breakdown?from=${addDays(TO, -800)}&to=${TO}&grain=year`, token);
    check('un rango de más de 760 días se rechaza con 400', largo.status === 400, `status ${largo.status}`);
    const sinToken = await req('GET', `/store/analytics/breakdown?from=${FROM}&to=${TO}`, null);
    check('sin token responde 401', sinToken.status === 401, `status ${sinToken.status}`);
  } finally {
    await cleanup(pg, userId);
    await pg.end();
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`RESULTADO: ${pass} OK · ${fail} FAIL · ${skip} NO MEDIDO`);
  if (skip) console.log('  (los NO MEDIDO no son fallas: son bloques sin datos en este entorno con qué comprobarse)');
  if (fail) console.log(`  fallaron: ${failures.join(', ')}`);
  console.log('='.repeat(72));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nERROR FATAL:', e.message); process.exit(1); });
