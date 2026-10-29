import type { Knex } from 'knex';
import {
  DIAS_INSTANCIA_REPOSICION, SUCURSALES_SIN_REPOSICION,
  type DocKepler, type EgresoLibro, type RetiroLibre, type VinculoLibro,
} from './caja-reposicion.engine';
import { sqlCustodiaCerrada, sqlDisponibleCaos } from './caja-custodia.service';
import { aprobacionDePagos, type PagoParaAprobar } from './pago-aprobado.engine';

/** Suma días a un `YYYY-MM-DD` (UTC, sin reloj local). */
export const sumarDias = (dia: string, n: number) =>
  new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// ── Lo que devuelve la base (node-pg entrega `numeric` como TEXTO: se convierte UNA vez) ───────
export type DocCrudo = Omit<DocKepler, 'monto'> & { monto: string | number };
export type EgresoCrudo = Omit<EgresoLibro, 'monto'> & { monto: string | number };
export type VinculoCrudo = Omit<VinculoLibro, 'monto' | 'external_id'> & { monto: string | number; external_id: string | number };
export type RetiroCrudo = {
  device: string; external_id: string | number; occurred_at: string | Date; ref: string | null;
  total: string | number; libre: string | number; sucursales_vinculadas: string[] | null;
};

/**
 * ⭐ `[CGA-A.61]` Las cuatro lecturas, como constructores de consulta. El servicio las corre en su
 * transacción; la sonda contra prod imprime ESTE mismo SQL (`.toString()`) y lo mide — medir una
 * consulta parecida no prueba la que corre (lección de memoria: «medir la consulta REAL»).
 *
 * ── De dónde sale cada cosa (ninguna se copia) ───────────────────────────────────────────────
 *  · Documentos: `analytics.bank_movement_legs` — la tabla que mantienen los triggers de `kdm1`
 *    (ADR-104), la MISMA que alimenta la cola. Egresos de la `0011` de cada sucursal, por `c9`.
 *    Índice `ix_bml_clave_fecha (tenant_id, clave_banco, fecha_valor)`.
 *  · Egresos: `finance.cash_ledger` por la MISMA llave que la cola (`origen_tipo` + `origen_ref`),
 *    y además los egresos cuyo documento Kepler ya no tiene (se canceló allá): se muestran.
 *  · Vínculos: `finance.caos_cash_links` vivos, con la referencia del retiro.
 *  · Retiros: CAOS tipo 4 con dinero libre (`sqlDisponibleCaos`) y sin custodia cerrada — la
 *    MISMA regla que `retirosLibres()` del lote.
 */
