/* eslint-disable no-console */
/**
 * CG.19 Capa 0 — siembra la PROPUESTA del mapa ruta -> cliente del ERP.
 *
 * La migracion 20260918260000 creo finance.route_customer_map y declaro en su cabecera que
 * "la propuesta la hace seed-route-customer-map.js". **Ese script nunca se escribio**, y por eso
 * la tabla lleva desde el 18-sep con CERO filas en produccion: el mapa existe, nadie lo puede
 * llenar, y el consumidor sigue resolviendo la identidad de la ruta con una expresion regular
 * sobre un nombre -- en tres lugares y con dos expresiones distintas. Este archivo cierra eso.
 *
 * -- De donde sale cada lado, medido antes de escribir ----------------------------------------
 *
 * IZQUIERDA: analytics.v_route_zone -- el registro operativo (18 rutas: 13 'ruta' a detalle y
 * 5 'vecinal'). No una lista tecleada: cuando la operacion da de alta otra, entra sola.
 *
 * DERECHA: analytics.erp_collections con tipo_cuenta='ruta' -- los clientes con los que Kepler
 * cobra la venta de ruta. Es un dato ESTRUCTURADO del ERP, no texto libre: trae cliente_code y
 * cliente_nombre. Medido en prod el 2026-10-06 son 16 clientes, y su codigo NO sigue una sola
 * convencion -- 'RUTA 21', 'RD 501', '2-32-321', 'RV001', 'RV3001', '2-32-RV01'. Cinco formas.
 * Por eso esto se propone y lo confirma un humano, en vez de cablear una sexta regex.
 *
 * -- Por que hay DOS testigos y no uno ---------------------------------------------------------
 *
 * Un nombre que dice "27" es un atributo debil (regla M3 de la fase). Asi que la propuesta se
 * arma con dos metodos independientes y solo se emite cuando coinciden:
 *
 *   1. NOMBRE  -- el numero de ruta que aparece en cliente_code / cliente_nombre.
 *   2. DINERO  -- cuantos cobros de ese cliente reproducen, al peso, la venta de esa ruta
 *                 (analytics.v_rd_route_daily) dentro de una ventana de 10 dias. El importe es
 *                 un arbitro independiente del nombre: nadie lo teclea para que coincida.
 *
 * Y el dinero viene con su PLACEBO: se cuenta tambien contra cuantas rutas AJENAS casa el mismo
 * cliente. Si casa parejo con varias, el metodo no discrimina y no se propone nada. Un arbitro
 * que nunca contradice es un espejo.
 *
 * -- Lo que NO hace ----------------------------------------------------------------------------
 *
 * No confirma. source='derivado' y confirmed_at en NULL. Una fila derivada NO alcanza para
 * aplicar dinero: eso lo decide la Capa 2 y exige firma. Y nunca pisa una fila confirmada.
 * Lo que no se puede proponer entra con cliente_code en NULL -- el estado honesto "sin propuesta",
 * que el CHECK rcm_par_chk obliga a que viaje junto con cliente_nombre en NULL.
 *
 *   node database/scripts/seed-route-customer-map.js                  # dry-run
 *   node database/scripts/seed-route-customer-map.js --apply
 *   node database/scripts/seed-route-customer-map.js --desde=2026-06-01
 */
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const M = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
const DESDE = (process.argv.find((a) => a.startsWith('--desde=')) || '').split('=')[1] || '2026-08-01';
const URL = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;

/** Tolerancia del arbitro de dinero. Medido: el capturista redondea al peso, nunca mas de $1.10. */
const EPS = 2;
/** Dias que puede tardar el cobro en registrarse despues de la venta. Medido: 0 a 4. */
const VENTANA = 10;
/**
 * Piso del arbitro de dinero, y no es arbitrario: la primera corrida propuso la ruta 505 para el
 * cliente RV3001 (una vecinal de otra plaza) con UN solo acierto -- un cobro de $17,521.17 contra
 * una venta de $17,521.39. Con ruido 0, "mas que ninguno" bastaba. Dos importes grandes coinciden
 * por azar mas seguido de lo que parece; una coincidencia no es evidencia.
 * Las 6 rutas de PH que si casan traen 42 a 50 aciertos contra 0 o 1 -- o sea que el piso no
 * recorta nada bueno: separa 50/1 de 1/0.
 */
const MIN_EVIDENCIA = 5;
const MIN_RAZON = 3;

