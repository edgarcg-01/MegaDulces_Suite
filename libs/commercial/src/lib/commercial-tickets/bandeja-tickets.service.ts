import { BadRequestException, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, todayMx } from '@megadulces/platform-core';
import type { TicketCandidato, TicketOrigen } from './commercial-tickets.service';

/**
 * Fase TK.12 — **Bandeja de tickets**: la pantalla deja de exigir un folio para mostrar algo.
 *
 * Hasta TK.9 la única entrada era teclear un folio. Ahora se elige sucursal + rango de fechas
 * (+ cliente, opcional) y la bandeja lista lo que existe; el buscador de la bandeja afina por
 * folio, clave de cliente o nombre. Mismos tres universos que `buscar()` y la misma fila
 * (`TicketCandidato`), para que el panel de detalle no se entere de por dónde llegó el `id`.
 *
 * ── ⚠️ SIN `ORDER BY` EN LAS CONSULTAS AL ERP, Y POR ESO EL TOPE SE DECLARA ──────────────
 * Es la misma decisión que `buscar()` (ver `LIMITE_POR_UNIVERSO` allá): sobre la vista de
 * facturas, un `ORDER BY … LIMIT` por RANGO DE FECHAS se midió en **23,856 ms** contra **970 ms**
 * sin él. Se ordena en JS. La consecuencia es honesta sólo si se DICE: cuando un universo llega
 * al tope, lo que se devuelve es un subconjunto del rango **que ni siquiera se puede afirmar que
 * sean los más recientes** → `truncado: true` + aviso para acortar el rango o buscar.
 *
 * ── MEDIDO CONTRA PROD (revisión de Edgar en el PR #193, 2026-09-30, sólo lectura) ─────────
 * Tiempo, con el tope viejo de 1,000:
 *
 *     mostrador  1 día   37 ms  ·  7 días  31 ms  ·  31 días  39 ms
 *     facturas   1 día    7 ms  ·  7 días  38 ms  ·  31 días  42 ms
 *
 * La velocidad no era el problema; el TOPE sí. Mostrador: 82,456 documentos en 31 días y 8
 * plazas = **2,660/día**, y el día más cargado (26-sep) **4,038**. Con 1,000, el filtro POR
 * DEFECTO (hoy, todas las plazas) ya salía truncado, mostrando ~25% del día: el aviso salía casi
 * siempre, y un aviso que sale siempre deja de leerse. El mismo día de 4,038 documentos:
 *
 *     limit 1,001    41 ms   (25% del día)
 *     limit 3,001   104 ms
 *     limit 6,001   153 ms   (el día ENTERO)
 *
 * Por eso el tope es 5,000: entra un día completo de la red con margen, a ~150 ms (el gate es
 * 1 s). El aviso de `truncado` queda para lo que de verdad no cabe: rangos de varios días sin
 * elegir sucursal ni buscar.
 */

/** Filas que se piden POR UNIVERSO. Medido: el día más cargado de la red son 4,038 en mostrador. */
const LIMITE_POR_UNIVERSO = 5000;
/** Rango máximo. Más que esto no es una bandeja, es un reporte (y la vista de facturas lo sufre). */
const MAX_DIAS = 31;

