/**
 * `[GP.10.2]` La etapa de almacén de un pedido, en una sola función.
 *
 * Los casos salen de prod (sólo lectura, 2026-11-13):
 *  · 16 pedidos surtidos en la Suite entre el 27-oct y el 03-nov siguen AUTORIZADO en Kepler → el
 *    piso va adelante, y se marca.
 *  · `08|0000415`: está en una ola, su `c11` dice SURTIDO, pero Kepler lo canceló (`c43 = 'C'`).
 *  · `01|0004030` (Padre Hidalgo): pasó de AUTORIZADO a EMBARCADO en Kepler en menos de 4 minutos,
 *    sin pasar por la Suite (recaptura del papel).
 */
import type { EtapaPedido, PresaleStage } from '@megadulces/contracts';
import { etapaDe, type HechosEtapa } from '../presale-control/presale-control.engine';
import { etapaDePedido, etapaDelPiso, type HechosPedido } from './etapa-pedido';

const kepler = (estatus: string | null, extra: Partial<HechosPedido> = {}): HechosPedido => ({
  origen: 'kepler', kepler: estatus, ola: null, checado: null, ...extra,
});
const preventa = (extra: Partial<HechosPedido> = {}): HechosPedido => ({
  origen: 'preventa', kepler: null, ola: null, checado: null, pedido_status: 'confirmed', ...extra,
});

describe('[GP.10.2] pedido de Kepler', () => {
  it('sin pasar por la Suite, la etapa es la de Kepler y la sabe Kepler', () => {
    expect(etapaDePedido(kepler('AUTORIZADO'))).toEqual({ etapa: 'autorizado', fuente: 'kepler', desfase: null });
    expect(etapaDePedido(kepler('EMBARCADO'))).toEqual({ etapa: 'embarcado', fuente: 'kepler', desfase: null });
  });

  it('⭐ surtido en la Suite y AUTORIZADO en Kepler (los 16 de oct-nov): surtido, del piso, y se marca', () => {
    const r = etapaDePedido(kepler('AUTORIZADO', { ola: { status: 'surtida', stage: 'en_ola' } }));
    expect(r).toEqual({ etapa: 'surtido', fuente: 'piso', desfase: 'piso_adelante' });
  });

  it('en una ola abierta o surtiéndose: etapas del piso que Kepler no tiene, sin desfase', () => {
    expect(etapaDePedido(kepler('AUTORIZADO', { ola: { status: 'abierta', stage: 'en_ola' } })))
      .toEqual({ etapa: 'en_cola', fuente: 'piso', desfase: null });
    expect(etapaDePedido(kepler('AUTORIZADO', { ola: { status: 'en_surtido', stage: 'en_ola' } })))
      .toEqual({ etapa: 'surtiendo', fuente: 'piso', desfase: null });
  });

  it('01|0004030: Kepler lo embarcó mientras su ola seguía abierta → embarcado, de Kepler, y se marca', () => {
    const r = etapaDePedido(kepler('EMBARCADO', { ola: { status: 'abierta', stage: 'en_ola' } }));
    expect(r).toEqual({ etapa: 'embarcado', fuente: 'kepler', desfase: 'kepler_adelante' });
  });

  it('checando y checado en la Suite', () => {
    expect(etapaDePedido(kepler('SURTIDO', { checado: 'en_checado' })).etapa).toBe('checando');
    expect(etapaDePedido(kepler('SURTIDO', { checado: 'checado' }))).toEqual({ etapa: 'checado', fuente: 'piso', desfase: 'piso_adelante' });
  });

  it('08|0000415: en una ola, c11 SURTIDO pero cancelado en Kepler → cancelado, aunque el piso diga otra cosa', () => {
    expect(etapaDePedido(kepler('CANCELADO', { ola: { status: 'abierta', stage: 'en_ola' } })))
      .toEqual({ etapa: 'cancelado', fuente: 'kepler', desfase: null });
  });

  it('NEGATIVA: sin cabecera en el ODS NO es «creado»: es sin_dato', () => {
    expect(etapaDePedido(kepler(null))).toEqual({ etapa: 'sin_dato', fuente: null, desfase: null });
    expect(etapaDePedido(kepler(null, { ola: { status: 'surtida', stage: 'en_ola' } })).etapa).toBe('sin_dato');
  });

  it('NEGATIVA: un estatus que Kepler traiga nuevo no se adivina: sin_dato', () => {
    expect(etapaDePedido(kepler('EN TRANSITO')).etapa).toBe('sin_dato');
  });
});

