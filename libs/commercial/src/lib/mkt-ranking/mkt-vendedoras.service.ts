import { Injectable, BadRequestException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ScopeService, todayMx } from '@megadulces/platform-core';
import { sumarDias } from './mkt-ranking.logic';

/**
 * `[MKT.18]` — Quién vendió cada ticket con promoción en el mostrador. La cajera lo escribe desde su
 * arqueo; el ranking lo agrega «por vendedora».
 *
 * ── Lo que pone cada quien ────────────────────────────────────────────────────────────────────
 *  · KEPLER: el ticket, sus promociones y cantidades (`analytics.v_kepler_sales_lines`) y su turno:
 *    `kdm1.c80` = apertura = `kdpv_folio_caja.c3`. Medido en prod (semana 45): 543 de 543 tickets
 *    con promoción empatan con su turno. La cajera NO teclea ni promos ni cantidades.
 *  · RH: la lista de personas = quien checó en el reloj de esa sucursal en los últimos 30 días
 *    (`hr.attendance_logs` → `device_enrollments`). `hr.employees` está vacía (0 filas, 2026-11-11)
 *    y casi nadie tiene puesto (12 de 823 ligados a usuario): por eso la lista trae a todos.
 *  · LA CAJERA: sólo QUIÉN. Se guarda la clave del reloj y el nombre de ese momento.
 *
 * Alcance: la cajera ve los tickets de SUS turnos (`kdpv_folio_caja.c8` = su usuario, como el
 * arqueo); quien supervisa (`verTodo`) ve los de la sucursal. La escritura se valida contra el
 * alcance de sucursal (`ScopeService.assertCanWrite`) y cada ticket se vuelve a buscar en Kepler:
 * no se guarda un ticket que no existe, ni de otro turno, ni una persona que no está en la lista.
 */

export interface PersonaVendedora { code: string; nombre: string; promotora: boolean }

export interface PromoDeTicket { code: string; mecanica: string; cantidad: number }

export interface TicketConPromo {
  doc_tipo: number;
  caja: string;
  folio: string;
  business_date: string;
  turno_apertura: string | null;
  cajero: string | null;
  total: number;
  promos: PromoDeTicket[];
  vendedora: { code: string; nombre: string } | null;
}

export interface TicketsDeTurnos {
  sucursal: string;
  dias: number;
  ve_toda_la_sucursal: boolean;
  tickets: TicketConPromo[];
  personas: PersonaVendedora[];
  asignados: number;
  consultado_at: string;
}

export interface AsignacionDto { doc_tipo: number; caja: string; folio: string; person_code: string | null }

/** Un usuario sin clave no es la cajera de ningún turno: no ve ningún ticket (y no se confunde con «ver todo»). */
const SIN_USUARIO = '#sin-usuario#';
const DIAS_DEFAULT = 7;
const DIAS_TOPE = 30;
const n = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const ymd = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10));
const llave = (t: { doc_tipo: number | string; caja: string; folio: string }) => `${Number(t.doc_tipo)}|${String(t.caja).trim()}|${String(t.folio).trim()}`;

