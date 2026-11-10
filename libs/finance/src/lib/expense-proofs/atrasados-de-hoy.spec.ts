import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import knexFactory from 'knex';
import { ESTADOS_ABIERTOS_SIN_FIRMA, ESTADOS_CERRADOS, ESTADOS_DECIDIDOS, filtroAtrasados } from './etapas-del-dia';

/**
 * `[GX.109]` — Candado de **lo de HOY ya aprobado sale en Atrasados el mismo día.**
 *
 * La Bandeja de hoy sólo muestra lo que espera firma (`recibida`); Atrasados, lo abierto de días
 * anteriores. Un vale levantado hoy y aprobado hoy (`aprobada`, o `revision` cuando ya subió su
 * evidencia) no salía en ninguna de las dos hasta el día siguiente (visto el 2026-11-10).
 */
describe('[GX.109] ESTADOS_ABIERTOS_SIN_FIRMA', () => {
  it('son los aprobados que esperan algo más: aprobada y revision', () => {
    expect([...ESTADOS_ABIERTOS_SIN_FIRMA].sort()).toEqual(['aprobada', 'revision']);
  });

  it('⛔ se DERIVA: decididos que no están cerrados (un estado nuevo no se queda fuera por una lista a mano)', () => {
    for (const e of ESTADOS_ABIERTOS_SIN_FIRMA) {
      expect(ESTADOS_DECIDIDOS).toContain(e);
      expect(ESTADOS_CERRADOS).not.toContain(e);
    }
  });

  it('⛔ lo que espera firma NO: eso ya sale en la bandeja, y salir dos veces lo duplica', () => {
    expect(ESTADOS_ABIERTOS_SIN_FIRMA).not.toContain('recibida');
  });
});

describe('[GX.109] filtroAtrasados, compilado', () => {
  const db = knexFactory({ client: 'pg' });

  it('⛔ el O va DENTRO de su paréntesis: no se salta el tenant ni lo cerrado', () => {
    const s = db('finance.v_expense_proofs').where({ tenant_id: 't' })
      .modify(filtroAtrasados, '2026-11-10 06:00', '2026-11-11 06:00').select('id').toSQL().toNative();
    expect(s.sql).toBe('select "id" from "finance"."v_expense_proofs" where "tenant_id" = $1'
      + ' and "status" not in ($2, $3)'
      + ' and ("created_at" < $4 or "created_at" >= $5 or "status" in ($6, $7))');
    expect(s.bindings).toEqual(['t', ...ESTADOS_CERRADOS, '2026-11-10 06:00', '2026-11-11 06:00', ...ESTADOS_ABIERTOS_SIN_FIRMA]);
  });
});

describe('[GX.109] el servicio usa UN filtro para la lista y el total', () => {
  const SERVICIO = readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8');
  const i = SERVICIO.indexOf('async delDia(');
  const cuerpo = SERVICIO.slice(i, SERVICIO.indexOf('\n  async ', i + 10));

  it('la lista Y el total pasan por filtroAtrasados (si no, el conteo no cuadra con la lista)', () => {
    expect(cuerpo.split('.modify(filtroAtrasados, desde, hasta)').length - 1).toBe(2);
    // ⛔ Y no quedó una copia a mano del filtro.
    expect(cuerpo).not.toContain('ESTADOS_ABIERTOS_SIN_FIRMA');
  });
});
