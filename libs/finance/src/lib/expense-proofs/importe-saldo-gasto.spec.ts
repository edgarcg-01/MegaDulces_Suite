import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[GX.69]` — Candado de **el importe del vale es el Saldo del gasto en Kepler, tal cual**.
 *
 * Regla del usuario (2026-10-06): el importe que muestra Suite es el «Saldo» del gasto
 * (`X-A-10`, `kdm1.c42`). Sin sumar impuestos, sin recalcular, sin el importe contable.
 * Mientras el gasto no existe, el de la solicitud.
 *
 * Dos cosas pueden romperlo en silencio y las dos son TEXTO:
 *  1. una lectura nueva del importe que vaya a la tabla en vez de a la vista;
 *  2. que alguien «mejore» la vista con IVA, con `c16` del gasto o con el contable.
 */
const soloCodigo = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const leer = (f: string) => soloCodigo(readFileSync(join(__dirname, f), 'utf8'));

const MIGS = join(__dirname, '../../../../../database/migrations-newdb');
const MIG = readdirSync(MIGS).find((f) => f.endsWith('_v_expense_proofs_importe_kepler.js'));
const VISTA_SQL = MIG ? soloCodigo(readFileSync(join(MIGS, MIG), 'utf8')) : '';

/**
 * Las sentencias (de la mención de la tabla al `;`) que LEEN el importe directo de la tabla.
 * Escribir en la tabla es correcto (la vista no se actualiza); leer el importe de ahí, no.
 */
function lecturasDeImporteEnTabla(src: string): string[] {
  const malas: string[] = [];
  const re = /['"]finance\.expense_proofs(?: as p)?['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const fin = src.indexOf(';', m.index);
    const stmt = src.slice(m.index, fin < 0 ? undefined : fin);
    if (/\.(update|insert)\(/.test(stmt)) continue;
    if (/\bimporte\b/.test(stmt)) malas.push(stmt.slice(0, 160));
  }
  return malas;
}

describe('[GX.69] el importe del vale es el Saldo del gasto de Kepler', () => {
  it('la migración de la vista existe', () => {
    expect(MIG).toBeTruthy();
  });

  it('el servicio no lee el importe de la tabla: lo lee de la vista', () => {
    expect(lecturasDeImporteEnTabla(leer('expense-proofs.service.ts'))).toEqual([]);
    expect(lecturasDeImporteEnTabla(leer('expense-capture-links.service.ts'))).toEqual([]);
    expect(leer('expense-proofs.service.ts')).toContain("'finance.v_expense_proofs'");
  });

  it('la vista toma el SALDO del gasto (c42 de X-A-10), sin cancelados', () => {
    expect(VISTA_SQL).toMatch(/d\.c42/);
    expect(VISTA_SQL).toMatch(/btrim\(d\.c4::text\) = '10'/);
    expect(VISTA_SQL).toMatch(/btrim\(d\.c43\), ''\) <> 'C'/);
    expect(VISTA_SQL).toMatch(/COALESCE\(g\.saldo, s\.importe, p\.importe\) AS importe/);
  });

  it('la vista no suma impuestos ni usa el importe contable', () => {
    expect(VISTA_SQL).not.toMatch(/1\.16|\bc14\b|iva|expense_doc_accounting|importe_contable/i);
  });

  /** Prueba negativa: el detector sí ve una lectura del importe contra la tabla. */
  it('el detector reconoce la lectura prohibida', () => {
    const mala = `const r = await trx('finance.expense_proofs').where({ id }).first('importe');`;
    const buena = `await trx('finance.expense_proofs').where({ id }).update({ importe: 1 });`;
    expect(lecturasDeImporteEnTabla(mala)).toHaveLength(1);
    expect(lecturasDeImporteEnTabla(buena)).toHaveLength(0);
  });
});
