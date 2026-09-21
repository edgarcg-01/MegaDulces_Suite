/**
 * El VEREDICTO del reconciliador del ODS, como función pura y probable.
 *
 * ── Por qué existe este archivo ─────────────────────────────────────────────────────────────
 * La decisión "¿esta pasada se marca CRÍTICA?" vivía inline dentro de `latir()` en
 * `reconcile-ods-window.js`, que abre una conexión y hace `process.exit`. O sea: no se podía
 * ejercer sin prod, y por lo tanto **nunca se ejerció**. Un gate sin prueba negativa es una
 * intención (ADR-056), y éste llevaba meses siendo exactamente eso.
 *
 * Sacarlo acá no es cosmética: es lo que permite romperlo a propósito
 * (`database/tests/test-reconcile-veredicto.js`) y exigir que se ponga rojo.
 *
 * ── La regla, y lo que la corrigió ──────────────────────────────────────────────────────────
 * ⭐ **CRÍTICO = lo que NO se pudo reponer, no lo que se encontró.** El reconciliador existe para
 * cerrar los huecos que el carril caliente se salta; marcar rojo por los huecos que ENCONTRÓ es
 * marcar rojo por haber hecho su trabajo.
 *
 * Medido en prod el 2026-09-21, cinco pasadas seguidas:
 *
 *     huecos  48  32  52  58  106
 *     repues. 48  32  52  58  106      errores 0 en las cinco
 *     ventana FULL del mismo dia: huecos 0
 *
 * No se perdió una sola fila y el tablero mostraba CRÍTICO. Peor: el umbral (50) se calibró con
 * 8 sucursales, y desde el 2026-09-18 la red tiene 9 — la nueva, Morelia Abastos, es la de mayor
 * volumen de la empresa y en dos pasadas aportó ella sola 42 de 52 y 54 de 56 huecos. El umbral
 * pasó a dispararse en operación normal, sin que nadie pueda hacer nada al respecto.
 *
 * Es el mismo criterio que `reconcile-ods-window.js` ya aplicaba —por escrito— a los SOBRANTES:
 * *"un rojo permanente que nadie atiende enseña a ignorar el tablero"*. Acá sólo se le aplica
 * también a los huecos. El conteo NO se pierde: sigue viajando en la nota como TENDENCIA, que es
 * donde sirve para ver si el carril caliente se está degradando.
 *
 * ⚠️ **En dry-run `repuestas` es 0 POR CONSTRUCCIÓN** (no se envía nada). Restar ahí daría "todo
 * sin reponer" y pondría roja cada corrida en seco. Por eso `apply` es parte del contrato.
 */
'use strict';

/**
 * @param {{huecos?:number, repuestas?:number, sobrantes?:number, errores?:number, abortados?:number}} r
 *        el resumen de la pasada.
 * @param {{apply?:boolean, alerta?:number, alertaSobrantes?:number, maxDeleteFrac?:number}} opts
 * @returns {{status:'ok'|'error', malo:boolean, sinReponer:number, sobreTendencia:boolean,
 *            sobranMal:boolean, motivos:string[], error:string|null, tendencia:string}}
 */
function veredicto(r = {}, opts = {}) {
  const { apply = true, alerta = 50, alertaSobrantes = 0, maxDeleteFrac = 0.2 } = opts;
  const huecos = Number(r.huecos) || 0;
  const repuestas = Number(r.repuestas) || 0;
  const sobrantes = Number(r.sobrantes) || 0;
  const errores = Number(r.errores) || 0;
  const abortados = Number(r.abortados) || 0;

  // Lo único que de verdad rompe la COMPLETITUD: un hueco que quedó abierto.
  const sinReponer = apply ? Math.max(0, huecos - repuestas) : 0;
  const sobranMal = alertaSobrantes > 0 && sobrantes > alertaSobrantes;
  const sobreTendencia = huecos > alerta;

  const motivos = [
    sinReponer > 0
      ? `${sinReponer} de ${huecos} filas ausentes NO se pudieron reponer — el ODS quedo incompleto`
      : null,
    sobranMal
      ? `${sobrantes} filas de mas en el ODS (umbral ${alertaSobrantes}) — DELETE sin propagar, revisar a mano`
      : null,
    errores > 0 ? `${errores} tablas con error` : null,
    abortados > 0
      ? `${abortados} tablas con DELETE abortado (fraccion > ${(100 * maxDeleteFrac).toFixed(0)}%) — revisar a mano`
      : null,
  ].filter(Boolean);

  const malo = motivos.length > 0;
  return {
    status: malo ? 'error' : 'ok',
    malo,
    sinReponer,
    sobreTendencia,
    sobranMal,
    motivos,
    error: malo ? motivos.join(' · ') : null,
    // Se cuelga de la NOTA, nunca del status: es señal de degradación del carril caliente, no de
    // pérdida de dato. Si un día esto crece y las repuestas no alcanzan, `sinReponer` lo dirá.
    tendencia: sobreTendencia ? ` · TENDENCIA: huecos sobre ${alerta} (repuestos, no es perdida)` : '',
  };
}

module.exports = { veredicto };
