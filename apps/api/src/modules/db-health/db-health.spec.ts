import { veredictoRetirada, veredictoSinLatido } from './db-health.service';

/**
 * `[DBH.5]` — **Un job declarado que nunca reportó no puede leerse como sano.**
 *
 * La compuerta que este archivo defiende es una sola: `unknown` **no cuenta para el `overall`**
 * de `getReport()` (a propósito: una fuente no configurada no debe ensuciar el semáforo), así que
 * devolver `unknown` para un job que SÍ está declarado en `CRON_JOBS` lo vuelve **invisible para
 * siempre**. Es la misma familia del `cfg ? classify : 'ok'` que la Fase VP.0 cazó: la ausencia
 * leyéndose como salud.
 *
 * ⛔ Medido en prod el 2026-09-21: **3 de 44** jobs registrados nunca habían escrito un latido —
 * `stock_snapshot` (la foto diaria de inventario, **con latido ya escrito en su propio código**),
 * `kepler_replica_refresh` y `cxc_snapshot`. Los tres decían «sin reporte aún» y el tablero seguía
 * verde. Nadie sabía que la foto de inventario no se estaba tomando.
 */
describe('[DBH.5] veredictoSinLatido', () => {
  it('⛔ NEGATIVA — un job DECLARADO que nunca reportó NO es unknown: es warn', () => {
    const v = veredictoSinLatido({ cadence: 'diario 23:50 MX' });
    expect(v.status).toBe('warn');
    // Lo que importa de verdad: que NO sea el estado que el overall saltea.
    expect(v.status).not.toBe('unknown');
    expect(v.status).not.toBe('ok');
  });

  it('la nota dice qué se sabe y qué no, sin inventar la causa', () => {
    const v = veredictoSinLatido({ cadence: 'diario 08:30 MX' });
    // La cadencia va en la nota: sin ella, «nunca reportó» no dice si es grave.
    expect(v.note).toContain('diario 08:30 MX');
    expect(v.note).toContain('NUNCA REPORTÓ');
    // ⚠️ Son tres causas distintas y el monitor no puede distinguirlas. Decir una sola sería
    // adivinar, y mandaría a revisar el lugar equivocado.
    expect(v.note).toContain('No se puede saber cuál sin mirarlo');
  });

  it('⛔ un job NO declarado sigue siendo unknown — ahí «no sé» es la verdad', () => {
    // Un job que apareció solo en `cron_runs` y que nadie registró no tiene contra qué juzgarse.
    // Si esto se volviera `warn`, cualquier job ajeno ensuciaría el semáforo y el tablero
    // enseñaría a ignorarse, que es el modo de falla opuesto y igual de caro.
    const v = veredictoSinLatido(undefined);
    expect(v.status).toBe('unknown');
    expect(v.note).toContain('no está en CRON_JOBS');
  });

  it('⚠️ es warn y NO critical: un job recién registrado todavía no fallo', () => {
    // Un job agregado a CRON_JOBS hoy, antes de cumplir su primera cadencia, cae legítimamente
    // acá. Un rojo por eso enseñaría a ignorar el tablero; el warn se apaga solo con el primer
    // latido.
    expect(veredictoSinLatido({ cadence: 'cada 30 min' }).status).not.toBe('critical');
  });
});

/**
 * `[VL.14]` **Una sonda RETIRADA calla — salvo que su fuente reviva.**
 *
 * Nace de un incidente medido el 2026-09-23: las cinco sondas de Wincaja llevaban días en
 * `critical` vigilando un sistema apagado el 2026-09-19, y ese ruido tapó DOS fallas reales del
 * mismo día (el respaldo volcando la base vieja y `caja-general-ship` perdiendo dato de prod).
 *
 * ⚠️ El riesgo de retirar es el opuesto: quedarse ciego. Por eso el caso que MÁS importa acá es el
 * tercero — si la fuente vuelve a escribir después del corte, la sonda tiene que gritar. Sin esa
 * rama, "retirar" sería un `catch` vacío con nombre elegante.
 */
describe('[VL.14] veredictoRetirada', () => {
  it('una sonda NO retirada devuelve null — manda classify(), no esto', () => {
    expect(veredictoRetirada({}, new Date('2026-09-01'))).toBeNull();
    expect(veredictoRetirada(undefined, new Date('2026-09-01'))).toBeNull();
  });

  it('retirada y sin datos nuevos: sale de la alarma con el motivo a la vista', () => {
    const v = veredictoRetirada(
      { retiredOn: '2026-09-19', retiredWhy: 'Morelia migró a Kepler' },
      new Date('2026-09-18T20:00:00-06:00'),
    );
    // `unknown` y no `ok`: de un sistema apagado no hay frescura que juzgar. Y el escáner
    // excluye `unknown` de las alertas a propósito — por eso este valor exacto importa.
    expect(v?.status).toBe('unknown');
    expect(v?.note).toContain('2026-09-19');
    expect(v?.note).toContain('Morelia migró a Kepler');
  });

  it('⭐ LA PRUEBA NEGATIVA: si la fuente revive después del corte, vuelve a alarmar', () => {
    const v = veredictoRetirada(
      { retiredOn: '2026-09-19', retiredWhy: 'Wincaja se apagó' },
      new Date('2026-09-22T10:00:00-06:00'),
    );
    expect(v?.status).toBe('warn');
    expect(v?.note).toContain('VOLVIÓ');
  });

  it('un dato del MISMO día del corte no cuenta como resurrección', () => {
    // El apagón ocurre en algún momento de ese día; lo escrito antes del cierre es el último
    // suspiro, no una reactivación. Sin esta tolerancia, retirar cualquier cosa daría `warn`
    // el mismo día y la compuerta nacería gritando.
    const v = veredictoRetirada({ retiredOn: '2026-09-19' }, new Date('2026-09-19T18:30:00-06:00'));
    expect(v?.status).toBe('unknown');
  });

  it('sin motivo escrito lo DECLARA, no lo inventa', () => {
    expect(veredictoRetirada({ retiredOn: '2026-09-19' }, null)?.note).toContain('sin motivo escrito');
  });
});
