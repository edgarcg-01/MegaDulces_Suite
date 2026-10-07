/**
 * CG.22.3 — Refresca `analytics.mv_caja_movimientos`, el corte de caja materializado.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-09-22: la bandeja de `/finanzas/caja-general` tardaba **415–720 ms
 * por consulta** tocando **~565,000 páginas de buffer**, porque `analytics.kepler_bank_movements`
 * tiene que leer las **651,450 filas / 567 MB** de `kepler_ods.kdm1` para clasificar cada
 * movimiento. Con la lista materializada, la misma consulta cuesta **0.4 ms y 99 páginas** —
 * 1,085× menos.
 *
 * ⚠️ [CG.22.4] ACÁ DECÍA "el corte entero son 12,237 filas y armarlo cuesta ~0.5–2 s". Medido el
 * 2026-09-24 sobre 951 corridas: son **12,294 filas** y el refresh mide **4,582 ms de media**
 * (min 2,446 · max 16,521 · desvío 1,863), con latidos en vivo de 3,846 y 6,602 ms. Armar la
 * vista tampoco son los 507 ms que dice la migración: medido tres veces da **2,289–3,279 ms**.
 * Un comentario que deja de ser cierto no avisa; por eso los números van con su fecha.
 *
 * Dos hipótesis más baratas se probaron y se REFUTARON antes de llegar a esto: un índice (existe
 * `idx_kdm1_tesoreria_c45` y con `enable_seqscan=off` el plan no cambia) y desmaterializar el CTE
 * `flj` (`NOT MATERIALIZED` salió PEOR: 501 ms y el doble de páginas). El detalle está en la
 * migración `20260923130000_mv_caja_movimientos.js`.
 *
 * ── Lo que este carril DECLARA ──────────────────────────────────────────────────────────────
 * El latido reporta **filas entregadas**, no "el proceso corrió" (ADR-053). Un matview que dejó
 * de refrescarse sirve datos viejos **sin un solo error**, y en una bandeja de caja eso se lee
 * como "no hay trabajo" — que es la peor lectura posible. Por eso:
 *   · si el matview no existe todavía, sale en `ok` con nota y NO se pone rojo (la migración
 *     puede no estar aplicada aún en ese entorno);
 *   · si queda en CERO filas, se reporta `error` — cero no es un refresh exitoso;
 *   · cada fila lleva `refrescado_en`, así que el consumidor puede declarar la edad del dato.
 *
 *   node database/importers/kepler/refresh-caja-matview.js --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const { Client } = require('pg');

// ⚠️ `.trim()` en cada argumento a propósito: el `crontab.feeds` se exportó una vez con CRLF y
// `argv.includes('--apply')` —comparación exacta— no matcheaba `--apply\r`, así que NUEVE carriles
// corrieron en seco diciendo "ok" durante horas. Que no vuelva a depender de un retorno de carro.
const APPLY = process.argv.slice(2).some((a) => a.trim() === '--apply');
// `[CPU.3]` Escape para operación: refresca sí o sí, sin preguntarle a la sonda.
const FORZAR = process.argv.slice(2).some((a) => a.trim() === '--forzar');
const KEY = 'mv_caja_refresh';
const MV = 'analytics.mv_caja_movimientos';
const FUENTE = 'analytics.kepler_bank_movements';

// ── `[CPU.3]` LA SONDA: preguntar antes de refrescar ────────────────────────────────────────
//
// Medido en prod el 2026-09-28 sobre 5,349 corridas: este carril gastaba **27,551 s en 3.7 días
// = 7,487 s/día = 0.087 núcleos** refrescando cada minuto — para capturar **~40 movimientos al
// día** (medidos: 14·82·58·74·16·57·1·20 en días consecutivos). Son ~36 refrescos por cada
// movimiento nuevo, y el resto son no-ops caros.
//
// ⛔ La salida FÁCIL era bajar la cadencia a 5 min, y se descartó con motivo: esto NO es un
// reporte, es la BANDEJA DE TRABAJO de Caja General, con un puente `NOTIFY`→WebSocket (CG.23.2)
// construido justamente para que se sienta viva. Bajar la cadencia desharía esa inversión y
// además obligaría a mover el umbral de `db-health` (`mv_caja_refresh`, warn al saltarse ~6
// corridas) en el mismo cambio, o el gate dejaría de medir lo que dice.
//
// Lo que se hace en cambio: comparar la FIRMA del corte entre la fuente y la copia, y refrescar
// sólo si difieren. La cadencia de un minuto NO se toca, así que la latencia tampoco.
//
// Costos medidos (prod, 2026-09-28):
//   firma ventana 2 d sobre la COPIA ......    4.7 ms
//   firma ventana 2 d sobre la FUENTE ......  638 ms
//   firma COMPLETA sobre la COPIA ..........    4.6 ms
//   firma COMPLETA sobre la FUENTE ........ 2,720 ms
//   REFRESH CONCURRENTLY .................. 5,151 ms   ← lo que hoy se paga 1,440 veces al día
//
// ── DESPUÉS, medido en una ventana REAL de 35 min en prod (2026-09-28 08:44→09:19) ─────────
//   3 refrescos reales ....... 18.5 s  (6,174 ms de media)
//  32 saltos por sonda ....... 27.3 s  (  853 ms de media — el proceso entero, no sólo la sonda)
//  ───────────────────────────────────
//  35 ciclos ................. 45.8 s  ⇒ 1.31 s por ciclo × 1,440 = **~1,885 s/día**
// contra los **7,487 s/día** de antes = **75 % menos · 0.065 núcleos recuperados**.
// (Quedó por debajo del 82 % proyectado porque la sonda promedia 853 ms y no 638: la diferencia
// es arrancar node, conectar y latir. El número honesto es el del ciclo completo, no el de la
// consulta sola.)
//
// ⭐ Y esa ventana trajo la prueba que no se podía fabricar, con dato de producción:
//   · `motivo: piso de 30 min (último hace 30.7)` ....... el piso disparó solo, como se diseñó;
//   · `motivo: la sonda vio cambios` ×2 ................. la sonda DETECTÓ movimientos reales y
//     refrescó dentro del mismo minuto (12,429 → 12,430 → 12,431 → 12,432 filas).
// O sea que no es una sonda que dice «sin cambios» para siempre: se probó contra cambios de
// verdad, que es lo único que descarta el falso verde que el piso viene a acotar.
//
// ⚠️ LA FIRMA LLEVA LA SUMA DE IMPORTES, no sólo el conteo. Con `count(*)` solo, un movimiento
// corregido en su monto —misma fila, otro importe— sería invisible para la sonda y la bandeja
// mostraría el importe viejo para siempre. Es el mismo razonamiento que ya está escrito para el
// `NOTIFY` de abajo; acá pesa más, porque de esto depende que el refresco ocurra.
const VENTANA_DIAS = 2;

// ── EL PISO: cada cuánto se refresca SÍ O SÍ, haya dicho lo que haya dicho la sonda ─────────
//
// ⛔⛔ ESTO ES LO QUE HACE SEGURO AL RESTO DEL ARCHIVO, y no es una red "por si acaso".
//
// Agregar una sonda mete un modo de falla NUEVO y peor que el que resuelve: si la sonda se
// equivoca y dice "no hay cambios" cuando sí los hay, la bandeja se congela **y nadie se entera**
// — el latido sigue en verde (el ciclo corrió bien), y `datos_al` sigue diciendo "hace un minuto"
// porque la pantalla lee la edad del LATIDO, no del matview (CG.22.4). Es el verde falso perfecto:
// exactamente lo que este carril fue construido para evitar.
//
// El piso acota ese daño a 30 minutos **sin depender de que la sonda sea correcta**: si la última
// corrida que REFRESCÓ DE VERDAD es más vieja que esto, se refresca y punto. Una sonda rota deja
// de ser un congelamiento indefinido y pasa a ser un rezago de 30 min con el costo de antes.
//
// ⭐ Y reemplaza —no acompaña— a la idea de "cada 30 min sondeá el universo completo": un refresh
// de verdad reconcilia TODO, incluso lo que la ventana no ve (una corrección tardía, una fila con
// `fecha_captura` nula). Sondear completo habría costado casi lo mismo y sólo habría servido si la
// sonda funciona, que es justo lo que no se puede asumir.
//
// Costo: 48 refrescos/día × 5.15 s = 247 s. Contra los 7,487 s/día de hoy, es ruido.
const PISO_MIN = 30;

function conexion() {
  const cs = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) throw new Error('sin DATABASE_URL_NEW/DATABASE_URL');
  return new Client({
    connectionString: cs,
    ssl: cs.includes('localhost') || cs.includes('pg-prod') ? false : { rejectUnauthorized: false },
    statement_timeout: 120000,
  });
}

/**
 * CG.23.2 — Avisa por `NOTIFY` que el corte de caja cambió, para que la pantalla no tenga que
 * preguntar cada tanto si pasó algo.
 *
 * ── Qué viaja, y qué NO ─────────────────────────────────────────────────────────────────────
 * Viaja la **firma** del corte, no los movimientos. `NOTIFY` no se persiste: lo que se emite
 * mientras nadie escucha se pierde, así que un aviso que llevara el dato convertiría un socket
 * caído tres segundos en un movimiento que no aparece nunca. Con la firma, el peor caso de un
 * aviso perdido es que la pantalla se entere en su repaso lento — no que pierda el dato.
 *
 * La firma incluye la SUMA de importes además del conteo: sólo con `count(*)` un movimiento
 * corregido (mismo folio, otro monto) no movería nada y la pantalla se quedaría con la cifra
 * vieja creyendo que está al día.
 *
 * Se avisa SIEMPRE tras un refresh exitoso, sin comparar contra la corrida anterior: este script
 * es un proceso nuevo en cada pasada del cron y no tiene memoria. Quien compara es la pantalla,
 * que sí tiene delante lo que está mostrando. El costo de avisar de más es un mensaje diminuto;
 * el de avisar de menos es una caja que miente.
 *
 * ⚠️ Un `NOTIFY` viaja al COMMIT. Estas consultas van fuera de una transacción explícita
 * (autocommit), así que sale al terminar cada `SELECT pg_notify(...)`.
 */