describe('[GP.10.2] pedido de preventa (PD-)', () => {
  it('confirmado sin tocar = autorizado; surtiéndose, surtido, revisado en caja y salido', () => {
    expect(etapaDePedido(preventa()).etapa).toBe('autorizado');
    expect(etapaDePedido(preventa({ pick: { iniciado: true, terminado: false, revisado: false } })).etapa).toBe('surtiendo');
    expect(etapaDePedido(preventa({ pick: { iniciado: true, terminado: true, revisado: false } })).etapa).toBe('surtido');
    expect(etapaDePedido(preventa({ pick: { iniciado: true, terminado: true, revisado: true } })).etapa).toBe('checado');
    expect(etapaDePedido(preventa({ salio: true })).etapa).toBe('embarcado');
  });

  it('siempre lo sabe el piso y nunca tiene desfase (no hay Kepler que comparar)', () => {
    const r = etapaDePedido(preventa({ pick: { iniciado: true, terminado: true, revisado: false } }));
    expect(r.fuente).toBe('piso');
    expect(r.desfase).toBeNull();
  });

  it('cancelado y entregado', () => {
    expect(etapaDePedido(preventa({ pedido_status: 'cancelled', salio: true })).etapa).toBe('cancelado');
    expect(etapaDePedido(preventa({ pedido_status: 'fulfilled' })).etapa).toBe('embarcado');
  });
});

/**
 * ⭐ Cruce de DOS implementaciones: la etapa de la Mesa de Control de preventa (`etapaDe`) y ésta
 * tienen que decir lo mismo sobre el almacén, en todos los hechos que comparten. Mientras `etapaDe`
 * no se retire (GP.10.2-deuda, D9), si alguien la mueve sin mover ésta, esta prueba truena.
 */
describe('[GP.10.2] cruce con etapaDe (Mesa de Control de preventa)', () => {
  /** La etapa de la Mesa, leída como etapa de almacén. `en_surtido` cubre «en cola» y «surtiendo». */
  const comoAlmacen: Record<PresaleStage, EtapaPedido[]> = {
    por_surtir: ['autorizado'],
    esperando_alta: ['autorizado'],
    en_surtido: ['en_cola', 'surtiendo'],
    en_caja: ['surtido', 'checado'],
    cobrado: ['embarcado'],
    en_ruta: ['embarcado'],
    entregado: ['embarcado'],
    devuelto: ['embarcado'],
    cancelado: ['cancelado'],
  };

  const olas: Array<HechosPedido['ola']> = [null, { status: 'abierta', stage: 'en_ola' }, { status: 'en_surtido', stage: 'en_ola' }, { status: 'surtida', stage: 'listo_embarque' }];
  const picks: Array<'surtiendo' | 'terminado' | null> = [null, 'surtiendo', 'terminado'];
  const casos: Array<{ status: string; ligado: boolean; guia: boolean }> = [
    { status: 'confirmed', ligado: false, guia: false },
    { status: 'confirmed', ligado: true, guia: false },
    { status: 'confirmed', ligado: false, guia: true },
    { status: 'fulfilled', ligado: false, guia: false },
    { status: 'cancelled', ligado: false, guia: false },
  ];

  it('las dos dicen lo mismo en los 60 cruces de hechos compartidos', () => {
    let n = 0;
    for (const ola of olas) for (const pick of picks) for (const c of casos) {
      const mesa: HechosEtapa = {
        status: c.status, wave_stage: ola ? (ola.stage === 'listo_embarque' ? 'listo_embarque' : 'en_ola') : null,
        ligado: c.ligado, customer_erp_code: '1234', en_guia_impresa: c.guia, pick,
      };
      const nuestra = etapaDePedido({
        origen: 'preventa', kepler: null, checado: null, pedido_status: c.status,
        ola, salio: c.ligado || c.guia,
        pick: pick ? { iniciado: true, terminado: pick === 'terminado', revisado: false } : null,
      });
      const deMesa = etapaDe(mesa);
      expect(comoAlmacen[deMesa], `${JSON.stringify({ ola, pick, c })}: mesa=${deMesa} nuestra=${nuestra.etapa}`).toContain(nuestra.etapa);
      n++;
    }
    expect(n).toBe(60);
  });

  it('etapaDelPiso: sin ninguna huella en la Suite devuelve null (no inventa «autorizado»)', () => {
    expect(etapaDelPiso(kepler('AUTORIZADO'))).toBeNull();
  });
});
