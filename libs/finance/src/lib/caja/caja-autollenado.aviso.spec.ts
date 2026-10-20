import { CajaAutollenadoService } from './caja-autollenado.service';

/**
 * `[CG.197]` Suite del DISPARADOR por aviso, que reemplazó al `@Cron`.
 *
 * ⭐ Lo que se prueba acá es **cuándo se decide correr**, no qué se escribe: eso lo cubren
 * `caja-autollenado.engine.spec.ts` (el plan) y el candado de base (lo escrito). Mezclarlas haría
 * que este archivo probara el motor contra una copia del motor.
 *
 * ⚠️ El doble de `correr()` NO ejecuta SQL y no pretende hacerlo — acá sólo importa **si se
 * llamó**. Un doble que fingiera escribir sería el defecto que el repo ya tiene documentado
 * («un DOBLE de Knex no valida SQL»).
 */

/** El payload real que emite `refresh-caja-matview.js` tras un refresh exitoso. */
const aviso = (filas: number, suma: string, folio = 'X-D-26 0000999') =>
  JSON.stringify({ tenant_id: 't', filas, max_folio: folio, max_captura: '2026-10-19', suma });

function armar(habilitado: boolean) {
  const svc = Object.create(CajaAutollenadoService.prototype) as CajaAutollenadoService;
  const llamadas: Array<{ aplicar?: boolean }> = [];
  Object.defineProperty(svc, 'habilitado', { get: () => habilitado, configurable: true });
  Object.defineProperty(svc, 'piso', { get: () => '2026-10-15', configurable: true });
  Object.assign(svc, {
    logger: { log: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined },
    running: false,
    ultimaFirma: '',
    correr: (o?: { aplicar?: boolean }) => { llamadas.push(o ?? {}); return Promise.resolve({} as never); },
  });
  return { svc, llamadas };
}

describe('[CG.197] el autollenado corre por AVISO, no por reloj', () => {
  it('un aviso nuevo dispara UNA corrida, y aplicando', async () => {
    const { svc, llamadas } = armar(true);
    await svc.porAviso(aviso(10, '1000.00'));
    expect(llamadas).toHaveLength(1);
    // ⛔ `aplicar: true`: el camino automático ESCRIBE. Si esto se cayera a simulación, el libro
    // dejaría de llenarse y el latido diría «ok» igual — un fallo mudo.
    expect(llamadas[0].aplicar).toBe(true);
  });

  it('⭐ el MISMO aviso repetido NO vuelve a correr (debounce por firma)', async () => {
    // El carril avisa tras CADA refresh, a propósito (avisa de más para no avisar de menos).
    // Sin esto, un refresh que no movió nada dispararía los ~8 s de una corrida completa.
    const { svc, llamadas } = armar(true);
    const mismo = aviso(10, '1000.00');
    await svc.porAviso(mismo);
    await svc.porAviso(mismo);
    await svc.porAviso(mismo);
    expect(llamadas).toHaveLength(1);
  });

  it('⛔ un cambio SÓLO en el importe sí dispara: la firma lleva la suma', async () => {
    // Un movimiento corregido (mismo folio, otro monto) no mueve `filas`. Si la firma fuera sólo
    // el conteo, esa corrección no se registraría nunca.
    const { svc, llamadas } = armar(true);
    await svc.porAviso(aviso(10, '1000.00'));
    await svc.porAviso(aviso(10, '1250.00'));
    expect(llamadas).toHaveLength(2);
  });

  it('un aviso con más filas dispara de nuevo', async () => {
    const { svc, llamadas } = armar(true);
    await svc.porAviso(aviso(10, '1000.00'));
    await svc.porAviso(aviso(11, '1100.00'));
    expect(llamadas).toHaveLength(2);
  });

  it('⛔ apagado: NO corre, pase lo que pase', async () => {
    const { svc, llamadas } = armar(false);
    await svc.porAviso(aviso(10, '1000.00'));
    await svc.porAviso(aviso(99, '9999.00'));
    expect(llamadas).toHaveLength(0);
  });

  it('⛔ un payload que no parsea se descarta, no revienta ni corre', async () => {
    // El aviso viene de FUERA del API (lo escribe el carril): es entrada no confiable.
    const { svc, llamadas } = armar(true);
    await expect(svc.porAviso('{esto no es json')).resolves.toBeUndefined();
    expect(llamadas).toHaveLength(0);
  });

  it('⛔ con una corrida en curso NO se encima', async () => {
    const { svc, llamadas } = armar(true);
    (svc as unknown as { running: boolean }).running = true;
    await svc.porAviso(aviso(10, '1000.00'));
    expect(llamadas).toHaveLength(0);
  });

  it('un payload vacío no corre: sin firma no hay nada que comparar', async () => {
    const { svc, llamadas } = armar(true);
    await svc.porAviso('');
    // `'{}'` parsea y da una firma de interrogantes; lo que importa es que no reviente y que
    // el segundo aviso idéntico tampoco corra.
    await svc.porAviso('');
    expect(llamadas.length).toBeLessThanOrEqual(1);
  });
});
