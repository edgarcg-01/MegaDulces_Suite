import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[NP.7]` «Levantar productos» se alcanza desde las DOS superficies con las que entra la gente.
 *
 * En la primera captura en prod (2026-11-03) Francisco no encontró el botón «en ningún lado» y entró
 * escribiendo la URL: el botón de cámara vivía sólo en el header del layout de las áreas, y la pantalla de
 * entrada (`/projects`, «Mi trabajo») no monta ese layout. A la Mesa de Servicio le pasó lo mismo (MS.3.1).
 *
 * «Mi trabajo» se prueba PINTADA en `mi-trabajo.component.spec.ts` (con y sin el permiso). Aquí, el header
 * de las áreas, leyendo su plantilla: sin comentarios, y con el botón DENTRO del `@if` que lo gatea.
 */
const sinComentarios = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '');
const LAYOUT_HTML = sinComentarios(readFileSync(join(__dirname, '../dashboard/layout/layout.component.html'), 'utf8'));
const LAYOUT_TS = readFileSync(join(__dirname, '../dashboard/layout/layout.component.ts'), 'utf8');

/** ¿`marca` está dentro del bloque `@if (cond) { … }`, sin que ese bloque se haya cerrado antes de llegar? */
export function gateadoPor(html: string, cond: string, marca: string): boolean {
  const i = html.indexOf(marca);
  if (i < 0) return false;
  const j = html.lastIndexOf(`@if (${cond}) {`, i);
  if (j < 0) return false;
  let abiertos = 0;
  for (const ch of html.slice(j, i)) {
    if (ch === '{') abiertos++;
    else if (ch === '}') abiertos--;
  }
  return abiertos >= 1;
}

describe('[NP.7] entrada a «Levantar productos» en el header de las áreas', () => {
  it('el botón de cámara está DENTRO del @if que lo gatea por permiso', () => {
    expect(gateadoPor(LAYOUT_HTML, '!isRestricted() && puedeLevantar()', 'routerLink="/levantamiento"')).toBe(true);
    expect(LAYOUT_TS).toMatch(/puedeLevantar = computed\(\(\) => this\.perms\.has\(Permission\.CATALOGO_LEVANTAR\)\)/);
  });

  it('⛔ NEGATIVA — el instrumento no se deja engañar: botón comentado, fuera del @if, o inexistente', () => {
    const boton = '<a routerLink="/levantamiento">x</a>';
    expect(gateadoPor(`@if (ok()) { ${boton} }`, 'ok()', 'routerLink="/levantamiento"')).toBe(true); // control
    expect(gateadoPor(sinComentarios(`@if (ok()) { <!-- ${boton} --> }`), 'ok()', 'routerLink="/levantamiento"')).toBe(false);
    expect(gateadoPor(`@if (ok()) { <span></span> } ${boton}`, 'ok()', 'routerLink="/levantamiento"')).toBe(false);
    expect(gateadoPor(`@if (ok()) { }`, 'ok()', 'routerLink="/levantamiento"')).toBe(false);
  });
});
