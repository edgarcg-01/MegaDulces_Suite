import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SucursalesService } from './sucursales.service';

/**
 * `[VAC.D4]` La frescura que declara el verificador por sucursal sale de la última REVISIÓN del
 * carril `ods_live_hot` (`analytics.ods_branch_checks`), no del latido `cdc_wal_NN`, que nadie
 * escribe (0 filas en prod el 2026-11-19). Doble de Knex: contesta el catálogo de sucursales y la
 * lectura de revisiones; no ejecuta SQL.
 */
type Fila = Record<string, unknown>;

function dbFalso(o: { kdms?: Fila[]; checks?: Fila[]; fallaChecks?: boolean } = {}) {
  const llamadas: { sql: string; bindings: unknown[] }[] = [];
  const raw = async (sql: string, bindings: unknown[] = []) => {
    llamadas.push({ sql, bindings });
    if (sql.includes('SET LOCAL')) return { rows: [] };
    if (sql.includes('ods_branch_checks')) {
      if (o.fallaChecks) throw new Error('relation "analytics.ods_branch_checks" does not exist');
      return { rows: o.checks ?? [] };
    }
    if (sql.includes('kepler_ods.kdms')) return { rows: o.kdms ?? [] };
    return { rows: [] };
  };
  const trx: any = { raw, transaction: async (fn: (t: unknown) => unknown) => fn(trx) };
  const db = { raw, transaction: async (fn: (t: unknown) => unknown) => fn(trx) };
  return { db, llamadas };
}

const kdms = (codigo: string, nombre: string): Fila => ({ codigo, nombre, direccion: '', ciudad: '', almacenes: [codigo] });

describe('[VAC.D4] SucursalesService · frescura por sucursal', () => {
  beforeEach(() => { vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });
  afterEach(() => vi.restoreAllMocks());

  it('datos_al es la última revisión del carril ods_live_hot de ESA sucursal', async () => {
    const { db, llamadas } = dbFalso({
      kdms: [kdms('03', '8 ESQUINAS'), kdms('07', 'MORELIA MADERO')],
      checks: [
        { sucursal: '03', last_check_at: '2026-11-19T16:01:06.302Z', last_error: null, al_dia: true },
        { sucursal: '07', last_check_at: '2026-11-19T15:30:00.000Z', last_error: null, al_dia: true },
      ],
    });
    const r = await new SucursalesService(db as never).getSucursales();
    expect(r.find((s) => s.codigo === '03')?.datos_al).toBe('2026-11-19T16:01:06.302Z');
    expect(r.find((s) => s.codigo === '07')?.datos_al).toBe('2026-11-19T15:30:00.000Z');
    // Con el tenant puesto en la misma transacción (RLS; el endpoint es @Public()).
    expect(llamadas.some((l) => l.sql.includes('SET LOCAL app.tenant_id'))).toBe(true);
    const lectura = llamadas.find((l) => l.sql.includes('ods_branch_checks'));
    expect(lectura?.bindings).toContain('ods_live_hot');
  });

  it('ya no lee el latido cdc_wal_NN, que nadie escribe', async () => {
    const { db, llamadas } = dbFalso({ kdms: [kdms('03', '8 ESQUINAS')] });
    await new SucursalesService(db as never).getSucursales();
    expect(llamadas.some((l) => l.sql.includes('cdc_wal'))).toBe(false);
  });

  it('una sucursal sin revisión registrada dice null (la pantalla lo declara «sin medir»)', async () => {
    const { db } = dbFalso({
      kdms: [kdms('03', '8 ESQUINAS'), kdms('09', 'NUEVA')],
      checks: [{ sucursal: '03', last_check_at: '2026-11-19T16:01:06.302Z', last_error: null, al_dia: true }],
    });
    const r = await new SucursalesService(db as never).getSucursales();
    expect(r.find((s) => s.codigo === '09')?.datos_al).toBeNull();
  });

  it('una revisión vieja o con error se devuelve igual: la edad la calcula y la declara la pantalla', async () => {
    const { db } = dbFalso({
      kdms: [kdms('05', 'ZAMORA CENTRO')],
      checks: [{ sucursal: '05', last_check_at: '2026-11-18T09:00:00.000Z', last_error: 'timeout', al_dia: false }],
    });
    const r = await new SucursalesService(db as never).getSucursales();
    expect(r[0].datos_al).toBe('2026-11-18T09:00:00.000Z');
  });

  it('si la lectura de revisiones falla, el catálogo de sucursales sale igual y datos_al es null', async () => {
    const { db } = dbFalso({ kdms: [kdms('03', '8 ESQUINAS')], fallaChecks: true });
    const r = await new SucursalesService(db as never).getSucursales();
    expect(r).toHaveLength(1);
    expect(r[0].nombre).toBe('8 ESQUINAS');
    expect(r[0].datos_al).toBeNull();
  });
});
