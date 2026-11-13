// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import { ComprasOcAbiertasComponent } from './compras-oc-abiertas.component';

/**
 * `[PQ.110]` Cancelar en Kepler desde el detalle de la orden. La regla vive en el servidor (se prueba
 * en `test-newdb-pq110-cancelar-oc.js` contra base real); aquí, lo que la PANTALLA promete:
 * no manda dos veces, no afirma lo que no sabe, no se cierra a medio camino y la fila dice la verdad
 * mientras la réplica de Kepler se pone al día.
 */
type Resp = { estado: 'cancelada' | 'rechazada'; rechazo: string | null; requisicion_reabierta: string | null };
const ORDEN = {
  almacen: '08', folio: '0000393', estatus: 'N', prob: 40, _clase: 'pendiente', _claseLabel: 'Pendiente',
  proveedor: 'Proveedor', valor: 351489.45,
  seguimiento: { estatus: 'no_surtida_cancelada', nota: 'El proveedor no surtió y ya no se necesita', actualizado_en: '2026-11-13', actualizado_por: 'x' },
};

function armar(disponible = true) {
  const c = Object.create(ComprasOcAbiertasComponent.prototype) as ComprasOcAbiertasComponent & Record<string, unknown>;
  const respuesta = new Subject<Resp>();
  const llamadas: Array<{ s: string; f: string; m: string }> = [];
  let recargas = 0;
  Object.assign(c, {
    destroyRef: { onDestroy: () => () => undefined },
    api: {
      cancelarOc: (s: string, f: string, m: string) => { llamadas.push({ s, f, m }); return respuesta; },
      ocCancelacion: () => of({ sucursal: '08', folio: '0000393', disponible: false, porque: 'ya se canceló', reabriria_requisicion: null, ultima: null }),
    },
    canCancelar: true,
    cancInfo: signal({ sucursal: '08', folio: '0000393', disponible, porque: disponible ? null : 'apagado', reabriria_requisicion: '0000087', ultima: null }),
    cancInfoError: signal(false),
    cancInfoSub: null,
    cancOrden: signal(null),
    cancMotivo: signal(''),
    cancError: signal(null),
    cancEnviando: signal(false),
    cancResultado: signal(null),
    motivoOk: () => true,
    canceladasAqui: signal(new Set<string>()),
    peekOrden: signal(null),
    cancReq: 0,
    clasifOk: () => true,
    reload: () => { recargas++; },
  });
  return { c, respuesta, llamadas, recargas: () => recargas };
}

