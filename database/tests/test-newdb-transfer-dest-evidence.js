/* eslint-disable no-console */
/**
 * [DM.11e] CANDADO del destino de traspasos — que un envío no se le acredite a quien no es.
 *
 * ── QUÉ PASÓ ────────────────────────────────────────────────────────────────────────────────
 * `analytics.transfer_dest_map` decía `TI000 "CENTRO DE DISTRIBUCIÓN ( CEDIS)" -> 8ESQ`, así que
 * en `/almacen/movimientos` los envíos al CEDIS aparecían como recibidos por 8ESQ.
 *
 * Lo puso el auto-ligado `[DM.11d]`, que ata `dest_code -> almacén` por **verdad de recepción**:
 * parea salida con recepción por `folio`+`serie` dentro de 15 días y se queda con el que más
 * gana. Dos cosas lo rompen a la vez:
 *   1. la recepción del CEDIS **no vive en `analytics.stock_movements`** — todos sus pareos son
 *      espurios;
 *   2. los folios son **secuencia por sucursal**, así que se parean entre sucursales distintas
 *      por pura coincidencia.
 *
 * Medido en prod el 2026-09-30, a nivel DOCUMENTO: **15 envíos, 13 sin recepción, 2 pareados con
 * 8ESQ = 13 % de evidencia** — y eso alcanzó, porque el ganador salía de
 * `DISTINCT ON (dest_code) ... ORDER BY n DESC`, sin mínimo ni dominancia. Costo: **15
 * documentos · 5,476 piezas · $123,454.08** en 120 días.
 *
 * ── LO QUE PASÓ LA SEGUNDA VEZ ──────────────────────────────────────────────────────────────
 * Medido en prod el 2026-09-30, DESPUÉS de que los bloques 1-3 estuvieran verdes:
 * `TI009 "SUCURSAL MORELIA MADERO" -> MD-32 "Almacén Morelia Madero (32)"`, que es el almacén
 * **Wincaja** de esa tienda: `deleted_at` NO nulo (borrado) y **0 recepciones de traspaso en
 * toda su historia**. Morelia Madero migró a Kepler y quien recibe es `07 Morelia Madero`; el
 * mapa se quedó en el almacén viejo. Resultado: los envíos sin recepción se publican con destino
 * a una sucursal que no existe, y la MISMA ruta física sale partida en dos filas de la matriz
 * (`00->07` pareado y `01->MD-32` por mapa), así que sus totales nunca cuadran contra sí mismos.
 *
 * ⚠️ **El bloque 1 le da verde y hace bien su trabajo.** Pregunta "¿la etiqueta y el almacén
 * hablan del mismo lugar?" y la respuesta honesta es que sí: "MORELIA MADERO" contra "Almacén
 * Morelia Madero (32)" concuerdan. Con DOS almacenes de la misma tienda en dos ERP distintos, el
 * NOMBRE no puede distinguirlos — no hay umbral ni prefijo que lo arregle. Lo que faltaba era
 * **otra pregunta**: ¿ese almacén todavía existe, y alguna vez recibió algo?
 *
 * ── LO QUE SE VERIFICA ──────────────────────────────────────────────────────────────────────
 *  1. NINGÚN destino contradice su propia etiqueta. Es el invariante general: si el ERP dice que
 *     el destino se llama CEDIS, el almacén ligado tiene que ser el CEDIS. Atrapa esta familia
 *     entera, no sólo el caso que ya conocemos.
 *  2. PRUEBA NEGATIVA con CONTROL POSITIVO: el detector marca el par histórico
 *     `TI000 -> 8ESQ` y **no** marca `TI002 -> 8ESQ`, que es legítimo. Sin el control, un
 *     detector que marcara todo se vería igual de verde.
 *  3. La evidencia real de `TI000` está por debajo del 60 % que el importer ahora exige — o sea
 *     que el umbral está calibrado contra el caso que de verdad falló, no contra un número
 *     elegido de memoria.
 *  4. El destino EXISTE: ningún `dest_code` apunta a un almacén con `deleted_at`.
 *  5. El destino RECIBE: ningún `dest_code` con envíos apunta a un almacén que jamás registró
 *     una recepción de traspaso. Un almacén que nunca recibió no puede ser el destino de nada.
 *  6. PRUEBA NEGATIVA de 4+5, con control positivo: marcan `MD-32` y NO marcan los almacenes
 *     vivos que sí reciben.
 *  7. IDENTIDAD DEL PAREO — el veredicto que la pantalla no emite. `ok` hoy sale de comparar las
 *     cantidades del par YA elegido; la identidad del destino nunca entra. Medido: la tasa de
 *     `ok` es la misma en los pares correctos (98.9 %) y en los contradictorios (98.1 %), o sea
 *     que `ok` no distingue un traspaso bueno de uno inventado. Acá se contrasta cada par contra
 *     su etiqueta y se publica cuántos contradicen, con su monto.
 *
 *   DATABASE_URL_NEW=<prod o destino> node database/tests/test-newdb-transfer-dest-evidence.js
 *   DEEP=1 … → además mide la evidencia de TODOS los TI% (tarda ~30 s)
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0, fail = 0, nomedido = 0;
const pass = (m) => { ok++; console.log('  ✔', m); };
const bad = (m) => { fail++; console.log('  x FALLA:', m); };
const skip = (m) => { nomedido++; console.log('  ~ NO MEDIDO:', m); };

/** El umbral que aplica `import-stock-movements.js` en su auto-ligado. */
const UMBRAL = 0.60;

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
// Palabras que describen el TIPO de destino, no CUÁL es: no distinguen nada.
const RELLENO = new Set(['SUCURSAL', 'TRASPASO', 'ALMACEN', 'CENTRO', 'DISTRIBUCION', 'DE', 'DEL',
  'LA', 'EL', 'LOS', 'LAS', 'Y']);

