// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ComprasOcAbiertasComponent } from './compras-oc-abiertas.component';

/**
 * `[PQ.160]` Editar cantidades desde el detalle de la orden. La regla y el cálculo de Kepler viven en el servidor
 * (`kepler-oc-edicion.spec.ts` y el ensayo en Kepler vivo); aquí, lo que la PANTALLA promete: sólo manda los renglones
 * que cambian, muestra el importe y el total que el servidor va a calcular, no deja mandar sin motivo o con una
 * cantidad en cero, no manda dos veces y no se cierra a medio camino. Control: la OC 00-0007492, 120 → 132 cajas.
 */
type Resp = { estado: 'aplicada' | 'rechazada'; rechazo: string | null; total_antes: number; total_despues: number | null };
const ORDEN = { almacen: '00', folio: '0007492', estatus: 'N', proveedor: 'SALSA MAGA SA DE CV', valor: 109098 };
const ren = (renglon: number, sku: string, costo: number) =>
  ({ renglon, sku, nombre: `SALSA ${sku}`, unidad: 'CJA', factor: 1, cantidad: 120, costo, importe: Math.round(120 * costo * 100) / 100 });
const RENGLONES = [ren(1, '99069', 223.98), ren(2, '99124', 276.01), ren(3, '99125', 204.58), ren(4, '99126', 204.58)];

function armar(disponible = true) {
  const c = Object.create(ComprasOcAbiertasComponent.prototype) as ComprasOcAbiertasComponent & Record<string, unknown>;
  const respuesta = new Subject<Resp>();
  const llamadas: Array<{ s: string; f: string; r: Array<{ renglon: number; cantidad: number }>; m: string }> = [];
  let recargas = 0;
  Object.assign(c, {
    destroyRef: { onDestroy: () => () => undefined },
    api: { editarOc: (s: string, f: string, r: Array<{ renglon: number; cantidad: number }>, m: string) => { llamadas.push({ s, f, r, m }); return respuesta; } },
    canEditarOc: true,
    edInfo: signal({ sucursal: '00', folio: '0007492', disponible, porque: disponible ? null : 'apagado', total: 109098, renglones: RENGLONES, requisicion: 'RQ-2026-03481', ultima: null }),
    edInfoSub: null,
    edOrden: signal(null),
    edRenglones: signal([]),
    edNuevas: signal(new Map()),
    edMotivo: signal(''),
    edError: signal(null),
    edEnviando: signal(false),
    edResultado: signal(null),
    edReq: 0,
    peekOrden: signal(null),
    reload: () => { recargas++; },
  });
  return { c, respuesta, llamadas, recargas: () => recargas };
}

describe('[PQ.160] OC abiertas — editar cantidades', () => {
  it('CONTROL: 120 → 132 en los 4 renglones da el subtotal que quedó en Kepler ($120,007.80, sin IVA en esta OC)', () => {
    const { c } = armar();
    c.abrirEdicion(ORDEN as never);
    for (const l of RENGLONES) c.ponerCantidad(l, 132);
    expect(c.subtotalHoy()).toBe(109098);
    expect(c.subtotalNuevo()).toBe(120007.8);
    expect(RENGLONES.map((l) => c.importeNuevo(l))).toEqual([29565.36, 36433.32, 27004.56, 27004.56]);
  });

  it('sólo manda los renglones que cambian, con su cantidad', () => {
    const { c, llamadas } = armar();
    c.abrirEdicion(ORDEN as never);
    c.ponerCantidad(RENGLONES[0], 132);
    c.ponerCantidad(RENGLONES[1], 120); // igual que hoy: no cuenta
    c.edMotivo.set('El proveedor confirma 12 cajas más');
    c.confirmarEdicion();
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]).toEqual({ s: '00', f: '0007492', r: [{ renglon: 1, cantidad: 132 }], m: 'El proveedor confirma 12 cajas más' });
  });

  it('NEGATIVAS: sin cambios, sin motivo suficiente o con una cantidad en cero no se puede guardar', () => {
    const { c, llamadas } = armar();
    c.abrirEdicion(ORDEN as never);
    c.edMotivo.set('Motivo suficiente aquí');
    expect(c.edListo()).toBe(false); // nada cambió
    c.ponerCantidad(RENGLONES[0], 132);
    c.edMotivo.set('corto');
    expect(c.edListo()).toBe(false);
    c.edMotivo.set('Motivo suficiente aquí');
    c.ponerCantidad(RENGLONES[1], 0);
    expect(c.edCantidadMala()).toBe(true);
    expect(c.edListo()).toBe(false);
    c.confirmarEdicion();
    expect(llamadas).toHaveLength(0);
  });

  it('NEGATIVA: si el servidor dijo que no se puede, el diálogo no se abre', () => {
    const { c } = armar(false);
    c.abrirEdicion(ORDEN as never);
    expect(c.edOrden()).toBeNull();
  });

  it('el envío se bloquea en el mismo clic y no se cierra a medio camino', () => {
    const { c, llamadas } = armar();
    c.abrirEdicion(ORDEN as never);
    c.ponerCantidad(RENGLONES[0], 132);
    c.edMotivo.set('Motivo suficiente aquí');
    c.confirmarEdicion();
    c.confirmarEdicion();
    expect(llamadas).toHaveLength(1);
    c.cerrarEdicion();
    expect(c.edOrden()).toBe(ORDEN);
  });

  it('rechazada: lo dice y al cerrar no recarga; aplicada: al cerrar recarga', () => {
    const a = armar();
    a.c.abrirEdicion(ORDEN as never);
    a.c.ponerCantidad(RENGLONES[0], 132);
    a.c.edMotivo.set('Motivo suficiente aquí');
    a.c.confirmarEdicion();
    a.respuesta.next({ estado: 'rechazada', rechazo: 'La OC ya tiene vale de entrada (0010500)', total_antes: 109098, total_despues: null });
    expect(a.c.edResultado()?.rechazo).toContain('vale de entrada');
    a.c.cerrarEdicion();
    expect(a.recargas()).toBe(0);

    const b = armar();
    b.c.abrirEdicion(ORDEN as never);
    b.c.ponerCantidad(RENGLONES[0], 132);
    b.c.edMotivo.set('Motivo suficiente aquí');
    b.c.confirmarEdicion();
    b.respuesta.next({ estado: 'aplicada', rechazo: null, total_antes: 109098, total_despues: 110889.84 });
    expect(b.c.edEnviando()).toBe(false);
    b.c.cerrarEdicion();
    expect(b.c.edOrden()).toBeNull();
    expect(b.recargas()).toBe(1);
  });
});
