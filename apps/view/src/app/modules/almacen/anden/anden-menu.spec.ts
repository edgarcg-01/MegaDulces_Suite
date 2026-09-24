import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Candados del **menú de sucursales** del Andén (WMS-REC.11).
 *
 * El paso 0 deja de ser "tecleá el folio" y pasa a ser "¿a qué sucursal entra la
 * mercancía?". Lo que se protege acá es lo que ya costó, o lo que costaría caro:
 *
 *  1. **Sólo el día de hoy, en hora de MÉXICO.** La regla la decidió Edgar; el
 *     AT TIME ZONE lo obliga la base, que corre en Etc/UTC: a las 7 de la noche,
 *     CURRENT_DATE pelado ya devuelve mañana. Medido ese día: con hora de México,
 *     0 vales; con CURRENT_DATE a las 7 PM, 4 — y eran los del día siguiente. El
 *     andén le habría cambiado el día al bodeguero a media tarde.
 *  2. **El día vacío NO se amplía solo.** Ampliar en silencio sería decidir por
 *     el dueño de la regla y taparía que el dato del día no llegó.
 *  3. **El alcance sale del alcance**, no de contar filas: un usuario asignado a
 *     tres plazas vería el aviso de "no tenés sucursal asignada" y sería falso.
 *  4. **Sin acentos graves dentro de los template literals.** Ya rompió el build
 *     cinco veces en este repo — la quinta fue en este mismo componente.
 */
const DIR = join(__dirname, 'components');
const SUCURSALES = readFileSync(join(DIR, 'anden-sucursales.component.ts'), 'utf8');
const VALES = readFileSync(join(DIR, 'anden-vales.component.ts'), 'utf8');
const ORQUESTADOR = readFileSync(join(__dirname, 'anden.component.ts'), 'utf8');

/** El acento grave, escrito así para no meterlo literal en este archivo. */
const BT = String.fromCharCode(96);

/**
 * El cuerpo del template y de los estilos, cortado por su CIERRE REAL.
 *
 * La primera versión de esto cortaba en el próximo acento grave, y así no podía
 * ver el único defecto que viene a buscar: el acento grave de más terminaba el
 * bloque y el candado pasaba en verde con el archivo roto. Se vio al romperlo a
 * propósito. Ahora corta en el cierre del decorador, que no es un acento grave.
 */
function literales(fuente: string): string[] {
  const out: string[] = [];
  for (const [marca, cierre] of [
    ['template: ', ','],
    ['styles: [', '],'],
  ] as const) {
    const abre = fuente.indexOf(marca + BT);
    if (abre < 0) continue;
    const desde = abre + marca.length + 1;
    const fin = fuente.indexOf('\n  ' + BT + cierre, desde);
    out.push(fuente.slice(desde, fin < 0 ? fuente.length : fin));
  }
  return out;
}

describe('Andén · el menú de sucursales', () => {
  it('el día se filtra en hora de México, no con CURRENT_DATE pelado', () => {
    // El backend vive en otro proyecto; se lee su fuente a propósito, porque la
    // regla es de negocio y este candado es el único lugar que la nombra entera.
    const svc = readFileSync(
      join(__dirname, '../../../../../../../libs/commercial/src/lib/commercial-receiving/receiving-session.service.ts'),
      'utf8',
    );
    const i = svc.indexOf('const HOY_MX');
    expect(i).toBeGreaterThan(-1);
    const bloque = svc.slice(i, i + 200);
    expect(bloque).toContain("AT TIME ZONE 'America/Mexico_City'");
    // Un CURRENT_DATE suelto en el filtro del día es justo el bug de las 7 PM.
    expect(bloque).not.toMatch(/=\s*CURRENT_DATE/);
  });

  it('el menú no tiene ninguna puerta para ampliar el día', () => {
    // Ni un parámetro de ventana, ni un "ver días anteriores": la regla es
    // sólo-hoy y se aplica literal.
    expect(SUCURSALES).not.toMatch(/dias|ventana|ultimos\s*\d|últimos\s*\d/i);
    expect(ORQUESTADOR).not.toMatch(/pendingErpBranches\([^)]+\)/);
    expect(ORQUESTADOR).not.toMatch(/pendingErpOrders\([^,)]+,/);
  });

  it('el día vacío se explica y ofrece el folio, en vez de quedar mudo', () => {
    expect(SUCURSALES).toContain('Hoy no hay vales');
    expect(SUCURSALES).toMatch(/verFolio\.emit\(\)/);
  });

  it('un error NO se pinta como "hoy no hay vales"', () => {
    // Son cosas distintas: confundirlas manda al bodeguero a buscar un camión
    // que sí llegó. El componente tiene una rama propia para el error.
    expect(SUCURSALES).toMatch(/@else if \(error\(\)\)/);
    expect(ORQUESTADOR).toContain('errorMenu');
  });

  it('el aviso del alcance sale del ALCANCE, no de contar sucursales', () => {
    expect(SUCURSALES).toContain('alcanceAbierto');
    expect(ORQUESTADOR).toMatch(/alcance === 'all'/);
  });

  it('una sucursal sin almacén no se puede tocar: abrirla daría 400', () => {
    expect(SUCURSALES).toMatch(/\[disabled\]="b\.sin_almacen"/);
    expect(ORQUESTADOR).toMatch(/if \(!b \|\| b\.sin_almacen\) return;/);
  });

  it('el folio a mano sigue existiendo como respaldo', () => {
    expect(ORQUESTADOR).toContain("modo() === 'vales'");
    expect(ORQUESTADOR).toContain('app-anden-folio');
    expect(ORQUESTADOR).toMatch(/'inicio' \| 'alta' \| 'vales' \| 'folio'/);
  });

  it('el extractor de literales encuentra de verdad el bloque, no una cadena vacía', () => {
    // Sin esto, un helper roto haría pasar el candado de abajo sobre la nada —
    // que es exactamente como falló su primera versión.
    for (const fuente of [SUCURSALES, VALES]) {
      const bloques = literales(fuente);
      expect(bloques.length).toBe(2);
      for (const b of bloques) expect(b.length).toBeGreaterThan(400);
    }
  });

  it('ningún acento grave dentro de los template literals', () => {
    // Quinta vez en este repo. Un backtick en un comentario del template cierra
    // la cadena y el error que sale habla de comas, no de comentarios.
    for (const [nombre, fuente] of [
      ['sucursales', SUCURSALES],
      ['vales', VALES],
    ] as const) {
      for (const bloque of literales(fuente)) {
        expect([nombre, bloque.includes(BT)]).toEqual([nombre, false]);
      }
    }
  });
});