const ORIGEN_LABEL: Record<TicketOrigen, string> = {
  mostrador: 'Ticket de mostrador',
  telemarketing: 'Factura de telemarketing',
  credito: 'Venta a crédito',
  pedido: 'Pedido de la plataforma',
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** `%` y `_` son comodines de LIKE: lo tecleado se escapa y se declara el ESCAPE al usarlo. */
const escLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface BandejaFiltros {
  from?: string;
  to?: string;
  /** Clave de cliente EXACTA (la global de Kepler, o el `code` de `commercial.customers`). */
  cliente?: string;
  /** Texto libre: folio (contiene), clave de cliente (empieza con) o nombre (contiene, sin acentos). */
  q?: string;
}

export interface BandejaFila extends TicketCandidato {
  cliente_code: string | null;
}

export interface BandejaTickets {
  desde: string;
  hasta: string;
  filas: BandejaFila[];
  /** true ⇒ algún universo llegó al tope: la lista está incompleta y su orden no es garantía. */
  truncado: boolean;
  resumen: { documentos: number; importe: number };
  /** Lo que los filtros no dicen por sí solos. `null` = nada que declarar. */
  aviso: string | null;
}

@Injectable()
export class BandejaTicketsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Normaliza y valida el rango. Sin fechas = hoy (en MX, no el día UTC del servidor). */
  rango(f: BandejaFiltros): { desde: string; hasta: string } {
    const hoy = todayMx();
    const desde = f.from || f.to || hoy;
    const hasta = f.to || f.from || hoy;
    if (!ISO.test(desde) || !ISO.test(hasta)) {
      throw new BadRequestException('Las fechas van como AAAA-MM-DD.');
    }
    if (desde > hasta) throw new BadRequestException('La fecha inicial es posterior a la final.');
    const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / 864e5) + 1;
    if (dias > MAX_DIAS) {
      throw new BadRequestException(`El rango máximo es de ${MAX_DIAS} días (pediste ${dias}).`);
    }
    return { desde, hasta };
  }

  async listar(f: BandejaFiltros, alcance: string[] | null): Promise<BandejaTickets> {
    const tenantId = this.tenantCtx.requireTenantId();
    const { desde, hasta } = this.rango(f);
    const cliente = (f.cliente || '').trim() || null;
    const q = (f.q || '').trim() || null;

    return this.tk.run(async (trx) => {
      let topado = false;
      const filas: BandejaFila[] = [];

      /** El buscador libre: folio contiene · clave empieza con · nombre contiene sin acentos. */
      const texto = (qb: Knex.QueryBuilder, folio: string, code: string, nombre: string) => {
        if (!q) return;
        const like = `%${escLike(q)}%`;
        qb.where((b) => {
          b.whereRaw(`${folio} ILIKE ? ESCAPE '\\'`, [like])
            .orWhereRaw(`${code} ILIKE ? ESCAPE '\\'`, [`${escLike(q)}%`])
            .orWhereRaw(`unaccent(${nombre}) ILIKE unaccent(?) ESCAPE '\\'`, [like]);
        });
      };

      // ── Mostrador (U-D-10) ─────────────────────────────────────────────────────────────
      const mos = trx('analytics.erp_sale_tickets as t')
        .where('t.tenant_id', tenantId)
        .whereBetween('t.fecha', [desde, hasta])
        .select('t.folio_digital as id', 't.sucursal', 't.warehouse_name as sucursal_nombre',
          't.caja', 't.folio', trx.raw(`to_char(t.fecha,'YYYY-MM-DD') as fecha`),
          't.cliente_code', 't.cliente_nombre', 't.total')
        .limit(LIMITE_POR_UNIVERSO + 1);
      // `[]` ⇒ knex emite `1 = 0`: quien no alcanza ninguna sucursal ve cero filas, nunca todas.
      if (alcance) mos.whereIn('t.sucursal', alcance);
      if (cliente) mos.where('t.cliente_code', cliente);
      texto(mos, 't.folio', 't.cliente_code', 't.cliente_nombre');
      const fm = await mos;
      if (fm.length > LIMITE_POR_UNIVERSO) topado = true;
      for (const r of fm.slice(0, LIMITE_POR_UNIVERSO)) {
        filas.push({ ...r, origen: 'mostrador', origen_label: ORIGEN_LABEL.mostrador } as BandejaFila);
      }

      // ── Telemarketing y crédito (U-D-8 / U-D-12) ───────────────────────────────────────
      const fac = trx('analytics.erp_sales_invoices as i')
        .where('i.tenant_id', tenantId)
        .whereBetween('i.fecha', [desde, hasta])
        .select('i.folio_digital as id', 'i.sucursal', 'i.doc_tipo', 'i.folio',
          trx.raw(`to_char(i.fecha,'YYYY-MM-DD') as fecha`),
          'i.cliente_code', 'i.cliente_nombre', 'i.total')
        .limit(LIMITE_POR_UNIVERSO + 1);
      if (alcance) fac.whereIn('i.sucursal', alcance);
      if (cliente) fac.where('i.cliente_code', cliente);
      texto(fac, 'i.folio', 'i.cliente_code', 'i.cliente_nombre');

      // ⚠️ El nombre de la plaza NO sale de la vista de facturas (sólo trae `warehouse_id`).
      const plazas = new Map<string, string>(
        (await trx('commercial.warehouses').where({ tenant_id: tenantId }).whereNull('deleted_at')
          .select('code', 'name')).map((w) => [String(w.code), String(w.name)]),
      );
      const ff = await fac;
      if (ff.length > LIMITE_POR_UNIVERSO) topado = true;
      for (const r of ff.slice(0, LIMITE_POR_UNIVERSO)) {
        const origen: TicketOrigen = r.doc_tipo === 'credito' ? 'credito' : 'telemarketing';
        filas.push({
          id: r.id, origen, origen_label: ORIGEN_LABEL[origen],
          sucursal: r.sucursal, sucursal_nombre: plazas.get(String(r.sucursal)) ?? null, caja: null,
          folio: r.folio, fecha: r.fecha, cliente_code: r.cliente_code ?? null,
          cliente_nombre: r.cliente_nombre, total: r.total,
        });
      }

      // ── Pedidos de la plataforma (PD-…) ────────────────────────────────────────────────
      // Tabla propia y chica: acá el ORDER BY sí se queda (mismo criterio que `buscar()`).
      const pd = trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', function () {
          this.on('c.tenant_id', '=', 'o.tenant_id').andOn('c.id', '=', 'o.customer_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'o.tenant_id').andOn('w.id', '=', 'o.warehouse_id');
        })
        .where('o.tenant_id', tenantId)
        .whereNull('o.deleted_at')
        // El día del pedido es el día MX, no el UTC en que quedó grabado el timestamptz.
        .whereRaw(`(o.created_at AT TIME ZONE 'America/Mexico_City')::date BETWEEN ?::date AND ?::date`, [desde, hasta])
        .select('o.code as id', 'w.code as sucursal', 'w.name as sucursal_nombre', 'o.code as folio',
          trx.raw(`to_char((o.created_at AT TIME ZONE 'America/Mexico_City')::date,'YYYY-MM-DD') as fecha`),
          'c.code as cliente_code', 'c.name as cliente_nombre', 'o.total')
        .orderBy('o.created_at', 'desc')
        .limit(LIMITE_POR_UNIVERSO + 1);
      if (alcance) pd.whereIn('w.code', alcance);
      if (cliente) pd.where('c.code', cliente);
      texto(pd, 'o.code', 'c.code', 'c.name');
      const fp = await pd;
      if (fp.length > LIMITE_POR_UNIVERSO) topado = true;
      for (const r of fp.slice(0, LIMITE_POR_UNIVERSO)) {
        filas.push({ ...r, caja: null, origen: 'pedido', origen_label: ORIGEN_LABEL.pedido } as BandejaFila);
      }

      // Lo más reciente primero; el `id` desempata para que la misma consulta liste igual dos
      // veces (sin ORDER BY en SQL, el planner no fija ningún orden).
      filas.sort((a, b) => String(b.fecha ?? '').localeCompare(String(a.fecha ?? ''))
        || String(b.id).localeCompare(String(a.id)));

      const importe = r2(filas.reduce((s, x) => s + (Number(x.total) || 0), 0));
      const partes: string[] = [];
      if (topado) {
        partes.push(`Hay más de ${LIMITE_POR_UNIVERSO.toLocaleString('es-MX')} documentos con estos filtros: `
          + 'la lista está incompleta y no necesariamente trae los más recientes. Acorta el rango, elige una sucursal o busca.');
      }
      if (!filas.length) partes.push('Sin documentos con estos filtros.');

      return {
        desde, hasta, filas, truncado: topado,
        resumen: { documentos: filas.length, importe },
        aviso: partes.length ? partes.join(' ') : null,
      };
    });
  }
}
