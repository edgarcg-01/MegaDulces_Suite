import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/** Misma tolerancia heurística que la conciliación póliza↔CFDI (Kepler no guarda
 *  el UUID → se casa por RFC + importe ± $1 + fecha ± 5 días). */
const TOL_IMPORTE = 1.0;
const VENTANA_DIAS = 5;
/** MAT.1.1 — fallback para operaciones SIN RFC (55% de las compras en Kepler): se
 *  cruza solo por importe + fecha, con ventana más estrecha. Match "débil": lo
 *  valida el humano por nombre (se muestra el beneficiario). */
const VENTANA_DIAS_WEAK = 3;

export interface AssignmentInput {
  cfdi_id: string;
  sucursal: string;
  doc_tipo?: string;
  doc_folio: string;
  note?: string;
}

/**
 * MAT.1 — Asignación CFDI ↔ operación (documento Kepler), confirmada por humano.
 *
 * El motor SUGIERE (heurística RFC+importe+fecha, reusada de la conciliación) y la
 * persona CONFIRMA o DESCARTA (ADR-016: LLM fuera del camino). La asignación
 * confirmada es la evidencia dura de materialidad que consume MAT.3.
 *
 * `fiscal.*` con RLS (tk.run) · `analytics.expense_documents` sin RLS (tenant explícito).
 */
