// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[RQ.15]` — El candado de la junta requisición ↔ orden de compra de Kepler.
 *
 * ⛔ De las once juntas que se midieron el 2026-10-09, ésta no estaba floja: **no existía**.
 * `commercial.purchase_requisitions` guardaba `ordered_at` y `ordered_by` —*cuándo* y *quién*—
 * y nunca **cuál** orden salió. Las 53 requisiciones ya `ordered`, por **$11,586,824**, no se
 * pueden seguir hasta la entrada de mercancía.
 *
 * ⚠️ Lo que protege este archivo es que el folio siga siendo OBLIGATORIO. Un campo opcional en
 * una junta que nadie llena se queda vacío: es exactamente lo que pasó con `ordered_at`, que sí
 * se llena y no sirve para seguir nada.
 */

const DIR = __dirname;
const SVC = readFileSync(join(DIR, 'commercial-replenishment.service.ts'), 'utf8');
const CTRL = readFileSync(join(DIR, 'commercial-replenishment.controller.ts'), 'utf8');
const MIG = readFileSync(join(DIR, '..', '..', '..', '..', '..', 'database', 'migrations-newdb', '20261009182516_requisicion_oc_kepler.js'), 'utf8');

/** Mide código, no redacción: los comentarios nombran las mismas palabras que las aserciones. */
function sinComentarios(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ').replace(/^\s*--.*$/gm, ' ');
}
const CODIGO = sinComentarios(SVC);
const MIG_SQL = sinComentarios(MIG);

