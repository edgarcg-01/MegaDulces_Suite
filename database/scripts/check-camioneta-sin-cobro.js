/* eslint-disable no-console */
/**
 * ⭐⭐ `[CGA-A.13]` — **Qué camioneta manda su VENTA y no manda su COBRO.**
 *
 *   node database/scripts/check-camioneta-sin-cobro.js
 *   node database/scripts/check-camioneta-sin-cobro.js --self-test
 *
 * Lee el runner (`kepler_consolidado`, `DATABASE_URL_KEPLER_CONSOLIDADO`). No escribe nada.
 * **Exit 1** cuando una unidad con venta fresca lleva su cobro atrasado o ausente: eso es
 * efectivo que ya se levantó y que nadie puede ver en Caja General.
 *
 * ── Por qué existe, medido el 2026-10-16 ───────────────────────────────────────────────────
 *
 * El `.cmd` de cada camioneta se **pega a mano, máquina por máquina**. No hay plantilla única ni
 * nadie que compare lo desplegado contra lo esperado, así que **un bloque faltante no produce
 * rojo: produce silencio**. Ese día hubo que cablear cuatro unidades a mano, y el censo decía:
 *
 *     11 camionetas empujan VENTAS   ·   4 empujaban COBROS
 *
 * ⛔ **Y el modo de fallar es el de siempre en este carril: no hay error, no hay log, no hay
 * descuadre.** Una unidad que nunca mandó cobros se ve **exactamente igual** que una que no
 * cobró nada. `GOTCHAS` §84 (un carril verde puede ser que murió el origen) y §86.
 *
 * ⭐ **Por eso se cruzan DOS latidos y no se mira uno.** La venta es el testigo independiente:
 * si una unidad mandó venta hoy, estuvo prendida, con red y con su Kepler vivo — así que la
 * ausencia del cobro **no es la camioneta, es el `.cmd`**. Mismo razonamiento que
 * `check-route-stock-push.js` (`[RD.32]`), que ya hace esto para la existencia.
 *
 * ── ⛔ [CGA-A.13b] EL LATIDO MIDE QUE EMPUJÓ, NO QUÉ EMPUJÓ — medido el 2026-10-22 ────────
 *
 * La versión anterior leía SÓLO los dos latidos del runner, y por eso `ruta_504` pasó **veinte
 * días en verde**:
 *
 *     ruta 504 · empujó hace 23 min   → la compuerta decía «✓ al día»
 *              · su última venta      → 01-oct, hace 20 días
 *
 * El `.cmd` corría, conectaba y escribía su latido; lo que mandaba era de hace tres semanas. Un
 * latido fresco con dato viejo se ve EXACTAMENTE igual que uno sano — es el mismo modo de fallar
 * que esta compuerta ya documenta, una capa más adentro.
 *
 * ⭐ Por eso ahora se cruzan TRES cosas y no dos: los dos latidos (¿empujó?) **y la fecha del
 * dato que aterrizó en prod** (¿qué empujó?). Son preguntas distintas y fallan por separado.
 *
 * ⚠️ Y aparecen las que NO están en el inventario del runner: las cuatro vecinales (`1V00x`) no
 * tienen fila de latido, así que para la versión anterior **no existían**. Llevan 14 días sin
 * mandar venta y ninguna mandó jamás un cobro.
 *
 * ⚠️ Lo que NO contesta: si el importe es correcto. Eso lo mide
 * `check-cobro-monto-desfasado.js` del lado de prod. Acá se mide **entrega** (ADR-053).
 */
'use strict';
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const SELF = process.argv.includes('--self-test');

/** Una unidad que mandó venta dentro de esta ventana estuvo viva: su cobro es exigible. */
const VENTA_FRESCA_H = 36;
/** Más de esto sin cobros, con venta fresca, es un carril caído o nunca cableado. */
const COBRO_RANCIO_H = 36;
/**
 * `[CGA-A.13b]` Días de atraso del DATO aterrizado que se toleran antes de gritar.
 *
 * ⚠️ **Tres y no uno, por el fin de semana**: las rutas no venden domingo, así que un lunes sano
 * ya arrastra dos días y un umbral de 1 gritaría todos los lunes. Una compuerta que grita cuando
 * no pasa nada se apaga a la semana, y así es como se pierde una compuerta.
 *
 * Medido el 2026-10-22, para que el número no se lea como gusto: los casos reales están muy por
 * encima — la 504 con 21 días, las vecinales con 15, la 501 con 8.
 */
