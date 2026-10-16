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
  CaosFechaIlegibleError,
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

// ── `[CGP-L.5]` El día del depósito es el día de NEGOCIO en México ─────────────────────────────────
//
// El servicio manda `occurred_at` como ISO en UTC. Recortarlo daba el día en UTC: un depósito a las
// 19:00 del 12-oct «era» del 13, y podía consumir un cobro del 13 — dinero que todavía no existía.
describe('[CGP-L.5] el corte del depósito usa el día de México', () => {
  it('⛔ un depósito a las 19:00 del 12-oct NO consume un cobro del 13', () => {
    const { resultados } = repartirIngresosCaos(
      [dep(1, '2026-10-13T01:00:00.000Z', 500)],               // 19:00 del 12-oct en México
      [
        { origen_ref: 'A', fecha: '2026-10-12', monto: 300 },
        { origen_ref: 'B', fecha: '2026-10-13', monto: 500 },
      ],
    );
    const v = resultados[0].veredicto;
    expect(v.aplicaciones.map((a) => a.fecha)).toEqual(['2026-10-12']);
    expect(v).toMatchObject({ estado: 'sin_respaldo', cubierto: 300, faltante: 200 });
  });

  it('a mediodía del 13 sí lo consume', () => {
    const { resultados } = repartirIngresosCaos(
      [dep(1, '2026-10-13T18:00:00.000Z', 500)],
      [
        { origen_ref: 'A', fecha: '2026-10-12', monto: 300 },
        { origen_ref: 'B', fecha: '2026-10-13', monto: 500 },
      ],
    );
    expect(resultados[0].veredicto).toMatchObject({ estado: 'cubierto', cubierto: 500 });
  });
});

/**
 * ⛔⛔ `[CG.162]` — **El `Date` que devuelve node-pg para una columna `date`.**
 *
 * Estas pruebas existen porque las de arriba son verdes y el motor estuvo roto en producción:
 * todas alimentan `fecha: '2026-09-09'`, strings ya limpios, y el defecto vivía en el paso que
 * convierte la fila del driver en ese string. Medido el 2026-10-15: 755 depósitos / $18,500,100
 * declarados «sin respaldo» porque `String(fecha_valor).slice(0,10)` daba `"Wed May 27"`.
 *
 * La primera es la prueba de REGRESIÓN (el valor real del driver tiene que funcionar); la segunda
 * y la tercera son las NEGATIVAS: una fecha que no se entiende tiene que GRITAR, nunca volver a
 * degradarse en silencio a «este dinero no tiene respaldo».
 */
describe('[CG.162] fecha ilegible: grita, no acusa', () => {
  it('un `Date` de node-pg (columna `date`) se lee como su día, no como "Wed May 27"', () => {
    // Exactamente lo que devuelve el driver: medianoche LOCAL del día de la columna.
    const fechaDelDriver = new Date(2026, 8, 9); // 2026-09-09 00:00 local
    const { resultados } = repartirIngresosCaos(
      [dep(1, '2026-09-10T18:00:00Z', 5000)],
      [{ origen_ref: 'a', fecha: fechaDelDriver, monto: 5000 }],
    );
    const v = resultados[0].veredicto;
    expect(v).toMatchObject({ estado: 'cubierto', cubierto: 5000 });
    expect(v.aplicaciones[0].fecha).toBe('2026-09-09');
  });

  it('⛔ el defecto exacto de prod: "Wed May 27" ya NO puede pasar por fecha', () => {
    expect(() => repartirIngresosCaos(
      [dep(1, '2026-09-10T18:00:00Z', 5000)],
      [{ origen_ref: 'a', fecha: 'Wed May 27', monto: 5000 }],
    )).toThrow(CaosFechaIlegibleError);
  });

  it('⛔ y el mensaje dice con qué reemplazarlo, no sólo que falló', () => {
    expect(() => repartirIngresosCaos(
      [dep(1, '2026-09-10T18:00:00Z', 5000)],
      [{ origen_ref: 'cobro-X', fecha: 'Wed May 27', monto: 5000 }],
    )).toThrow(/cobro-X.*diaDeFecha/s);
  });

  it('⛔ un depósito con instante ilegible tampoco se degrada a «sin respaldo»', () => {
    expect(() => repartirIngresosCaos(
      [{ device: 'AST700-19758', external_id: 9, occurred_at: 'no-es-una-fecha', total: 100 }],
      [{ origen_ref: 'a', fecha: '2026-09-09', monto: 5000 }],
    )).toThrow(CaosFechaIlegibleError);
  });

  it('la ley medida en prod se mantiene: cobros anteriores cubren el depósito al 100%', () => {
    // Saldo corrido real (2026-10-15): nunca negativo, peor saldo +$18,726.
    const { resultados } = repartirIngresosCaos(
      [dep(1, '2026-05-27T20:00:00Z', 18726)],
      [{ origen_ref: 'a', fecha: new Date(2026, 4, 27), monto: 18726 }],
    );
    expect(resultados[0].veredicto.estado).toBe('cubierto');
  });
});
