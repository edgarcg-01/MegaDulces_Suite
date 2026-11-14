// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver transito.spec.ts).

import {
  decidirCancelacionRequisicion, sentenciasCancelacionRequisicion,
  type EntradaCancelacionRequisicion, type RequisicionACancelar,
} from './kepler-req-cancelacion';
import { permisosNecesarios, sentenciasCancelacion } from './kepler-oc-cancelacion';

/** Una de las 20 requisiciones de la Suite que Kepler reabrió en Morelia Abastos (su OC se canceló a mano). */
const RQ: RequisicionACancelar = {
  serie: '1', folio: '0000008', estado: 'A', total: 36552.12, capturista: 'SUITE',
  fecha_captura: '2026-10-29', hora_captura: '12:40', renglones: 7,
};
const base = (o: Partial<EntradaCancelacionRequisicion> = {}): EntradaCancelacionRequisicion => ({
  requisicion: RQ, coincidencias: 1, oc_vivas: [], ...o,
});

describe('[KR.7] decidirCancelacionRequisicion — la regla de Kepler y sólo lo observado', () => {
  it('pendiente (A) sin OC viva —reabierta porque su OC se canceló—: se cancela', () => {
    expect(decidirCancelacionRequisicion(base())).toEqual({ ok: true });
  });

  it('nueva (N) que nunca tuvo OC: se cancela', () => {
    expect(decidirCancelacionRequisicion(base({ requisicion: { ...RQ, estado: 'N' } }))).toEqual({ ok: true });
  });

  it('NEGATIVA: con una OC viva NO se cancela, aunque esté en A — y dice qué hacer primero', () => {
    const d = decidirCancelacionRequisicion(base({ oc_vivas: ['0000210'] }));
    expect(d.ok).toBe(false);
    expect(!d.ok && d.motivo).toMatch(/orden de compra 0000210.*primero se cancela la OC/);
  });

  it('la OC viva se dice ANTES que el estado (F con OC viva → «cancela la OC», no «no se ha visto»)', () => {
    const d = decidirCancelacionRequisicion(base({ requisicion: { ...RQ, estado: 'F' }, oc_vivas: ['0007296'] }));
    expect(!d.ok && d.motivo).toMatch(/primero se cancela la OC/);
  });

  it.each([
    ['F', /convertida en orden de compra/], ['R', /convertida en parte/], ['X', /en estado X/],
  ])('estado %s sin OC viva: no se ha visto cómo la cancela Kepler', (estado, palabra) => {
    const d = decidirCancelacionRequisicion(base({ requisicion: { ...RQ, estado } }));
    expect(d.ok).toBe(false);
    expect(!d.ok && d.motivo).toMatch(palabra);
    expect(!d.ok && d.motivo).toMatch(/no se ha visto/);
  });

  it('ya cancelada, no existe o el folio es ambiguo: rechazo con su porqué', () => {
    expect(decidirCancelacionRequisicion(base({ requisicion: { ...RQ, estado: 'C' } }))).toEqual({ ok: false, motivo: 'La requisición ya está cancelada en Kepler' });
    expect(decidirCancelacionRequisicion(base({ requisicion: null, coincidencias: 0 })).ok).toBe(false);
    const d = decidirCancelacionRequisicion(base({ coincidencias: 2 }));
    expect(!d.ok && d.motivo).toMatch(/2 requisiciones con ese folio/);
  });
});

describe('[KR.7] sentenciasCancelacionRequisicion — lo que escribe Kepler, y sus candados', () => {
  const plan = {
    sucursal: '08', requisicion: { serie: '1', folio: '0000008', estado: 'A', renglones: 7 },
    capturista: 'SUITE', fecha: '2026-11-14', hora: '11:05',
  };
  const [cab, ren] = sentenciasCancelacionRequisicion(plan);

  it('cabecera: C, importes y saldo en 0, y quién/cuándo como Kepler (el testigo 0003143)', () => {
    expect(cab.sql).toMatch(/SET c43 = 'C', c13 = 0, c14 = 0, c15 = 0, c16 = 0, c42 = 0, c67 = \$5, c68 = \$6, c69 = \$7/);
    expect(cab.params).toEqual(['08', '1', '0000008', 'A', 'SUITE', '2026-11-14', '11:05']);
    expect(cab.esperadas).toBe(1);
  });

  it('candado 1: el estado leído va en el WHERE (si la convirtieron entre leer y escribir, 0 filas)', () => {
    expect(cab.sql).toMatch(/btrim\(c4::text\) = '30'/);
    expect(cab.sql).toMatch(/AND btrim\(c43\) = \$4/);
  });

  it('candado 2: la regla de Kepler también en el WHERE — ninguna OC viva que la referencie', () => {
    expect(cab.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM md\.kdm1 o[\s\S]*btrim\(o\.c4::text\) = '35'[\s\S]*btrim\(o\.c37::text\) = '30' AND btrim\(o\.c39\) = \$3 AND btrim\(o\.c43\) <> 'C'\)/);
  });

  it('renglones: se borran, y deben ser exactamente los que se leyeron', () => {
    expect(ren.sql).toMatch(/^DELETE FROM md\.kdm2 WHERE .*btrim\(c4::text\) = '30'/);
    expect(ren.params).toEqual(['08', '1', '0000008']);
    expect(ren.esperadas).toBe(7);
  });

  it('NEGATIVA: un estado no cancelable no produce sentencias (la regla debió rechazarlo)', () => {
    expect(() => sentenciasCancelacionRequisicion({ ...plan, requisicion: { ...plan.requisicion, estado: 'F' } })).toThrow(/no cancelable/);
  });

  it('las copias del ensayo se nombran igual que en PQ.110', () => {
    const [c] = sentenciasCancelacionRequisicion(plan, { kdm1: 'pg_temp.k1', kdm2: 'pg_temp.k2' });
    expect(c.sql).toContain('UPDATE pg_temp.k1 SET');
    expect(c.sql).toContain('FROM pg_temp.k1 o');
  });

  it('pide los mismos permisos que cancelar una OC sin requisición: KR.7 no necesita permisos nuevos', () => {
    const columnasOc = sentenciasCancelacion({
      sucursal: '08', oc: { serie: '1', folio: '1', renglones: 1 }, requisicion: null, capturista: 'S', fecha: 'f', hora: 'h',
    })[0].sql.match(/SET (.*) WHERE/s)![1].split(',').map((x) => x.trim().split(' ')[0]).sort();
    const columnasRq = cab.sql.match(/SET (.*?)\s+WHERE/s)![1].split(',').map((x) => x.trim().split(' ')[0]).sort();
    expect(columnasRq).toEqual(columnasOc);
    expect(permisosNecesarios(false)).toHaveLength(10);
  });
});