function cuerpo(nombre: string): string {
  const i = CODIGO.indexOf(`${nombre}(`);
  if (i < 0) throw new Error(`No existe ${nombre}()`);
  const resto = CODIGO.slice(i + nombre.length);
  const fin = resto.search(/\n {2}(?:async |private |\/\*\* |[a-zA-Z]+\()/);
  return fin < 0 ? CODIGO.slice(i) : CODIGO.slice(i, i + nombre.length + fin);
}

describe('[RQ.15] el arnés', () => {
  it('encuentra el método y la migración', () => {
    expect(() => cuerpo('markOrdered')).not.toThrow();
    expect(MIG).toContain('oc_folio');
  });

  it('y falla fuerte si el método se renombra', () => {
    expect(() => cuerpo('noExisteEsto')).toThrow(/No existe/);
  });
});

describe('[RQ.15] ⛔ el folio de la OC es OBLIGATORIO', () => {
  const c = cuerpo('markOrdered');

  it('⭐⭐ sin sucursal o sin folio, se rechaza', () => {
    // Un campo opcional en una junta que nadie llena se queda vacío. Es lo que ya pasó: la
    // capacidad de marcar ordenada existe desde RA.14 y ninguna pantalla la llama.
    expect(c).toMatch(/if \(!sucursal \|\| !folio\)/);
    expect(c).toContain('BadRequestException');
  });

  it('⛔ NEGATIVA: no hay un camino que ordene sin folio', () => {
    // Si quedara una sobrecarga sin argumentos, el freno sería decorativo.
    expect(c).not.toMatch(/markOrdered\(id\)\s*\{[\s\S]{0,80}setEstado\(id, 'approved', 'ordered'\)/);
    expect(c).toMatch(/setEstado\(id, 'approved', 'ordered', \{ oc_sucursal/);
  });

  it('⭐ y la ruta recibe el cuerpo: sin esto el controlador nunca se lo pasaría', () => {
    const i = CTRL.indexOf(`@Post('requisitions/:id/order')`);
    expect(i).toBeGreaterThan(0);
    const bloque = CTRL.slice(i, i + 700);
    expect(bloque).toContain('oc_sucursal');
    expect(bloque).toContain('oc_folio');
  });
});

describe('[RQ.15] la coordenada es de KEPLER, y va entera', () => {
  it('⛔ las DOS columnas o NINGUNA — media coordenada no identifica un documento', () => {
    // El folio se repite entre sucursales (lo midió la Fase CC con `doc_prefix`): uno suelto
    // apunta a varios documentos mientras se lee como si apuntara a uno.
    expect(MIG_SQL).toMatch(/CHECK \(\(oc_sucursal IS NULL AND oc_folio IS NULL\)/);
    expect(MIG_SQL).toMatch(/btrim\(COALESCE\(oc_sucursal,''\)\) <> ''/);
  });

  it('⭐ una OC sale de UNA requisición: índice único parcial', () => {
    expect(MIG_SQL).toMatch(/CREATE UNIQUE INDEX[\s\S]{0,140}oc_sucursal, oc_folio\)[\s\S]{0,60}WHERE oc_folio IS NOT NULL/);
  });

  it('⛔ NEGATIVA: no se crea una llave foránea — la OC vive en Kepler, no acá', () => {
    // ADR-040: integrar, no construir. Una FK exigiría una tabla propia de órdenes.
    expect(MIG_SQL).not.toMatch(/references|foreign/i);
  });
});

describe('[RQ.15] lo que no se capturó se DECLARA, no se inventa', () => {
  it('⭐⭐ nace NULLABLE y sin backfill', () => {
    // Las 53 `ordered` que ya existen no tienen de dónde sacar el folio: nadie lo capturó.
    // Inferirlo por cercanía de fecha e importe sería fabricar un vínculo que nadie verificó,
    // en la columna que después se usa para decir "esto se compró".
    expect(MIG_SQL).not.toMatch(/UPDATE commercial\.purchase_requisitions/);
    // ⚠️ `NOT NULL` a secas NO sirve de negativa: casa con el `WHERE oc_folio IS NOT NULL` del
    // índice parcial, que es correcto y necesario. Se mide la DECLARACIÓN de la columna.
    expect(MIG_SQL).not.toMatch(/\.notNullable\(\)/);
    expect(MIG_SQL).not.toMatch(/SET NOT NULL/);
  });

  it('⭐ y queda quién capturó el folio, aparte de quién movió el estado', () => {
    // Con el tiempo marcar el estado se automatiza; capturar el folio sigue siendo una persona
    // mirando un papel. Guardar los dos en el mismo campo borraría esa diferencia.
    expect(MIG).toContain('oc_capturada_por');
    expect(cuerpo('setEstado')).toMatch(/oc_capturada_por = userId|oc_capturada_por.*userId/);
  });

  it('el `down` deshace exactamente lo que hizo el `up`', () => {
    expect(MIG).toMatch(/exports\.down[\s\S]*dropColumn/);
    expect(MIG).toMatch(/exports\.down[\s\S]*DROP INDEX IF EXISTS/);
  });
});

describe('[RQ.15] la pantalla, que era lo que de verdad faltaba', () => {
  const RAIZ = join(DIR, '..', '..', '..', '..', '..');
  const PANT = readFileSync(join(RAIZ, 'apps', 'view', 'src', 'app', 'modules', 'compras', 'pages', 'compras-requisiciones.component.ts'), 'utf8');
  const CLI = readFileSync(join(RAIZ, 'apps', 'view', 'src', 'app', 'modules', 'compras', 'compras.service.ts'), 'utf8');

  it('⭐⭐ existe un lugar donde teclear el folio', () => {
    // El endpoint y el método del cliente existían desde RA.14 y NINGÚN componente los llamaba.
    // Hacer el folio obligatorio en el backend no sirve de nada sin esto.
    expect(PANT).toContain('abrirOc');
    expect(PANT).toContain('guardarOc');
    expect(PANT).toContain('markOrdered');
  });

  it('⛔ y manda las DOS coordenadas', () => {
    expect(PANT).toMatch(/markOrdered\(r\.id, \{ oc_sucursal: suc, oc_folio: fol \}\)/);
  });

  it('⭐ el botón sólo aparece en las APROBADAS', () => {
    // En una pendiente no hay nada que ordenar todavía; en una ya ordenada el folio ya está.
    expect(PANT).toMatch(/@if \(r\.estado === 'approved'\) \{[\s\S]{0,400}abrirOc\(r\)/);
  });

  it('⛔ una `ordered` SIN folio se DECLARA, no se deja en blanco', () => {
    // Son las 53 que se ordenaron antes de que la columna existiera. Un blanco se lee como
    // "todavía no lo capturaron"; «sin OC» dice que ya no se va a poder.
    expect(PANT).toMatch(/@else if \(r\.estado === 'ordered'\) \{[\s\S]{0,300}sin OC/);
  });

  it('⛔ el error NO cierra el diálogo: lo tecleado se puede corregir', () => {
    // El 409 del índice único es el caso real (ese folio ya está en otra requisición). Cerrar
    // borraría el dato recién tecleado y la persona tendría que volver a escribirlo.
    // ⚠️ Se ancla a la DEFINICIÓN, no a la primera aparición: `guardarOc(` sale antes en el
    // template (`(keyup.enter)="guardarOc()"`) y el extractor traía ese pedazo de HTML.
    const i = PANT.indexOf('guardarOc(): void {');
    expect(i).toBeGreaterThan(0);
    const b = PANT.slice(i, i + 2200);
    expect(b).toContain('error:');
    expect(b).not.toMatch(/error:[\s\S]{0,400}ocVisible\.set\(false\)/);
  });

  it('⭐ el backend DEVUELVE el folio, o la pantalla nunca podría mostrarlo', () => {
    expect(SVC).toMatch(/oc_sucursal' AS oc_sucursal/);
    expect(SVC).toMatch(/oc_folio'\s+AS oc_folio/);
    expect(CLI).toContain('oc_folio?: string | null');
  });

  it('⚠️ y se piden con `to_jsonb` para no romper si el código llega antes que la migración', () => {
    // El deploy y las migraciones viajan por caminos distintos y ya llegaron desordenados antes
    // en este repo. Una columna directa daría 42703 y tiraría la lista entera.
    expect(SVC).toContain(`to_jsonb(r) ->> 'oc_folio'`);
  });
});
