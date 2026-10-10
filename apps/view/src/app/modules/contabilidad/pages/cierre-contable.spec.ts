import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// ⚠️ Por SUBRUTA: el barrel `@megadulces/contracts` **no re-exporta `authz` a propósito**
// (`[ID.28]`). Importarlo de ahí compila y deja `AUTHZ_TREE` en `undefined`, con lo que la
// búsqueda devuelve `null` y el candado parece decir "el nodo no existe".
import { AUTHZ_TREE } from '@megadulces/contracts/authz/authz-tree';
import { faltantesDe, peorDeCerrados, soloCerrados, textoEstado } from './contabilidad-cierre.component';
import type { MesCierre, EstadoCierre, FamiliaCierre } from '../cierre-contable.service';

/**
 * `[CPA.0]` — Candado del **semáforo de cierre** del lado de la pantalla.
 *
 * Dos cosas distintas, porque fallan por motivos distintos:
 *
 *  1. **El cableado** ruta ↔ guard ↔ pestaña ↔ nodo del árbol. Nace del defecto que ya ocurrió
 *     dos veces en este mismo módulo: `[CP.8.33]` declaró el nodo del puente apuntando a
 *     `/contabilidad/contpaqi`, que es OTRA página con OTRO permiso, y nadie lo hubiera visto
 *     hasta que alguien hiciera clic y el guard lo rebotara (`[IC.13]`). Acá se comprueba además
 *     algo propio de esta fase: que el permiso sea **el que ya está repartido**, porque si
 *     estrenara uno, la pantalla entraría a prod sin que nadie pudiera abrirla (`[LC.6.2]`).
 *  2. **Las reglas de lectura**, que es lo único de esta pantalla que puede mentir con un número.
 *
 * El (1) se lee de los archivos como TEXTO en vez de importar `app.routes.ts`: ese módulo
 * arrastra guards, PrimeNG y media app, y un candado no debería depender de 300 imports
 * transitivos cargando en jsdom. Es configuración estructural, no comportamiento.
 */

const RAIZ = join(__dirname, '..', '..', '..', '..', '..', '..', '..');
const leer = (p: string) => readFileSync(join(RAIZ, p), 'utf8');

const RUTA = '/contabilidad/cierre';
const PERMISO = 'FISCAL_CONTAB_VER';

/**
 * ⚠️ El árbol es de DOS niveles (`projects` → `modules`), no una lista plana de módulos. Lo
 * escribí plano primero y estas tres pruebas se pusieron rojas: un `flatMap` de un nivel no
 * encuentra el nodo y el candado habría dicho "no existe" sobre algo que sí estaba. Mismo
 * recorrido recursivo que usa el candado hermano de `[CP.8.33]`.
 */
interface Nodo { id: string; route?: string; view?: string[]; manage?: string[]; projects?: Nodo[]; modules?: Nodo[]; }

function todosLosNodos(nodos: readonly Nodo[]): Nodo[] {
  return (nodos ?? []).flatMap((n) => [n, ...todosLosNodos((n.projects ?? n.modules ?? []) as Nodo[])]);
}

const NODOS = todosLosNodos(AUTHZ_TREE as unknown as Nodo[]);
const nodoDe = (ruta: string) => NODOS.find((n) => n.route === ruta) ?? null;

describe('[CPA.0] cierre contable — cableado', () => {
  const rutas = leer('apps/view/src/app/app.routes.ts');
  const tabs = leer('apps/view/src/app/modules/contabilidad/contabilidad-tabs.ts');

  it('la ruta existe y la gatea el permiso correcto', () => {
    const bloque = rutas.slice(rutas.indexOf("path: 'cierre'"));
    expect(bloque.slice(0, 400)).toContain('contabilidad-cierre.component');
    expect(bloque.slice(0, 400)).toContain(`permissionGuard(Permission.${PERMISO})`);
  });

  it('la pestaña apunta a la misma ruta y pide el mismo permiso', () => {
    const linea = tabs.split('\n').find((l) => l.includes(RUTA));
    expect(linea).toBeTruthy();
    expect(linea).toContain(`Permission.${PERMISO}`);
  });

  it('el nodo del árbol apunta a la misma ruta, con el mismo permiso de lectura', () => {
    const nodo = nodoDe(RUTA);
    expect(nodo).toBeTruthy();
    expect(nodo?.view).toEqual([PERMISO]);
  });

  it('⭐ NO estrena permiso: el mismo que ya usa otra pantalla del proyecto, o sea ya repartido', () => {
    const otros = NODOS.filter((m) => m.route !== RUTA && (m.view ?? []).includes(PERMISO));
    expect(otros.length).toBeGreaterThan(0);
  });

  it('⛔ NEGATIVA — no se gatea con el permiso del PUENTE: son dos públicos distintos', () => {
    const bloque = rutas.slice(rutas.indexOf("path: 'cierre'"), rutas.indexOf("path: 'cierre'") + 400);
    expect(bloque).not.toContain('FISCAL_CONTPAQI_BRIDGE_VER');
  });

  it('⛔ sin `manage`: esta pantalla señala, no asienta (ADR-040)', () => {
    expect(nodoDe(RUTA)?.manage).toEqual([]);
  });
});

