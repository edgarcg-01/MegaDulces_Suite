import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[TDA.2]` — El mostrador dice DE DÓNDE salió el precio, y ya no publica una fila arbitraria.
 *
 * ── El defecto que se corrigió ──────────────────────────────────────────────
 * `kepler_ods.kdii` trae UNA FILA POR SUCURSAL. `/api/kp/precio` hacía `ORDER BY c1 LIMIT 1` sin
 * filtrar por plaza, así que se quedaba con la primera fila que Postgres devolviera — en orden
 * **arbitrario**. El número del mostrador podía cambiar solo cada vez que una sucursal se
 * re-sincronizaba, y podía ser el de **CEDIS** (`sucursal='00'`), que es exactamente la fila que la
 * etiquetera excluye a propósito.
 *
 * **Medido en prod el 2026-09-09: 712 de 9,348 códigos (7.6 %)** tienen más de un precio base
 * entre plazas. El comentario que vivía en `kp.service.ts` decía 385: la cifra había envejecido y
 * el defecto afectaba a casi el doble de productos de lo que el propio código declaraba.
 *
 * Y la otra mitad: la etiquetera respeta `source='manual'` (un precio corregido a mano, que el
 * importer nunca pisa) mientras el mostrador leía el ERP crudo. **Medido: hoy hay CERO filas
 * `manual` en prod**, así que ese defecto estaba latente, no activo — se arregla porque el día que
 * alguien use el override no puede ser el día en que se descubra que el mostrador lo ignora.
 *
 * Lo que este candado NO cubre —y hay que decirlo— es la pregunta de fondo: la etiquetera imprime
 * la MODA DE LA RED (excluyendo CEDIS) y el mostrador contesta por plaza. Son dos preguntas
 * distintas y cuál corresponde a la etiqueta del anaquel es una decisión de negocio, no de código.
 * Queda declarada como deuda, no resuelta por omisión.
 */

const SVC = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'apps', 'api', 'src', 'modules', 'kp', 'kp.service.ts'), 'utf8');
const CTRL = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'apps', 'api', 'src', 'modules', 'kp', 'kp.controller.ts'), 'utf8');
const FRONT = readFileSync(join(__dirname, 'verificador.service.ts'), 'utf8');
const PAGE = readFileSync(join(__dirname, 'pages', 'tienda-verificador.component.ts'), 'utf8');

describe('verificador · de qué plaza salió el precio', () => {
  it('el endpoint acepta sucursal', () => {
    expect(CTRL).toMatch(/getPrecio\(@Query\('q'\) q: string, @Query\('sucursal'\) sucursal\?: string\)/);
    expect(SVC).toMatch(/async getPrecio\(q: string, sucursal\?: string\)/);
  });

  // LA NEGATIVA DEL DEFECTO: si volviera el `LIMIT 1` sin orden por plaza, volvería el número
  // inestable. Se exige que el orden mande CEDIS al final y que no quede un LIMIT 1 arbitrario.
  it('ya NO se queda con una fila arbitraria', () => {
    const fn = /async getPrecio\([\s\S]*?\n  \}/.exec(SVC)![0];
    expect(fn).not.toMatch(/ORDER BY c1\s*\n\s*LIMIT 1/);
    expect(fn).toMatch(/ORDER BY \(TRIM\(sucursal::text\) = '00'\)/);
  });

  it('con sucursal contesta esa plaza; sin ella lo DECLARA', () => {
    const fn = /async getPrecio\([\s\S]*?\n  \}/.exec(SVC)![0];
    expect(fn).toMatch(/rows\.find\(\(x: any\) => x\.sucursal === suc\)/);
    // `precio_ambiguo` es el tercer estado: no es "está bien" ni "está mal", es "varía y no pude
    // acotarlo". Sin él la pantalla publicaría un número inestable como si fuera el único.
    expect(fn).toMatch(/const ambiguo = !suc && distintos\.size > 1/);
    expect(fn).toMatch(/precio_ambiguo: ambiguo/);
    // Y una plaza sin el producto no es un "no encontrado": el producto existe, no ahí.
    expect(fn).toMatch(/plaza_pedida_sin_dato/);
  });

  it('el override manual del anaquel gana, y se lee con el tenant puesto', () => {
    expect(SVC).toMatch(/l\.source = 'manual'/);
    // RLS FORCE + endpoint @Public(): sin el tenant en la MISMA tx la lectura vuelve vacía EN
    // SILENCIO si el rol es app_runtime, o sea el override desaparecería sin un solo error.
    const fn = /private async overrideManual\([\s\S]*?\n  \}/.exec(SVC)![0];
    expect(fn).toMatch(/SET LOCAL app\.tenant_id/);
    expect(fn).toMatch(/this\.db\.transaction/);
    // Es un refinamiento del precio, no el precio: si falla, el mostrador sigue contestando.
    expect(fn).toMatch(/catch[\s\S]*return null/);
  });

  it('el front manda la sucursal al live, no sólo al respaldo', () => {
    expect(FRONT).toMatch(/if \(sucursal\) params\['sucursal'\] = sucursal/);
    expect(FRONT).toMatch(/\{ params \}/);
  });

  // LA NEGATIVA QUE MÁS DUELE SI SE ROMPE: la procedencia tiene que resetearse en CADA resultado.
  // Pegada del producto anterior, la pantalla diría "precio corregido a mano" sobre uno que no lo
  // está — y eso es peor que no decir nada, porque suena a confirmación.
  it('la procedencia se resetea en cada resultado', () => {
    const fn = /private aplicar\(r: ResultadoBusqueda\): void \{[\s\S]*?\n  \}/.exec(PAGE)![0];
    for (const s of ['origenPrecio.set', 'precioAmbiguo.set', 'plazasDistintas.set', 'plazaSinDato.set']) {
      expect(fn).toContain(s);
    }
    // Con `??` y `=== true`: un campo ausente (el camino del respaldo no los trae) cae al valor
    // neutro, nunca a `undefined` colándose como verdadero.
    expect(fn).toMatch(/r\.origenPrecio \?\? 'kepler'/);
    expect(fn).toMatch(/r\.precioAmbiguo === true/);
  });

  it('la pantalla lo dice, no lo esconde', () => {
    expect(PAGE).toMatch(/origenPrecio\(\) === 'override_manual'/);
    expect(PAGE).toMatch(/precioAmbiguo\(\)/);
    expect(PAGE).toMatch(/plazaSinDato\(\)/);
  });
});
