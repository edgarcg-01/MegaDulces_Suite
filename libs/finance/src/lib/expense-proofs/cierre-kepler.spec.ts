import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cierraPorKepler, valesQueCierraKepler, ESTADOS_QUE_CIERRA_KEPLER } from './cierre-kepler';

/**
 * `[GX.85]` Cuando Kepler pone la `F` («autorizado y aplicado — el dinero salió»), el vale
 * se cierra y pasa a Historial. Medido en prod el 2026-10-13: 13 vales abiertos ya estaban en `F`.
 */
describe('[GX.85] cierraPorKepler', () => {
  it.each(['recibida', 'aprobada', 'revision'])('%s + F = se cierra', (s) => {
    expect(cierraPorKepler(s, 'F')).toBe(true);
  });

  it('rechazada + F NO se cierra: la decisión nuestra no la tapa Kepler', () => {
    expect(cierraPorKepler('rechazada', 'F')).toBe(false);
  });

  it('validada + F no hace nada: ya está cerrado', () => {
    expect(cierraPorKepler('validada', 'F')).toBe(false);
  });

  it.each(['A', 'N', 'C', null, undefined, ''])('aprobada + %s NO se cierra: el dinero no ha salido', (k) => {
    expect(cierraPorKepler('aprobada', k)).toBe(false);
  });

  it('rechazada no está entre los estados que Kepler cierra', () => {
    expect(ESTADOS_QUE_CIERRA_KEPLER).not.toContain('rechazada');
    expect(ESTADOS_QUE_CIERRA_KEPLER).not.toContain('validada');
  });
});

describe('[GX.85] valesQueCierraKepler', () => {
  const V = (id: string, status: string, sucursal: string | null, folio: string | null) =>
    ({ id, status, sucursal, folio_solicitud: folio });

  it('cruza por (sucursal, folio): el mismo folio en otra plaza NO cierra', () => {
    const abiertos = [V('a', 'aprobada', '04', '0000046'), V('b', 'aprobada', '00', '0000046')];
    const kepler = [{ sucursal: '04', folio: '0000046', estado: 'F' }, { sucursal: '00', folio: '0000046', estado: 'A' }];
    expect(valesQueCierraKepler(abiertos, kepler)).toEqual(['a']);
  });

  it('tolera espacios en la llave (Kepler los trae)', () => {
    expect(valesQueCierraKepler([V('a', 'recibida', '08', '0000140')], [{ sucursal: '08 ', folio: ' 0000140', estado: 'F' }]))
      .toEqual(['a']);
  });

  it('sin sucursal o sin folio no se cierra: no se sabe cuál solicitud es la suya', () => {
    const kepler = [{ sucursal: '', folio: '0000001', estado: 'F' }];
    expect(valesQueCierraKepler([V('a', 'aprobada', null, '0000001'), V('b', 'aprobada', '01', null)], kepler)).toEqual([]);
  });

  it('un vale sin solicitud en la vista no se cierra (no medido no es F)', () => {
    expect(valesQueCierraKepler([V('a', 'aprobada', '01', '0000022')], [])).toEqual([]);
  });

  it('un rechazado con F se queda como está', () => {
    expect(valesQueCierraKepler([V('a', 'rechazada', '01', '0000009')], [{ sucursal: '01', folio: '0000009', estado: 'F' }]))
      .toEqual([]);
  });
});

describe('[GX.85] el cron', () => {
  const src = readFileSync(join(__dirname, 'cierre-kepler.service.ts'), 'utf8');

  it('fija el tenant antes de leer (RLS forzado: sin esto el universo es cero)', () => {
    expect(src.indexOf("set_config('app.tenant_id'")).toBeGreaterThan(-1);
    expect(src.indexOf("set_config('app.tenant_id'")).toBeLessThan(src.indexOf("trx('finance.expense_proofs')"));
  });

  it('repite la condición de estado en el UPDATE (si alguien lo rechazó entre medio, gana su decisión)', () => {
    const update = src.slice(src.indexOf('.update({'));
    const antes = src.slice(0, src.indexOf('.update({'));
    expect(antes.lastIndexOf('.whereIn(\'status\'')).toBeGreaterThan(antes.lastIndexOf(".whereIn('id', ids)"));
    expect(update).toContain("status: 'validada'");
  });

  it('late con su clave, y la clave tiene umbral en CRON_JOBS', () => {
    expect(src).toContain("jobKey: 'gastos_cierre_kepler'");
    const health = readFileSync(join(__dirname, '../../../../../apps/api/src/modules/db-health/db-health.service.ts'), 'utf8');
    expect(health).toContain("key: 'gastos_cierre_kepler'");
  });
});
