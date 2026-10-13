'use strict';
/**
 * ⭐⭐ `[CG.139]` — **UN MOVIMIENTO, DOS CAJAS: el reparto del dinero, definido una sola vez.**
 *
 * Edgar, corrigiéndome: *"se asocia a un movimiento de CAOS, pero el dinero que entró a CAOS y el
 * dinero que entró a caja chica es diferente. Se engloban en movimiento pero se separan en
 * dinero"*.
 *
 * ── El error que esto cierra ────────────────────────────────────────────────────────────────
 *
 * Yo venía modelando cada movimiento como **de una caja o de la otra**, y eso es falso en la
 * mitad de los casos. Medido en prod el 2026-10-13, los tres cobros de ruta:
 *
 *     monto registrado ..... $49,457.00   un solo movimiento
 *     se lo tragó la máquina  $49,400.00   los BILLETES
 *     quedó en el cajón ....... $57.00     la MORRALLA
 *
 * La máquina no maneja monedas —todos sus montos son múltiplos de 20— así que de un mismo cobro
 * los billetes terminan en la bóveda y las monedas en el cajón. Clasificar el movimiento entero
 * como «de CAOS» se habría comido $57 de efectivo que **sí** está en el cajón; clasificarlo como
 * «de caja general» publica $49,400 que están dentro de una máquina. Las dos están mal, y por eso
 * no se puede resolver con una columna que diga a cuál pertenece.
 *
 * ── Por qué una VISTA y no una columna ──────────────────────────────────────────────────────
 *
 * ⛔ Una columna `caja_fisica` fue mi primer intento y era doblemente equivocada: por binaria (lo
 * de arriba) y por **copia** — el reparto se DERIVA de dos hechos que ya están en la base, y
 * materializarlo crea una segunda verdad que se desincroniza el día que alguien agrega o quita un
 * enlace. La regla del proyecto es derivar, no copiar.
 *
 * Lo que sí faltaba es que la derivación viviera en **UN** lugar. Hoy el `CASE` está escrito a
 * mano dentro de `movimientosSueltos()`, y cualquier consulta nueva que quiera el reparto lo
 * vuelve a escribir — que es exactamente cómo se producen dos cifras distintas para el mismo
 * hecho. Esta vista es esa única definición.
 *
 * ── Las dos vías, y hacen falta las dos ─────────────────────────────────────────────────────
 *
 *   (a) **Nació en la máquina** (`origen_tipo='caos'`): el movimiento ES el del cajero, su monto
 *       entero es de la bóveda y al cajón no llegó nada. Hecho duro del feed.
 *   (b) **Enlazado** (`finance.caos_cash_links`): de un cobro capturado, la parte que la máquina
 *       contó. ⚠️ `monto_enlazado` es lo que contó la MÁQUINA, o sea sólo billetes: el resto es
 *       la morralla, y por eso el `monto − en_boveda` del cajón sale solo.
 *
 * ⚠️ `k.deleted_at IS NULL`: un enlace retirado deja de repartir. Sin eso un enlace borrado
 * seguiría mandando dinero a la bóveda y el cajón mostraría de menos para siempre.
 *
 * ⚠️ **`sin_enlace` NO es «todo quedó en el cajón»**: es que nadie declaró lo contrario. Se
 * publica como `reparto_via` para que un consumidor pueda distinguir el reparto MEDIDO del
 * supuesto, en vez de leer un `en_boveda = 0` como un hecho (ADR-056).
 *
 * ⛔ Esta vista **no cambia ninguna cifra existente**: es la misma expresión que ya corría en
 * `movimientosSueltos()`, movida a donde se pueda citar. El esperado del corte no la usa —
 * descansa en las dos piernas de la máquina (`[CG.96]`), que no dependen de que alguien enlace.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.v_caja_reparto_movimiento';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA} AS
    SELECT l.tenant_id,
           l.id              AS cash_ledger_id,
           l.folio,
           l.sucursal,
           l.fecha,
           l.created_at,
           l.tipo,
           l.estado,
           l.origen_tipo,
           l.monto,
           -- Lo que nunca pasó por el cajón.
           CASE WHEN l.origen_tipo = 'caos' THEN l.monto
                ELSE coalesce((SELECT sum(k.monto_enlazado)
                                 FROM finance.caos_cash_links k
                                WHERE k.cash_ledger_id = l.id
                                  AND k.deleted_at IS NULL), 0)
           END AS en_boveda,
           -- Lo que sí llegó al cajón: el resto. En un cobro de ruta, la morralla.
           l.monto - CASE WHEN l.origen_tipo = 'caos' THEN l.monto
                ELSE coalesce((SELECT sum(k.monto_enlazado)
                                 FROM finance.caos_cash_links k
                                WHERE k.cash_ledger_id = l.id
                                  AND k.deleted_at IS NULL), 0)
           END AS en_cajon,
           -- ⚠️ CON QUÉ se repartió. 'sin_enlace' = nadie lo declaró, NO "quedó todo en el cajón".
           CASE WHEN l.origen_tipo = 'caos' THEN 'nacio_en_la_maquina'
                WHEN EXISTS (SELECT 1 FROM finance.caos_cash_links k
                              WHERE k.cash_ledger_id = l.id AND k.deleted_at IS NULL) THEN 'enlazado'
                ELSE 'sin_enlace'
           END AS reparto_via
      FROM finance.cash_ledger l
     WHERE l.deleted_at IS NULL`);

  /**
   * ⛔ `security_invoker` y los GRANT **no sobreviven a un `CREATE OR REPLACE VIEW`** (ADR-057).
   * Se re-aplican siempre, no sólo la primera vez. Sin el invoker la vista leería con los
   * permisos de quien la creó y se saltaría el RLS forzado de `cash_ledger`.
   */
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  for (const rol of ['app_runtime', 'dev_ro']) {
    await knex.raw(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rol}') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA analytics TO ${rol}';
        EXECUTE 'GRANT SELECT ON ${VISTA} TO ${rol}';
      END IF;
    END $$`);
  }

  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[CG.139] El reparto de CADA movimiento de caja entre la boveda (CAOS) y el cajon. Un cobro de ruta entra como UN movimiento y se separa en dinero: los billetes los cuenta la maquina, la morralla llega al cajon. reparto_via dice con que se repartio; sin_enlace NO significa que todo quedo en el cajon.'`);

  /**
   * ⛔ El candado. Una vista que se crea y nadie comprueba es una definición con esperanza.
   *
   * (1) **Conservación**: `en_boveda + en_cajon` tiene que dar el `monto`, fila por fila. Si un
   *     enlace declarara más de lo que el movimiento vale, `en_cajon` saldría negativo y el cajón
   *     mostraría de menos sin un solo error.
   * (2) **Prueba de que reparte de verdad**: tiene que existir al menos un movimiento **partido**
   *     (las dos partes > 0). Sin esta aserción, una vista que mandara todo a un solo lado
   *     pasaría en verde y sería justo el error que esta migración viene a cerrar.
   *
   * ⚠️ (2) se DECLARA como no medido si todavía no hay enlaces, en vez de darse por buena: una
   * base sin enlaces no prueba ni refuta el reparto.
   */
  const [{ rotas, partidos, negativos, filas }] = (await knex.raw(`
    SELECT count(*) FILTER (WHERE round(en_boveda + en_cajon, 2) <> round(monto, 2))::int AS rotas,
           count(*) FILTER (WHERE en_boveda > 0 AND en_cajon > 0)::int AS partidos,
           count(*) FILTER (WHERE en_cajon < 0)::int AS negativos,
           count(*)::int AS filas
      FROM ${VISTA}`)).rows;

  if (Number(rotas) !== 0 || Number(negativos) !== 0) {
    throw new Error(
      `[CG.139] el reparto no conserva el monto: ${rotas} fila(s) donde boveda + cajon <> monto y `
      + `${negativos} con el cajon en negativo. La migracion se revierte entera.`);
  }

  // eslint-disable-next-line no-console
  console.log(`[CG.139] ${VISTA} lista · ${filas} movimiento(s) · conservacion OK · `
    + (Number(partidos) > 0
      ? `${partidos} partido(s) entre las dos cajas (el reparto se ejerce).`
      : 'NO MEDIDO: todavia no hay un movimiento partido con que probar el reparto.'));
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