// ── Las reglas de lectura ──────────────────────────────────────────────────────────────────

const fam = (over: Partial<FamiliaCierre> = {}): FamiliaCierre => ({
  familia: 'compras',
  etiqueta: 'Compras del mes',
  senal_cuentas: 'abonos 2120*',
  senal: 0,
  senal_renglones: 0,
  provisional: null,
  testigo: 45141396,
  testigo_fuente: 'fiscal.cfdis recibidas',
  cobertura_base: 'testigo',
  mediana_6m: null,
  cobertura: 0,
  estado: 'bad',
  motivo: null,
  escala_a: 'jefe_finanzas',
  umbral: { target: 0.5, warn_at: 0.2, escalate_at: 0.1 },
  ...over,
});

const mes = (over: Partial<MesCierre> = {}): MesCierre => ({
  anio_mes: '2026-09',
  periodo_estado: 'cerrado',
  estado: 'bad',
  conteo: { ok: 0, warn: 0, bad: 1, sin_meta: 0, sin_medir: 0 },
  familias: [fam()],
  ...over,
});

describe('[CPA.0] qué entra al titular', () => {
  it('septiembre-2026 compras entra, con su testigo y a quién escala', () => {
    const f = faltantesDe([mes()]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ mes: '2026-09', familia: 'compras', renglones: 0, escala_a: 'jefe_finanzas' });
  });

  it('⛔ NEGATIVA — el mes EN CURSO no entra aunque sus familias se vean mal', () => {
    const enCurso = mes({ anio_mes: '2026-10', periodo_estado: 'en_curso' });
    expect(faltantesDe([enCurso])).toHaveLength(0);
    expect(soloCerrados([enCurso])).toHaveLength(0);
  });

  it('⛔ NEGATIVA — `sin_meta` y `sin_medir` NO entran: son trabajo de otra persona', () => {
    const m = mes({ familias: [fam({ estado: 'sin_meta' }), fam({ familia: 'ventas', estado: 'sin_medir' })] });
    expect(faltantesDe([m])).toHaveLength(0);
  });

  it('cuando la base es `historia`, el testigo que se publica es la mediana, no un null', () => {
    const m = mes({ familias: [fam({ cobertura_base: 'historia', testigo: null, mediana_6m: 4_200_000, testigo_fuente: null })] });
    expect(faltantesDe([m])[0]).toMatchObject({ testigo: 4_200_000, testigo_fuente: 'mediana de 6 meses' });
  });
});

describe('[CPA.0] el color del encabezado', () => {
  it('un mes cerrado en rojo manda sobre los verdes', () => {
    expect(peorDeCerrados([mes({ anio_mes: '2026-08', estado: 'ok' }), mes()])).toBe('bad');
  });

  it('todos verdes → verde', () => {
    expect(peorDeCerrados([mes({ estado: 'ok' }), mes({ anio_mes: '2026-08', estado: 'ok' })])).toBe('ok');
  });

  it('⛔ NEGATIVA — sin meses cerrados devuelve sin_medir, NO ok: vacío no es sano', () => {
    expect(peorDeCerrados([])).toBe('sin_medir');
    expect(peorDeCerrados([mes({ periodo_estado: 'en_curso', estado: 'ok' })])).toBe('sin_medir');
  });

  it('⛔ NEGATIVA — un `sin_meta` no se cuela como verde', () => {
    expect(peorDeCerrados([mes({ estado: 'ok' }), mes({ anio_mes: '2026-08', estado: 'sin_meta' })]))
      .toBe('sin_medir');
  });
});

describe('[CPA.0] las dos ausencias se leen distinto', () => {
  it('cada estado tiene su palabra, y ninguna se repite', () => {
    const todos: EstadoCierre[] = ['ok', 'warn', 'bad', 'sin_meta', 'sin_medir'];
    const textos = todos.map(textoEstado);
    expect(new Set(textos).size).toBe(todos.length);
  });

  it('⛔ `sin_meta` y `sin_medir` NO dicen lo mismo: se arreglan por caminos distintos', () => {
    expect(textoEstado('sin_meta')).not.toBe(textoEstado('sin_medir'));
  });
});
