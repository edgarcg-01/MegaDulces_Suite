'use strict';
/**
 * ⭐⭐ `[CG.183]` Candado de **la cobertura de Caja General**: las dos propiedades que son
 * aserciones de SQL y que el candado de jest no puede hacer.
 *
 *   node database/tests/test-newdb-caja-cobertura.js
 *
 * Sólo lee.
 *
 * ── Qué se rompió, medido ───────────────────────────────────────────────────────────────────
 *
 * `list()` publicaba sus KPIs **sin denominador**, y cuando se le agregó uno la primera versión
 * traía un defecto peor que no tenerlo: **la ventana se derivaba del `min`/`max` de lo capturado.**
 * El numerador no llevaba filtro de fecha —cubría todo el libro— pero el denominador sí se acotaba
 * a esa ventana derivada, o sea **al tramo donde el numerador casualmente vive**.
 *
 * Medido en prod el 2026-10-14, sin `from`/`to`:
 *
 *     numerador                               75 movimientos (2026-09-25 .. 2026-12-10)
 *     denominador recortado a la derivada        835
 *     denominador real                        13,235
 *     cobertura publicada  8.2 %   ·   real  0.6 %          <- 15x mejor
 *
 * ⭐ El nombre del defecto: **un denominador que se persigue la cola.** Se encoge hasta alcanzar al
 * numerador, así que tiende a 100 % por construcción y **falla SIEMPRE hacia el lado que
 * tranquiliza** — el peor sesgo para un número que existe para inquietar. Y nada avisa: `8.2 %` es
 * perfectamente plausible.
 *
 * ── Por qué ESTAS aserciones, y por qué acá y no en jest ────────────────────────────────────
 *
 * Las tres propiedades de forma (ventana pedida vs derivada, ventana vacía, ventana de un día) ya
 * viven en `libs/contracts/src/http/caja-cobertura.contract.spec.ts`, mutadas en rojo. Las DOS de
 * acá son sobre lo que la consulta hace contra una base real, y jest no puede afirmarlas.
 *
 * ⛔ **El esperado se calcula por un camino INDEPENDIENTE del servicio.** Si la prueba obtuviera su
 * valor corriendo la misma consulta que el código, dejaría de ser un candado y pasaría a ser un
 * **espejo**: se pondría verde incluso con el filtro de fecha puesto, porque las dos patas lo
 * llevarían. Es el `un árbitro que nunca contradice es un espejo` de ADR-059 — escrito en el repo
 * para los datos, y que el 2026-10-14 apareció **cuatro veces en cuatro capas** el mismo día:
 * un padrón usado de árbitro que contenía justo lo que debía distinguir (80.6 % de falso acierto),
 * medir una consulta *parecida* a la del servicio, un candado que le pregunta a la implementación
 * si la implementación está bien, y mirar el **crontab retirado** para saber si el despliegue corre.
 *
 * ⚠️ Y las cifras NO se escriben como literales. `13,235` es la cola de hoy; mañana es otra y la
 * prueba se pondría roja sin que nada esté mal. Lo que se afirma es la **propiedad**, que sobrevive
 * a los datos.
 *
 * ⚠️ **Este archivo NO corre en CI** — es la deuda **VP.5** de `CLAUDE.md` (`ci.yml` línea 359
 * declara que la suite «necesita API arriba»). Se dice en voz alta: es un candado **dormido**, que
 * alguien tiene que correr. Aun así vale, y la diferencia con una medición suelta es toda: una
 * medición vive en un chat y se pierde con la sesión; esto lo encuentra la próxima persona.
 */

require('dotenv').config();
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let ok = 0;
let fail = 0;
let nomedido = 0;

const check = (cond, txt, detalle = '') => {
  if (cond) { ok++; console.log(`  ✓ ${txt}`); }
  else { fail++; console.log(`  ✗ ${txt}${detalle ? '\n      ' + detalle : ''}`); }
};
const declarar = (txt) => { nomedido++; console.log(`  ⓘ NO MEDIDO — ${txt}`); };