/**
 * ¿La etiqueta del ERP y el almacén ligado hablan del mismo lugar?
 *
 * ⚠️ Compara por PREFIJO DE 3, no de 5. Con 5 el detector daba FALSO POSITIVO en el caso más
 * común del catálogo: "SUCURSAL 8 ESQUINAS" produce el token "ESQUINAS", cuyo prefijo de 5 es
 * "ESQUI" y el almacén se llama "8ESQ" — o sea que marcaba como contradicción el vínculo
 * legítimo. Lo atrapó el bloque 2 de este mismo archivo, que es para lo que existe: un detector
 * que marca todo se ve igual de verde que uno que discrimina.
 */
/**
 * [DM.15] Qué veredicto merece un destino del mapa. Regla PURA (no toca la DB) para poder
 * probarla contra casos fabricados: si dependiera de que haya basura viva en prod, el día que el
 * mapa quede limpio el detector dejaría de poder demostrar que tiene dientes — y un detector romo
 * se ve exactamente igual de verde que uno que discrimina. Es la misma lección del bloque 2.
 *
 * Tres veredictos, porque son TRES situaciones y dos de ellas no son la misma ausencia:
 *   retirado        → el almacén tiene deleted_at. El vínculo es falso: FALLA.
 *   no_verificable  → opera, pero no registra ni una recepción, así que nada puede confirmarlo.
 *                     Es el CEDIS. Se DECLARA con su monto; no se falla ni se da por bueno.
 *   sano            → vivo y con historia de recepción.
 */
const juzgarDestino = (r) => {
  if (r.borrado) return 'retirado';
  if (Number(r.envios_180d) > 0 && Number(r.recepciones) === 0) return 'no_verificable';
  return 'sano';
};

