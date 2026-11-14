// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver transito.spec.ts).
import type { PoolClient } from 'pg';
import { KeplerOcCancelAdapter } from './kepler-oc-cancel.adapter';
import type { PlanCancelacion } from './kepler-oc-cancelacion';
import type { PlanCancelacionRequisicion } from './kepler-req-cancelacion';

/**
 * `[PQ.110]`/`[KR.7]` El paso que ESCRIBE (`confirmar` / `confirmarRequisicion` → `ejecutar`): el ORDEN y el
 * todo-o-nada, con un cliente falso. ⚠️ Un doble no ejecuta SQL: el SQL se ejerce en el ensayo contra Kepler
 * vivo (`ops/prod/ensayo-cancelar-oc/`). Esto cuida lo que el ensayo NO ve, porque lo sobrescribe.
 */
function cliente(o: { permisoNegado?: number; filas?: number[] } = {}) {
  const log: string[] = [];
  let permiso = 0; let sentencia = 0;
  const c = {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT (has_')) { log.push('permiso'); return { rows: [{ ok: permiso++ !== o.permisoNegado }] }; }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { log.push(sql); return { rowCount: 0, rows: [] }; }
      log.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
      return { rowCount: o.filas?.[sentencia++] ?? 1, rows: [] };
    },
  } as unknown as PoolClient;
  return { c, log };
}

class Expuesto extends KeplerOcCancelAdapter {
  conf(c: PoolClient, p: PlanCancelacion) { return this.confirmar(c, p); }
  confRq(c: PoolClient, p: PlanCancelacionRequisicion) { return this.confirmarRequisicion(c, p); }
}
const ad = new Expuesto();
const planOc: PlanCancelacion = {
  sucursal: '08', oc: { serie: '1', folio: '0000236', renglones: 1 }, requisicion: null, capturista: 'SUITE', fecha: '2026-11-14', hora: '10:00',
};
const planRq: PlanCancelacionRequisicion = {
  sucursal: '08', requisicion: { serie: '1', folio: '0000064', estado: 'A', renglones: 4 }, capturista: 'SUITE', fecha: '2026-11-14', hora: '10:00',
};

describe('[PQ.110]/[KR.7] el paso que escribe: permisos → sentencias → COMMIT, o nada', () => {
  it('OC: pregunta los 10 permisos ANTES de escribir, corre las 2 sentencias y confirma', async () => {
    const { c, log } = cliente({ filas: [1, 1] });
    expect(await ad.conf(c, planOc)).toBeNull();
    expect(log).toEqual([...Array(10).fill('permiso'), 'UPDATE md.kdm1', 'DELETE FROM', 'COMMIT']);
  });

  it('NEGATIVA: falta un permiso → ROLLBACK sin escribir, y el texto de siempre (PQ.110 no cambia)', async () => {
    const { c, log } = cliente({ permisoNegado: 3 });
    const m = await ad.conf(c, planOc);
    expect(m).toMatch(/^Kepler \(sucursal 08\) todavía no le da a la Suite el permiso para cancelar \(.*\); no se escribió nada$/);
    expect(log).not.toContain('UPDATE md.kdm1');
    expect(log[log.length - 1]).toBe('ROLLBACK');
  });

  it('NEGATIVA: una sentencia afecta otra cantidad de filas → ROLLBACK y no corre la siguiente', async () => {
    const { c, log } = cliente({ filas: [0] });
    expect(await ad.conf(c, planOc)).toBe('Kepler cambió mientras se cancelaba (cabecera de la OC: 0 filas, se esperaban 1); no se escribió nada');
    expect(log).not.toContain('DELETE FROM');
    expect(log).not.toContain('COMMIT');
  });

  it('OC con requisición: el permiso que falta se dice «para reabrir la requisición»', async () => {
    const { c } = cliente({ permisoNegado: 10 });
    expect(await ad.conf(c, { ...planOc, requisicion: { serie: '1', folio: '0000087', renglones: 4 } })).toMatch(/permiso para reabrir la requisición/);
  });

  it('requisición (KR.7): los mismos 10 permisos, sus 2 sentencias y COMMIT', async () => {
    const { c, log } = cliente({ filas: [1, 4] });
    expect(await ad.confRq(c, planRq)).toBeNull();
    expect(log).toEqual([...Array(10).fill('permiso'), 'UPDATE md.kdm1', 'DELETE FROM', 'COMMIT']);
  });

  it('requisición: si alguien la convirtió entre leer y escribir (0 filas) → ROLLBACK', async () => {
    const { c } = cliente({ filas: [0] });
    expect(await ad.confRq(c, planRq)).toMatch(/cabecera de la requisición: 0 filas, se esperaban 1/);
  });

  it('requisición: el permiso que falta se dice «para cancelar la requisición»', async () => {
    const { c } = cliente({ permisoNegado: 0 });
    expect(await ad.confRq(c, planRq)).toMatch(/permiso para cancelar la requisición/);
  });
});
