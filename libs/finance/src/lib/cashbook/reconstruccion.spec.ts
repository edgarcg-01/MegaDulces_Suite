import type { MovimientoCaos } from './identidad';
import { diferenciaContraTestigo, piezasDe, reproducirCaos } from './reconstruccion';
import type { Contexto } from './reglas';

/**
 * `[LE.3.4]` — La reconstrucción en memoria: suma lo que la máquina hace con las MISMAS reglas que
 * el libro, se compara contra la foto de «Fin de Día» y DECLARA una bóveda que pediría billetes
 * que no tiene. (La medición contra prod está en el plan: el 20-oct cuadra en las 5 denominaciones.)
 */
const CTX: Contexto = { actor: { kind: 'servicio', service: 'reconstruccion' }, valueAt: '' };
let n = 0;
const mov = (type_id: number, type_label: string, piezas: [number, number][], total?: string): MovimientoCaos => {
  n += 1;
  const suma = piezas.reduce((s, [d, q]) => s + Math.abs(d) * q, 0);
  return {
    device: 'AST-T', external_id: n, type_id, type_label, occurred_at: new Date(Date.UTC(2026, 9, 15, 12, n)).toISOString(),
    total: total ?? `${suma}.00`, ref: type_id === 0 ? 'ruta 27 151026' : null, user_external: 'x',
    piezas: piezas.map(([d, q]) => ({ denom: String(d), pieza_tipo: 'B', quantity: String(q) })),
  };
};

describe('[LE.3.4] reconstrucción contra los testigos de la máquina', () => {
  it('depósitos, retiros y un cambio llegan EXACTO a la foto de «Fin de Día»', () => {
    const r = reproducirCaos([
      mov(0, 'Deposito', [[500, 10], [200, 5]]),
      mov(4, 'Dispensar', [[500, 3]]),
      mov(0, 'Deposito', [[100, 7]]),
      mov(7, 'Cambio', [[500, 1], [-100, 5]], '0'),   // sólo puede dar los $100 que ya tiene
      mov(2, 'Fin de Dia', [[500, 8], [200, 5], [100, 2]]),
    ], CTX);
    expect(r.puntos).toHaveLength(1);
    expect(r.puntos[0]).toMatchObject({ tipo: 'fin_de_dia', cuadra: true });
    expect(r.negativos).toEqual([]);
    expect(r.sinRegla).toEqual([]);
  });

  it('NEGATIVA: un movimiento que falta se ve en la foto, por denominación', () => {
    const r = reproducirCaos([mov(0, 'Deposito', [[500, 10]]), mov(2, 'Fin de Dia', [[500, 10], [200, 1]])], CTX);
    expect(r.puntos[0].cuadra).toBe(false);
    expect(diferenciaContraTestigo(r.puntos[0].libro, r.puntos[0].testigo ?? {})).toEqual({ 200: '-1' });
  });

  it('NEGATIVA: un retiro de billetes que la bóveda no tiene se DECLARA (no se esconde ni revienta)', () => {
    const r = reproducirCaos([mov(0, 'Deposito', [[500, 2]]), mov(4, 'Dispensar', [[500, 5]])], CTX);
    expect(r.negativos).toHaveLength(1);
    expect(r.negativos[0].detalle.join()).toMatch(/BOVEDA_CAOS 500 = -3/);
  });

  it('«Contenido Modificado» y un vaciado que no coincide con su desglose quedan fuera, con motivo', () => {
    const r = reproducirCaos([
      mov(13, 'Contenido Modificado', [], '-25420.00'),
      mov(5, 'Vaciar Stocks', [[500, 172]], '20.00'),
    ], CTX);
    expect(r.sinRegla.map((s) => s.motivo).join(' | ')).toMatch(/Contenido Modificado.*\|.*no coincide con su desglose/);
    expect(piezasDe(r.libro, 'BOVEDA_CAOS')).toEqual({});
  });

  it('el orden lo pone la numeración de la máquina, no el orden en que llegan', () => {
    const a = mov(0, 'Deposito', [[500, 2]]);
    const b = mov(4, 'Dispensar', [[500, 2]]);
    expect(reproducirCaos([b, a], CTX).negativos).toEqual([]);
  });
});
