import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { pgRaw } from './pg-raw.util';

export interface Sucursal {
  codigo:    string;
  nombre:    string;
  direccion: string;
  ciudad:    string;
  almacenes: string[];
  datos_al:  string | null;
}

@Injectable()
export class SucursalesService {
  constructor(@Inject(KNEX_NEW_DB) private readonly db: Knex) {}

  private static iso(v: any): string | null {
    return v ? new Date(v).toISOString() : null;
  }

  async getSucursales(): Promise<Sucursal[]> {
    const rows = await pgRaw<any>(this.db, `
      SELECT s.sucursal      AS codigo,
             TRIM(s.c2)      AS nombre,
             TRIM(s.c4)      AS direccion,
             TRIM(s.c5)      AS ciudad,
             (SELECT ARRAY_AGG(DISTINCT TRIM(k.c1))
                FROM kepler_ods.kdik k WHERE k.sucursal = s.sucursal) AS almacenes,
             -- Frescura por sucursal: latido del consumidor del WAL de esa
             -- sucursal (analytics.cron_runs), no el viejo watermark por tandas.
             (SELECT cr.last_finish FROM analytics.cron_runs cr
               WHERE cr.job_key = 'cdc_wal_' || s.sucursal)   AS datos_al
      FROM kepler_ods.kdms s
      ORDER BY s.sucursal
    `);
    return rows.map(r => ({
      codigo:    r.codigo,
      nombre:    r.nombre || `Sucursal ${r.codigo}`,
      direccion: r.direccion || '',
      ciudad:    r.ciudad || '',
      almacenes: (r.almacenes || []).sort(),
      datos_al:  SucursalesService.iso(r.datos_al),
    }));
  }
}