/**
 * El numero de ruta que declara un texto del ERP. Devuelve null si no lo declara, que NO es lo
 * mismo que cero: 'R.V. PH SALGADO MORALES' no trae numero y esta bien que no lo traiga.
 *
 * El orden importa. '2-32-321' tiene tres numeros y el bueno es el ultimo segmento; empezar por
 * "el primer numero de 2 o 3 digitos" devolveria '32' (la sucursal) y propondria una ruta que no
 * existe. Las reglas van de la mas especifica a la mas laxa y cada una se nombra, para que una
 * heuristica mala se pueda retirar sin revisar las 18 a mano.
 */
function numeroDeRuta(texto) {
  const t = String(texto || '').trim();
  if (!t) return null;
  let m;
  if ((m = t.match(/^RUTA\s*0*(\d{2,3})$/i))) return { num: m[1], regla: 'codigo_ruta_NN' };
  if ((m = t.match(/^R\.?\s?D\.?\s*0*(\d{2,3})$/i))) return { num: m[1], regla: 'codigo_rd_NN' };
  if ((m = t.match(/-0*(\d{2,3})$/))) return { num: m[1], regla: 'codigo_ultimo_segmento' };
  if ((m = t.match(/\bR\.?\s?[DV]\.?\s*0*(\d{2,3})\b/i))) return { num: m[1], regla: 'nombre_rd_NN' };
  if ((m = t.match(/\bRD\s+[A-ZÁÉÍÓÚÑ]+\s+0*(\d{2,3})\b/i))) return { num: m[1], regla: 'nombre_rd_plaza_NN' };
  return null;
}

const money = (v) => '$' + Number(v || 0).toLocaleString('es-MX', { maximumFractionDigits: 0 });

