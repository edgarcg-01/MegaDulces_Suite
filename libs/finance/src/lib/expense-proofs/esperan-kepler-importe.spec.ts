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
