import { Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

export interface CfdiListFilters {
  from?: string; to?: string;
  emisor_rfc?: string; receptor_rfc?: string;
  tipo?: string; metodo_pago?: string; rol?: string;
  estatus_sat?: string; search?: string;
  limit?: number; offset?: number;
}

/** FISCAL.4.2 — Lectura del almacén fiscal.cfdis (tenant-scoped por RLS). */
@Injectable()
export class CfdiService {
  constructor(private readonly tk: TenantKnexService) {}

  async list(f: CfdiListFilters) {
    const limit = Math.min(Number(f.limit) || 50, 500);
    const offset = Number(f.offset) || 0;
    return this.tk.run(async (trx) => {
      const q = trx('fiscal.cfdis').modify((b) => this.applyFilters(b, f));
      const [{ count }] = await q.clone().count<{ count: string }[]>('* as count');
      const rows = await q
        .select(
          'id', 'uuid', 'tipo_comprobante', 'serie', 'folio', 'fecha', 'emisor_rfc', 'emisor_nombre',
          'receptor_rfc', 'receptor_nombre', 'total', 'moneda', 'metodo_pago', 'forma_pago',
          'rol', 'estatus_sat',
        )
        .orderBy('fecha', 'desc').limit(limit).offset(offset);
      return { total: Number(count), limit, offset, rows };
    });
  }

  async get(id: string) {
    return this.tk.run(async (trx) =>
      trx('fiscal.cfdis').where({ id }).orWhere({ uuid: id.toUpperCase() }).first());
  }

  /** Resumen: conteo/monto por tipo de comprobante + método de pago, en el rango. */
  async stats(f: CfdiListFilters) {
    return this.tk.run(async (trx) => {
      const base = () => trx('fiscal.cfdis').modify((b) => this.applyFilters(b, f));
      const porTipo = await base()
        .select('tipo_comprobante').count('* as n').sum('total as total')
        .groupBy('tipo_comprobante');
      const porMetodo = await base()
        .select('metodo_pago').count('* as n').sum('total as total')
        .groupBy('metodo_pago');
      const totRows = await base().count('* as n').sum('total as total').sum('total_trasladados as iva');
      const tot: any = (totRows as any[])[0] ?? {};
      return { total: Number(tot.n ?? 0), monto: Number(tot.total ?? 0), iva: Number(tot.iva ?? 0), porTipo, porMetodo };
    });
  }

  private applyFilters(b: any, f: CfdiListFilters) {
    if (f.from) b.where('fecha', '>=', f.from);
    if (f.to) b.where('fecha', '<=', `${f.to} 23:59:59`);
    if (f.emisor_rfc) b.where('emisor_rfc', f.emisor_rfc.toUpperCase());
    if (f.receptor_rfc) b.where('receptor_rfc', f.receptor_rfc.toUpperCase());
    if (f.tipo) b.where('tipo_comprobante', f.tipo);
    if (f.metodo_pago) b.where('metodo_pago', f.metodo_pago);
    if (f.rol) b.where('rol', f.rol);
    if (f.estatus_sat) b.where('estatus_sat', f.estatus_sat);
    if (f.search) {
      const s = `%${f.search}%`;
      b.where((w: any) => w.whereILike('emisor_nombre', s).orWhereILike('receptor_nombre', s).orWhereILike('uuid', s).orWhereILike('folio', s));
    }
  }
}