(async () => {
  if (!URL) throw new Error('falta DATABASE_URL_NEW');
  const c = new Client({ connectionString: URL, statement_timeout: 180000 });
  await c.connect();
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [M]);
    const db = await c.query(`SELECT current_database() d, inet_server_addr()::text h`);
    console.log(`\n=== CG.19 siembra del mapa ruta -> cliente (${APPLY ? 'APPLY' : 'DRY-RUN'})`
      + ` · ${db.rows[0].d}@${db.rows[0].h || 'local'} · desde ${DESDE} ===\n`);

    for (const rel of ['analytics.v_route_zone', 'analytics.erp_collections', 'analytics.v_rd_route_daily']) {
      const r = await c.query(`SELECT to_regclass($1) t`, [rel]);
      if (!r.rows[0].t) throw new Error(`no existe ${rel} — sin eso no hay de donde proponer`);
    }

    // IZQUIERDA: el registro operativo.
    const rutas = (await c.query(`
      SELECT route_code, route_name, tipo, parent_code
        FROM analytics.v_route_zone WHERE tenant_id = $1 ORDER BY tipo, route_code`, [M])).rows;

    // DERECHA: los clientes con los que el ERP cobra la ruta.
    const clientes = (await c.query(`
      SELECT cliente_code, max(cliente_nombre) AS cliente_nombre, max(sucursal) AS sucursal,
             count(*)::int AS cobros, sum(monto)::numeric AS total,
             min(cobro_date)::text AS d0, max(cobro_date)::text AS d1
        FROM analytics.erp_collections
       WHERE tipo_cuenta = 'ruta' AND cobro_date >= $1 AND cliente_code IS NOT NULL
       GROUP BY 1 ORDER BY 1`, [DESDE])).rows;

    // EL ARBITRO DE DINERO. Cada cobro contra la venta de CADA ruta, no solo la candidata:
    // la columna que importa no es cuantas veces acierta sino si acierta MAS que con las otras.
    const ev = (await c.query(`
      WITH cob AS (
        SELECT cliente_code, cobro_date, monto FROM analytics.erp_collections
         WHERE tipo_cuenta = 'ruta' AND cobro_date >= $1 AND cliente_code IS NOT NULL AND monto > 0
      ), ven AS (
        SELECT route_code, business_date, venta FROM analytics.v_rd_route_daily
         WHERE business_date >= ($1::date - $3::int) AND venta > 0
      )
      SELECT c.cliente_code, v.route_code, count(*)::int AS n
        FROM cob c
        JOIN ven v ON abs(c.monto - v.venta) <= $2
                  AND v.business_date BETWEEN c.cobro_date - $3::int AND c.cobro_date
       GROUP BY 1, 2`, [DESDE, EPS, VENTANA])).rows;

    const porCliente = new Map();
    for (const r of ev) {
      if (!porCliente.has(r.cliente_code)) porCliente.set(r.cliente_code, []);
      porCliente.get(r.cliente_code).push({ route: r.route_code, n: r.n });
    }
    for (const v of porCliente.values()) v.sort((a, b) => b.n - a.n);

    // Propuesta por cliente: nombre y dinero tienen que apuntar al mismo lado.
    const candidatos = new Map(); // route_code -> [{ cliente, ... }]
    const descartados = [];       // clientes que no produjeron candidato, con el motivo

    for (const cl of clientes) {
      const porNombre = numeroDeRuta(cl.cliente_code) || numeroDeRuta(cl.cliente_nombre);
      const dinero = porCliente.get(cl.cliente_code) || [];
      const mejor = dinero[0] || null;
      const ruido = dinero[1] ? dinero[1].n : 0;
      // El dinero solo VOTA si discrimina. Ver MIN_EVIDENCIA.
      const dineroVale = !!mejor && mejor.n >= MIN_EVIDENCIA && mejor.n >= Math.max(1, ruido) * MIN_RAZON;

      // Un numero que el nombre saca pero que NO es una ruta del registro no es un candidato que
      // compita con el dinero: es un parseo fallido. Medido: el codigo `RV001` da "01" --
      // no existe ninguna ruta 01 -- mientras el dinero lo pega a `1V001` con 16 aciertos y cero
      // ruido. Tratarlo como discrepancia dejaba fuera a las dos vecinales de Padre Hidalgo, que
      // es justo la identidad que nadie habia podido derivar.
      const nombreResuelve = !!porNombre && rutas.some((r) => r.route_code === porNombre.num);

      let route = null; let regla = null; let motivo = null;
      if (porNombre && dineroVale && porNombre.num === mejor.route) {
        route = mejor.route; regla = `${porNombre.regla}+dinero`;
      } else if (!nombreResuelve && dineroVale) {
        route = mejor.route;
        regla = porNombre ? `dinero (el nombre dio ${porNombre.num}, que no es ruta)` : 'dinero';
      } else if (porNombre && dineroVale && porNombre.num !== mejor.route) {
        motivo = `DISCREPAN: el nombre dice ${porNombre.num} y el dinero ${mejor.route} (${mejor.n} aciertos)`;
      } else if (porNombre) {
        // Sin arbitro: el nombre solo. Se propone, pero se rotula -- es mas debil y hay que verlo.
        route = porNombre.num;
        regla = `${porNombre.regla} SIN arbitro de dinero`;
      } else if (mejor) {
        // ⛔ Nunca se propone por dinero a secas: midio 1 acierto y basto para inventar un par.
        motivo = `solo dinero (${mejor.n} aciertos con ${mejor.route}) y el nombre no declara ruta`
          + ' — insuficiente, el importe coincide por azar';
      } else {
        motivo = 'el nombre no declara ruta y ningun cobro casa con la venta de ninguna';
      }

      const existe = route && rutas.some((r) => r.route_code === route);
      if (!existe) {
        descartados.push({ ...cl, motivo: motivo || `propone ${route}, que no esta en el registro operativo` });
        continue;
      }
      if (!candidatos.has(route)) candidatos.set(route, []);
      candidatos.get(route).push({
        cliente: cl.cliente_code, nombre: cl.cliente_nombre, sucursal: cl.sucursal,
        regla, evidencia: mejor ? mejor.n : 0, ruido, cobros: cl.cobros,
        total: Number(cl.total), d0: cl.d0, d1: cl.d1,
      });
    }

    // Dos clientes para una ruta no siempre es ambiguedad. Medido en Canindo: `RUTA 50N` cobro de
    // enero al 13-ago (y tres de esas cuentas se llaman literalmente TEMPORAL) y `RD 50N` desde el
    // 12-ago hasta hoy. No se solapan: es una SUCESION de cuentas, no dos candidatos para el mismo
    // hecho. Cuando los rangos no se tocan gana la vigente y la anterior queda anotada; cuando SI
    // se solapan no hay forma de decidir y se deja sin propuesta.
    const propuesta = new Map();
    const conflicto = new Map();
    for (const [route, lista] of candidatos) {
      if (lista.length === 1) { propuesta.set(route, lista[0]); continue; }
      const orden = [...lista].sort((a, b) => (a.d0 < b.d0 ? -1 : 1));
      const seSolapan = orden.some((x, i) => i > 0 && x.d0 < orden[i - 1].d1);
      if (seSolapan) { conflicto.set(route, lista.map((x) => x.cliente)); continue; }
      const vigente = orden[orden.length - 1];
      const previos = orden.slice(0, -1);
      propuesta.set(route, {
        ...vigente,
        regla: `${vigente.regla} · sucesion`,
        previos: previos.map((p) => `${p.cliente} (${p.d0}→${p.d1})`),
      });
    }

    console.log(`  ${rutas.length} rutas en el registro · ${clientes.length} clientes de ruta en el ERP`
      + ` · ${propuesta.size} propuestas\n`);
    console.log('  ruta   tipo      cliente ERP    evid/ruido  regla');
    console.log('  ' + '-'.repeat(86));
    for (const r of rutas) {
      const p = propuesta.get(r.route_code);
      const ev2 = p ? `${p.evidencia}/${p.ruido}`.padStart(10) : '         —';
      const cl = p ? p.cliente.padEnd(14) : '(sin propuesta)'.padEnd(14);
      const rg = conflicto.has(r.route_code)
        ? `CONFLICTO: ${conflicto.get(r.route_code).join(', ')}`
        : (p ? p.regla : '');
      console.log(`  ${r.route_code.padEnd(6)} ${r.tipo.padEnd(9)} ${cl} ${ev2}  ${rg}`);
    }
    for (const [rc, p] of propuesta) {
      if (p.previos) console.log(`    ↳ ${rc}: cuenta anterior ${p.previos.join(', ')}`);
    }
    if (descartados.length) {
      console.log('\n  ⚠️ clientes del ERP que cobran ruta y quedaron SIN ligar — con su motivo:');
      for (const s of descartados) {
        console.log(`     ${s.cliente_code.padEnd(12)} ${String(s.cliente_nombre).slice(0, 40).padEnd(40)}`
          + ` ${String(s.cobros).padStart(4)} cob ${money(s.total).padStart(12)}`);
        console.log(`       └ ${s.motivo}`);
      }
    }

    if (!APPLY) { console.log('\n  (dry-run: no se escribio nada. Agrega --apply)\n'); return; }

    let nuevas = 0; let refrescadas = 0; let protegidas = 0;
    for (const r of rutas) {
      const p = propuesta.get(r.route_code) || null;
      const note = conflicto.has(r.route_code)
        ? `sin propuesta: ${conflicto.get(r.route_code).length} clientes del ERP reclaman esta ruta `
          + `(${conflicto.get(r.route_code).join(', ')})`
        : (p ? `evidencia ${p.evidencia} cobros al peso contra ${p.ruido} de la siguiente ruta; `
             + `${p.cobros} cobros ${money(p.total)} desde ${DESDE}`
             + (p.previos ? `; cuenta anterior ${p.previos.join(', ')}` : '') : null);
      // Una fila CONFIRMADA es trabajo humano: no se pisa nunca.
      const res = await c.query(`
        INSERT INTO finance.route_customer_map
               (tenant_id, route_code, route_name, sucursal, cliente_code, cliente_nombre,
                source, match_regla, note)
        VALUES ($1, $2, $3, $4, $5, $6, 'derivado', $7, $8)
        ON CONFLICT (tenant_id, route_code, coalesce(sucursal, ''))
        DO UPDATE SET route_name     = excluded.route_name,
                      cliente_code   = excluded.cliente_code,
                      cliente_nombre = excluded.cliente_nombre,
                      match_regla    = excluded.match_regla,
                      note           = excluded.note,
                      updated_at     = now()
          WHERE finance.route_customer_map.confirmed_at IS NULL
            AND (finance.route_customer_map.cliente_code IS DISTINCT FROM excluded.cliente_code
              OR finance.route_customer_map.match_regla  IS DISTINCT FROM excluded.match_regla
              OR finance.route_customer_map.note         IS DISTINCT FROM excluded.note)
        RETURNING (xmax = 0) AS insertada`,
      [M, r.route_code, r.route_name, p ? p.sucursal : null,
        p ? p.cliente : null, p ? p.nombre : null,
        p ? p.regla : (conflicto.has(r.route_code) ? 'conflicto' : 'sin_propuesta'), note]);
      if (!res.rowCount) { protegidas++; continue; }
      if (res.rows[0].insertada) nuevas++; else refrescadas++;
    }
    console.log(`\n  ${nuevas} nuevas · ${refrescadas} refrescadas · ${protegidas} sin cambio (o confirmadas)\n`);

    const cov = await c.query(`SELECT * FROM finance.v_route_customer_map_coverage`);
    for (const r of cov.rows) {
      console.log(`  COBERTURA: ${r.rutas} rutas · ${r.con_propuesta} con propuesta`
        + ` · ${r.sin_propuesta} SIN · ${r.confirmadas} confirmadas · ${r.por_confirmar} por confirmar`);
    }
    console.log('\n  Nada de esto aplica dinero todavia: la Capa 2 exige confirmed_at.\n');
  } finally {
    await c.end().catch(() => {});
  }
})().catch((e) => { console.error('\n💥', e.message); process.exitCode = 1; });
