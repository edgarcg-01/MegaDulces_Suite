import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[PGP.123]` G.UI.2 — Candado de **la cola «Esperan a Kepler» viaja con lo capturado**.
 *
 * `finance.v_expense_proofs` arma `importe` como `COALESCE(saldo del gasto, total de la solicitud, lo capturado)`:
 * en una solicitud cancelada en Kepler ese saldo es 0, y la cola preguntaba «¿salió dinero?» junto a «$0.00».
 * Medido el 2026-11-15 en la cola con los vales reales: vales de $712.43, $1,500 y $4,600. La vista ya traía
 * `importe_capturado` e `importe_fuente`; faltaba pedirlos.
 *
 * Se vigila sobre el texto porque la regresión es la consulta reescrita a mano, y eso no lo ve una prueba de la
 * pantalla con datos de mentira.
 */
const soloCodigo = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8'));
const inicio = SERVICIO.indexOf('async esperanKepler(');
const METODO = SERVICIO.slice(inicio, SERVICIO.indexOf('async buscarGastos(', inicio));

describe('[PGP.123] G.UI.2 esperanKepler: lo capturado viaja con la fila', () => {
  it('el método existe donde se busca (si se mueve, este candado se tiene que mover con él)', () => {
    expect(inicio).toBeGreaterThan(0);
    expect(METODO.length).toBeGreaterThan(200);
  });

  it('la consulta pide lo capturado y la fuente del monto', () => {
    expect(METODO).toContain('importe_capturado::numeric AS importe_capturado, importe_fuente');
  });

  it('⛔ la fila devuelve lo capturado como null cuando no hay (no como 0) y la fuente tal cual', () => {
    expect(METODO).toContain('importe_capturado: f.importe_capturado == null ? null : Number(f.importe_capturado)');
    expect(METODO).toContain('importe_fuente: f.importe_fuente ?? null');
  });
});

/**
 * `[PGP.122]` La solicitud que nació en la Suite y Kepler rechazó caía en la cola como «No se pudo leer su estado en
 * Kepler», plegada y sin poder abrirse (medido con Playwright el 2026-11-19). La cola ahora trae cómo va su escritura,
 * y el buscador abre un vale por su id (el renglón sin folio no tiene otra llave). La prueba de base real es el bloque
 * O de `database/tests/test-newdb-comprobacion-gasto-suite.js`; esto cuida que la consulta no se reescriba sin ellos.
 */
describe('[PGP.122] esperanKepler y buscarGastos: la solicitud sin escribir', () => {
  const BUSCAR = SERVICIO.slice(SERVICIO.indexOf('async buscarGastos('), SERVICIO.indexOf('async buscarGastos(') + 3000);

  it('la cola pide la escritura de la solicitud, sólo si la columna existe', () => {
    expect(METODO).toContain(`hasColumn('expense_proofs', 'kepler_request_status')`);
    expect(METODO).toContain('ep.kepler_request_status, ep.kepler_request_note, ep.kepler_request_next_at, ep.kepler_request_attempts');
    expect(METODO).toContain('LEFT JOIN finance.expense_proofs ep ON ep.id = v.id');
  });

  it('⛔ sólo el vale que NACIÓ en la Suite trae nace_en_la_suite', () => {
    expect(METODO).toContain(`conSolicitud && f.origen === 'solicitud'`);
  });

  it('el buscador abre un vale por su id, antes de la búsqueda por texto', () => {
    const id = BUSCAR.indexOf(`.where('p.id', q.toLowerCase())`);
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThan(BUSCAR.indexOf('applySmartSearch'));
  });
});