/* [CG.22.4] `al` llega por PARÁMETRO y ya no se lee del matview. La columna `refrescado_en` se
 * retira porque hacía que `REFRESH ... CONCURRENTLY` reescribiera la tabla ENTERA cada minuto —
 * ver la nota larga en `ciclo()`. La forma del payload NO cambia: `caja-realtime.service.ts:80`
 * sigue leyendo `datos_al`. */
async function avisar(c, al) {
  const q = await c.query(`
    SELECT tenant_id::text            AS tenant_id,
           count(*)::int              AS filas,
           max(folio)                 AS max_folio,
           max(fecha_captura)::text   AS max_captura,
           round(sum(importe), 2)::text AS suma
      FROM ${MV}
     GROUP BY tenant_id`);

  let n = 0;
  for (const t of q.rows) {
    const payload = JSON.stringify({
      tenant_id: t.tenant_id,
      filas: t.filas,
      max_folio: t.max_folio,
      max_captura: t.max_captura,
      firma: `${t.filas}|${t.max_folio || ''}|${t.max_captura || ''}|${t.suma || ''}`,
      datos_al: al,
    });
    // El tope de un payload de NOTIFY son 8000 bytes; esto son ~200. Si algún día creciera,
    // reventaría acá con un error claro en vez de truncarse en silencio.
    await c.query(`SELECT pg_notify('caja_movimientos', $1)`, [payload]);
    n++;
  }
  return n;
}

