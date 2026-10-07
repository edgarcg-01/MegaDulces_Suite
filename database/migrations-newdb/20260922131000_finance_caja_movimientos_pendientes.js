/**
 * CG.21 — La bandeja de la caja, **los dos signos**, sobre la vista que ya existía.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────────
 *
 * En CG.20 declaré que los gastos de caja "no están en Kepler". **Era falso** y lo corrige la
 * medición: están enteros, y el discriminante es `kdm1.c45` — la cuenta por la que se movió el
 * dinero — que el catálogo del propio Kepler nombra en `kdb1`:
 *
 *     c1=0011 | c2=CAJA GENERAL | c3=EFECTIVO | c5=102-0011
 *
 * Cobertura del EGRESO, 5 meses cerrados, caja del Control vs Kepler `c45='0011'`
 * (`X-D-25/26/60` + `X-A-45`, sin cancelados):
 *
 *     abr  922 · $8,622,808.23   vs   997 · $8,605,307.85    100%
 *     may 1343 · $7,756,485.72   vs  1410 · $8,212,145.93    106%
 *     jun 1217 · $9,206,165.89   vs  1222 · $9,206,511.89    100%
 *     jul 1205 · $9,878,687.05   vs  1202 · $9,580,938.37     97%
 *     ago 1021 · $8,644,075.03   vs  1008 · $8,518,523.05     99%
 *     ───────  $44,108,221.92    vs        $44,123,427.09    100%  (Δ 0.03%)
 *
 * Los ±3-6% por mes son el rezago de captura cruzando el corte; en 5 meses netea a cero. Del lado
 * del ingreso el cuadre es aún más fino: julio $10,452,178.12 vs $10,452,158.24, **Δ $19.88**.
 *
 * ── Lo que esta vista NO hace: casar por importe ──────────────────────────────────────────────
 *
 * ⛔ Se midió el piso de ruido con un control negativo — el mismo cruce contra una ventana placebo
 * de Kepler desplazada 180 días — y da **23-34%**. O sea: un tercio de los "aciertos" de cualquier
 * matcher por importe son casualidad de densidad. Por eso acá **no se casa nada**: la fila de caja
 * se crea DESDE el documento, con `origen_ref` explícito, y no hay nada que adivinar.
 *
 * ── La llave lleva el doc_tipo, y no es decorativo ────────────────────────────────────────────
 *
 * `origen_ref = sucursal|doc_tipo|folio|clave_banco` — la misma forma compuesta que
 * `caja-general.service.ts:681` ya usa para abrir el detalle. Medido: **el folio COLISIONA** entre
 * `X-A-45`, `X-D-26` y `X-D-60` (los folios 0000011, 0000014, 0000029, 0000030… existen en los
 * tres a la vez). Con `sucursal|folio` a secas, confirmar un anticipo **bloquearía un pago
 * distinto** contra `ux_cash_ledger_origen_vivo`, y el pago desaparecería de la bandeja sin que
 * nadie lo capturara. Es la trampa que la Fase CC ya pagó una vez (`doc_prefix` en la PK).
 *
 * ── Decisiones que se ven en el WHERE ─────────────────────────────────────────────────────────
 *
 * · `tipo_cuenta='caja'` en vez de `clave_banco='0011'`: agarra las cinco cajas del catálogo. Hoy
 *   cuatro están dormidas (0010 con 1 doc en 180d; 0030/0040/0050 con cero) — no se les construye
 *   nada especial, aparecen solas el día que se usen. Depende del criterio derivado que instala
 *   `20260922130000`; con la lista de claves vieja, 0030 y 0050 nunca entrarían.
 * · `es_traspaso = false`: el fondeo de caja (`N-A-26`) tiene DOS piernas y necesita criterio
 *   propio. Son 11 docs / $33,624 en 180 días. Queda fuera CON MOTIVO, y la cobertura lo cuenta
 *   aparte para que no sea un hueco invisible.
 * · `signo <> 0`: `flujo='otro'` llega con signo NULL. Sin dirección no hay ingreso ni gasto que
 *   proponer, y un NULL tratado como cero sería inventarle sentido.
 * · `origen_tipo` sale del signo: `'cobro'` entra, `'pago_proveedor'` sale. **Los dos ya los admite
 *   `cash_ledger_origen_chk`** (`20260918150000:134`) → cero cirugía de constraint.
 *
 * `security_invoker` para que la RLS de `finance.cash_ledger` aplique con quien pregunta; el filtro
 * de tenant va DENTRO porque `analytics.*` no tiene RLS.
 *
 * ⛔ Ni un `?` en este SQL: knex se lo come como binding y ya costó un regex entero en
 * `20260819220000`. Cuantificadores con `{0,1}`.
 *
 * @param { import("knex").Knex } knex
 */

