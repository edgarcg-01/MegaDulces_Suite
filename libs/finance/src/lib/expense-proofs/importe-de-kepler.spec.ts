import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[GX.68]` — Candado de **el importe del vale lo dicta Kepler**.
 *
 * El reporte: «Claude Vision sigue cambiando el total de los vales». Medido en el código, la
 * visión NO escribía `importe` (sólo deja una leyenda, ver `vision-avisa.spec.ts`). Lo que sí
 * grababa un total distinto al de Kepler era `create()`: volvía a buscar la solicitud SÓLO por
 * folio, y con 373 folios repetidos entre plazas `.first()` tomaba la de OTRA tienda.
 *
 * Se vigila sobre el texto porque la regresión es una consulta escrita de nuevo a mano, y eso
 * no lo ve ninguna prueba de comportamiento sin una base con folios repetidos.
 */
const soloCodigo = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const leer = (f: string) => soloCodigo(readFileSync(join(__dirname, f), 'utf8'));
const SERVICIO = leer('expense-proofs.service.ts');
const LINKS = leer('expense-capture-links.service.ts');

const BRK = String.fromCharCode(10);
const metodo = (src: string, decl: string): string => {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  const fin = src.indexOf(BRK + '  }', i);
  return fin < 0 ? src.slice(i) : src.slice(i, fin);
};

/** ¿El cuerpo consulta las solicitudes de Kepler directo, sin pasar por el resolvedor? */
const consultaDirecta = (cuerpo: string) => /trx\(\s*['"]analytics\.expense_requests['"]\s*\)/.test(cuerpo);

/** Objetos `.update({...})` / `.insert({...})` que asignan `importe` desde la lectura OCR. */
const importeDesdeOcr = (src: string) =>
  /importe\s*:\s*[^,\n]*(monto_ocr|ocr|\.total\b|lectura|vision)/i.test(src);

describe('[GX.68] el importe del vale sale de Kepler', () => {
  const CREATE = metodo(SERVICIO, 'async create(dto: CreateExpenseProofDto');

  it('el método existe (si se renombra, el candado debe saberlo)', () => {
    expect(CREATE.length).toBeGreaterThan(0);
  });

  it('create() NO consulta la solicitud por su cuenta: usa la de lookupSolicitud', () => {
    expect(CREATE).toContain('this.lookupSolicitud(folioSolicitud, req(dto.sucursal))');
    expect(consultaDirecta(CREATE)).toBe(false);
  });

  it('el resolvedor filtra por sucursal', () => {
    const LOOKUP = metodo(SERVICIO, 'private async lookupSolicitud(');
    expect(LOOKUP).toMatch(/qb\.where\(\s*'sucursal'/);
  });

  it('casar una captura toma el importe de Kepler con la sucursal de la captura', () => {
    const MATCH = metodo(SERVICIO, 'async match(');
    expect(MATCH).toContain('this.lookupSolicitud(f, cur.sucursal)');
    expect(MATCH).toMatch(/importe:\s*real\s*\|\|\s*declarado/);
  });

  it('ningún camino graba en `importe` lo que leyó la visión', () => {
    expect(importeDesdeOcr(SERVICIO)).toBe(false);
  });

  /** Prueba negativa: los detectores sí ven la forma vieja del defecto. */
  it('los detectores reconocen el defecto que cierran', () => {
    const viejo = `const solRow = await trx('analytics.expense_requests')
        .where({ tenant_id: t, folio: folioSolicitud }).first(x);`;
    expect(consultaDirecta(viejo)).toBe(true);
    expect(importeDesdeOcr('.update({ importe: dto.monto_ocr, status })')).toBe(true);
    expect(importeDesdeOcr('.update({ importe: real || declarado })')).toBe(false);
  });

  it('la captura por link sin folio sigue siendo la única que guarda lo declarado', () => {
    expect(LINKS).toMatch(/folio_solicitud:\s*null/);
  });
});