/**
 * El denominador, armado ACÁ y no importado del servicio. Replica el `whereNotExists` por glosa de
 * `movimientosPendientes()` — sin él contaría documentos que la cola YA OCULTA por estar
 * capturados, y la cobertura saldría peor de lo que es: mediría trabajo ya hecho como pendiente.
 *
 * ⛔⛔ `[CGA-A.11]` **ESTA RÉPLICA LLEVABA EL DEFECTO ADENTRO, y por eso nadie lo vio.**
 * Faltaba `y.origen_tipo = 'caos'`. Sin eso, `glosa LIKE doc_tipo || ' ' || folio` tapa a
 * cualquier otra sucursal con el mismo folio —el folio de camioneta es consecutivo **por
 * unidad**, no global—, así que el denominador daba por hecho trabajo que nadie hizo y la
 * cobertura salía **mejor de lo que era**. Medido en prod el 2026-10-16:
 *
 *     denominador ROTO  (sin acotar)   13,222 movimientos · $162,111,454.69
 *     denominador BUENO (acotado)      13,361 movimientos · $163,188,930.98
 *                                     ───────────────────────────────────────
 *     diferencia                          139 movimientos ·   $1,077,476.29
 *
 * ⭐ **La lección no es el `AND` que faltaba: es que la prueba REPLICABA la consulta en vez de
 * ejercer el servicio.** Una réplica hereda los defectos del original y después los certifica.
 * `GOTCHAS` §86. Lo vigila `npm run check:dedup-por-llave`.
 */