describe('[PQ.110] OC abiertas — cancelar en Kepler', () => {
  it('el motivo llega lleno con la nota de «No surtida / cancelada»: el mismo acto no se teclea dos veces', () => {
    const { c } = armar();
    c.abrirCancelar(ORDEN as never);
    expect(c.cancOrden()).toBe(ORDEN);
    expect(c.cancMotivo()).toBe('El proveedor no surtió y ya no se necesita');
  });

  it('sin esa marca, el motivo arranca vacío', () => {
    const { c } = armar();
    c.abrirCancelar({ ...ORDEN, seguimiento: { ...ORDEN.seguimiento, estatus: 'backorder' } } as never);
    expect(c.cancMotivo()).toBe('');
  });

  it('NEGATIVA: si el servidor dijo que no se puede, el diálogo no se abre', () => {
    const { c } = armar(false);
    c.abrirCancelar(ORDEN as never);
    expect(c.cancOrden()).toBeNull();
  });

  it('el envío se bloquea en el MISMO clic: el doble clic no manda dos cancelaciones', () => {
    const { c, llamadas } = armar();
    c.abrirCancelar(ORDEN as never);
    c.confirmarCancelar();
    expect(c.cancEnviando()).toBe(true);
    c.confirmarCancelar();
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]).toEqual({ s: '08', f: '0000393', m: 'El proveedor no surtió y ya no se necesita' });
  });

  it('mientras se envía no se cierra (la respuesta no tendría dónde decir qué pasó)', () => {
    const { c } = armar();
    c.abrirCancelar(ORDEN as never);
    c.confirmarCancelar();
    c.cerrarCancelar();
    expect(c.cancOrden()).toBe(ORDEN);
  });

  it('cancelada: el diálogo lo dice, la fila deja de afirmar «Pendiente» y al cerrar se recarga', () => {
    const { c, respuesta, recargas } = armar();
    c.abrirCancelar(ORDEN as never);
    c.confirmarCancelar();
    respuesta.next({ estado: 'cancelada', rechazo: null, requisicion_reabierta: '0000087' });
    expect(c.cancEnviando()).toBe(false);
    expect(c.cancResultado()?.estado).toBe('cancelada');
    expect(c.estadoTexto(ORDEN as never)).toBe('Cancelada desde la Suite · Kepler todavía no lo refleja');
    // Cuando la réplica ya la ve cancelada (C), la fila dice lo de Kepler, no lo de la Suite.
    expect(c.estadoTexto({ ...ORDEN, estatus: 'C' } as never)).not.toContain('todavía no lo refleja');
    c.cerrarCancelar();
    expect(c.cancOrden()).toBeNull();
    expect(recargas()).toBe(1);
  });

  it('rechazada: la fila sigue como está y no se recarga nada', () => {
    const { c, respuesta, recargas } = armar();
    c.abrirCancelar(ORDEN as never);
    c.confirmarCancelar();
    respuesta.next({ estado: 'rechazada', rechazo: 'La OC ya tiene vale de entrada (0000533)', requisicion_reabierta: null });
    expect(c.cancResultado()?.rechazo).toContain('vale de entrada');
    expect(c.estadoTexto(ORDEN as never)).toBe('Pendiente · llega 40 %');
    c.cerrarCancelar();
    expect(recargas()).toBe(0);
  });

  it('NEGATIVA: un error sin respuesta NO afirma que Kepler quedó igual: dice que no se pudo confirmar', () => {
    const { c, respuesta } = armar();
    c.abrirCancelar(ORDEN as never);
    c.confirmarCancelar();
    respuesta.error({ status: 0 });
    expect(c.cancEnviando()).toBe(false);
    expect(c.cancError()).toMatch(/No se pudo confirmar/);
    expect(c.cancError()).not.toMatch(/no se (cambió|escribió) nada/i);
  });

  it('el error del servidor se dice con su porqué (p.ej. apagado en la sucursal)', () => {
    const { c, respuesta } = armar();
    c.abrirCancelar(ORDEN as never);
    c.confirmarCancelar();
    respuesta.error({ status: 503, error: { message: 'Cancelar OC en Kepler está apagado para Morelia Abastos: ciérrala en Kepler a mano' } });
    expect(c.cancError()).toContain('apagado para Morelia Abastos');
  });

  it('la plantilla: el botón es destructivo (danger, nunca --action) y el aviso ya no dice que TODAS tienen vale', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, 'compras-oc-abiertas.component.ts'), 'utf8');
    expect(src).toMatch(/p-button-danger" \(click\)="abrirCancelar\(peekOrden\(\)!\)"/);
    // NEGATIVA: el texto viejo afirmaba que todas tenían su vale abierto (sólo 21 de 160, medido).
    expect(src).not.toContain('su vale de entrada (X-A-37) está abierto y hay que cancelarlo allá');
  });

  it('D41: la ficha de la requisición DICE que su OC se canceló (no cambia de estado) y el servidor lo manda', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const ficha = readFileSync(join(__dirname, 'compras-requisicion-detalle.component.ts'), 'utf8');
    const back = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', '..', 'libs', 'commercial', 'src', 'lib', 'commercial-replenishment', 'commercial-replenishment.service.ts'), 'utf8');
    expect(ficha).toMatch(/@if \(r\.oc_cancelada; as c\)/);
    expect(ficha).toContain('se canceló en Kepler');
    expect(back).toMatch(/purchase_order_cancellations[\s\S]{0,300}estado: 'cancelada'/);
    expect(back).toMatch(/purchase_order_folio: po\?\.folio \?\? null,\s*oc_cancelada,/);
  });
});