export const consultasReposicion = {
  docs(k: Knex, tenantId: string, desde: string, hasta: string): Knex.QueryBuilder {
    return k('analytics.bank_movement_legs as l')
      // [CGA-A.65] El centro y la referencia de Kepler (cabecera por su llave primaria): deciden si el
      // pago va en la hoja de gastos de su zona, con la MISMA regla que la hoja.
      .leftJoin('kepler_ods.kdm1 as d', function llave() {
        this.on('d.sucursal', 'l.src_sucursal').andOn('d.c1', 'l.src_c1').andOn('d.c2', 'l.src_c2')
          .andOn('d.c3', 'l.src_c3').andOn('d.c4', 'l.src_c4').andOn('d.c5', 'l.src_c5').andOn('d.c6', 'l.src_c6');
      })
      .where('l.tenant_id', tenantId).where('l.clave_banco', '0011')
      .whereBetween('l.fecha_valor', [desde, hasta])
      .where('l.signo', '<', 0).where('l.es_traspaso', false).where('l.importe', '>', 0)
      .whereNotIn('l.sucursal', [...SUCURSALES_SIN_REPOSICION])
      .select('l.sucursal', 'l.doc_tipo', 'l.folio', 'l.beneficiario',
        k.raw(`to_char(l.fecha_valor, 'YYYY-MM-DD') AS fecha_valor`),
        k.raw(`to_char(l.fecha_captura, 'YYYY-MM-DD') AS fecha_captura`),
        k.raw('l.importe AS monto'),
        k.raw(`nullif(btrim(d.c12::text), '') AS centro`),
        k.raw(`nullif(btrim(d.c11::text), '') AS referencia`),
        k.raw(`l.sucursal || '|' || l.doc_tipo || '|' || l.folio || '|' || l.clave_banco AS origen_ref`));
  },

  egresos(k: Knex, tenantId: string, desde: string, hasta: string, refs: string[]): Knex.QueryBuilder {
    return k('finance.cash_ledger as cl')
      .where('cl.tenant_id', tenantId).where('cl.origen_tipo', 'pago_proveedor')
      .whereNull('cl.deleted_at').whereNot('cl.estado', 'cancelado')
      .where((w) => {
        if (refs.length) w.whereIn('cl.origen_ref', refs);
        w.orWhere((o) => o
          .whereRaw(`cl.origen_ref ~ '^0[1-9][|][^|]+[|][^|]+[|]0011$'`)
          .whereBetween('cl.fecha', [desde, hasta])
          .whereRaw(`NOT EXISTS (SELECT 1 FROM analytics.bank_movement_legs b
               WHERE b.tenant_id = cl.tenant_id AND b.sucursal = split_part(cl.origen_ref, '|', 1)
                 AND b.doc_tipo = split_part(cl.origen_ref, '|', 2) AND b.folio = split_part(cl.origen_ref, '|', 3)
                 AND b.clave_banco = '0011')`));
      })
      .select('cl.id', 'cl.folio', 'cl.origen_ref', 'cl.monto', 'cl.origen_efectivo',
        k.raw(`to_char(cl.fecha, 'YYYY-MM-DD') AS fecha`));
  },

  vinculos(k: Knex, tenantId: string, ids: string[]): Knex.QueryBuilder {
    return k('finance.caos_cash_links as kl')
      .leftJoin('analytics.caos_cash_movements as m', function enlace() {
        this.on('m.tenant_id', 'kl.tenant_id').andOn('m.device', 'kl.caos_device').andOn('m.external_id', 'kl.caos_external_id');
      })
      .where('kl.tenant_id', tenantId).whereNull('kl.deleted_at').whereIn('kl.cash_ledger_id', ids)
      .orderBy([{ column: 'kl.created_at', order: 'asc' }])
      .select('kl.id as link_id', 'kl.cash_ledger_id', 'kl.caos_device as device', 'kl.caos_external_id as external_id',
        'm.ref', 'kl.monto_enlazado as monto');
  },

  /** Retiros con dinero libre cerca de la ventana: el motor sólo usa los que están a ≤ N días. */
  retiros(k: Knex, tenantId: string, desde: string, hasta: string, conCustodia: boolean): Knex.QueryBuilder {
    const q = k('analytics.caos_cash_movements as m')
      .where('m.tenant_id', tenantId).where('m.type_id', 4)
      .where('m.occurred_at', '>=', sumarDias(desde, -(DIAS_INSTANCIA_REPOSICION + 1)))
      .where('m.occurred_at', '<', sumarDias(hasta, DIAS_INSTANCIA_REPOSICION + 2))
      .whereRaw(`${sqlDisponibleCaos('m')} > 0.005`);
    if (conCustodia) q.whereRaw(`NOT ${sqlCustodiaCerrada('m')}`);
    return q
      .orderBy([{ column: 'm.occurred_at', order: 'asc' }, { column: 'm.external_id', order: 'asc' }])
      .select('m.device', 'm.external_id', 'm.occurred_at', 'm.ref',
        k.raw('abs(m.total) AS total'), k.raw(`${sqlDisponibleCaos('m')} AS libre`),
        // Las sucursales cuyos egresos ya explica el retiro: la segunda forma de afinidad.
        k.raw(`ARRAY(SELECT DISTINCT split_part(cl.origen_ref, '|', 1) FROM finance.caos_cash_links kv
            JOIN finance.cash_ledger cl ON cl.id = kv.cash_ledger_id AND cl.deleted_at IS NULL
           WHERE kv.tenant_id = m.tenant_id AND kv.caos_device = m.device AND kv.caos_external_id = m.external_id
             AND kv.deleted_at IS NULL AND cl.origen_ref ~ '^0[0-9][|]') AS sucursales_vinculadas`));
  },
};

// ── `[CGA-A.62]` ¿Se aprobó antes de pagarse? Las tres lecturas de la cadena ──────────────────

export type PagoHoraCrudo = { sucursal: string; folio: string; pagado_at: string | Date };
export type SolicitudCruda = { sucursal: string; folio: string; importe: string | number; beneficiario: string | null;
  estado: string | null; capturado_at: string | Date | null; fecha: string | null };
export type ValeCrudo = { id: string; sucursal: string | null; folio_solicitud: string | null; status: string;
  created_at: string | Date; aprobado_at: string | Date | null; aprobado_por: string | null;
  validated_at: string | Date | null; validated_by: string | null; evidencia_at: string | Date | null };

/** Hora local de Kepler (`c68` fecha + `c69` texto) → instante en México. Sin hora válida: fin del día. */
const HORA_KEPLER = (t: string) => `((${t}.c68::date + CASE WHEN btrim(coalesce(${t}.c69::text, '')) ~ '^[0-9]{1,2}:[0-9]{2}(:[0-9]{2}){0,1}$'
    THEN btrim(${t}.c69::text)::time ELSE '23:59:59'::time END) AT TIME ZONE 'America/Mexico_City')`;