const concuerdan = (label, whCode, whName) => {
  const destino = norm(`${whCode} ${whName}`).replace(/[^A-Z0-9 ]/g, ' ');
  const tokens = norm(label).replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/)
    .filter((t) => t.length >= 3 && !RELLENO.has(t));
  if (!tokens.length) return null; // sin nada distintivo que comparar → no se juzga
  return tokens.some((t) => destino.includes(t.slice(0, 3)));
};

(async () => {
  const db = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    const t = (await db.query(`SELECT id FROM public.tenants WHERE slug = 'mega_dulces' LIMIT 1`)).rows[0];
    if (!t) { console.log('sin tenant mega_dulces: nada que medir'); process.exitCode = 0; return; }
    const T = t.id;
    await db.query('SELECT set_config($1,$2,false)', ['app.tenant_id', T]);

    // ── 1. Ningún destino contradice su etiqueta ────────────────────────────────────────────
    console.log('\n[1] El almacén ligado no puede contradecir la etiqueta del ERP');
    const mapa = (await db.query(
      `SELECT dm.dest_code, dm.dest_label, w.code, w.name
         FROM analytics.transfer_dest_map dm
         JOIN commercial.warehouses w ON w.id = dm.warehouse_id
        WHERE dm.tenant_id = $1 AND w.code NOT ILIKE 'RUTA%'
        ORDER BY dm.dest_code`, [T])).rows;
    if (!mapa.length) { skip('no hay ningún dest_code ligado a un almacén.'); }
    else {
      // ⚠️ La aserción DURA es sobre los `TI%`: ahí la etiqueta del ERP nombra una sucursal y la
      // contradicción es inequívoca. El resto del mapa son códigos de CLIENTE ligados a un
      // almacén; que "NO TOCAR ANTONIO VILLA" apunte a La Piedad puede ser el lugar donde ese
      // cliente recibe, no un error — se REPORTA para revisión humana, no se falla.
      const evalua = (r) => ({ r, v: concuerdan(r.dest_label, r.code, r.name) });
      const tis = mapa.filter((r) => /^TI/i.test(r.dest_code)).map(evalua);
      const otros = mapa.filter((r) => !/^TI/i.test(r.dest_code)).map(evalua);
      const malosTi = tis.filter((x) => x.v === false);
      const juzgados = tis.filter((x) => x.v !== null).length;
      if (!juzgados) skip('ningún TI% tiene etiqueta distintiva que comparar.');
      else if (malosTi.length) {
        malosTi.slice(0, 8).forEach(({ r }) => console.log(`     · ${r.dest_code} "${r.dest_label}" → ${r.code} ${r.name}`));
        bad(`${malosTi.length} de ${juzgados} traspasos entre sucursales apuntan a un almacén que su propia etiqueta desmiente.`);
      } else {
        pass(`los ${juzgados} traspasos entre sucursales concuerdan con su almacén.`);
      }
      const sospechosos = otros.filter((x) => x.v === false);
      if (sospechosos.length) {
        console.log(`     (para revisión humana, NO falla: ${sospechosos.length} código(s) de cliente ligados a un almacén que su etiqueta no menciona)`);
        sospechosos.slice(0, 5).forEach(({ r }) => console.log(`        ${r.dest_code} "${r.dest_label}" → ${r.code} ${r.name}`));
      }
    }

    // ── 2. Prueba negativa con control positivo ─────────────────────────────────────────────
    console.log('\n[2] Prueba negativa: el detector distingue, no marca todo');
    const malo = concuerdan('CENTRO DE DISTRIBUCIÓN ( CEDIS)', '03', '8ESQ');       // el bug histórico
    const bueno = concuerdan('TRASPASO 8 ESQUINAS', '03', '8ESQ');                  // legítimo
    if (malo === false && bueno === true) {
      pass('marca el par histórico TI000→8ESQ y NO marca TI002→8ESQ (tiene dientes y discrimina).');
    } else if (malo !== false) {
      bad('el detector NO marca el par que causó el incidente: es utilería.');
    } else {
      bad('el detector marca TI002→8ESQ, que es correcto: daría falsos positivos sobre todo el mapa.');
    }

    // ── 3. El umbral está calibrado contra el caso real ─────────────────────────────────────
    console.log('\n[3] La evidencia de TI000 queda por debajo del umbral del importer');
    const ev = async (destCode) => (await db.query(
      `WITH ship AS (
         SELECT DISTINCT folio, doc_serie, warehouse_id, doc_date
           FROM analytics.stock_movements
          WHERE tenant_id=$1 AND doc_code='TrsfShip' AND dest_code=$2
            AND doc_date >= CURRENT_DATE - 365),
       par AS (
         SELECT r.warehouse_id rcv_wh FROM ship s
          LEFT JOIN LATERAL (
            SELECT rr.warehouse_id FROM analytics.stock_movements rr
             WHERE rr.tenant_id=$1 AND rr.doc_code='TrsfRcv' AND rr.parent_group='41'
               AND rr.parent_folio=s.folio AND coalesce(rr.parent_serie,'')=coalesce(s.doc_serie,'')
               AND rr.warehouse_id <> s.warehouse_id
               AND rr.doc_date >= s.doc_date AND rr.doc_date <= s.doc_date + 15
             GROUP BY rr.warehouse_id) r ON true)
       SELECT count(*)::int envios,
              coalesce(max(n),0)::int mejor
         FROM par LEFT JOIN LATERAL (
           SELECT count(*)::int n FROM par p2 WHERE p2.rcv_wh = par.rcv_wh AND par.rcv_wh IS NOT NULL
         ) q ON true`, [T, destCode])).rows[0];

    const e0 = await ev('TI000');
    if (!Number(e0.envios)) { skip('no hay envíos a TI000 en el último año.'); }
    else {
      const pct = Number(e0.mejor) / Number(e0.envios);
      console.log(`     TI000: ${e0.envios} envíos · mejor candidato ${e0.mejor} pareos · ${(pct * 100).toFixed(0)} % de evidencia`);
      if (pct < UMBRAL) {
        pass(`${(pct * 100).toFixed(0)} % está por debajo del ${(UMBRAL * 100).toFixed(0)} % que exige el auto-ligado: hoy no lo ligaría.`);
      } else {
        bad(`${(pct * 100).toFixed(0)} % supera el umbral: el auto-ligado volvería a atar el CEDIS a otro almacén.`);
      }
    }

    // ── 4+5. El destino EXISTE y RECIBE ─────────────────────────────────────────────────────
    // La pregunta que el bloque 1 no puede hacer. El nombre no distingue dos almacenes de la
    // MISMA tienda en dos ERP (Kepler '07 Morelia Madero' vs Wincaja 'MD-32 Almacén Morelia
    // Madero (32)'): los dos hablan del mismo lugar y sólo uno opera. Se pregunta por el HECHO,
    // no por el texto: ¿está vivo? ¿alguna vez recibió un traspaso?
    console.log('\n[4] El almacén destino existe (no está borrado)');
    const vivos = (await db.query(
      `SELECT dm.dest_code, dm.dest_label, w.code, w.name,
              (w.deleted_at IS NOT NULL) AS borrado,
              (SELECT count(*)::int FROM analytics.stock_movements rr
                WHERE rr.tenant_id = dm.tenant_id AND rr.warehouse_id = w.id
                  AND rr.doc_code = 'TrsfRcv') AS recepciones,
              (SELECT count(DISTINCT m.folio || '|' || coalesce(m.doc_serie,''))::int
                 FROM analytics.stock_movements m
                WHERE m.tenant_id = dm.tenant_id AND m.doc_code = 'TrsfShip'
                  AND m.dest_code = dm.dest_code AND m.doc_date >= CURRENT_DATE - 180) AS envios_180d,
              (SELECT coalesce(sum(m.amount),0) FROM analytics.stock_movements m
                WHERE m.tenant_id = dm.tenant_id AND m.doc_code = 'TrsfShip'
                  AND m.dest_code = dm.dest_code AND m.doc_date >= CURRENT_DATE - 180) AS monto_180d
         FROM analytics.transfer_dest_map dm
         JOIN commercial.warehouses w ON w.id = dm.warehouse_id
        WHERE dm.tenant_id = $1
        ORDER BY dm.dest_code`, [T])).rows;

    if (!vivos.length) skip('no hay ningún dest_code ligado a un almacén.');
    else {
      const borrados = vivos.filter((r) => juzgarDestino(r) === 'retirado');
      if (borrados.length) {
        borrados.forEach((r) => console.log(
          `     · ${r.dest_code} "${r.dest_label}" → ${r.code} ${r.name} [BORRADO]` +
          ` · ${r.envios_180d} envíos / $${Number(r.monto_180d).toLocaleString('es-MX', { maximumFractionDigits: 2 })} en 180 d`));
        bad(`${borrados.length} de ${vivos.length} destinos apuntan a un almacén BORRADO: la pantalla publica envíos a una sucursal que no existe.`);
      } else {
        pass(`los ${vivos.length} destinos ligados apuntan a almacenes vivos.`);
      }

      console.log('\n[5] El almacén destino recibe traspasos (tiene historia de recepción)');
      // ⚠️ DOS AUSENCIAS DISTINTAS, y confundirlas es el error que esta fase persigue:
      //   · almacén RETIRADO (deleted_at) con 0 recepciones → el vínculo es falso. Lo marca [4];
      //     acá se excluye para no cobrar dos veces el mismo defecto.
      //   · almacén VIVO que opera pero no registra ni una recepción → el destino puede ser
      //     perfectamente correcto y la recepción simplemente NO VIVE en esta tabla. Es el caso
      //     del CEDIS, que este mismo archivo documenta arriba. Eso no es un error del mapa: es
      //     un hueco de la fuente, y se DECLARA con su monto en vez de fallar o de taparlo.
      // Sólo se juzga a quien TIENE envíos: un destino sin tráfico no prueba nada en ninguna
      // dirección. Es la diferencia entre "no recibe" y "no se midió".
      const conTrafico = vivos.filter((r) => Number(r.envios_180d) > 0);
      const mudosVivos = conTrafico.filter((r) => juzgarDestino(r) === 'no_verificable');
      const mudosMuertos = conTrafico.filter((r) => juzgarDestino(r) === 'retirado' && Number(r.recepciones) === 0);
      if (!conTrafico.length) skip('ningún dest_code ligado tuvo envíos en 180 días.');
      else {
        // El FALLA primero y el DECLARADO después: al revés se lee como si el declarado fuera
        // el que falla, que es justo la confusión que este bloque existe para deshacer.
        mudosMuertos.forEach((r) => console.log(
          `     · ${r.dest_code} "${r.dest_label}" → ${r.code} ${r.name}: RETIRADO y sin una sola recepción.`));
        if (mudosVivos.length) {
          mudosVivos.forEach((r) => console.log(
            `     · ${r.dest_code} "${r.dest_label}" → ${r.code} ${r.name}: almacén VIVO, 0 recepciones en el feed.` +
            ` ${r.envios_180d} envíos / $${Number(r.monto_180d).toLocaleString('es-MX', { maximumFractionDigits: 2 })} atribuidos sin poder verificarse.`));
        }
        if (mudosMuertos.length) {
          bad(`${mudosMuertos.length} destino(s) apuntan a un almacén RETIRADO que además nunca recibió: el vínculo es falso (ver [4]).`);
        } else if (mudosVivos.length) {
          skip(`${mudosVivos.length} de ${conTrafico.length} destinos no son verificables por esta vía: el almacén opera pero su recepción no está en el feed. Declarado, no aprobado.`);
        } else {
          pass(`los ${conTrafico.length} destinos con tráfico apuntan a almacenes que sí reciben.`);
        }
      }

      // ── 6. Prueba negativa de 4+5 ─────────────────────────────────────────────────────────
      // Un detector que marca todo se ve igual de verde que uno que discrimina. El control
      // positivo son los almacenes vivos CON recepciones: no pueden caer en ninguna de las dos.
      console.log('\n[6] Prueba negativa: el detector discrimina (casos fabricados)');
      // Se prueba contra filas INVENTADAS a propósito, no contra lo que hoy haya en prod: el
      // mapa se limpió el 2026-09-30 y si la prueba dependiera de encontrar basura viva, a
      // partir de ese día dejaría de medir nada y nadie se enteraría.
      const casos = [
        // [ fila, veredicto esperado, por qué ]
        [{ borrado: true, envios_180d: 56, recepciones: 0 }, 'retirado', 'TI009→MD-32, el caso que lo originó'],
        [{ borrado: true, envios_180d: 0, recepciones: 99 }, 'retirado', 'retirado pesa aunque haya recibido en su día'],
        [{ borrado: false, envios_180d: 15, recepciones: 0 }, 'no_verificable', 'TI000→CEDIS: vivo, sin recepción en el feed'],
        [{ borrado: false, envios_180d: 4955, recepciones: 3000 }, 'sano', 'TI001→01 Padre Hidalgo, legítimo'],
        [{ borrado: false, envios_180d: 0, recepciones: 0 }, 'sano', 'sin tráfico no se juzga: no medir no es reprobar'],
      ];
      const fallos = casos.filter(([fila, esperado]) => juzgarDestino(fila) !== esperado);
      if (fallos.length) {
        fallos.forEach(([fila, esperado, porque]) => console.log(
          `     · esperaba "${esperado}" y dio "${juzgarDestino(fila)}" — ${porque}`));
        bad(`el detector falla ${fallos.length} de ${casos.length} casos de control: no se puede confiar en sus veredictos.`);
      } else {
        pass(`distingue los ${casos.length} casos de control (retirado / no verificable / sano), incluido el que originó el incidente.`);
      }
      // Y además, el estado real de hoy — que es un HECHO reportado, no la prueba del detector.
      const sanos = vivos.filter((r) => juzgarDestino(r) === 'sano');
      console.log(`     estado real: ${sanos.length} sano(s) · ${borrados.length} retirado(s) · ${mudosVivos.length} no verificable(s)`);
    }

    // ── 7. Identidad del pareo: el veredicto que la pantalla no emite ────────────────────────
    // `transfersPhysical` parea salida con recepción por folio+serie y publica `ok` si las
    // CANTIDADES cuadran. La identidad del destino nunca entra al veredicto, y el propio envío
    // la trae escrita: `dest_label` viene del ERP y no participa ni del pareo ni del mapa, o sea
    // que es árbitro válido. Se juzga con el MISMO `concuerdan()` del bloque 1 — una segunda
    // copia de la regla se desincroniza y deja de medir lo mismo.
    console.log('\n[7] Identidad del pareo: ¿el que recibió es el que el envío nombra?');
    const pares = (await db.query(
      `WITH shp AS (
         SELECT warehouse_id, folio, doc_serie, MIN(doc_date) doc_date,
                SUM(qty) qty, SUM(amount) amount, max(dest_label) dest_label
           FROM analytics.stock_movements
          WHERE tenant_id = $1 AND doc_code = 'TrsfShip' AND doc_date >= CURRENT_DATE - 180
          GROUP BY 1,2,3),
       rcv AS (
         SELECT warehouse_id, parent_serie, parent_folio, MIN(doc_date) doc_date, SUM(qty) qty
           FROM analytics.stock_movements
          WHERE tenant_id = $1 AND doc_code = 'TrsfRcv' AND parent_group = '41'
            AND doc_date >= CURRENT_DATE - 180
          GROUP BY 1,2,3)
       SELECT w.code, w.name, s.dest_label, s.amount,
              (abs(coalesce(s.qty,0) - coalesce(r.qty,0)) < 0.01) AS publicado_ok
         FROM rcv r
         JOIN LATERAL (
           SELECT * FROM shp s
            WHERE s.folio = r.parent_folio AND coalesce(s.doc_serie,'') = coalesce(r.parent_serie,'')
              AND s.warehouse_id <> r.warehouse_id
              AND s.doc_date <= r.doc_date AND s.doc_date >= r.doc_date - 15
            ORDER BY abs(coalesce(s.qty,0) - coalesce(r.qty,0)) ASC, abs(s.doc_date - r.doc_date) ASC
            LIMIT 1) s ON true
         JOIN commercial.warehouses w ON w.id = r.warehouse_id`, [T])).rows;

    if (!pares.length) skip('no hay pares de traspaso en 180 días.');
    else {
      const juzgado = pares.map((p) => ({ p, v: concuerdan(p.dest_label, p.code, p.name) }));
      const contradicen = juzgado.filter((x) => x.v === false);
      const confirmados = juzgado.filter((x) => x.v === true);
      const sinJuicio = juzgado.filter((x) => x.v === null);
      const money = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 });
      const suma = (a) => a.reduce((s, x) => s + Number(x.p.amount || 0), 0);
      console.log(`     ${confirmados.length} confirmados (${money(suma(confirmados))}) ·` +
        ` ${contradicen.length} contradicen (${money(suma(contradicen))}) ·` +
        ` ${sinJuicio.length} sin etiqueta distintiva`);
      // Lo que se exige NO es cero contradicciones —el pareo por folio entre secuencias por
      // sucursal siempre va a tener coincidencias— sino que la contradicción esté DECLARADA y
      // no disfrazada de `ok`. Acá se mide cuántas se publican hoy como si estuvieran bien.
      const mentira = contradicen.filter((x) => x.p.publicado_ok);
      if (!contradicen.length) {
        pass(`los ${confirmados.length} pares arbitrables coinciden con la etiqueta del ERP.`);
      } else if (mentira.length) {
        contradicen.slice(0, 5).forEach(({ p }) => console.log(
          `     · "${p.dest_label}" → recibió ${p.code} ${p.name} · ${money(p.amount)}${p.publicado_ok ? ' · publicado OK' : ''}`));
        bad(`${mentira.length} par(es) acreditan la recepción a una sucursal que su etiqueta desmiente Y se publican como OK (${money(suma(mentira))}).`);
      } else {
        pass(`${contradicen.length} par(es) contradicen su etiqueta, pero ninguno se publica como OK.`);
      }
      if (sinJuicio.length) {
        console.log(`     (${sinJuicio.length} pares sin etiqueta distintiva: no se juzgan, se declaran)`);
      }
    }

    if (process.env.DEEP === '1') {
      console.log('\n[3b] Evidencia de todos los TI% (DEEP)');
      const codes = (await db.query(
        `SELECT DISTINCT dest_code FROM analytics.transfer_dest_map
          WHERE tenant_id=$1 AND dest_code ILIKE 'TI%' ORDER BY 1`, [T])).rows;
      for (const { dest_code } of codes) {
        const e = await ev(dest_code);
        const pct = Number(e.envios) ? Number(e.mejor) / Number(e.envios) : 0;
        console.log(`     ${dest_code}: ${e.envios} envíos · ${(pct * 100).toFixed(0)} %`);
      }
      pass('evidencia de todos los TI% reportada.');
    } else {
      skip('la evidencia de TODOS los TI% tarda ~30 s (un LATERAL por envío): corre con DEEP=1.');
    }

    console.log(`\n=== ${ok} OK · ${fail} FALLAS · ${nomedido} NO MEDIDOS ===`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
