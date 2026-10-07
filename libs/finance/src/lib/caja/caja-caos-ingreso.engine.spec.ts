/**
 * `[CG.58]` — Pruebas del reparto de ingresos de CAOS.
 *
 * Las que definen la entrega son negativas:
 *   · un cobro POSTERIOR al depósito **no** lo respalda — forzarlo fabricaría un respaldo que no
 *     existe y rompería la ley del proceso («primero Kepler, después CAOS»);
 *   · un cobro **no se usa dos veces** — si se reusara, el 100% sería de mentira;
 *   · el reparto **no depende del orden en que llegan las filas**, o no se puede auditar.
 */
import {
  repartirIngresosCaos, resumirReparto,
  type CobroDisponible, type DepositoCaos,
} from './caja-caos-ingreso.engine';

const dep = (id: number, occurred_at: string, total: number): DepositoCaos =>
  ({ device: 'AST700-19758', external_id: id, occurred_at, total });
const cob = (ref: string, fecha: string, monto: number, consumido = 0): CobroDisponible =>
  ({ origen_ref: ref, fecha, monto, consumido });

describe('repartirIngresosCaos — el ingreso se cubre con cobros ANTERIORES', () => {
  it('varios cobros forman un depósito: el vínculo es N:1, no 1:1', () => {
    // Medido en prod: los depósitos son múltiplos de 10 y el 57% de los cobros traen centavos,
    // así que el 1:1 por importe es imposible por construcción (3.5% de casos).
    const r = repartirIngresosCaos(
      [dep(1, '2026-09-10T18:00:00Z', 10000)],
      [cob('a', '2026-09-08', 3877.24), cob('b', '2026-09-09', 4122.76), cob('c', '2026-09-09', 5000)],
    );
    const v = r.resultados[0].veredicto;
    expect(v.estado).toBe('cubierto');
    expect(v.aplicaciones.length).toBe(3);
    expect(v.cubierto).toBe(10000);
    // El último entra PARCIAL: 3877.24 + 4122.76 = 8000, faltan 2000 de los 5000 de "c".
    expect(v.aplicaciones[2]).toEqual({ origen_ref: 'c', fecha: '2026-09-09', monto: 2000, parcial: true });
    // Y lo que sobra de "c" queda disponible: es efectivo cobrado y no depositado.
    expect(r.sinDepositar).toEqual([{ origen_ref: 'c', fecha: '2026-09-09', disponible: 3000 }]);
  });

  it('⛔ [negativa] un cobro POSTERIOR al depósito no lo respalda', () => {
    const r = repartirIngresosCaos(
      [dep(1, '2026-09-10T18:00:00Z', 5000)],
      [cob('tarde', '2026-09-11', 99999)],
    );
    const v = r.resultados[0].veredicto;
    expect(v.estado).toBe('sin_respaldo');
    expect(v.aplicaciones).toEqual([]);
    if (v.estado === 'sin_respaldo') expect(v.faltante).toBe(5000);
    // El cobro tardío sigue entero y disponible: no se tocó.
    expect(r.sinDepositar).toEqual([{ origen_ref: 'tarde', fecha: '2026-09-11', disponible: 99999 }]);
  });

  it('el cobro del MISMO día sí respalda: la ley es "antes o el mismo día"', () => {
    const r = repartirIngresosCaos(
      [dep(1, '2026-09-10T18:00:00Z', 5000)],
      [cob('hoy', '2026-09-10', 5000)],
    );
    expect(r.resultados[0].veredicto.estado).toBe('cubierto');
  });

  it('⛔ [negativa] un cobro NO se usa dos veces: sin esto el 100% sería de mentira', () => {
    const r = repartirIngresosCaos(
      [dep(1, '2026-09-10T10:00:00Z', 6000), dep(2, '2026-09-11T10:00:00Z', 6000)],
      [cob('unico', '2026-09-09', 10000)],
    );
    const [a, b] = r.resultados.map((x) => x.veredicto);
    expect(a.estado).toBe('cubierto');            // consume 6000 de los 10000
    expect(b.estado).toBe('sin_respaldo');        // le quedan 4000: falta 2000
    if (b.estado === 'sin_respaldo') {
      expect(b.cubierto).toBe(4000);
      expect(b.faltante).toBe(2000);
    }
    expect(r.sinDepositar).toEqual([]);
  });

  it('los depósitos se procesan del más VIEJO al más nuevo, llegue como llegue la lista', () => {
    const cobros = [cob('x', '2026-09-01', 1000)];
    const ordenA = repartirIngresosCaos([dep(1, '2026-09-05T10:00:00Z', 600), dep(2, '2026-09-06T10:00:00Z', 600)], cobros);
    const ordenB = repartirIngresosCaos([dep(2, '2026-09-06T10:00:00Z', 600), dep(1, '2026-09-05T10:00:00Z', 600)], cobros);
    // Mismo reparto: el 05 se lleva 600 y el 06 queda corto, venga como venga la lista.
    const clave = (r: ReturnType<typeof repartirIngresosCaos>) =>
      r.resultados.map((x) => [x.deposito.external_id, x.veredicto.estado, x.veredicto.cubierto].join('|')).join(' ');
    expect(clave(ordenA)).toBe(clave(ordenB));
    expect(clave(ordenA)).toBe('1|cubierto|600 2|sin_respaldo|400');
  });

  it('un cobro ya consumido a medias arranca por su saldo, no por su monto', () => {
    const r = repartirIngresosCaos(
      [dep(1, '2026-09-10T10:00:00Z', 1000)],
      [cob('medio', '2026-09-01', 5000, 4500)],   // le quedan 500
    );
    const v = r.resultados[0].veredicto;
    expect(v.cubierto).toBe(500);
    expect(v.estado).toBe('sin_respaldo');
  });

  it('el resumen publica el efectivo cobrado y NO depositado, que es el dato que falta hoy', () => {
    const r = repartirIngresosCaos(
      [dep(1, '2026-09-10T10:00:00Z', 1000)],
      [cob('a', '2026-09-01', 1000), cob('b', '2026-09-02', 18800)],
    );
    expect(resumirReparto(r)).toEqual({
      depositos: 1,
      cubiertos: 1,
      sin_respaldo: 0,
      monto_depositado: 1000,
      monto_respaldado: 1000,
      monto_faltante: 0,
      monto_sin_depositar: 18800,
    });
  });

  it('el centavo del redondeo no deja tramos fantasma', () => {
    const r = repartirIngresosCaos(
      [dep(1, '2026-09-10T10:00:00Z', 100)],
      [cob('a', '2026-09-01', 100.004)],
    );
    expect(r.resultados[0].veredicto.estado).toBe('cubierto');
    // Lo que sobra (menos de un centavo) NO se publica como disponible.
    expect(r.sinDepositar).toEqual([]);
  });

  it('sin cobros, ningún depósito se cubre — y no se inventa respaldo', () => {
    const r = repartirIngresosCaos([dep(1, '2026-09-10T10:00:00Z', 1000)], []);
    const v = r.resultados[0].veredicto;
    expect(v.estado).toBe('sin_respaldo');
    expect(v.cubierto).toBe(0);
  });
});