export const consultasAprobacion = {
  /**
   * La HORA de cada pago X-D-26 de sucursal: `bank_movement_legs` sólo guarda el día de captura.
   * Por `ix_kdm1_captura` (`c68::date`): sólo los días que trae la ventana. Medido 2026-10-28:
   * 0 de 3,745 X-D desde el 1-oct con `c69` fuera de formato; la guarda queda por si acaso, y
   * entonces se toma el fin del día (benigno: nunca inventa una firma DESPUÉS del pago).
   */
  pagosHora(k: Knex, diasCaptura: string[]): Knex.QueryBuilder {
    const dias = diasCaptura.length ? diasCaptura : ['1900-01-01'];
    return k('kepler_ods.kdm1 as d')
      // `IN (?, ?, …)` y no `= ANY(?)`: así el SQL que imprime la sonda es el mismo que corre.
      .whereRaw(`d.c68::date IN (${dias.map(() => '?').join(', ')})`, dias)
      .where('d.c2', 'X').where('d.c3', 'D').where('d.c4', 26)
      .whereRaw(`btrim(d.c45) = '0011'`)
      .whereNotIn('d.sucursal', [...SUCURSALES_SIN_REPOSICION])
      .select('d.sucursal', k.raw('btrim(d.c6) AS folio'), k.raw(`${HORA_KEPLER('d')} AS pagado_at`));
  },

  /** Las solicitudes X-A-15-1 de la vista canónica (`analytics.expense_requests`), 45 días antes. */
  solicitudes(k: Knex, tenantId: string, desde: string, hasta: string, sucursales: string[]): Knex.QueryBuilder {
    return k('analytics.expense_requests as r')
      .where('r.tenant_id', tenantId)
      .whereBetween('r.fecha', [sumarDias(desde, -45), sumarDias(hasta, 31)])
      .whereIn('r.sucursal', sucursales.length ? sucursales : ['--'])
      .select('r.sucursal', 'r.folio', 'r.importe', 'r.beneficiario', 'r.estado',
        k.raw(`(r.capturado_at AT TIME ZONE 'America/Mexico_City') AS capturado_at`),
        k.raw(`to_char(r.fecha, 'YYYY-MM-DD') AS fecha`));
  },

  /** Los vales de esas solicitudes. `conFirma`: si la columna de `[CGA-A.62]` ya existe. */
  vales(k: Knex, tenantId: string, sucursales: string[], folios: string[], conFirma: boolean): Knex.QueryBuilder {
    return k('finance.expense_proofs as v')
      .where('v.tenant_id', tenantId)
      .whereIn('v.sucursal', sucursales.length ? sucursales : ['--'])
      .whereIn('v.folio_solicitud', folios.length ? folios : ['--'])
      .select('v.id', 'v.sucursal', 'v.folio_solicitud', 'v.status', 'v.created_at',
        conFirma ? 'v.aprobado_at' : k.raw('NULL::timestamptz AS aprobado_at'),
        conFirma ? 'v.aprobado_por' : k.raw('NULL::text AS aprobado_por'),
        'v.validated_at', 'v.validated_by', 'v.evidencia_at');
  },
};

const iso = (v: string | Date | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

/**
 * Los pagos de la ventana con su HORA, y el juicio de aprobación de cada uno. Un documento sin
 * hora en Kepler toma el fin de su día de captura (benigno, ver `pagosHora`).
 */
export function aprobacionesDeCrudos(docs: DocCrudo[], horas: PagoHoraCrudo[], solicitudes: SolicitudCruda[], vales: ValeCrudo[]) {
  const hora = new Map(horas.map((h) => [`${h.sucursal}|${h.folio}`, iso(h.pagado_at)]));
  const pagos: PagoParaAprobar[] = docs.map((d) => ({
    clave: d.origen_ref, sucursal: d.sucursal, importe: Number(d.monto), beneficiario: d.beneficiario,
    fecha_pago: String(d.fecha_valor ?? d.fecha_captura ?? ''),
    pagado_at: hora.get(`${d.sucursal}|${d.folio}`)
      ?? new Date(`${d.fecha_captura ?? d.fecha_valor}T23:59:59-06:00`).toISOString(),
  }));
  return aprobacionDePagos(
    pagos,
    solicitudes.map((s) => ({ sucursal: s.sucursal, folio: s.folio, importe: Number(s.importe), beneficiario: s.beneficiario,
      estado: s.estado, capturado_at: iso(s.capturado_at), fecha: s.fecha })),
    vales.map((v) => ({ id: v.id, sucursal: v.sucursal, folio_solicitud: v.folio_solicitud, status: v.status,
      created_at: iso(v.created_at) as string, aprobado_at: iso(v.aprobado_at), aprobado_por: v.aprobado_por,
      validated_at: iso(v.validated_at), validated_by: v.validated_by, evidencia_at: iso(v.evidencia_at) })),
  );
}

/** Lo crudo de la base, ya convertido, para el motor. */
export function entradaDeCrudos(desde: string, hasta: string, docs: DocCrudo[], egresos: EgresoCrudo[], vinculos: VinculoCrudo[], retiros: RetiroCrudo[]) {
  return {
    desde, hasta,
    docs: docs.map((d) => ({ ...d, monto: Number(d.monto) })),
    egresos: egresos.map((g) => ({ ...g, monto: Number(g.monto) })),
    vinculos: vinculos.map((v) => ({ ...v, external_id: Number(v.external_id), monto: Number(v.monto) })),
    retiros: retiros.map((r): RetiroLibre => ({
      device: r.device, external_id: Number(r.external_id),
      occurred_at: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
      ref: r.ref, total: Number(r.total), libre: Number(r.libre), sucursales_vinculadas: r.sucursales_vinculadas ?? [],
    })),
  };
}
