import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { type SucursalVerificador } from '@megadulces/contracts';
import { lecturaDeSucursales, type LecturaSucursal } from '@megadulces/commercial';
import { pgRaw } from './pg-raw.util';

/** `[VAC.L1]` Una sola definición: el contrato que también consume la pantalla. */
export type Sucursal = SucursalVerificador;

const TENANT = process.env.MEGA_DULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

@Injectable()
export class SucursalesService {
  private readonly logger = new Logger(SucursalesService.name);

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
                FROM kepler_ods.kdik k WHERE k.sucursal = s.sucursal) AS almacenes
      FROM kepler_ods.kdms s
      ORDER BY s.sucursal
    `);
    const frescura = await this.frescuraPorSucursal(rows.map((r) => String(r.codigo ?? '').trim()));
    return rows.map(r => ({
      codigo:    r.codigo,
      nombre:    r.nombre || `Sucursal ${r.codigo}`,
      direccion: r.direccion || '',
      ciudad:    r.ciudad || '',
      almacenes: (r.almacenes || []).sort(),
      datos_al:  SucursalesService.iso(frescura.get(String(r.codigo ?? '').trim())?.checked_at),
    }));
  }

  /**
   * `[VAC.D4]` De cuándo son los precios de cada sucursal: la última vez que el carril
   * `ods_live_hot` REVISÓ esa sucursal contra el ERP (`analytics.ods_branch_checks`).
   *
   * Hasta el 2026-11-19 se leía `analytics.cron_runs.job_key = 'cdc_wal_NN'`, un latido que nadie
   * escribe (medido ese día en prod: **0 filas**), así que la pantalla decía «Frescura del ERP sin
   * medir» desde septiembre. Lo que sí existe, medido el mismo día:
   *  · el carril `ods_live_hot` lleva `kdii` (los precios) del ERP al ODS — `KP_ODS_TABLES` y
   *    `ODS_HASH_TABLES` en `ops/k3s/20-ods-live-hot.deployment.yaml`;
   *  · el shipper escribe `ods_branch_checks` al cerrar la pasada de CADA sucursal, haya o no
   *    cambios (`database/importers/kepler/replicate-ods-live.js`), y si la pasada falla conserva
   *    la última buena: las 9 sucursales tenían su revisión de hace menos de 1 minuto, sin error.
   * Es la misma fuente que ya usan la existencia del vendedor (MCP.3.16) y Cortes, por el mismo
   * lector (`lecturaDeSucursales`). «Revisada» y no «le llegó algo»: una tienda que no cambió
   * precios en tres días sigue al día, y la marca de lo empujado diría lo contrario.
   *
   * Se devuelve `checked_at` aunque la lectura ya no esté al día: la pantalla calcula la edad y la
   * declara. Sin fila o con la consulta caída → `null`, que la pantalla dice «sin medir».
   */
  private async frescuraPorSucursal(codigos: string[]): Promise<Map<string, LecturaSucursal>> {
    const sucursales = [...new Set(codigos.filter(Boolean))].map((c) => ({ id: c, code: c }));
    if (!sucursales.length) return new Map();
    try {
      // RLS: el lector filtra por `current_tenant_id()`, y este endpoint es `@Public()`.
      return await this.db.transaction(async (trx) => {
        await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
        return lecturaDeSucursales(trx, sucursales);
      });
    } catch (e: unknown) {
      this.logger.warn(`frescura por sucursal no se pudo leer: ${e instanceof Error ? e.message : String(e)}`);
      return new Map();
    }
  }
}
