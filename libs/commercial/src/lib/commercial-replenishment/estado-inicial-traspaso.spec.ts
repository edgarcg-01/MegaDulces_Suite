import { KeplerRequisitionSinkAdapter } from './kepler-requisition-sink.adapter';
import { DOCTIPOS } from './kepler-doctipo';

/**
 * `[PQ.135]` · `[DT5]` **Con qué estado nace el pedido de traspaso.**
 *
 * El mismo `U-D-40` tiene dos puertas desde ADR-127: la requisición que aprueba Compras (nace
 * `AUTORIZADO`, como los 4,213 que las sucursales capturan a mano) y el pedido que arma la
 * sucursal en Autoabasto, que el PM decidió que nazca `CREADO` para que el origen lo revise.
 * El estado viaja en la entrada y **no se edita la constante compartida**.
 *
 * Un `c11` que el tipo no declara se rechaza ANTES de abrir la conexión: escribirlo no falla, y
 * por eso es peligroso — deja el documento fuera de todos los filtros del ERP y de la Suite.
 *
 * ⚠️ Lo que estas pruebas NO cubren: que Kepler acepte el documento. Eso lo ejerce
 * `kepler-requisition-sink.ensayo.spec.ts` contra el servidor real, y sólo corre desde `md` con
 * los secretos de `kepler_push`.
 */
const base = {
  requisition_id: '11111111-1111-1111-1111-111111111111',
  folio_suite: 'RQ-2026-99999',
  sucursal: '08',
  destino_sucursal: '07',
  fecha: '2026-11-22',
  total: 100,
  lineas: [{ sku: '70012', nombre: 'BOMBON', cajas: 1, piezas_por_caja: 12, costo_caja: 100, importe: 100 }],
};

/** El adapter sin pasar por Nest: `entregar` valida el estado antes de tocar la red. */
const sink = () => Object.create(KeplerRequisitionSinkAdapter.prototype) as KeplerRequisitionSinkAdapter;

describe('[PQ.135] el estado con el que nace el traspaso', () => {
  it('CREADO y AUTORIZADO son los estados que el pedido de traspaso admite', () => {
    expect(DOCTIPOS.traspaso.estadosIniciales).toEqual(['CREADO', 'AUTORIZADO']);
  });

  it('⛔ un estado que el tipo no declara se rechaza, y el motivo dice cuáles valen', async () => {
    const r = await sink().entregar({ ...base, tipo: 'traspaso', estado_inicial: 'SURTIDO' });
    expect(r.estado).toBe('rechazada');
    expect(r.motivo).toContain('SURTIDO');
    expect(r.motivo).toContain('CREADO o AUTORIZADO');
  });

  it('⛔ tampoco se cuela un estado inventado', async () => {
    const r = await sink().entregar({ ...base, tipo: 'traspaso', estado_inicial: 'LISTO' });
    expect(r.estado).toBe('rechazada');
    expect(r.motivo).toContain('LISTO');
  });

  /**
   * CONTROL: los estados buenos NO se rechazan por el estado. Llegan más lejos y mueren por otra
   * cosa (sin servidor ni plantilla configurados en esta máquina) — lo que importa es que el
   * motivo ya no hable del estado inicial.
   */
  it.each(['CREADO', 'AUTORIZADO', 'creado'])('CONTROL: «%s» pasa la puerta del estado', async (estado) => {
    const r = await sink().entregar({ ...base, tipo: 'traspaso', estado_inicial: estado });
    expect(r.motivo ?? '').not.toContain('no válido');
  });

  it('⛔ la COMPRA no admite elegir estado: su c11 es la referencia de la Suite', async () => {
    const r = await sink().entregar({ ...base, tipo: 'compra', proveedor_code: 'P1', estado_inicial: 'CREADO' });
    expect(r.estado).toBe('rechazada');
    expect(r.motivo).toContain('no admite elegir estado');
  });

  it('sin estado_inicial no se rechaza nada: sigue mandando el del tipo', async () => {
    const r = await sink().entregar({ ...base, tipo: 'traspaso' });
    expect(r.motivo ?? '').not.toContain('no válido');
  });
});

describe('[PQ.135] qué columnas lleva el renglón de cada documento', () => {
  it('el traspaso escribe cantidad pedida (c51) y estado (c28) en el renglón', () => {
    expect(DOCTIPOS.traspaso.renglonPedidaYEstado).toBe(true);
  });

  it('CONTROL: en la compra no se midió, así que el renglón se queda como estaba', () => {
    expect(DOCTIPOS.compra.renglonPedidaYEstado).toBeFalsy();
    expect(DOCTIPOS.compra.estadosIniciales).toBeUndefined();
  });
});