// La llave compuesta, en un solo lugar: si cambia, cambia acá y en ningún otro lado.
const ORIGEN_REF = `k.sucursal || '|' || k.doc_tipo || '|' || k.folio || '|' || k.clave_banco`;
const ORIGEN_TIPO = `CASE WHEN k.signo > 0 THEN 'cobro' ELSE 'pago_proveedor' END`;

exports.up = async function (knex) {
  const v = await knex.raw(`SELECT to_regclass('analytics.kepler_bank_movements') AS t`);
  if (!v.rows[0] || !v.rows[0].t) return; // entorno sin la vista de tesorería: nada que derivar

  // ── 1. Lo que Kepler ya sabe y la caja todavía no aplicó ───────────────────────────────────
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_movimientos_pendientes`);
  await knex.raw(`
    CREATE VIEW finance.v_caja_movimientos_pendientes
      WITH (security_invoker = true) AS
    SELECT k.tenant_id,
           k.clave_banco,
           k.banco_nombre                                              AS caja_nombre,
           k.sucursal,
           k.doc_tipo,
           k.folio,
           ${ORIGEN_REF}                                               AS origen_ref,
           CASE WHEN k.signo > 0 THEN 'ingreso' ELSE 'gasto' END       AS tipo,
           ${ORIGEN_TIPO}                                              AS origen_tipo,
           k.fecha_valor,
           k.fecha_captura,
           k.entidad_code,
           k.beneficiario,
           k.concepto,
           k.metodo,
           k.importe                                                   AS monto
      FROM analytics.kepler_bank_movements k
     WHERE k.tenant_id = current_tenant_id()
       AND k.tipo_cuenta = 'caja'
       AND k.signo <> 0
       AND k.es_traspaso = false
       AND k.importe > 0
       AND NOT EXISTS (
             SELECT 1
               FROM finance.cash_ledger l
              WHERE l.tenant_id   = k.tenant_id
                AND l.origen_tipo = ${ORIGEN_TIPO}
                AND l.origen_ref  = ${ORIGEN_REF}
                AND l.deleted_at IS NULL
                AND l.estado <> 'cancelado')`);
  await knex.raw(`GRANT SELECT ON finance.v_caja_movimientos_pendientes TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW finance.v_caja_movimientos_pendientes IS
    'CG.21 — movimientos de CAJA que Kepler ya registró y el libro todavía no aplicó, los dos '
    'signos. Llave origen_ref = sucursal|doc_tipo|folio|clave_banco: el folio COLISIONA entre '
    'X-A-45, X-D-26 y X-D-60, medido. Excluye traspasos (2 piernas) y signo NULL, con motivo.'`);

  // ── 2. Cobertura: anclado vs tecleado, POR SIGNO ───────────────────────────────────────────
  //
  // `v_caja_ingreso_cobertura` (20260921170000) filtra `tipo='ingreso'` y dejaría el egreso
  // anclado invisible. Ésta la supersede con el tipo como dimensión. ⚠️ La vieja NO se dropea:
  // el código desplegado puede ir por delante de las migraciones en este proyecto (hay 4 sin
  // aplicar a prod ahora mismo) y dropear una vista que el deploy vigente lee tumba /cobertura.
  // Se retira en cuanto nada la consulte.
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_cobertura`);
  await knex.raw(`
    CREATE VIEW finance.v_caja_cobertura
      WITH (security_invoker = true) AS
    SELECT l.tenant_id,
           l.sucursal,
           date_trunc('month', l.fecha)::date                                       AS mes,
           l.tipo,
           count(*)::int                                                            AS movimientos,
           count(*) FILTER (WHERE l.origen_tipo IS NOT NULL)::int                   AS anclados,
           count(*) FILTER (WHERE l.origen_tipo IS NULL)::int                       AS capturados,
           coalesce(sum(l.monto), 0)                                                AS monto,
           coalesce(sum(l.monto) FILTER (WHERE l.origen_tipo IS NOT NULL), 0)       AS monto_anclado
      FROM finance.cash_ledger l
     WHERE l.tenant_id = current_tenant_id()
       AND l.deleted_at IS NULL
       AND l.estado <> 'cancelado'
     GROUP BY 1, 2, 3, 4`);
  await knex.raw(`GRANT SELECT ON finance.v_caja_cobertura TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW finance.v_caja_cobertura IS
    'CG.21 — anclado vs tecleado por mes, sucursal y TIPO. Supersede v_caja_ingreso_cobertura, '
    'que filtraba tipo=ingreso y dejaba el egreso anclado invisible.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_cobertura`);
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_movimientos_pendientes`);
};
