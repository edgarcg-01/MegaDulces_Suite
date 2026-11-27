import { CommercialCommissionsService } from './commercial-commissions.service';

/**
 * `[RD.C1.3]` — **Una corrida sin neto medido no se firma.**
 *
 * ⛔⛔ Y el candado va sobre las **líneas**, no sobre `total_neto IS NULL`. La diferencia la
 * encontró una fila real (`[RD.C1.3b]`): la corrida del **8→21-oct** publica
 * `total_neto = 51,522.93` —**idéntico al bruto**— con sus **11 líneas de supervisor** en
 * `sin_configurar` y la compuerta **guardada** diciendo `pasa`. Un candado escrito como
 * «sin neto medido» se implementa mirando el total… **y esa corrida pasa**.
 *
 * Por eso el caso 2 de este archivo es el importante: reproduce Q21 —neto presente, línea sin
 * configurar— y exige que **se rechace igual**. Si alguien «simplifica» el candado al total,
 * ese test es el que se pone rojo.
 *
 * ⚠️ Esto no ejecuta SQL (dobles de knex), igual que `commission-inmutable.spec.ts`: lo que se
 * comprueba es el **flujo de control**, que es donde vive la regla.
 */

/** Un `trx` falso: devuelve la corrida viva y las líneas «sin medir» que se le pidan. */
function trxCon(viva: Record<string, unknown>, sinMedir: { nombre: string | null }[]) {
  const actualizados: Record<string, unknown>[] = [];
  const qb = (tabla: string): Record<string, (...a: unknown[]) => unknown> => {
    const self: Record<string, (...a: unknown[]) => unknown> = {
      where: () => self, whereNull: () => self, whereNot: () => self,
      first: async () => (tabla === 'commercial.commission_runs' ? viva : undefined),
      // `distinct` cierra la consulta de las líneas: devuelve la lista tal cual.
      distinct: async () => (tabla === 'commercial.commission_run_lines' ? sinMedir : []),
      update: async (p: unknown) => { actualizados.push(p as Record<string, unknown>); return 1; },
      orderBy: () => self, select: async () => [],
    };
    return self;
  };
  const trx = ((tabla: string) => qb(tabla)) as unknown as Record<string, unknown>;
  (trx as { fn?: unknown }).fn = { now: () => 'now()' };
  return { trx, actualizados };
}

function servicio(trx: unknown) {
  const tenantCtx = { get: () => ({ userId: 'aprobador' }), requireTenantId: () => 't1' } as never;
  const tk = { run: async (cb: (t: unknown) => unknown) => cb(trx) } as never;
  return new CommercialCommissionsService(tk, tenantCtx);
}

/** `created_by` distinto del aprobador: si no, salta primero la regla de `[RD.101]`. */
const BORRADOR = { id: 'r1', status: 'borrador', created_by: 'otro', gates: [] };

describe('[RD.C1.3] el neto sin medir no llega a la firma', () => {
  // Candado del propio doble: sin esto, los dos casos de abajo podrían pasar por vacuidad.
  it('el doble entrega la corrida y las líneas que se le dan', async () => {
    const { trx } = trxCon(BORRADOR, [{ nombre: 'ANA' }]);
    const t = trx as unknown as (x: string) => {
      first: () => Promise<unknown>; distinct: () => Promise<unknown>;
    };
    expect(await t('commercial.commission_runs').first()).toEqual(BORRADOR);
    expect(await t('commercial.commission_run_lines').distinct()).toEqual([{ nombre: 'ANA' }]);
  });

  it('⛔ PRUEBA NEGATIVA: con una deducción sin configurar, aprobar se RECHAZA y dice de quién', async () => {
    const { trx, actualizados } = trxCon(BORRADOR, [{ nombre: 'ANGEL ALBERTO VAZQUEZ MEJIA' }]);
    await expect(servicio(trx).setStatus('r1', 'aprobado'))
      .rejects.toThrow(/no está medido.*ANGEL ALBERTO VAZQUEZ MEJIA/s);
    expect(actualizados).toEqual([]);   // y no escribió el estado
  });

  it('⛔⛔ EL CASO Q21: el neto NO es nulo y aun así se rechaza — el candado mira la LÍNEA', async () => {
    // La fila REAL del 8→21-oct, medida en prod el 2026-11-27: `total_neto` presente e igual al
    // bruto, y 11 líneas de supervisor en `sin_configurar` que son **2 personas** distintas
    // (la consulta del candado es `DISTINCT`, así que cuenta personas, no líneas).
    const q21 = { ...BORRADOR, total_a_pagar: 51522.93, total_neto: 51522.93, total_deduccion: 0 };
    const dos = [{ nombre: 'ANGEL ALBERTO VAZQUEZ MEJIA' }, { nombre: 'FRANCISCO DE JESUS MARTINEZ RAZO' }];
    const { trx, actualizados } = trxCon(q21, dos);
    await expect(servicio(trx).setStatus('r1', 'aprobado'))
      .rejects.toThrow(/2 persona\(s\).*ANGEL ALBERTO VAZQUEZ MEJIA · FRANCISCO DE JESUS MARTINEZ RAZO/s);
    expect(actualizados).toEqual([]);
    // ⭐ Y el neto estaba presente: si el candado mirara el total, esta corrida se firmaría.
    expect(q21.total_neto).not.toBeNull();
  });

  it('sin líneas sin configurar, aprobar pasa y queda la firma', async () => {
    const { trx, actualizados } = trxCon(BORRADOR, []);
    await servicio(trx).setStatus('r1', 'aprobado');
    expect(actualizados).toHaveLength(1);
    expect(actualizados[0]).toMatchObject({ status: 'aprobado', approved_by: 'aprobador' });
  });

  it('el candado es sólo de aprobar: anular una corrida sin medir sigue permitido', async () => {
    const { trx, actualizados } = trxCon(BORRADOR, [{ nombre: 'ANA' }]);
    await servicio(trx).setStatus('r1', 'anulado');
    expect(actualizados).toHaveLength(1);
    expect(actualizados[0]).toMatchObject({ status: 'anulado' });
  });

  it('una línea sin nombre congelado no rompe el mensaje: dice cuántas, sin inventar a quién', async () => {
    const { trx } = trxCon(BORRADOR, [{ nombre: null }]);
    await expect(servicio(trx).setStatus('r1', 'aprobado'))
      .rejects.toThrow(/1 persona\(s\)\. Cárgala/);
  });
});
