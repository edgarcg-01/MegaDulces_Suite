import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { ScopeService, branchKeySql } from '@megadulces/platform-core';

/**
 * `[UB.3]` El almacén de una operación de Ubicaciones, validado UNA vez para todos los servicios
 * del módulo (alta suelta, captura masiva, asignación). Antes cada servicio lo repetía.
 *
 *  · Visible para quien consulta (alcance de LECTURA, `warehouseIds`).
 *  · No es un camión (`RUTA-*`): los camiones no tienen racks.
 *  · Con alcance de ESCRITURA si `escribir` — comparado contra la clave CANÓNICA de la sucursal
 *    (`branchKeySql`), no contra `code`: en Morelia `code` es `MD-30` y la clave es `30`.
 *
 * Fuera de alcance responde igual que "no existe": no se confirma qué tiene otra sucursal.
 */
export interface AlmacenUbicaciones {
  id: string;
  code: string;
  name: string;
  /** Sucursal de Kepler (`kdii.sucursal`); NULL = sólo Wincaja o ruta, sin ficha de Kepler. */
  kepler_code: string | null;
}

export const ES_RUTA = /^RUTA-/i;

export async function almacenDeUbicaciones(
  trx: Knex | Knex.Transaction,
  scope: ScopeService,
  ctx: { visibles: string[] | null; resuelto: Awaited<ReturnType<ScopeService['current']>> },
  warehouseId: string,
  escribir: boolean,
): Promise<AlmacenUbicaciones> {
  if (ctx.visibles !== null && !ctx.visibles.includes(warehouseId)) throw new NotFoundException('Almacén no encontrado.');
  const wh = await trx('commercial.warehouses as w')
    .where('w.id', warehouseId)
    .whereNull('w.deleted_at')
    .first('w.id', 'w.code', 'w.name', 'w.kepler_code', trx.raw(`${branchKeySql('w')} AS clave`));
  if (!wh || ES_RUTA.test(wh.code)) throw new NotFoundException('Almacén no encontrado.');
  if (escribir && !scope.canWrite(ctx.resuelto, 'warehouse', wh.clave)) {
    throw new ForbiddenException(`No puedes cambiar ubicaciones en ${wh.name}.`);
  }
  return { id: wh.id, code: wh.code, name: wh.name, kepler_code: wh.kepler_code ? String(wh.kepler_code).trim() : null };
}

/** El contexto de alcance, que se arma FUERA de `tk.run` (ScopeService abre su propia consulta). */
export async function contextoDeAlcance(scope: ScopeService, ruta: string) {
  const visibles = await scope.warehouseIds({}, ruta, 'almacen');
  const resuelto = await scope.current('almacen');
  return { visibles, resuelto };
}
