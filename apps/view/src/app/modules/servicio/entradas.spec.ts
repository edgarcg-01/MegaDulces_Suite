import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[MS.3.7]` «Reportar un problema» llega a TODA superficie con la suite, no sólo a «Mi trabajo».
 *
 * Esta prueba existe porque el pendiente MS.3.7 se anotó como «faltan los shells de tienda y telemarketing»
 * SIN haberlo medido, y era falso: esas dos áreas montan el mismo `LayoutComponent` que lleva el botón
 * (verificado en navegador con un jefe de tienda en `/tienda/verificador` y una teleoperadora en
 * `/telemarketing/dashboard`). Un pendiente declarado sin medir cuesta lo mismo que un número dibujado.
 *
 * Lo que se defiende: el botón vive en el header del layout, gateado SÓLO por el permiso de reportar (y por el
 * modo kiosco), y cada área operativa monta ese layout. Si alguien le da a tienda o telemarketing un shell propio
 * sin el botón, esto se pone rojo — y el pendiente deja de ser falso.
 */
const RUTAS = readFileSync(join(__dirname, '../../app.routes.ts'), 'utf8').replace(/\r\n/g, '\n');
const LAYOUT_HTML = readFileSync(join(__dirname, '../dashboard/layout/layout.component.html'), 'utf8');

/** Lo que puede haber entre la llave de apertura y el `path:` de un grupo: comentarios de bloque o de línea. */
const COMENTARIOS = '(?:    /\\*[^]*?\\*/\n|    //.*\n)*';

/** El bloque `{ path: 'x', ... }` de primer nivel, hasta el siguiente grupo de primer nivel. */
function bloque(path: string): string {
  const i = RUTAS.search(new RegExp(`\n  \\{\n${COMENTARIOS}    path: '${path}',`));
  if (i < 0) return '';
  const resto = RUTAS.slice(i + 1);
  const fin = resto.slice(5).search(new RegExp(`\n  \\{\n${COMENTARIOS}    path: '`));
  return fin < 0 ? resto : resto.slice(0, fin + 5);
}

describe('[MS.3.7] «Reportar un problema» en las áreas operativas', () => {
  it('el botón está en el header del layout y lo gatea el permiso de reportar', () => {
    const i = LAYOUT_HTML.indexOf('routerLink="/servicio/solicitudes"');
    expect(i).toBeGreaterThan(0);
    const antes = LAYOUT_HTML.slice(Math.max(0, i - 200), i);
    expect(antes).toContain('puedeReportar()');
  });

  it.each(['tienda', 'telemarketing', 'servicio', 'comercial', 'compras', 'finanzas', 'logistica'])(
    'el área «%s» monta el LayoutComponent que lleva el botón',
    (area) => {
      const b = bloque(area);
      expect(b, `no se encontró el bloque de la ruta «${area}»`).not.toBe('');
      expect(b).toMatch(/component: LayoutComponent/);
    },
  );

  it('⛔ NEGATIVA — el helper no se traga bloques ajenos: un área inexistente no se encuentra', () => {
    expect(bloque('area-que-no-existe')).toBe('');
  });
});
