import type { PoolClient } from 'pg';

import { sumarAcumuladoAcreedor } from './kepler-filas';

/**
 * `[PGP.172]` El acumulado del acreedor (`md.kdxg`) **nace con el primer movimiento**: no es un catálogo.
 * Cada prueba de aquí tiene su control negativo, porque las tres que importan son justamente las que no
 * se veían: que la fila se cree en vez de rechazar, que NO se cree cuando hay más de una, y que el
 * `UPDATE` filtre SIEMPRE por sucursal (sin `c2`, en `md_03` sumaba a la fila de la 02 sin dar error).
 */

/** Las 58 columnas de `kdxg`, como las devuelve `pg_attribute`. */
const COLS = [
  { n: 'c1', t: 'character varying' }, { n: 'c2', t: 'character varying' }, { n: 'c3', t: 'character varying' },
  { n: 'c4', t: 'timestamp without time zone' }, { n: 'c5', t: 'numeric' },
  { n: 'c6', t: 'timestamp without time zone' }, { n: 'c7', t: 'timestamp without time zone' },
  { n: 'c8', t: 'character varying' }, { n: 'c9', t: 'character varying' }, { n: 'c10', t: 'character varying' },
  ...Array.from({ length: 48 }, (_, i) => ({ n: `c${i + 11}`, t: 'numeric' })),
];

function clienteFalso(filasQueActualiza: number) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const q = async (text: string, vals?: unknown[]) => {
    sql.push(String(text).replace(/\s+/g, ' ').trim());
    params.push(vals ?? []);
    if (/FROM pg_attribute/.test(text)) return { rows: COLS, rowCount: COLS.length };
    if (/UPDATE md\.kdxg/.test(text)) return { rows: [], rowCount: filasQueActualiza };
    if (/INSERT INTO md\.kdxg/.test(text)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { c: { query: q } as unknown as PoolClient, sql, params };
}

const GASTO = { sucursal: '05', acreedor: 'GG006', columna: 'c58', importe: 2000, fecha: '2026-11-27', fechas: ['c4', 'c6'] as const };

describe('[PGP.172] sumarAcumuladoAcreedor', () => {
  it('cuando la fila YA existe, la actualiza y no inserta nada', async () => {
    const { c, sql } = clienteFalso(1);
    expect(await sumarAcumuladoAcreedor(c, { ...GASTO })).toBe('actualizada');
    expect(sql.some((s) => s.startsWith('UPDATE md.kdxg'))).toBe(true);
    expect(sql.some((s) => s.includes('INSERT INTO md.kdxg'))).toBe(false);
  });

  it('⭐ cuando NO existe, la CREA en vez de rechazar (el 80.7 % de los pares del catálogo)', async () => {
    const { c, sql, params } = clienteFalso(0);
    expect(await sumarAcumuladoAcreedor(c, { ...GASTO })).toBe('creada');
    const i = sql.findIndex((s) => s.includes('INSERT INTO md.kdxg'));
    expect(i).toBeGreaterThan(-1);
    // Las 58 columnas, y el importe sólo en la del mes; todo lo demás nace en cero/vacío.
    const cols = /\(([^)]*)\) VALUES/.exec(sql[i])?.[1].split(', ') ?? [];
    expect(cols).toHaveLength(58);
    const v = params[i];
    expect(v[cols.indexOf('c1')]).toBe('PESOS');
    expect(v[cols.indexOf('c2')]).toBe('05');
    expect(v[cols.indexOf('c3')]).toBe('GG006');
    expect(v[cols.indexOf('c58')]).toBe(2000);
    expect(v[cols.indexOf('c4')]).toBe('2026-11-27');
    expect(v[cols.indexOf('c6')]).toBe('2026-11-27');
    // CONTROL: la fecha que este movimiento NO mueve queda «sin fecha», y los otros 47 acumuladores en 0.
    expect(v[cols.indexOf('c7')]).toBe('1800-01-01');
    expect(v[cols.indexOf('c5')]).toBe(0);
    const acumuladores = cols.filter((x) => /^c(1[1-9]|[2-5]\d)$/.test(x) && x !== 'c58');
    expect(acumuladores).toHaveLength(47);
    for (const a of acumuladores) expect(v[cols.indexOf(a)]).toBe(0);
  });

  it('⭐ CONTROL NEGATIVO: con MÁS de una fila propia revienta ruidoso y NO inserta', async () => {
    const { c, sql } = clienteFalso(2);
    await expect(sumarAcumuladoAcreedor(c, { ...GASTO })).rejects.toThrow(/trae 2 filas propias en 05/);
    expect(sql.some((s) => s.includes('INSERT INTO md.kdxg'))).toBe(false);
  });

  it('⛔ CONTROL NEGATIVO del defecto de la nota: el UPDATE SIEMPRE filtra por sucursal (c2)', async () => {
    const { c, sql, params } = clienteFalso(1);
    await sumarAcumuladoAcreedor(c, { ...GASTO });
    const u = sql.find((s) => s.startsWith('UPDATE md.kdxg')) ?? '';
    expect(u).toContain("btrim(c1) = 'PESOS'");
    expect(u).toContain('btrim(c2) = $3');
    expect(u).toContain('btrim(c3) = $4');
    expect(params[sql.indexOf(u)][2]).toBe('05');
  });

  it('el pago sube c4 y c7; el gasto, c4 y c6', async () => {
    const pago = clienteFalso(1);
    await sumarAcumuladoAcreedor(pago.c, { ...GASTO, columna: 'c46', fechas: ['c4', 'c7'] });
    const u = pago.sql.find((s) => s.startsWith('UPDATE md.kdxg')) ?? '';
    expect(u).toContain('c46 = c46 + $1');
    expect(u).toContain('c4 = greatest(c4, $2::timestamp)');
    expect(u).toContain('c7 = greatest(c7, $2::timestamp)');
    expect(u).not.toContain('c6 = greatest');
  });

  it('CONTROL NEGATIVO: una columna que no es de Kepler no se interpola nunca', async () => {
    const { c, sql } = clienteFalso(1);
    await expect(sumarAcumuladoAcreedor(c, { ...GASTO, columna: 'c58; DROP TABLE md.kdxg' }))
      .rejects.toThrow(/Columna inválida/);
    await expect(sumarAcumuladoAcreedor(c, { ...GASTO, fechas: ['c4', 'x1'] })).rejects.toThrow(/Columna de fecha inválida/);
    expect(sql).toHaveLength(0);
  });

  it('CONTROL NEGATIVO: si la columna de fecha es la del importe, el plan está mal y se dice', async () => {
    const { c } = clienteFalso(1);
    await expect(sumarAcumuladoAcreedor(c, { ...GASTO, fechas: ['c58'] })).rejects.toThrow(/es la misma del importe/);
  });
});