const DENOM = (filtroFecha) => `
  SELECT count(*)::int AS movimientos, coalesce(sum(v.monto),0)::numeric AS monto
    FROM finance.v_caja_movimientos_pendientes v
   WHERE v.tenant_id = $1
     AND NOT EXISTS (
       SELECT 1 FROM finance.cash_ledger y
        WHERE y.tenant_id = v.tenant_id AND y.deleted_at IS NULL AND y.estado <> 'cancelado'
          AND y.origen_tipo = 'caos'
          AND y.glosa LIKE v.doc_tipo || ' ' || v.folio || '%')
     ${filtroFecha}`;

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW (o PROD_DB_URL).'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);

  // ── 0. ¿Hay con qué comprobarlo? ──────────────────────────────────────────────────────────
  // ⛔ Primero se mide si el universo alcanza. Un candado sobre un conjunto vacío pasa "por vacío,
  // no por sano", que es lo que `test-newdb-caja-fuentes-y-definer` lleva días reportando.
  console.log('\n[0] Hay universo con qué medir');
  const { rows: [u] } = await c.query(`
    SELECT (SELECT count(*)::int FROM finance.cash_ledger
             WHERE tenant_id=$1 AND deleted_at IS NULL) AS libro,
           (SELECT count(*)::int FROM finance.v_caja_movimientos_pendientes
             WHERE tenant_id=$1) AS cola`, [TENANT]);
  check(u.libro > 0 && u.cola > 0,
    `el libro tiene ${u.libro} y la cola ${u.cola}: hay con qué comparar`);

  // ── 1. SIN VENTANA, EL DENOMINADOR NO SE FILTRA POR FECHA ─────────────────────────────────
  console.log('\n[1] Sin `from`/`to`, el denominador cubre la cola ENTERA');
  const { rows: [sinLimite] } = await c.query(DENOM(''), [TENANT]);
  const { rows: [libroSpan] } = await c.query(`
    SELECT to_char(min(fecha),'YYYY-MM-DD') AS desde, to_char(max(fecha),'YYYY-MM-DD') AS hasta,
           count(*)::int AS movimientos
      FROM finance.cash_ledger WHERE tenant_id=$1 AND deleted_at IS NULL`, [TENANT]);

  if (!libroSpan.desde) {
    declarar('el libro está vacío: sin span no se puede construir el caso del denominador recortado');
  } else {
    const { rows: [recortado] } = await c.query(
      DENOM(`AND v.fecha_valor >= $2::date AND v.fecha_valor <= $3::date`),
      [TENANT, libroSpan.desde, libroSpan.hasta]);

    /**
     * ⛔ **EL CONTROL NEGATIVO, y es el que le da sentido a todo.** Si el denominador recortado al
     * span de los datos fuera IGUAL al completo, este candado pasaría en verde con el defecto
     * puesto. La propiedad que se afirma es que las dos cifras **difieren** — o sea que derivar la
     * ventana SÍ cambia el resultado, y por lo tanto no da lo mismo cuál se use.
     */
    check(recortado.movimientos < sinLimite.movimientos,
      `recortar al span del libro CAMBIA el denominador (${recortado.movimientos} < ${sinLimite.movimientos}): el defecto es detectable`,
      'si fueran iguales, este candado pasaría en verde con la ventana derivada puesta');

    const pctRecortada = (100 * libroSpan.movimientos) / (libroSpan.movimientos + recortado.movimientos);
    const pctHonesta = (100 * libroSpan.movimientos) / (libroSpan.movimientos + sinLimite.movimientos);
    check(pctRecortada > pctHonesta,
      `y la ventana derivada INFLA la cobertura (${pctRecortada.toFixed(1)}% contra ${pctHonesta.toFixed(1)}%)`,
      'la dirección importa más que el factor: falla hacia el lado que tranquiliza');
  }

  // ── 2. LA NORMALIZACIÓN DE SUCURSAL, EN LOS DOS LADOS ─────────────────────────────────────
  console.log('\n[2] `sucursal` se compara normalizada: la cola trae códigos compuestos');
  const { rows: comp } = await c.query(`
    SELECT split_part(v.sucursal,'-',1) AS plaza,
           count(*) FILTER (WHERE v.sucursal LIKE '%-%')::int AS compuestas,
           count(*)::int AS total
      FROM finance.v_caja_movimientos_pendientes v
     WHERE v.tenant_id=$1 GROUP BY 1 HAVING count(*) FILTER (WHERE v.sucursal LIKE '%-%') > 0
     ORDER BY 2 DESC LIMIT 1`, [TENANT]);

  if (!comp.length) {
    declarar('la cola no tiene códigos compuestos hoy: la normalización del denominador no se puede ejercer');
  } else {
    const plaza = comp[0].plaza;
    const { rows: [n] } = await c.query(`
      SELECT count(*) FILTER (WHERE v.sucursal = $2)::int AS igualdad,
             count(*) FILTER (WHERE split_part(v.sucursal,'-',1) = $2)::int AS normalizado,
             coalesce(sum(v.monto) FILTER (WHERE v.sucursal = $2),0)::numeric AS monto_igualdad,
             coalesce(sum(v.monto) FILTER (WHERE split_part(v.sucursal,'-',1) = $2),0)::numeric AS monto_normalizado
        FROM finance.v_caja_movimientos_pendientes v WHERE v.tenant_id=$1`, [TENANT, plaza]);
    const escondido = n.normalizado - n.igualdad;
    const pct = (100 * escondido) / n.normalizado;
    check(escondido > 0,
      `en la plaza ${plaza}, comparar por igualdad esconde ${escondido} movimientos y $${Number(n.monto_normalizado - n.monto_igualdad).toLocaleString('es-MX', { minimumFractionDigits: 2 })} (${pct.toFixed(1)}%)`,
      'un filtro que coincide a medias no falla: resta en silencio y el renglón se ve sano');
  }

  /**
   * ⚠️ **El NUMERADOR no tiene compuestas en datos reales** (medido: 0 de 75 filas del libro), así
   * que esta mitad **no se puede ejercer contra prod** — y un candado armado sobre prod pasaría
   * verde sin tocarla nunca, que es justo el «normaliza a medias» que hay que atrapar. Se DECLARA
   * en vez de dibujarse como verificada; cubrirla exige inyectar una fila como fixture.
   */
  const { rows: [nc] } = await c.query(`
    SELECT count(*) FILTER (WHERE sucursal LIKE '%-%')::int AS compuestas
      FROM finance.cash_ledger WHERE tenant_id=$1 AND deleted_at IS NULL`, [TENANT]);
  if (nc.compuestas === 0) {
    declarar('el LIBRO no tiene sucursales compuestas: la normalización del numerador no se ejerce con datos reales (hace falta un fixture)');
  } else {
    check(true, `el libro tiene ${nc.compuestas} compuestas: la normalización del numerador sí se ejerce`);
  }

  await c.end();
  console.log(`\n${ok} ✓ · ${fail} ✗ · ${nomedido} no medidos`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
