/**
 * [PU.VG.3] — Qué se puede materializar sin un supuesto de gasto firmado.
 *
 * Unitaria de verdad: funciones puras, sin Postgres.
 *
 * ⭐ Hay DOS ejes acá y el segundo es el que casi sale mal:
 *   1. que la compuerta FRENE lo que tiene que frenar;
 *   2. que al frenarlo **no destruya nada** — `materialize` cierra toda partida `source='plan'`
 *      cuyo `source_ref` no quedó en `seen` (`status='cerrada'`, `vigente_amount = 0`). Una
 *      compuerta que omitiera las bloqueadas cerraría las 40 partidas de gasto que ya existen en
 *      prod, con vigente en cero. El primer diseño hacía exactamente eso.
 */
import { supuestoGastoFirmado, accionMaterializacion, huerfanasQueSeCierran, AUTOR_MAQUINA } from './budget-materialize.policy';

describe('supuestoGastoFirmado · qué cuenta como firma', () => {
  it('una persona que tocó los supuestos, firma', () => {
    expect(supuestoGastoFirmado({ existe: true, autor: 'edgar' })).toBe(true);
  });

  it('⭐ un supuesto de 0 % TAMBIÉN está firmado: congelar el gasto es una decisión', () => {
    // La firma es el HECHO de que alguien decidió, no el valor que decidió. Si la firma fuera
    // «el crecimiento es distinto de cero», una decisión legítima se leería como ausencia.
    expect(supuestoGastoFirmado({ existe: true, autor: 'direccion' })).toBe(true);
  });

  it('sin fila, no hay firma — el estado real de prod hoy (0 filas)', () => {
    expect(supuestoGastoFirmado({ existe: false })).toBe(false);
    expect(supuestoGastoFirmado(null)).toBe(false);
    expect(supuestoGastoFirmado(undefined)).toBe(false);
  });

  it('⛔ la MÁQUINA no firma presupuestos [PRUEBA NEGATIVA]', () => {
    // El autopiloto ya escribe `sales_plan_settings` (3 filas con created_by='autopilot' en prod).
    // Si mañana alguien lo cablea a escribir las de gasto, esta compuerta se volvería un no-op en
    // silencio — y un gate que se apaga solo es peor que no tenerlo.
    expect(supuestoGastoFirmado({ existe: true, autor: AUTOR_MAQUINA })).toBe(false);
    expect(supuestoGastoFirmado({ existe: true, autor: 'AutoPilot' })).toBe(false);
    expect(supuestoGastoFirmado({ existe: true, autor: '  autopilot  ' })).toBe(false);
  });

  it('una fila sin autor no cuenta: «no se sabe quién» no es una firma', () => {
    expect(supuestoGastoFirmado({ existe: true, autor: null })).toBe(false);
    expect(supuestoGastoFirmado({ existe: true, autor: '   ' })).toBe(false);
    expect(supuestoGastoFirmado({ existe: true })).toBe(false);
  });
});

describe('accionMaterializacion · qué se escribe', () => {
  it('gasto sin firma: bloqueado', () => {
    expect(accionMaterializacion({ esGastoDerivadoDelPlan: true, firmado: false })).toBe('bloqueado_sin_firma');
  });
  it('gasto con firma: se escribe', () => {
    expect(accionMaterializacion({ esGastoDerivadoDelPlan: true, firmado: true })).toBe('escribir');
  });
  it('⭐ el INGRESO no se bloquea: es otro carril y otra firma', () => {
    expect(accionMaterializacion({ esGastoDerivadoDelPlan: false, firmado: false })).toBe('escribir');
  });
});

describe('huerfanasQueSeCierran · ⛔ LA TRAMPA: bloquear no puede destruir', () => {
  const existentes = ['gasto:601:', 'gasto:602:', 'ingreso:mostrador:01'];

  it('una partida de gasto BLOQUEADA sigue en `seen` y NO se cierra', () => {
    // Asi queda el conjunto con la compuerta correcta: las bloqueadas entran igual.
    const seen = ['gasto:601:', 'gasto:602:', 'ingreso:mostrador:01'];
    expect(huerfanasQueSeCierran(seen, existentes)).toEqual([]);
  });

  it('⛔ si las bloqueadas se omitieran del conjunto, se cerrarían — el diseño que se descartó', () => {
    // Esto es lo que habria pasado con el primer diseno: saltar las de gasto al ARMAR el conjunto.
    const seenMalo = ['ingreso:mostrador:01'];
    expect(huerfanasQueSeCierran(seenMalo, existentes)).toEqual(['gasto:601:', 'gasto:602:']);
  });

  it('y lo que SÍ tiene que cerrarse sigue cerrándose: una partida que salió del plan', () => {
    const seen = ['gasto:601:', 'ingreso:mostrador:01'];
    expect(huerfanasQueSeCierran(seen, existentes)).toEqual(['gasto:602:']);
  });
});