@Injectable()
export class MaterialidadAssignmentsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private assertRfc(rfc: string) {
    if (!/^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(rfc)) throw new BadRequestException('RFC inválido');
  }

  /**
   * Vista de conciliación por proveedor: cada CFDI recibido con su asignación
   * confirmada (si hay) o, si no, la mejor operación sugerida. Excluye del
   * sugeridor las operaciones ya confirmadas a otro CFDI y los pares descartados.
   */
  async reconcile(rfcInput: string) {
    const rfc = (rfcInput || '').trim().toUpperCase();
    this.assertRfc(rfc);
    const tid = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const r = await trx.raw(
        `SELECT c.id AS cfdi_id, c.uuid, c.serie, c.folio, c.fecha, c.total,
                c.tipo_comprobante, c.metodo_pago, c.estatus_sat,
                (c.xml IS NOT NULL) AS has_xml,
                a.id AS assign_id, a.sucursal AS a_sucursal, a.doc_tipo AS a_doc_tipo, a.doc_folio AS a_doc_folio,
                a.importe_operacion AS a_importe, a.diff_importe AS a_diff_importe, a.diff_days AS a_diff_days,
                a.match_source AS a_source, a.created_by_username AS a_by, a.created_at AS a_at,
                a.status AS a_status, a.id AS a_id,
                s.sucursal AS s_sucursal, s.doc_tipo AS s_doc_tipo, s.doc_folio AS s_doc_folio,
                s.importe AS s_importe, s.fecha AS s_fecha, s.diff_importe AS s_diff_importe, s.diff_days AS s_diff_days,
                s.beneficiario AS s_beneficiario, s.strength AS s_strength
           FROM fiscal.cfdis c
           -- [MAT.5] Tambien las PROPUESTAS (status auto), no solo lo confirmado. Si el lote las
           -- escribiera y esta vista siguiera mirando solo confirmed, la pantalla volveria a
           -- sugerir lo mismo que ya esta propuesto y el trabajo del lote seria invisible.
           -- SIN ACENTOS GRAVES EN ESTE COMENTARIO: va dentro de un template literal de JS.
           LEFT JOIN fiscal.cfdi_assignments a ON a.cfdi_id = c.id AND a.status IN ('confirmed', 'auto')
           LEFT JOIN LATERAL (
             SELECT e.sucursal, e.doc_tipo, e.doc_folio, e.importe, e.fecha, e.beneficiario,
                    LEAST(abs(COALESCE(e.importe,0) - COALESCE(c.total,0)),
                          abs(COALESCE(e.importe,0) + COALESCE(e.iva,0) - COALESCE(c.total,0))) AS diff_importe,
                    abs(e.fecha - c.fecha::date) AS diff_days,
                    CASE WHEN UPPER(COALESCE(e.rfc,'')) = UPPER(c.emisor_rfc) THEN 'strong' ELSE 'weak' END AS strength
               FROM analytics.expense_documents e
              WHERE e.tenant_id = :tid AND e.doc_tipo IN ('XA2001','XA1001')
                AND COALESCE(c.total,0) > 0
                AND LEAST(abs(COALESCE(e.importe,0) - COALESCE(c.total,0)),
                          abs(COALESCE(e.importe,0) + COALESCE(e.iva,0) - COALESCE(c.total,0))) <= :tol
                AND (
                  -- fuerte: el documento tiene el RFC del proveedor (ventana normal)
                  ( UPPER(COALESCE(e.rfc,'')) = UPPER(c.emisor_rfc)
                    AND e.fecha BETWEEN (c.fecha::date - (:dias)::int) AND (c.fecha::date + (:dias)::int) )
                  OR
                  -- débil (MAT.1.1): documento SIN RFC → importe+fecha (ventana estrecha) +
                  -- el nombre de la operación debe compartir una palabra (≥4) con el proveedor
                  ( btrim(COALESCE(e.rfc,'')) = ''
                    AND e.fecha BETWEEN (c.fecha::date - (:diasWeak)::int) AND (c.fecha::date + (:diasWeak)::int)
                    AND EXISTS (
                      SELECT 1 FROM regexp_split_to_table(upper(COALESCE(e.beneficiario,'')), '[^A-Z0-9]+') w
                       WHERE length(w) >= 4 AND upper(COALESCE(c.emisor_nombre,'')) LIKE '%' || w || '%'
                    ) )
                )
                AND NOT EXISTS (
                  SELECT 1 FROM fiscal.cfdi_assignments a2
                   WHERE a2.status = 'confirmed' AND a2.sucursal = e.sucursal
                     AND a2.doc_tipo = e.doc_tipo AND a2.doc_folio = e.doc_folio AND a2.cfdi_id <> c.id)
                AND NOT EXISTS (
                  SELECT 1 FROM fiscal.cfdi_assignments a3
                   WHERE a3.status = 'rejected' AND a3.cfdi_id = c.id
                     AND a3.sucursal = e.sucursal AND a3.doc_tipo = e.doc_tipo AND a3.doc_folio = e.doc_folio)
              -- prioriza fuerte sobre débil, luego menor diferencia de importe/fecha
              ORDER BY (CASE WHEN UPPER(COALESCE(e.rfc,'')) = UPPER(c.emisor_rfc) THEN 0 ELSE 1 END) ASC, diff_importe ASC, diff_days ASC
              LIMIT 1
           ) s ON true
          WHERE c.rol = 'recibidas' AND UPPER(c.emisor_rfc) = :rfc AND c.estatus_sat <> 'cancelado'
          ORDER BY c.fecha DESC
          LIMIT 1000`,
        { tid, rfc, tol: TOL_IMPORTE, dias: VENTANA_DIAS, diasWeak: VENTANA_DIAS_WEAK },
      );
      return (r.rows as any[]).map((row) => this.mapRow(row));
    });
  }

  /** Confirma la asignación CFDI↔operación (evidencia). 1:1 en ambos sentidos. */
  async confirm(input: AssignmentInput) {
    const tid = this.tenantCtx.requireTenantId();
    const ctx = this.tenantCtx.get();
    const cfdiId = String(input.cfdi_id || '').trim();
    const sucursal = String(input.sucursal || '').trim();
    const docTipo = String(input.doc_tipo || 'XA2001').trim();
    const docFolio = String(input.doc_folio || '').trim();
    if (!cfdiId || !sucursal || !docFolio) throw new BadRequestException('cfdi_id, sucursal y doc_folio son obligatorios');

    return this.tk.run(async (trx) => {
      const cfdi = await trx('fiscal.cfdis').where({ id: cfdiId }).select('id', 'uuid', 'emisor_rfc', 'total', 'fecha').first();
      if (!cfdi) throw new NotFoundException('CFDI no encontrado');

      const clash = await trx('fiscal.cfdi_assignments')
        .where({ tenant_id: tid, status: 'confirmed', sucursal, doc_tipo: docTipo, doc_folio: docFolio })
        .whereNot('cfdi_id', cfdiId).first();
      if (clash) throw new ConflictException('Esa operación ya está asignada a otro CFDI.');

      const op = await trx('analytics.expense_documents')
        .where({ tenant_id: tid, sucursal, doc_tipo: docTipo, doc_folio: docFolio })
        .select('importe', 'fecha').first();
      const importeCfdi = Number(cfdi.total || 0);
      const importeOp = op ? Number(op.importe || 0) : null;
      const diffImporte = importeOp != null ? Math.abs(importeOp - importeCfdi) : null;
      const diffDays = op?.fecha && cfdi.fecha
        ? Math.abs(Math.round((Date.parse(String(cfdi.fecha)) - Date.parse(String(op.fecha))) / 86400000)) : null;

      // Un confirm reemplaza cualquier estado previo de este CFDI (confirmado o rechazos).
      await trx('fiscal.cfdi_assignments').where({ tenant_id: tid, cfdi_id: cfdiId }).del();
      const [ins] = await trx('fiscal.cfdi_assignments').insert({
        tenant_id: tid, cfdi_id: cfdiId, cfdi_uuid: cfdi.uuid, rfc: String(cfdi.emisor_rfc || '').toUpperCase(),
        sucursal, doc_tipo: docTipo, doc_folio: docFolio,
        importe_cfdi: importeCfdi, importe_operacion: importeOp, diff_importe: diffImporte, diff_days: diffDays,
        status: 'confirmed', match_source: 'importe_fecha', note: input.note || null,
        created_by: ctx?.userId ?? null, created_by_username: ctx?.username ?? null, updated_at: trx.fn.now(),
      }).returning('*');
      return this.mapAssignment(ins);
    });
  }

  /** Descarta un par sugerido para que no vuelva a proponerse (deja rastro). */
  async reject(input: AssignmentInput) {
    const tid = this.tenantCtx.requireTenantId();
    const ctx = this.tenantCtx.get();
    const cfdiId = String(input.cfdi_id || '').trim();
    const sucursal = String(input.sucursal || '').trim();
    const docTipo = String(input.doc_tipo || 'XA2001').trim();
    const docFolio = String(input.doc_folio || '').trim();
    if (!cfdiId || !sucursal || !docFolio) throw new BadRequestException('cfdi_id, sucursal y doc_folio son obligatorios');

    return this.tk.run(async (trx) => {
      const cfdi = await trx('fiscal.cfdis').where({ id: cfdiId }).select('uuid', 'emisor_rfc').first();
      if (!cfdi) throw new NotFoundException('CFDI no encontrado');
      const exists = await trx('fiscal.cfdi_assignments')
        .where({ tenant_id: tid, cfdi_id: cfdiId, status: 'rejected', sucursal, doc_tipo: docTipo, doc_folio: docFolio }).first();
      if (!exists) {
        await trx('fiscal.cfdi_assignments').insert({
          tenant_id: tid, cfdi_id: cfdiId, cfdi_uuid: cfdi.uuid, rfc: String(cfdi.emisor_rfc || '').toUpperCase(),
          sucursal, doc_tipo: docTipo, doc_folio: docFolio,
          status: 'rejected', match_source: 'importe_fecha',
          created_by: ctx?.userId ?? null, created_by_username: ctx?.username ?? null, updated_at: trx.fn.now(),
        });
      }
      return { ok: true };
    });
  }

  /**
   * `[MAT.5]` — **La pasada masiva: propone los pares inequívocos de toda la base, de una vez.**
   *
   * ⛔ **Propone, NO confirma.** Inserta con `status = 'auto'`, que la base distingue del
   * `confirmed` de una persona (mig `20261009153940`). Un cruce por importe y fecha es una pista
   * fuerte, **no la prueba de que la operación existió**, y `MAT.3` consume esta tabla como
   * evidencia de materialidad. Escribirlo como confirmado sería una mentira con consecuencia
   * fiscal.
   *
   * ⭐ **Por qué existe.** `reconcile()` es bueno, pero recibe UN RFC a la vez y pide confirmar
   * factura por factura. Medido el 2026-10-09: **399 proveedores, 14,891 CFDIs recibidos y CERO
   * filas en la tabla** desde que se construyó en julio. Nadie iba a hacerlo a mano nunca. Esto
   * convierte el trabajo de *buscar* los pares en *aprobarlos*.
   *
   * ⚠️ **Sólo el 1:1 estricto.** El CFDI tiene que tener exactamente un candidato **y** la
   * operación no puede estar reclamada por otro CFDI. Medido: de 2,725 pares candidatos, **1,900
   * cumplen las dos condiciones ($99,961,324)**; los otros 825 quedan para la persona, que es
   * exactamente donde su criterio vale algo.
   *
   * ⛔ **Sólo el casamiento FUERTE** (con RFC). El débil de `[MAT.1.1]` —sin RFC, cruzado por
   * nombre— se deja fuera a propósito: proponer en masa un cruce que se apoya en que dos nombres
   * compartan una palabra es sembrar trabajo de revisión, no ahorrarlo.
   *
   * Idempotente: no toca lo ya confirmado, lo ya propuesto ni lo rechazado.
   */
  async autoProponer(opts: { dias?: number; limite?: number } = {}) {
    const tid = this.tenantCtx.requireTenantId();
    const ctx = this.tenantCtx.get();
    const dias = Math.min(1095, Math.max(30, Number(opts.dias) || 365));
    const limite = Math.min(20000, Math.max(1, Number(opts.limite) || 5000));

    return this.tk.run(async (trx) => {
      // ⚠️ La MISMA heurística que `reconcile()`: RFC + importe ±$1 + fecha ±5 d, con el importe
      // comparado contra el total de la operación O contra total+IVA (Kepler guarda las dos formas
      // según el documento). Si fueran dos definiciones, lo que propone el lote y lo que sugiere
      // la pantalla no coincidirían, y nadie sabría cuál creer.
      const r = await trx.raw(
        `WITH c AS (
           SELECT id, uuid, emisor_rfc, fecha::date AS f, total
             FROM fiscal.cfdis
            WHERE rol = 'recibidas' AND tipo_comprobante = 'I' AND estatus_sat <> 'cancelado'
              AND fecha >= CURRENT_DATE - (:dias)::int AND COALESCE(total, 0) > 0
         ), e AS (
           SELECT sucursal, doc_tipo, doc_folio, importe, iva, fecha, rfc
             FROM analytics.expense_documents
            WHERE tenant_id = :tid AND doc_tipo IN ('XA2001', 'XA1001')
              AND fecha >= CURRENT_DATE - ((:dias)::int + 35)
         ), par AS (
           SELECT c.id AS cfdi_id, c.uuid, c.emisor_rfc, c.total,
                  e.sucursal, e.doc_tipo, e.doc_folio, e.importe, e.fecha,
                  LEAST(abs(COALESCE(e.importe,0) - c.total),
                        abs(COALESCE(e.importe,0) + COALESCE(e.iva,0) - c.total)) AS diff_importe,
                  abs(e.fecha - c.f) AS diff_days
             FROM c
             JOIN e ON UPPER(COALESCE(e.rfc,'')) = UPPER(c.emisor_rfc)
                   AND e.fecha BETWEEN c.f - (:tolDias)::int AND c.f + (:tolDias)::int
                   AND LEAST(abs(COALESCE(e.importe,0) - c.total),
                             abs(COALESCE(e.importe,0) + COALESCE(e.iva,0) - c.total)) <= :tol
         ), unico_cfdi AS (SELECT cfdi_id FROM par GROUP BY cfdi_id HAVING count(*) = 1),
            unica_op   AS (SELECT sucursal, doc_tipo, doc_folio FROM par
                            GROUP BY 1,2,3 HAVING count(*) = 1)
         INSERT INTO fiscal.cfdi_assignments
           (tenant_id, cfdi_id, cfdi_uuid, rfc, sucursal, doc_tipo, doc_folio,
            importe_cfdi, importe_operacion, diff_importe, diff_days,
            status, match_source, created_by, created_by_username, updated_at)
         SELECT :tid, p.cfdi_id, p.uuid, UPPER(p.emisor_rfc), p.sucursal, p.doc_tipo, p.doc_folio,
                p.total, p.importe, p.diff_importe, p.diff_days,
                'auto', 'auto_rfc_importe_fecha', :uid, :uname, now()
           FROM par p
           JOIN unico_cfdi uc ON uc.cfdi_id = p.cfdi_id
           JOIN unica_op  uo ON uo.sucursal = p.sucursal AND uo.doc_tipo = p.doc_tipo AND uo.doc_folio = p.doc_folio
          -- Idempotencia: ni este CFDI ni esta operación pueden tener ya una fila viva, y el par
          -- no puede estar rechazado. Los índices únicos de la migración lo vuelven estructural;
          -- esto evita que el lote entero muera por una sola colisión.
          WHERE NOT EXISTS (SELECT 1 FROM fiscal.cfdi_assignments a
                             WHERE a.tenant_id = :tid AND a.cfdi_id = p.cfdi_id
                               AND a.status IN ('confirmed','auto'))
            AND NOT EXISTS (SELECT 1 FROM fiscal.cfdi_assignments a2
                             WHERE a2.tenant_id = :tid AND a2.sucursal = p.sucursal
                               AND a2.doc_tipo = p.doc_tipo AND a2.doc_folio = p.doc_folio
                               AND a2.status IN ('confirmed','auto'))
            AND NOT EXISTS (SELECT 1 FROM fiscal.cfdi_assignments a3
                             WHERE a3.tenant_id = :tid AND a3.cfdi_id = p.cfdi_id AND a3.status = 'rejected'
                               AND a3.sucursal = p.sucursal AND a3.doc_tipo = p.doc_tipo AND a3.doc_folio = p.doc_folio)
          LIMIT :limite
         RETURNING importe_cfdi`,
        { tid, dias, tol: TOL_IMPORTE, tolDias: VENTANA_DIAS, limite, uid: ctx?.userId ?? null, uname: ctx?.username ?? 'sistema' },
      );

      const filas = (r.rows ?? []) as { importe_cfdi: string | number }[];
      const importe = filas.reduce((s, x) => s + (Number(x.importe_cfdi) || 0), 0);

      // ⭐ Y lo que NO se propuso, con su motivo. Sin esto, "1,900 propuestas" se lee como «ya está
      // casado todo lo que se podía», que es falso: quedan 12,991 CFDIs sin candidato siquiera.
      const ctx2 = await trx.raw(
        `WITH c AS (
           SELECT id, emisor_rfc, fecha::date AS f, total FROM fiscal.cfdis
            WHERE rol='recibidas' AND tipo_comprobante='I' AND estatus_sat <> 'cancelado'
              AND fecha >= CURRENT_DATE - (:dias)::int AND COALESCE(total,0) > 0
         ), e AS (
           SELECT sucursal, doc_tipo, doc_folio, importe, iva, fecha, rfc FROM analytics.expense_documents
            WHERE tenant_id = :tid AND doc_tipo IN ('XA2001','XA1001')
              AND fecha >= CURRENT_DATE - ((:dias)::int + 35)
         ), par AS (
           SELECT c.id AS cfdi_id, e.sucursal, e.doc_tipo, e.doc_folio FROM c
             JOIN e ON UPPER(COALESCE(e.rfc,'')) = UPPER(c.emisor_rfc)
                   AND e.fecha BETWEEN c.f - (:tolDias)::int AND c.f + (:tolDias)::int
                   AND LEAST(abs(COALESCE(e.importe,0) - c.total),
                             abs(COALESCE(e.importe,0) + COALESCE(e.iva,0) - c.total)) <= :tol
         )
         SELECT (SELECT count(*) FROM c)                                   AS cfdis,
                (SELECT count(DISTINCT cfdi_id) FROM par)                  AS con_candidato,
                (SELECT count(*) FROM par)                                 AS pares`,
        { tid, dias, tol: TOL_IMPORTE, tolDias: VENTANA_DIAS },
      );
      const m = ctx2.rows[0] ?? {};
      const cfdis = Number(m.cfdis) || 0;
      const conCandidato = Number(m.con_candidato) || 0;

      return {
        propuestas: filas.length,
        importe: Math.round(importe * 100) / 100,
        ventana_dias: dias,
        // El universo, siempre: una cifra de casamiento sin su denominador es propaganda.
        cfdis_en_ventana: cfdis,
        cfdis_con_candidato: conCandidato,
        /** CFDIs que no tienen NI UN candidato fuerte. No es ambigüedad: es ausencia. */
        cfdis_sin_candidato: cfdis - conCandidato,
        /** Pares que existen pero no son 1:1 — quedan para la persona, que es donde sirve. */
        pares_ambiguos: Math.max(0, (Number(m.pares) || 0) - filas.length),
      };
    });
  }

  /**
   * `[MAT.5]` La persona aprueba en lote lo que la máquina propuso: `auto` → `confirmed`.
   *
   * ⭐ Acá es donde el casamiento se vuelve evidencia, y por eso queda su nombre: el `created_by`
   * de la propuesta era el sistema; el de la confirmación es quien la miró.
   */
  async confirmarPropuestas(ids: string[]) {
    const tid = this.tenantCtx.requireTenantId();
    const ctx = this.tenantCtx.get();
    const lista = (ids ?? []).map((x) => String(x || '').trim()).filter(Boolean);
    if (!lista.length) throw new BadRequestException('No se recibió ninguna propuesta que confirmar');

    return this.tk.run(async (trx) => {
      const n = await trx('fiscal.cfdi_assignments')
        .where({ tenant_id: tid, status: 'auto' })
        .whereIn('id', lista)
        .update({
          status: 'confirmed',
          // ⚠️ `match_source` conserva que el par lo encontró la máquina. Quien confirma responde
          // de haberlo mirado, no de haberlo hallado — y dentro de un año esa diferencia importa.
          created_by: ctx?.userId ?? null,
          created_by_username: ctx?.username ?? null,
          updated_at: trx.fn.now(),
        });
      return { confirmadas: n, pedidas: lista.length };
    });
  }

  /** Revierte una asignación confirmada (la borra). */
  async unassign(id: string) {
    const tid = this.tenantCtx.requireTenantId();
    const n = await this.tk.run((trx) => trx('fiscal.cfdi_assignments').where({ tenant_id: tid, id }).del());
    if (!n) throw new NotFoundException('Asignación no encontrada');
    return { deleted: n };
  }

  private mapRow(row: any) {
    const assignment = row.assign_id ? {
      id: row.assign_id, sucursal: row.a_sucursal, doc_tipo: row.a_doc_tipo, doc_folio: row.a_doc_folio,
      importe_operacion: row.a_importe != null ? Number(row.a_importe) : null,
      diff_importe: row.a_diff_importe != null ? Number(row.a_diff_importe) : null,
      diff_days: row.a_diff_days != null ? Number(row.a_diff_days) : null,
      match_source: row.a_source, by: row.a_by, at: row.a_at,
      /**
       * `[MAT.5]` `'confirmed'` = lo miró una persona y ES evidencia. `'auto'` = lo propuso la
       * máquina y TODAVÍA NO lo es. ⛔ Viaja al front para que la pantalla no los pinte igual:
       * una propuesta que se lee como confirmada es exactamente lo que no puede pasar acá.
       */
      status: row.a_status === 'auto' ? 'auto' : 'confirmed',
    } : null;
    const suggestion = (!assignment && row.s_doc_folio) ? {
      sucursal: row.s_sucursal, doc_tipo: row.s_doc_tipo, doc_folio: row.s_doc_folio,
      importe: row.s_importe != null ? Number(row.s_importe) : null, fecha: row.s_fecha,
      diff_importe: row.s_diff_importe != null ? Number(row.s_diff_importe) : null,
      diff_days: row.s_diff_days != null ? Number(row.s_diff_days) : null,
      beneficiario: row.s_beneficiario ?? null,
      strength: row.s_strength === 'weak' ? 'weak' : 'strong',
    } : null;
    return {
      cfdi_id: row.cfdi_id, uuid: row.uuid, serie: row.serie, folio: row.folio, fecha: row.fecha,
      total: Number(row.total || 0), tipo_comprobante: row.tipo_comprobante, metodo_pago: row.metodo_pago,
      estatus_sat: row.estatus_sat, has_xml: !!row.has_xml,
      /**
       * `[MAT.5.1]` ⛔ Acá estaba el agujero que anulaba todo el cuidado de arriba: el estado del
       * RENGLÓN decía `assignment ? 'confirmed' : …`, así que una propuesta de la máquina llegaba
       * a la pantalla como `confirmed` y se pintaba con palomita verde y «Asignada por …».
       *
       * ⚠️ El campo `assignment.status` viajaba bien **y nadie lo miraba**: la pantalla hace
       * `@switch (c.status)` sobre ESTE valor, no sobre el de adentro. Un dato correcto en un
       * campo que el consumidor no lee es indistinguible de no tenerlo.
       *
       * ⭐ Importa ahora y no en abstracto: el lote de MAT.5 todavía no se corrió. Correrlo antes
       * de este arreglo habría metido **1,900 pares por $99,961,324** a una pantalla que los
       * muestra como evidencia fiscal verificada por una persona.
       */
      status: assignment
        ? (assignment.status === 'auto' ? 'auto' : 'confirmed')
        : (suggestion ? 'suggested' : 'unmatched'),
      assignment, suggestion,
    };
  }

  private mapAssignment(a: any) {
    return {
      id: a.id, cfdi_id: a.cfdi_id, cfdi_uuid: a.cfdi_uuid, rfc: a.rfc,
      sucursal: a.sucursal, doc_tipo: a.doc_tipo, doc_folio: a.doc_folio,
      importe_cfdi: a.importe_cfdi != null ? Number(a.importe_cfdi) : null,
      importe_operacion: a.importe_operacion != null ? Number(a.importe_operacion) : null,
      diff_importe: a.diff_importe != null ? Number(a.diff_importe) : null,
      diff_days: a.diff_days != null ? Number(a.diff_days) : null,
      status: a.status, by: a.created_by_username, at: a.created_at,
    };
  }
}
