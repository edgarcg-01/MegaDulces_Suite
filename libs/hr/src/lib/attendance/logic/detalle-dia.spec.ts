/**
 * `[RH.1.5b]` La comida, el desayuno y las horas netas de UN día (`detalle-dia.ts`), con la regla que Mega Talento
 * corrigió el 08/10/2026: el desayuno sólo existe si el día trae DOS pausas. Con una sola, esa pausa es la comida.
 *
 * Medido contra 6,137 días-persona reales (35 días, todas las plazas): 1,629 días dejan de llamar «desayuno» a la
 * comida y las horas netas no cambian en ninguno. Lo que se defiende aquí es eso mismo: cambia cómo se LLAMA la
 * pausa, no lo que se paga.
 */
import { detalleDia, type ConfigDesayuno } from './detalle-dia';

const TIENDA: ConfigDesayuno = { topeMin: 30, hastaMin: 13 * 60, maxPlausibleMin: 120, cuentaComoJornada: false };
const OFICINAS: ConfigDesayuno = { ...TIENDA, topeMin: 25, cuentaComoJornada: true };

describe('[RH.1.5b] detalleDia — desayuno sólo con dos pausas', () => {
  it('⛔ una sola pausa antes de las 13:00 es la COMIDA, no un desayuno', () => {
    const d = detalleDia(['08:00:00', '11:22:00', '12:21:00', '17:00:00'], TIENDA);
    expect(d.desayunoMin).toBeNull();
    expect(d.desayunoExcesoMin).toBeNull();
    expect(d.comidaMin).toBe(59);
    expect(d.netasMin).toBe(9 * 60 - 59);
  });

  it('dos pausas: la primera antes del corte es el desayuno y la otra la comida', () => {
    const d = detalleDia(['08:00:00', '11:00:00', '11:41:00', '15:00:00', '16:00:00', '18:00:00'], TIENDA);
    expect([d.desayunoMin, d.desayunoExcesoMin, d.comidaMin]).toEqual([41, 11, 60]);
    expect(d.netasMin).toBe(10 * 60 - 41 - 60);
  });

  it('en Oficinas el desayuno se paga: sólo se descuenta la comida', () => {
    const d = detalleDia(['08:00:00', '11:00:00', '11:20:00', '14:00:00', '15:00:00', '17:00:00'], OFICINAS);
    expect([d.desayunoMin, d.desayunoPagado, d.comidaMin]).toEqual([20, true, 60]);
    expect(d.netasMin).toBe(9 * 60 - 60);
  });

  it('⛔ con dos pausas pero la primera después de las 13:00, tampoco hay desayuno', () => {
    const d = detalleDia(['08:00:00', '13:30:00', '14:00:00', '16:00:00', '16:10:00', '18:00:00'], TIENDA);
    expect(d.desayunoMin).toBeNull();
    expect(d.comidaMin).toBe(40);
  });

  it('las horas netas de una sola pausa no dependen de cómo se llame la pausa', () => {
    // Antes: «desayuno de 59» no pagado (se descontaba igual). Ahora: «comida de 59». Mismo neto.
    const d = detalleDia(['09:00:00', '12:00:00', '12:59:00', '18:00:00'], TIENDA);
    expect(d.netasMin).toBe(9 * 60 - 59);
  });
});
