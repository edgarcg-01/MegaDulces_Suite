import { ConflictException } from '@nestjs/common';
import { CommissionContrastService } from './commission-contrast.service';

/**
 * `[RD.98]` — **Sin libro no hay contraste.**
 *
 * Medido en prod el 2026-10-29: la vista del contraste contaba 260 «sin medir», y 22 eran de Q21,
 * cuya corrida es del MOTOR (origen `manual`). Contrastarla sería medir el motor contra sí mismo:
 * saldría «cuadra» al peso. El servicio tiene que negarse ANTES de correr el motor.
 */

function servicio(per: Record<string, unknown>) {
  const db = Object.assign(
    () => ({ where: () => ({ del: async () => 0 }), insert: async () => 0 }),
    { raw: async () => ({ rows: [per] }) });
  const tk = { run: async (cb: (t: unknown) => unknown) => cb(db) };
  const tenantCtx = { requireTenantId: () => 't1' };
  let motorCorrio = 0;
  const commissions = { computeRun: async () => { motorCorrio++; return { lines: [], scale: { id: 's1' } }; } };
  const svc = new CommissionContrastService(tk as never, tenantCtx as never, commissions as never);
  return { svc, motor: () => motorCorrio };
}

describe('[RD.98] el contraste sólo corre sobre quincenas con libro', () => {
  it('una quincena cerrada cuya corrida es del motor se rechaza, sin correr el motor', async () => {
    const { svc, motor } = servicio({ anio: 2026, period_no: 21, date_to: '2026-10-21', cerrada: true, con_libro: false });
    await expect(svc.contrastarPeriodo('p21')).rejects.toBeInstanceOf(ConflictException);
    expect(motor()).toBe(0);
  });

  it('una quincena cerrada CON libro sí corre el motor (control: el rechazo no es general)', async () => {
    const { svc, motor } = servicio({ anio: 2026, period_no: 20, date_to: '2026-10-07', cerrada: true, con_libro: true });
    await svc.contrastarPeriodo('p20');
    expect(motor()).toBe(1);
  });
  // ⚠️ El filtro SQL de `contrastarAnio` no se prueba acá: un doble de Knex no ejecuta SQL. Se
  // midió contra prod en sólo lectura (2026-10-29): 20 quincenas, Q1–Q20, ninguna Q21.
});