const DATO_RANCIO_D = 3;
/**
 * `[RC.6]` El carril de cobros ya no espera 15 min: cada laptop corre un RESIDENTE que empuja
 * cada 20 s (`push-cobros.cmd`). Si la laptop está en línea (la venta empujó hace poco) y el
 * latido de cobros tiene más de esto, el residente se cayó o nunca se instaló.
 *
 * Pedido de Edgar el 2026-10-22, con la ruta 26 esperando: «15 minutos de espera nadie los
 * hace». Por eso esto es ROJO y no aviso: una unidad sin residente es el incidente de vuelta.
 */
const RESIDENTE_RANCIO_MIN = 3;
/** Más de esto sin venta = la laptop no está en línea; no se le puede exigir residente. */
const EN_LINEA_MIN = 20;

const horas = (t) => (t ? (Date.now() - new Date(t).getTime()) / 3.6e6 : null);
const edad = (h) => (h == null ? 'nunca' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${Math.round(h / 24)} d`);
const money = (v) => (v == null ? '—' : '$' + Math.round(Number(v)).toLocaleString('en-US'));
const pad = (s, n) => String(s ?? '').padEnd(n);

/**
 * ⭐ El `LEFT JOIN` es lo que carga el peso: **una unidad SIN fila de cobros tiene que salir**,
 * y es justamente el caso que más duele (nunca se cableó). El `--self-test` lo degrada a `INNER`
 * —el error natural de quien escribe esta consulta— y exige que encuentre MENOS.
 */
const censo = (join) => `
  SELECT v.truck,
         v.last_ok AS venta_ok, v.rows_last AS venta_filas,
         c.last_ok AS cobro_ok, c.rows_last AS cobro_filas, c.valor_last AS cobro_valor,
         host(coalesce(c.client_ip, v.client_ip)) AS ip
    FROM ingest.route_push_heartbeat v
    ${join} JOIN ingest.route_collections_heartbeat c ON c.truck = v.truck
   ORDER BY v.truck`;

/**
 * ⭐ `[CGA-A.13b]` **Qué tan viejo es el dato que ATERRIZÓ**, que es otra pregunta que el latido.
 *
 * Se lee de prod y es OPCIONAL a propósito: sin `PROD_DB_URL` la compuerta sigue corriendo con
 * lo que sí puede medir, y lo DECLARA. Una compuerta que se cae entera porque le falta una de
 * sus dos fuentes deja de correr, y una compuerta que no corre no protege nada.
 */
async function datoAterrizado() {
  const url = process.env.PROD_DB_URL;
  if (!url) return null;
  const p = new Client({ connectionString: url, ssl: false, connectionTimeoutMillis: 10000 });
  try {
    await p.connect();
    await p.query(`SET default_transaction_read_only = on`);
    await p.query(`SET statement_timeout='30s'`);
    const { rows: v } = await p.query(`
      SELECT route_no ruta, max(business_date) dia FROM analytics.route_push_lines GROUP BY 1`);
    const { rows: c } = await p.query(`
      SELECT replace(truck,'ruta_','') ruta, max(fecha) dia
        FROM analytics.route_collections WHERE cuenta='0011' GROUP BY 1`);
    const m = new Map();
    const put = (r, k, d) => { const o = m.get(r) ?? {}; o[k] = d; m.set(r, o); };
    for (const r of v) put(String(r.ruta), 'venta', r.dia);
    for (const r of c) put(String(r.ruta), 'cobro', r.dia);
    return m;
  } catch { return null; } finally { try { await p.end(); } catch { /* ya cerrada */ } }
}

/** Días entre hoy y una fecha de negocio. `null` = nunca llegó nada. */
const dias = (d) => (d == null ? null : Math.round((Date.now() - new Date(d).getTime()) / 864e5));
const corto = (d) => (d == null ? 'nunca' : String(d instanceof Date ? d.toISOString() : d).slice(0, 10));

/**
 * La regla, en un solo lugar: se usa igual en el informe y en la prueba negativa.
 *
 * ⛔ El orden importa. `dato_rancio` va ANTES de `al_dia` y DESPUÉS de los dos del cobro: una
 * unidad que empuja puntualmente datos de hace tres semanas no está «al día», y una que ni
 * siquiera manda cobros tiene un problema más específico que merece su propio nombre.
 */
function clasificar(r) {
  const hv = horas(r.venta_ok);
  const hc = horas(r.cobro_ok);
  if (r.fuera_inventario) return 'fuera_inventario';             // ni latido tiene
  if (hv == null || hv > VENTA_FRESCA_H) return 'dormida';      // no mandó venta: otro problema
  if (hc == null) return 'sin_cablear';                          // venta fresca, cobro NUNCA
  if (hc > COBRO_RANCIO_H) return 'carril_caido';                // venta fresca, cobro rancio
  // `[RC.6]` Laptop en línea y el cobro sin latir hace > 3 min: el residente de 20 s no está.
  if (hv * 60 <= EN_LINEA_MIN && hc * 60 > RESIDENTE_RANCIO_MIN) return 'sin_residente';
  // `[CGA-A.13b]` Empuja puntual, pero lo que manda es viejo. El caso de la 504.
  const dv = dias(r.dato_venta);
  const dc = dias(r.dato_cobro);
  if (r.dato_medido && ((dv != null && dv > DATO_RANCIO_D) || (dc != null && dc > DATO_RANCIO_D))) {
    return 'dato_rancio';
  }
  return 'al_dia';
}

const ROTULO = {
  al_dia: '✓ al día',
  carril_caido: '⛔ CARRIL CAÍDO',
  sin_cablear: '⛔ SIN CABLEAR',
  dato_rancio: '⛔ EMPUJA DATO VIEJO',
  sin_residente: '⛔ SIN RESIDENTE (cobro a 15 min)',
  fuera_inventario: '⛔ FUERA DEL INVENTARIO',
  dormida: '·  dormida',
};

/**
 * ⚠️ `dato` se pasa, no se vuelve a leer: el `--self-test` corre `leer` dos veces y abrir dos
 * conexiones a prod por cada corrida sería pagar la medición dos veces para nada.
 */
async function leer(c, join, dato) {
  const { rows } = await c.query(censo(join));
  const medido = dato != null;
  const filas = rows.map((r) => {
    const d = dato?.get(String(r.truck).replace('ruta_', '')) ?? {};
    const x = { ...r, dato_medido: medido, dato_venta: d.venta ?? null, dato_cobro: d.cobro ?? null };
    return { ...x, estado: clasificar(x) };
  });

  /**
   * ⭐ Las que están en el dato de prod y NO en el inventario del runner. Para la versión
   * anterior no existían: el censo arranca `FROM route_push_heartbeat`, así que una unidad sin
   * latido era invisible — y las cuatro vecinales llevan 14 días así.
   */
  if (medido) {
    const conLatido = new Set(filas.map((r) => String(r.truck).replace('ruta_', '')));
    for (const [ruta, d] of dato) {
      if (conLatido.has(ruta)) continue;
      const x = {
        truck: ruta, venta_ok: null, cobro_ok: null, venta_filas: null, cobro_filas: null,
        cobro_valor: null, ip: null, fuera_inventario: true, dato_medido: true,
        dato_venta: d.venta ?? null, dato_cobro: d.cobro ?? null,
      };
      filas.push({ ...x, estado: clasificar(x) });
    }
    filas.sort((a, b) => String(a.truck).localeCompare(String(b.truck), 'es', { numeric: true }));
  }
  return filas;
}

const ROTO = ['sin_cablear', 'carril_caido', 'dato_rancio', 'fuera_inventario', 'sin_residente'];

async function main(c, dato) {
  const filas = await leer(c, 'LEFT', dato);

  console.log('\n[CGA-A.13] Camionetas: quién empuja, qué empuja, y quién no aparece\n');
  console.log(`  ${pad('camión', 9)}${pad('empujó', 10)}${pad('cobro', 10)}` +
    `${pad('venta hasta', 17)}${pad('cobro hasta', 17)}${pad('valor', 11)}${pad('dónde está', 17)}estado`);
  console.log(`  ${'-'.repeat(112)}`);

  for (const r of filas) {
    const dv = dias(r.dato_venta); const dc = dias(r.dato_cobro);
    const marca = (d, n) => (!r.dato_medido ? '?' : `${corto(d)}${n != null && n > DATO_RANCIO_D ? ` (${n}d)` : ''}`);
    console.log(`  ${pad(r.truck, 9)}${pad(edad(horas(r.venta_ok)), 10)}` +
      `${pad(edad(horas(r.cobro_ok)), 10)}${pad(marca(r.dato_venta, dv), 17)}` +
      `${pad(marca(r.dato_cobro, dc), 17)}${pad(money(r.cobro_valor), 11)}` +
      `${pad(r.ip || '—', 17)}${ROTULO[r.estado]}`);
  }

  if (!dato) {
    console.log('\n  ⚠️ NO MEDIDO: sin `PROD_DB_URL` no se puede ver QUÉ empujó cada unidad, sólo que');
    console.log('     empujó. Las columnas «hasta» salen en «?» — no son un cero ni un visto bueno.');
  }

  const malas = filas.filter((r) => ROTO.includes(r.estado));
  const dormidas = filas.filter((r) => r.estado === 'dormida');
  const viejas = filas.filter((r) => r.estado === 'dato_rancio');
  const fuera = filas.filter((r) => r.estado === 'fuera_inventario');

  console.log('');
  if (dormidas.length) {
    console.log(`  ·  ${dormidas.length} dormida(s): sin venta en ${VENTA_FRESCA_H} h. No se juzga su cobro —`);
    console.log('     no se puede distinguir «no cobró» de «está apagada», y se DECLARA (ADR-056).');
  }

  if (!malas.length) {
    console.log('\n  ✓ Toda unidad con venta fresca manda su cobro, con dato del día.\n');
    return 0;
  }

  const sinCobro = filas.filter((r) => r.estado === 'sin_cablear' || r.estado === 'carril_caido');
  if (sinCobro.length) {
    console.log(`\n⛔ ${sinCobro.length} unidad(es) mandaron VENTA y no mandan COBRO: ${sinCobro.map((r) => r.truck).join(', ')}`);
    console.log('   La venta prueba que la máquina estuvo prendida y con red, así que esto NO es la');
    console.log('   camioneta: le falta el bloque de cobros al `.cmd`. Plantilla única en');
    console.log('   `database/importers/kepler/route-push/` (`[CGA-A.12]`).');
  }

  /**
   * ⭐ El caso que esta compuerta no veía. Se dice aparte porque **se arregla en otro lado**: el
   * `.cmd` funciona —empuja puntual— y lo que está viejo es su Kepler local o la ventana de días.
   */
  if (viejas.length) {
    console.log(`\n⛔ ${viejas.length} unidad(es) EMPUJAN PUNTUAL Y MANDAN DATO VIEJO:`);
    for (const r of viejas) {
      const dv = dias(r.dato_venta); const dc = dias(r.dato_cobro);
      console.log(`     ${pad(r.truck, 9)} empujó hace ${edad(horas(r.venta_ok))}, `
        + `pero su venta llega al ${corto(r.dato_venta)}${dv != null ? ` (${dv} d)` : ''}`
        + ` y su cobro al ${corto(r.dato_cobro)}${dc != null ? ` (${dc} d)` : ''}`);
    }
    console.log('   El `.cmd` corre y conecta: lo viejo es lo que manda. Mirar el Kepler de esa');
    console.log('   unidad y la ventana `--dias` con que se generó su archivo.');
  }

  const sinRes = filas.filter((r) => r.estado === 'sin_residente');
  if (sinRes.length) {
    console.log(`\n⛔ ${sinRes.length} unidad(es) EN LÍNEA SIN RESIDENTE de cobros: ${sinRes.map((r) => r.truck).join(', ')}`);
    console.log(`   Su cobro espera hasta 15 min. Instalar en la laptop (por VNC, un solo pegado):`);
    console.log('   node database/importers/kepler/route-push/armar-push-camioneta.js --truck <ruta> --solo-cobros --ps1');
  }

  if (fuera.length) {
    console.log(`\n⛔ ${fuera.length} unidad(es) NO están en el inventario del runner: ${fuera.map((r) => r.truck).join(', ')}`);
    console.log('   Tienen dato en prod y ninguna fila de latido, así que para esta compuerta no');
    console.log('   existían. Se cablean con el generador, igual que las demás.');
  }
  console.log('');
  return 1;
}

async function selfTest(c, dato) {
  console.log('\n[self-test] El `LEFT JOIN` es lo que hace visible a la que NUNCA se cableó.\n');
  /**
   * ⛔ Las «fuera del inventario» se QUITAN de esta prueba: `leer` las agrega a los dos lados por
   * igual, así que empatarían los conteos y el mensaje diría «no puede distinguir» justo cuando
   * sí distingue. Esta prueba es sobre el `JOIN`, y esas filas no pasan por el `JOIN`.
   */
  const delJoin = (f) => f.filter((r) => !r.fuera_inventario);
  const bueno = delJoin(await leer(c, 'LEFT', dato));
  const roto = delJoin(await leer(c, 'INNER', dato));

  const cuenta = (f) => f.filter((r) => r.estado === 'sin_cablear' || r.estado === 'carril_caido').length;
  const nb = cuenta(bueno);
  const nr = cuenta(roto);

  console.log(`  LEFT JOIN (el vigente)  → ${bueno.length} unidades censadas · ${nb} con problema`);
  console.log(`  INNER JOIN (el defecto) → ${roto.length} unidades censadas · ${nr} con problema`);

  const fallos = [];
  if (roto.length > bueno.length) fallos.push(`el INNER censa MÁS (${roto.length} > ${bueno.length}): imposible`);
  if (nr > nb) fallos.push(`el INNER encuentra MÁS problemas (${nr} > ${nb}): la prueba está al revés`);

  if (bueno.length === roto.length) {
    console.log('\n  · Hoy todas las unidades tienen fila de cobros: la prueba no puede distinguir');
    console.log('    sin una unidad nunca cableada, y se DECLARA — no se da por buena.');
  } else {
    console.log(`\n  ✓ Distingue: el INNER perdería ${bueno.length - roto.length} unidad(es) de vista,`);
    console.log(`    y con ellas ${nb - nr} problema(s) — las que NUNCA mandaron un cobro.`);
  }

  /**
   * ⭐ `[CGA-A.13b]` La prueba negativa de la regla NUEVA, sobre la función pura: un latido fresco
   * con dato viejo tiene que salir `dato_rancio`, y el MISMO latido con dato de hoy tiene que
   * salir `al_dia`. Sin el segundo caso, la regla podría estar gritando siempre y se vería igual
   * de «correcta» — que es exactamente cómo una compuerta se vuelve ruido y la apagan.
   */
  console.log('\n[self-test] Un latido fresco con dato viejo NO es «al día» (el caso de la 504).\n');
  const ahora = new Date().toISOString();
  const viejo = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
  const hoyD = new Date().toISOString().slice(0, 10);
  const casos = [
    ['empuja puntual, dato de hace 21 d', 'dato_rancio',
      { venta_ok: ahora, cobro_ok: ahora, dato_medido: true, dato_venta: viejo, dato_cobro: viejo }],
    ['empuja puntual, dato de hoy', 'al_dia',
      { venta_ok: ahora, cobro_ok: ahora, dato_medido: true, dato_venta: hoyD, dato_cobro: hoyD }],
    ['dato viejo pero SIN medir prod', 'al_dia',
      { venta_ok: ahora, cobro_ok: ahora, dato_medido: false, dato_venta: null, dato_cobro: null }],
    // `[RC.6]` Laptop en línea (venta hace 5 min) y cobro hace 10 min: no hay residente.
    ['en línea, cobro late hace 10 min', 'sin_residente',
      { venta_ok: new Date(Date.now() - 5 * 60e3).toISOString(), cobro_ok: new Date(Date.now() - 10 * 60e3).toISOString(),
        dato_medido: true, dato_venta: hoyD, dato_cobro: hoyD }],
    // Y el mismo caso con la laptop fuera de línea (venta hace 2 h) NO se juzga: no se puede.
    ['fuera de línea, cobro hace 10 min', 'al_dia',
      { venta_ok: new Date(Date.now() - 2 * 3600e3).toISOString(), cobro_ok: new Date(Date.now() - 10 * 60e3).toISOString(),
        dato_medido: true, dato_venta: hoyD, dato_cobro: hoyD }],
    ['sin latido, con dato en prod', 'fuera_inventario',
      { fuera_inventario: true, venta_ok: null, cobro_ok: null, dato_medido: true, dato_venta: viejo, dato_cobro: null }],
  ];
  for (const [nombre, espera, fila] of casos) {
    const real = clasificar(fila);
    const ok = real === espera;
    console.log(`  ${ok ? '✓' : '✗'} ${pad(nombre, 38)} espera ${pad(espera, 18)} dio ${real}`);
    if (!ok) fallos.push(`«${nombre}»: se esperaba ${espera} y dio ${real}`);
  }

  console.log('');
  if (fallos.length) { for (const f of fallos) console.log(`  ✗ ${f}`); console.log(''); return 1; }
  return 0;
}

(async () => {
  const url = process.env.DATABASE_URL_KEPLER_CONSOLIDADO;
  if (!url) { console.error('⛔ falta DATABASE_URL_KEPLER_CONSOLIDADO en el .env'); process.exit(1); }
  // `[CGA-A.13b]` Se lee UNA vez y se pasa: el self-test llama a `leer` dos veces.
  const dato = await datoAterrizado();
  const c = new Client({ connectionString: url, ssl: false, connectionTimeoutMillis: 10000 });
  await c.connect();
  let code = 0;
  try {
    await c.query(`SET default_transaction_read_only = on`);
    code = SELF ? await selfTest(c, dato) : await main(c, dato);
  } finally { await c.end(); }
  process.exit(code);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