/**
 * `[CPU.3]` Firma del corte: conteo + último folio + suma de importes.
 *
 * Los tres juntos detectan las tres formas de cambiar: una fila NUEVA mueve el conteo y el folio,
 * una fila BORRADA mueve el conteo, y una fila CORREGIDA en su monto mueve sólo la suma. Quitar
 * cualquiera de los tres deja un agujero por el que la bandeja se queda vieja sin avisar.
 *
 * `where` viene armado con constantes de este archivo — nunca con entrada de usuario.
 */
async function firma(c, rel, where) {
  const q = await c.query(
    `SELECT count(*)::int AS n, max(folio) AS f, round(coalesce(sum(importe), 0), 2)::text AS s
       FROM ${rel} WHERE ${where}`);
  const r = q.rows[0];
  return { sig: `${r.n}|${r.f || ''}|${r.s || ''}`, n: r.n };
}

async function ciclo() {
  const c = conexion();
  await c.connect();
  try {
    const existe = await c.query(`SELECT to_regclass($1) AS t`, [MV]);
    if (!existe.rows[0] || !existe.rows[0].t) {
      return { filas: null, nota: `${MV} todavía no existe (migración sin aplicar en este entorno)` };
    }

    // ── `[CPU.3]` EL PISO, primero ──────────────────────────────────────────────────────────
    // Se pregunta ANTES que la sonda y a propósito: si toca refrescar por piso, sondear sería
    // pagar 643 ms para llegar igual al refresh. Y se mide contra la última corrida que refrescó
    // DE VERDAD (`note IS NULL`) — no contra la última corrida, que con la sonda puesta es casi
    // siempre un salto. Confundirlas dejaría el piso permanentemente satisfecho: el bug que
    // convierte esta protección en un adorno.
    const piso = await c.query(
      `SELECT extract(epoch FROM now() - max(finished_at))/60 AS min
         FROM analytics.cron_run_log
        WHERE tenant_id = $1 AND job_key = $2 AND note IS NULL AND status = 'ok'`,
      [process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c', KEY]);
    // `null` = nunca refrescó (o no hay historial) ⇒ se refresca. Un piso que no se puede medir
    // se resuelve refrescando, nunca saltando: lo barato es el refresh, lo caro es la bandeja vieja.
    const minDesdeRefresh = piso.rows[0] && piso.rows[0].min != null ? Number(piso.rows[0].min) : null;
    const tocaPorPiso = FORZAR || minDesdeRefresh === null || minDesdeRefresh >= PISO_MIN;

    // ── ¿Y si no toca por piso, hace falta por dato? ─────────────────────────────────────────
    // La COPIA se filtra por `fecha_captura` y la FUENTE por lo mismo MÁS `tipo_cuenta='caja'`,
    // que es exactamente el `WHERE` con el que la migración define el matview. Si ese filtro
    // cambiara allá y no acá, la sonda compararía dos universos distintos y pediría refrescar
    // para siempre — ruidoso, pero nunca silencioso, que es el lado correcto del error.
    let msSonda = 0;
    let sigCopia = null;
    if (!tocaPorPiso) {
      const ventana = `fecha_captura >= current_date - ${VENTANA_DIAS}`;
      const tSonda = Date.now();
      const fFuente = await firma(c, FUENTE, `tipo_cuenta = 'caja' AND (${ventana})`);
      const fCopia = await firma(c, MV, ventana);
      msSonda = Date.now() - tSonda;
      sigCopia = fCopia.sig;

      if (fFuente.sig === fCopia.sig) {
        // ⚠️ El latido reporta las filas REALES del matview, no 0. El contrato de este carril dice
        // que cero filas es `error` (un refresh que vacía la bandeja no es un éxito), así que
        // informar 0 en un ciclo sano lo pintaría de rojo — un arreglo de CPU inventando una alarma.
        const r = await c.query(`SELECT count(*)::int n FROM ${MV}`);
        return {
          filas: r.rows[0].n, ms: msSonda, saltado: true,
          // ⚠️ `note` NO NULO es lo que distingue un salto de un refresh de verdad, y es de lo que
          // se agarra el piso de arriba. Si algún día alguien "limpia" esta nota, el piso queda
          // satisfecho para siempre y la protección desaparece sin que nada se ponga rojo.
          nota: `sin cambios (ventana ${VENTANA_DIAS}d: ${sigCopia}) en ${msSonda} ms`
            + `; último refresh real hace ${minDesdeRefresh === null ? '?' : minDesdeRefresh.toFixed(1)} min`,
        };
      }
    }

    const t0 = Date.now();
    // CONCURRENTLY para no tomar el lock exclusivo: sin esto la bandeja queda EN BLANCO mientras
    // corre el refresh. Requiere el índice UNIQUE que crea la migración.
    await c.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${MV}`);
    const ms = Date.now() - t0;

    // ⛔⛔ [CG.22.4] LA EDAD DEL DATO NO PUEDE VIAJAR DENTRO DEL MATVIEW, y no es una preferencia.
    //
    // `REFRESH ... CONCURRENTLY` no copia la tabla: calcula lo nuevo a una temp, hace un FULL JOIN
    // por la llave única y aplica SÓLO lo que difiere, comparando la FILA COMPLETA con
    // `(y.*) IS DISTINCT FROM (x.*)`. El matview cargaba DOS columnas que cambian en cada pasada
    // por construcción -- `computed_at` (heredada de la vista base por el `SELECT k.*`) y
    // `refrescado_en` (`now()`, que agregaba la migración) -- así que el 100 % de las filas
    // parecía distinto. Medido: el diff veía 12,294 filas cambiadas y las que cambiaban de verdad
    // eran CERO. O sea, `CONCURRENTLY` —que existe justamente para aplicar el delta— aplicaba la
    // tabla entera, que es su PEOR caso, y encima pagando el sobrecosto del diff.
    //
    // El precio, medido: 12,294 DELETE + 12,294 INSERT por minuto sobre una tabla cuyo contenido
    // de negocio crece **58-74 filas por DÍA**; **8.72 MB de WAL por refresh = 12.3 GB por día**;
    // 854 autovacuums; y los índices al 54.6x y 417x de su tamaño reconstruido.
    //
    // Ahora la marca sale del reloj de ESTE proceso, y a propósito DESPUÉS de que el REFRESH
    // volvió: ése es el instante en que el dato se hizo visible, que es más honesto que el `now()`
    // del arranque de la transacción (el refresh tarda segundos).
    const al = new Date().toISOString();

    const r = await c.query(`SELECT count(*)::int n FROM ${MV}`);
    const filas = r.rows[0].n;
    if (!filas) throw new Error(`${MV} quedó con 0 filas: eso no es un refresh exitoso`);

    const avisados = await avisar(c, al);
    // `[CPU.3]` El MOTIVO va al log y no al `note` del latido: `note` es la señal binaria de la
    // que depende el piso (nulo = refrescó de verdad), así que cargarle texto acá lo rompería.
    const motivo = FORZAR ? '--forzar'
      : minDesdeRefresh === null ? 'sin historial de refresh'
        : tocaPorPiso ? `piso de ${PISO_MIN} min (último hace ${minDesdeRefresh.toFixed(1)})`
          : `la sonda vio cambios en ${msSonda} ms`;
    return { filas, ms, al, avisados, motivo };
  } finally {
    await c.end().catch(() => {});
  }
}

(async () => {
  if (!APPLY) {
    console.log('dry-run: no se refresca nada. Agregá --apply.');
    return;
  }
  const hb = require(path.join(__dirname, '..', 'lib', 'cron-heartbeat'));
  await hb.begin(KEY, 'Caja — refresca mv_caja_movimientos').catch(() => {});
  try {
    const r = await ciclo();
    if (r.filas == null) {
      console.log(r.nota);
      await hb.end(KEY, { status: 'ok', rows: 0, note: r.nota }).catch(() => {});
      return;
    }
    // `[CPU.3]` Un ciclo que no refrescó SIGUE SIENDO un ciclo sano, y el latido tiene que decir
    // eso: `ok` con las filas reales. La nota deja el rastro de POR QUÉ no se refrescó, para que
    // el día que alguien vea la bandeja vieja pueda distinguir "la sonda dijo que no hacía falta"
    // de "el carril no corrió" — que es justo la confusión que el latido existe para cortar.
    if (r.saltado) {
      console.log(`sin refrescar: ${r.nota} · ${r.filas} filas`);
      await hb.end(KEY, { status: 'ok', rows: r.filas, note: r.nota }).catch(() => {});
      return;
    }
    console.log(`refrescado: ${r.filas} filas en ${r.ms} ms (al ${r.al}) · ${r.avisados} aviso(s) NOTIFY · motivo: ${r.motivo}`);
    await hb.end(KEY, { status: 'ok', rows: r.filas }).catch(() => {});
  } catch (e) {
    console.error('falló:', e.message);
    await hb.end(KEY, { status: 'error', error: e.message }).catch(() => {});
    process.exitCode = 1;
  }
})();
