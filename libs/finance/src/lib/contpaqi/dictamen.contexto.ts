import type { Knex } from 'knex';
import type {
  CfdiDelContexto, ContextoDictamen, CuentaDelCatalogo, PolizaADictaminar, PolizaDeElla,
} from './dictamen';

/** Las tablas de la réplica de las que sale una asociación CFDI ↔ póliza (`analytics.v_contpaqi_cfdi_poliza`). */
const TABLAS_DE_ASOCIACION = ['ct_asoccfdis', 'ct_asocdoctosadministrativos', 'ct_asoccfdinodosdepago',
  'ct_movimientospoliza', 'ct_polizas'];

/**
 * `[CP.8.95]` — **Lee de la base lo que el dictamen necesita para las pólizas de UN mes.** Sólo lee.
 *
 * Recibe la transacción con el tenant ya puesto (`finance.*`, `fiscal.cfdis`, `contpaqi.*` y el catálogo tienen RLS
 * forzado) y además filtra por `tenant_id` explícito en las de `analytics` que no lo tienen.
 *
 * ⛔ Si una consulta falla, falla: no se cambia por un `null`. El `null` de un campo del contexto significa «quien
 * llama no lo pidió», y el dictamen lo declara `*_no_medido`; un error de SQL convertido en `null` se leería igual
 * y nadie lo vería.
 *
 * Cada lectura se acota a lo que traen las pólizas (sus cuentas, sus UUID, sus emisores) y usa los índices que
 * existen: `(tenant_id, upper(cfdi_uuid))` en las líneas de póliza, `(tenant_id, uuid)` en los CFDI y, en la réplica
 * de ContPAQi (`[CP.9.3]`), los `ix_cp93_*` por UUID y por GUID.
 */
