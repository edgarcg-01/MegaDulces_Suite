import { KeplerRequisitionSinkAdapter } from './kepler-requisition-sink.adapter';
import { DOCTIPOS } from './kepler-doctipo';

/**
 * `[PQ.135]` · `[DT5]` **Con qué estado nace el pedido de traspaso — y con cuáles NO.**
 *
 * D1, cerrada por el PM el 2026-11-22 («seguimos el modelo de Kepler»): el `U-D-40` que escribe la
 * Suite nace **`AUTORIZADO`**, igual que los 4,182 que las sucursales capturan a mano. `CREADO`
 * quedó descartado con la medición: en el carril de sucursal no existe un solo pedido en ese
 * estado, y el menú de Kepler va de «Alta de pedido» directo a «Estatus Surtido» — un documento
 * que naciera `CREADO` quedaría antes del primer paso del flujo. La revisión del origen, que es lo
 * que D1 buscaba, vive en el **borrador de la Suite**.
 *
 * Por eso `estado_inicial` no es una opción sino una **puerta**: un `c11` que el tipo no declara se
 * rechaza ANTES de abrir la conexión. Escribirlo no falla —y por eso es peligroso—, deja el
 * documento fuera de todos los filtros del ERP y de la Suite.
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
  it('AUTORIZADO es el ÚNICO estado que el pedido de traspaso admite (D1, 2026-11-22)', () => {
    expect(DOCTIPOS.traspaso.estadosIniciales).toEqual(['AUTORIZADO']);
  });

  it('y es también el default del tipo: quien no manda estado_inicial cae ahí', () => {
    expect(DOCTIPOS.traspaso.c11).toBe('AUTORIZADO');
  });

  /**
   * ⛔ LA PRUEBA DE D1. `CREADO` fue la decisión original del PM y se revirtió con la medición: 0 de
   * 5,621 pedidos de sucursal de 365 días nacen así. Si alguien vuelve a abrir esa puerta, esta se
   * pone roja.
   */
  it('⛔ CREADO se RECHAZA: no existe en el carril de sucursal y ninguna pantalla lo mueve', async () => {
    const r = await sink().entregar({ ...base, tipo: 'traspaso', estado_inicial: 'CREADO' });
    expect(r.estado).toBe('rechazada');
    expect(r.motivo).toContain('CREADO');
    expect(r.motivo).toContain('sólo AUTORIZADO');
  });

  it.each(['SURTIDO', 'EMBARCADO', 'LISTO'])(
    '⛔ «%s» tampoco se cuela, y el motivo dice cuál es el único que vale',
    async (estado) => {
      const r = await sink().entregar({ ...base, tipo: 'traspaso', estado_inicial: estado });
      expect(r.estado).toBe('rechazada');
      expect(r.motivo).toContain(estado);
      expect(r.motivo).toContain('sólo AUTORIZADO');
    },
  );

  /**
   * CONTROL: el estado bueno NO se rechaza por el estado. Llega más lejos y muere por otra cosa
   * (sin servidor ni plantilla configurados en esta máquina) — lo que importa es que el motivo ya
   * no hable del estado inicial.
   */
  it.each(['AUTORIZADO', 'autorizado', '  Autorizado  '])('CONTROL: «%s» pasa la puerta del estado', async (estado) => {
    const r = await sink().entregar({ ...base, tipo: 'traspaso', estado_inicial: estado });
    expect(r.motivo ?? '').not.toContain('no válido');
  });

  it('⛔ la COMPRA no admite elegir estado: su c11 es la referencia de la Suite', async () => {
    const r = await sink().entregar({ ...base, tipo: 'compra', proveedor_code: 'P1', estado_inicial: 'AUTORIZADO' });
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
