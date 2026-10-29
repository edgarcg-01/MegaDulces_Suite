import type { Knex } from 'knex';

/**
 * ⭐ `[CGA-A.65]` Los pagos de una zona con el efectivo de su venta — del ODS, sin copiar nada.
 *
 * La pierna `0011` de cada pago sale de `analytics.bank_movement_legs` (la tabla que mantienen los
 * triggers de `kdm1`, ADR-104; la misma de la reposición y de la cola), y su centro de costo
 * (`c12`) y su referencia (`c11`), de la cabecera `kepler_ods.kdm1` por su llave primaria (`src_*`
 * = `kdm1_pkey`). Cuál va en la hoja y cuál no lo decide el motor (`hoja-gastos.engine.ts`), en un
 * solo lugar y con pruebas: aquí no se filtra por centro.
 */
const ORIGEN_REF = `l.sucursal || '|' || l.doc_tipo || '|' || l.folio || '|' || l.clave_banco`;

export const consultasHoja = {
  /**
   * Los pagos de la zona desde `desde` (día de pago). `soloPendientes`: sin los que el libro de Caja
   * General ya explica (un retiro de CAOS los liga, o salieron del cajón). `conHojas`: sin los que
   * ya van en una hoja vigente (la tabla puede no existir todavía: lo dice quien llama).
   */
  pagos(k: Knex, tenantId: string, sucursales: string[], desde: string,
    opts: { soloPendientes: boolean; conHojas: boolean }): Knex.QueryBuilder {
    const q = k('analytics.bank_movement_legs as l')
      .join('kepler_ods.kdm1 as d', function llave() {
        this.on('d.sucursal', 'l.src_sucursal').andOn('d.c1', 'l.src_c1').andOn('d.c2', 'l.src_c2')
          .andOn('d.c3', 'l.src_c3').andOn('d.c4', 'l.src_c4').andOn('d.c5', 'l.src_c5').andOn('d.c6', 'l.src_c6');
      })
      .where('l.tenant_id', tenantId).where('l.clave_banco', '0011')
      .whereIn('l.sucursal', sucursales.length ? sucursales : ['--'])
      .where('l.fecha_valor', '>=', desde)
      .where('l.signo', '<', 0).where('l.es_traspaso', false).where('l.importe', '>', 0);
    if (opts.soloPendientes) {
      q.whereRaw(`NOT EXISTS (SELECT 1 FROM finance.cash_ledger cl
          WHERE cl.tenant_id = l.tenant_id AND cl.origen_tipo = 'pago_proveedor' AND cl.deleted_at IS NULL
            AND cl.estado <> 'cancelado' AND cl.origen_ref = ${ORIGEN_REF}
            AND (cl.origen_efectivo = 'cajon' OR EXISTS (SELECT 1 FROM finance.caos_cash_links kl
                  WHERE kl.tenant_id = cl.tenant_id AND kl.cash_ledger_id = cl.id AND kl.deleted_at IS NULL)))`);
    }
    if (opts.conHojas) {
      q.whereRaw(`NOT EXISTS (SELECT 1 FROM finance.expense_sheet_lines h
          WHERE h.tenant_id = l.tenant_id AND h.vigente AND h.origen_ref = ${ORIGEN_REF})`);
    }
    return q
      .orderBy([{ column: 'l.fecha_valor', order: 'asc' }, { column: 'l.sucursal', order: 'asc' }, { column: 'l.folio', order: 'asc' }])
      .select('l.sucursal', 'l.doc_tipo', 'l.folio', 'l.beneficiario',
        k.raw(`${ORIGEN_REF} AS origen_ref`),
        k.raw(`to_char(l.fecha_valor, 'YYYY-MM-DD') AS fecha_pago`),
        k.raw(`to_char(l.fecha_captura, 'YYYY-MM-DD') AS fecha_captura`),
        k.raw('l.importe AS importe'),
        k.raw(`nullif(btrim(l.entidad_code), '') AS clave`),
        k.raw(`nullif(btrim(d.c12::text), '') AS centro`),
        k.raw(`nullif(btrim(d.c11::text), '') AS referencia`));
  },
};