export async function leerContextoDictamen(
  trx: Knex | Knex.Transaction,
  tenantId: string,
  periodo: string,
  hoy: string,
  polizas: PolizaADictaminar[],
): Promise<ContextoDictamen> {
  const cuentas = [...new Set(polizas.flatMap((p) => p.asiento.movimientos.map((m) => String(m.cuenta))))];
  const uuids = [...new Set(polizas.flatMap((p) => (p.uuids ?? []).map((u) => String(u).toUpperCase())))];
  const ini = `${periodo}-01`;
  const sig = siguienteMes(periodo);

  const catalogo = new Map<string, CuentaDelCatalogo>();
  if (cuentas.length) {
    const filas = await trx('analytics.contpaqi_accounts').where('tenant_id', tenantId).whereIn('codigo', cuentas)
      .select('codigo', 'afectable', 'es_baja');
    for (const r of filas) catalogo.set(String(r.codigo), { afectable: Number(r.afectable) === 1, baja: !!r.es_baja });
  }

  const emisora = await trx('fiscal.issuer_config').where({ tenant_id: tenantId, active: true })
    .orderBy('is_default', 'desc').first('rfc');

  const cfdis = new Map<string, CfdiDelContexto>();
  if (uuids.length) {
    const filas = (await trx.raw(`
      SELECT uuid, tipo_comprobante, emisor_rfc, receptor_rfc, total, to_char(fecha, 'YYYY-MM-DD') AS fecha, moneda,
             total_retenidos, estatus_sat, cancel_sustitucion_uuid, impuestos,
             substring(xml FROM 'TipoRelacion="([0-9]{2})"') AS relacion
        FROM fiscal.cfdis
       WHERE tenant_id = ? AND uuid = ANY(?)`, [tenantId, uuids])).rows as any[];
    for (const r of filas) {
      cfdis.set(String(r.uuid).toUpperCase(), {
        tipo: r.tipo_comprobante ?? null,
        emisor_rfc: r.emisor_rfc ?? null,
        receptor_rfc: r.receptor_rfc ?? null,
        total: Number(r.total) || 0,
        fecha: r.fecha ?? null,
        moneda: r.moneda ?? null,
        retenidos: Number(r.total_retenidos) || 0,
        estatus_sat: r.estatus_sat ?? null,
        sustituto: r.cancel_sustitucion_uuid ?? null,
        mixta: esMixta(r.impuestos),
        relacion: r.relacion ?? null,
      });
    }
  }

  // Las pólizas de egreso de contabilidad del periodo, con ±3 días a las orillas (el cobro cruza el corte de mes).
  const lineas = (await trx.raw(`
    SELECT l.ejercicio, l.periodo, l.folio, to_char(p.fecha, 'YYYY-MM-DD') AS fecha, l.cuenta, l.cargo_abono, l.importe
      FROM analytics.gl_polizas p
      JOIN analytics.gl_poliza_lines l ON l.tenant_id = p.tenant_id AND l.source = p.source AND l.ejercicio = p.ejercicio
       AND l.periodo = p.periodo AND l.tipo_pol = p.tipo_pol AND l.folio = p.folio
     WHERE p.tenant_id = ? AND p.source = 'contpaqi' AND p.tipo_pol = '2'
       AND p.fecha >= ?::date - 3 AND p.fecha < ?::date + 3`, [tenantId, ini, sig])).rows as any[];
  const porPoliza = new Map<string, PolizaDeElla>();
  for (const l of lineas) {
    const k = `${l.ejercicio}|${l.periodo}|2|${l.folio}`;
    if (!porPoliza.has(k)) porPoliza.set(k, { k, fecha: l.fecha, renglones: [] });
    porPoliza.get(k)!.renglones.push({ cuenta: String(l.cuenta), abono: l.cargo_abono === 'A', importe: Number(l.importe) });
  }

  // `[CP.9.4]` La réplica de ContPAQi UNIDA al staging. El staging liga un solo UUID por movimiento y ninguno a nivel
  // póliza: conocía 21,363 UUID contra 137,116 de la réplica desde 2025 (16 %, medido 2026-10-30). La réplica está
  // completa hasta su última sincronía (`asociacionesAl`); el staging es fresco al minuto. Juntas no ven menos que antes.
  const uuidEnEgresos = new Map<string, string[]>();
  if (uuids.length) {
    const filas = (await trx.raw(`
      SELECT cfdi_uuid AS u, ejercicio, periodo, folio::text AS folio
        FROM analytics.v_contpaqi_cfdi_poliza
       WHERE tenant_id = ? AND cfdi_uuid = ANY(?) AND tipo_pol = 2
      UNION
      SELECT upper(cfdi_uuid), ejercicio, periodo, folio
        FROM analytics.gl_poliza_lines
       WHERE tenant_id = ? AND upper(cfdi_uuid) = ANY(?) AND source = 'contpaqi' AND tipo_pol = '2'`,
    [tenantId, uuids, tenantId, uuids])).rows as any[];
    for (const r of filas) uuidEnEgresos.set(r.u, [...(uuidEnEgresos.get(r.u) ?? []), `${r.ejercicio}|${r.periodo}|2|${r.folio}`]);
  }
  // La sincronía más vieja de lo que arma la asociación; si falta alguna, no se sabe.
  const sync = (await trx.raw(`
    SELECT count(*)::int AS n,
           to_char(min(last_push_at) AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS al
      FROM contpaqi_ods._sync_status
     WHERE table_name = ANY(?)`, [TABLAS_DE_ASOCIACION])).rows[0] as any;
  const asociacionesAl = sync?.n === TABLAS_DE_ASOCIACION.length ? (sync.al as string) : null;

  const ejercicios = new Map<number, { cerrado: boolean }>();
  for (const r of await trx('analytics.v_contpaqi_ejercicio').where('tenant_id', tenantId).select('ejercicio', 'cerrado')) {
    ejercicios.set(Number(r.ejercicio), { cerrado: !!r.cerrado });
  }

  // Provisiones (diario, abono 2120) del año anterior al cierre del periodo: por cuenta e importe, con su fecha.
  const prov = (await trx.raw(`
    SELECT l.cuenta, round(l.importe::numeric * 100)::bigint AS centavos, to_char(p.fecha, 'YYYY-MM-DD') AS fecha
      FROM analytics.gl_polizas p
      JOIN analytics.gl_poliza_lines l ON l.tenant_id = p.tenant_id AND l.source = p.source AND l.ejercicio = p.ejercicio
       AND l.periodo = p.periodo AND l.tipo_pol = p.tipo_pol AND l.folio = p.folio
     WHERE p.tenant_id = ? AND p.source = 'contpaqi' AND p.tipo_pol = '3' AND l.cargo_abono = 'A'
       AND l.cuenta LIKE '2120%' AND p.fecha >= ?::date - 366 AND p.fecha < ?::date`, [tenantId, ini, sig])).rows as any[];
  const provisiones = new Map<string, string[]>();
  for (const r of prov) {
    const k = `${r.cuenta}|${r.centavos}`;
    provisiones.set(k, [...(provisiones.get(k) ?? []), r.fecha]);
  }

  const anticipos = new Map<string, number>();
  for (const r of await trx('analytics.contpaqi_ledger_monthly').where({ tenant_id: tenantId, anio_mes: periodo })
    .where('cuenta', 'like', '1050%').select('cuenta', 'saldo_ini')) {
    anticipos.set(String(r.cuenta).slice(4), Number(r.saldo_ini) || 0);
  }

  const rfcDeCuenta = new Map<string, Set<string>>();
  for (const r of await trx('contpaqi.supplier_accounts').where('tenant_id', tenantId)
    .whereIn('veredicto', ['confirmado', 'uuid_solido']).whereNotNull('rfc').select('cuenta', 'rfc')) {
    if (!rfcDeCuenta.has(r.cuenta)) rfcDeCuenta.set(r.cuenta, new Set());
    rfcDeCuenta.get(r.cuenta)!.add(r.rfc);
  }

  const emisores = [...new Set([...cfdis.values()].map((c) => c.emisor_rfc).filter((r): r is string => !!r))];
  const efos = new Set<string>(emisores.length
    ? await trx('fiscal.sat_list_rfcs').where('lista', '69B').whereIn('situacion', ['Definitivo', 'Presunto'])
      .whereIn('rfc', emisores).pluck('rfc')
    : []);

  return {
    periodo, hoy,
    rfcEmpresa: emisora?.rfc ?? null,
    catalogo, cfdis,
    polizasDeElla: [...porPoliza.values()],
    uuidEnEgresos, asociacionesAl, ejercicios, provisiones, anticipos, rfcDeCuenta, efos,
  };
}

function siguienteMes(periodo: string): string {
  const [y, m] = periodo.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** ¿Trae traslados de IVA (`002`) al 0 % y a más del 15 %, los dos con base? (`impuestos` del ADD de ContPAQi). */
function esMixta(impuestos: any): boolean {
  const traslados = (impuestos?.impuestos?.traslados ?? impuestos?.traslados ?? []) as any[];
  const iva = traslados.filter((x) => String(x?.impuesto) === '002' && Number(x?.base) > 0);
  return iva.some((x) => Number(x.tasa) === 0) && iva.some((x) => Number(x.tasa) > 0.15);
}