@Injectable()
export class MktVendedorasService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  /** La sucursal pedida (validada contra el alcance de ESCRITURA) o la única que tiene asignada. */
  async resolverSucursal(pedida: string | undefined): Promise<string> {
    const code = String(pedida ?? '').trim();
    if (code) {
      if (!/^\d{2}$/.test(code)) throw new BadRequestException('Sucursal inválida');
      await this.scope.assertCanWrite('warehouse', code);
      return code;
    }
    const dim = (await this.scope.current()).dims.warehouse;
    if (dim.modeWrite !== 'all' && dim.valuesWrite.length === 1) return dim.valuesWrite[0];
    throw new BadRequestException(dim.valuesWrite.length > 1
      ? `Elige la sucursal: tienes ${dim.valuesWrite.length} asignadas.`
      : 'Tu usuario no tiene sucursal asignada.');
  }

  /** Personas que checaron en el reloj de la sucursal en los últimos 30 días, con su nombre del reloj. */
  private async personas(trx: Knex.Transaction, sucursal: string): Promise<PersonaVendedora[]> {
    const r = await trx.raw(
      `WITH a AS (
         SELECT DISTINCT ad.device_id, ad.device_user_id, d.site_code
           FROM hr.attendance_logs ad
           JOIN hr.attendance_devices d ON d.id = ad.device_id
           JOIN hr.attendance_sites s ON s.code = d.site_code AND s.warehouse_code = ?
          -- Las checadas crudas (attendance_days es una vista sobre éstas que calcula la fecha de cada una).
          WHERE ad.punched_at >= (?::date - 30)
       )
       SELECT DISTINCT ON (code) code, nombre, promotora FROM (
         SELECT COALESCE(NULLIF(btrim(e.person_code), ''), btrim(e.device_user_id)) code,
                btrim(e.device_name) nombre, COALESCE(psp.is_promoter, false) promotora, psp.is_active
           FROM a
           JOIN hr.device_enrollments e ON e.device_id = a.device_id AND e.device_user_id = a.device_user_id
           LEFT JOIN hr.person_site_profiles psp
             ON psp.site_code = a.site_code AND psp.person_code = COALESCE(NULLIF(btrim(e.person_code), ''), btrim(e.device_user_id))
          WHERE NULLIF(btrim(e.device_name), '') IS NOT NULL AND e.match_status <> 'ignorado'
       ) x
       -- Quien se mudó de plaza tiene su ficha de esta en baja: no se ofrece.
       WHERE is_active IS DISTINCT FROM false
       ORDER BY code, nombre`,
      [sucursal, todayMx()]);
    return (r.rows as Array<{ code: string; nombre: string; promotora: boolean }>)
      .map((p) => ({ code: p.code, nombre: p.nombre, promotora: p.promotora === true }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  /**
   * Los tickets de mostrador con una promoción DADA DE ALTA (vigente ese día, canal mostrador, esa
   * sucursal), con su turno; sólo los de los turnos de `cajero` salvo que vea toda la sucursal.
   */
  private async ticketsConPromo(trx: Knex.Transaction, sucursal: string, desde: string, hasta: string, cajero: string | null): Promise<TicketConPromo[]> {
    const r = await trx.raw(
      `WITH pr AS (
         SELECT code, mecanica, vigencia_desde, vigencia_hasta FROM commercial.mkt_ranking_promos
          WHERE deleted_at IS NULL AND activo AND 'mostrador' = ANY(canales)
            AND (warehouse_codes IS NULL OR ? = ANY(warehouse_codes))
            AND vigencia_desde <= ? AND (vigencia_hasta IS NULL OR vigencia_hasta >= ?)
       ),
       l AS (
         SELECT l.doc_tipo, l.caja, l.folio, l.business_date, l.total_documento, l.sku, sum(l.qty) qty
           FROM analytics.v_kepler_sales_lines l
          WHERE l.warehouse_code = ? AND l.canal = 'mostrador' AND l.business_date BETWEEN ? AND ?
            AND l.sku IN (SELECT code FROM pr)
          GROUP BY 1, 2, 3, 4, 5, 6
       )
       SELECT l.doc_tipo, l.caja, l.folio, l.business_date, l.total_documento, l.sku, l.qty,
              (SELECT p.mecanica FROM pr p WHERE p.code = l.sku AND l.business_date BETWEEN p.vigencia_desde AND COALESCE(p.vigencia_hasta, l.business_date)
                ORDER BY p.vigencia_desde DESC LIMIT 1) mecanica,
              NULLIF(ltrim(btrim(h.c80::text), '0'), '') apertura,
              NULLIF(btrim(f.c8), '') cajero
         FROM l
         JOIN kepler_ods.kdm1 h
           ON btrim(h.sucursal) = ? AND btrim(h.c1) = ? AND h.c2 = 'U' AND h.c3 = 'D'
          AND h.c4::int = l.doc_tipo AND btrim(h.c5::text) = l.caja AND btrim(h.c6) = l.folio AND h.c9::date = l.business_date
         LEFT JOIN LATERAL (
           SELECT f.c8 FROM kepler_ods.kdpv_folio_caja f
            WHERE f.sucursal = ? AND btrim(f.c1) = ? AND f.c3::bigint::text = NULLIF(ltrim(btrim(h.c80::text), '0'), '')
            ORDER BY f.c5 DESC LIMIT 1
         ) f ON true`,
      [sucursal, hasta, desde, sucursal, desde, hasta, sucursal, sucursal, sucursal, sucursal]);

    const porTicket = new Map<string, TicketConPromo>();
    for (const x of r.rows as Array<Record<string, unknown>>) {
      // Sólo cuenta si la promo estaba vigente ESE día (el código pudo ser otra promo antes).
      if (!x['mecanica']) continue;
      const cajeroTicket = (x['cajero'] as string | null)?.toUpperCase() ?? null;
      if (cajero && cajeroTicket !== cajero) continue;
      const t = { doc_tipo: n(x['doc_tipo']), caja: String(x['caja']).trim(), folio: String(x['folio']).trim() };
      const k = llave(t);
      const actual = porTicket.get(k) ?? {
        ...t, business_date: ymd(x['business_date']), turno_apertura: (x['apertura'] as string) ?? null,
        cajero: cajeroTicket, total: n(x['total_documento']), promos: [], vendedora: null,
      };
      actual.promos.push({ code: String(x['sku']), mecanica: String(x['mecanica']), cantidad: n(x['qty']) });
      porTicket.set(k, actual);
    }
    return [...porTicket.values()].sort((a, b) =>
      b.business_date.localeCompare(a.business_date) || a.caja.localeCompare(b.caja) || b.folio.localeCompare(a.folio));
  }

  /** Lo que ve el arqueo: los tickets con promoción de sus turnos, la lista de personas y lo ya asignado. */
  async tickets(sucursalPedida: string | undefined, diasPedidos: string | undefined, usuario: string | undefined, verTodo: boolean): Promise<TicketsDeTurnos> {
    const sucursal = await this.resolverSucursal(sucursalPedida);
    const d = Number(diasPedidos ?? DIAS_DEFAULT);
    const dias = Math.min(DIAS_TOPE, Math.max(0, Number.isFinite(d) ? Math.floor(d) : DIAS_DEFAULT));
    const cajero = verTodo ? null : (usuario ?? '').trim().toUpperCase() || SIN_USUARIO;
    const hasta = todayMx();
    const desde = sumarDias(hasta, -dias);
    return this.tk.run(async (trx) => {
      const [tickets, personas, asignados] = await Promise.all([
        this.ticketsConPromo(trx, sucursal, desde, hasta, cajero),
        this.personas(trx, sucursal),
        trx('commercial.mkt_promo_ticket_sellers').where({ warehouse_code: sucursal }).whereBetween('business_date', [desde, hasta])
          .select('doc_tipo', 'caja', 'folio', 'person_code', 'person_name'),
      ]);
      const de = new Map((asignados as Array<Record<string, unknown>>).map((a) => [
        llave({ doc_tipo: n(a['doc_tipo']), caja: String(a['caja']), folio: String(a['folio']) }),
        { code: String(a['person_code']), nombre: String(a['person_name']) },
      ]));
      for (const t of tickets) t.vendedora = de.get(llave(t)) ?? null;
      return {
        sucursal, dias, ve_toda_la_sucursal: verTodo, tickets, personas,
        asignados: tickets.filter((t) => t.vendedora).length,
        consultado_at: new Date().toISOString(),
      };
    });
  }

  /**
   * Guarda quién vendió. `person_code: null` quita la asignación. Cada ticket se vuelve a buscar en
   * Kepler dentro del alcance de quien guarda (su turno, o la sucursal si supervisa) y la persona
   * debe estar en la lista del reloj: el nombre lo pone el servidor, no la pantalla.
   */
  async guardar(sucursalPedida: string | undefined, items: AsignacionDto[] | undefined, usuario: { id?: string; username?: string }, verTodo: boolean): Promise<{ guardados: number; quitados: number }> {
    const sucursal = await this.resolverSucursal(sucursalPedida);
    if (!Array.isArray(items) || !items.length) throw new BadRequestException('No hay nada que guardar');
    if (items.length > 500) throw new BadRequestException('Demasiados tickets en una sola captura');
    const tenantId = this.tenantCtx.requireTenantId();
    const cajero = verTodo ? null : (usuario.username ?? '').trim().toUpperCase() || SIN_USUARIO;
    const hasta = todayMx();
    const desde = sumarDias(hasta, -DIAS_TOPE);
    return this.tk.run(async (trx) => {
      const [tickets, personas] = await Promise.all([
        this.ticketsConPromo(trx, sucursal, desde, hasta, cajero),
        this.personas(trx, sucursal),
      ]);
      const ticketDe = new Map(tickets.map((t) => [llave(t), t]));
      const personaDe = new Map(personas.map((p) => [p.code, p]));
      let guardados = 0;
      let quitados = 0;
      for (const it of items) {
        const t = ticketDe.get(llave({ doc_tipo: n(it?.doc_tipo), caja: String(it?.caja ?? ''), folio: String(it?.folio ?? '') }));
        if (!t) throw new BadRequestException(`El ticket ${it?.caja}-${it?.folio} no es de tus turnos con promoción (o ya pasaron ${DIAS_TOPE} días).`);
        const where = { tenant_id: tenantId, warehouse_code: sucursal, doc_tipo: t.doc_tipo, caja: t.caja, folio: t.folio };
        if (it.person_code === null || it.person_code === undefined || String(it.person_code).trim() === '') {
          quitados += await trx('commercial.mkt_promo_ticket_sellers').where(where).del();
          continue;
        }
        const p = personaDe.get(String(it.person_code).trim());
        if (!p) throw new BadRequestException('Esa persona no está en la lista del reloj de esta sucursal');
        await trx('commercial.mkt_promo_ticket_sellers')
          .insert({
            ...where, business_date: t.business_date, turno_apertura: t.turno_apertura,
            person_code: p.code, person_name: p.nombre,
            created_by: usuario.id ?? null, created_by_username: usuario.username ?? null,
            updated_by: usuario.id ?? null, updated_by_username: usuario.username ?? null,
          })
          .onConflict(['tenant_id', 'warehouse_code', 'doc_tipo', 'caja', 'folio'])
          .merge({ person_code: p.code, person_name: p.nombre, updated_by: usuario.id ?? null, updated_by_username: usuario.username ?? null, updated_at: trx.fn.now() });
        guardados++;
      }
      return { guardados, quitados };
    });
  }
}
