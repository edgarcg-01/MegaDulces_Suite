import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ComprasEntradasComponent } from './compras-entradas.component';

/**
 * [RE.61] «Siguiente» abre otra entrada mientras las respuestas de la anterior siguen en camino.
 * Medido en prod el 2026-11-09: al pasar de PIÑATAS TOÑO a BOTANAS PAU, el panel mostró unos
 * segundos los productos de PIÑATAS TOÑO bajo el encabezado de BOTANAS PAU. La respuesta que
 * llega tarde no puede pisar a la entrada abierta.
 *
 * Sin TestBed: se arma sobre el prototipo con lo único que tocan openDetail y sus cargas.
 */
type Pendientes = { detail: Subject<any>[]; recon: Subject<any>[]; adj: Subject<any>[] };

function armar() {
  const p: Pendientes = { detail: [], recon: [], adj: [] };
  const nuevo = (lista: Subject<any>[]) => { const s = new Subject<any>(); lista.push(s); return s; };
  const c: any = Object.create(ComprasEntradasComponent.prototype);
  Object.assign(c, {
    showDetail: signal(false), detailLoading: signal(false), detailData: signal(null), detailTarget: signal(null),
    recon: signal(null), reconLoading: signal(false), verLineasKepler: signal(false), hojaIdx: signal(0),
    explains: signal([]), explainsLoading: signal(false), explainsTotal: signal(0),
    destroyRef: { onDestroy: () => () => undefined, destroyed: false },
    toast: { add: () => undefined },
    svc: { detail: () => nuevo(p.detail), reconcile: () => nuevo(p.recon) },
    compras: { adjustmentsForEntrada: () => nuevo(p.adj) },
  });
  return { c, p };
}

const fila = (folio: string) => ({ sucursal: '06', folio, proveedor_code: 'P1', receipt_date: '2026-11-07' }) as any;
const recon = (desc: string) => ({ lines: [{ remision: { descripcion: desc } }], lectura: { fuente: 'ocr', renglones_leidos: 1 } });

describe('[RE.61] la respuesta de la entrada anterior no pisa a la abierta', () => {
  it('conciliación, detalle y ajustes de A que llegan después de abrir B se descartan', () => {
    const { c, p } = armar();
    const a = fila('0001220');
    const b = fila('0000494');

    c.openDetail(a);
    p.detail[0].next({ deposits: [{ ocr_lines: [{ descripcion: 'Piñata Med' }] }] }); // A pide su conciliación
    c.openDetail(b); // «Siguiente» antes de que conteste

    p.recon[0].next(recon('Piñata Med'));
    p.adj[0].next({ rows: [{ id: 'ajuste-de-A' }], total_monto: 50 });
    expect(c.detailTarget()).toBe(b);
    expect(c.recon()).toBeNull();
    expect(c.explains()).toEqual([]);

    p.detail[1].next({ deposits: [{ ocr_lines: [{ descripcion: 'Chicharrón' }] }] });
    p.recon[1].next(recon('Chicharrón'));
    expect(c.recon().lines[0].remision.descripcion).toBe('Chicharrón');
    expect(c.reconLoading()).toBe(false);
  });

  it('el detalle de A que llega tarde tampoco reemplaza al de B', () => {
    const { c, p } = armar();
    c.openDetail(fila('0001220'));
    c.openDetail(fila('0000494'));
    p.detail[1].next({ folio: 'B', deposits: [] });
    p.detail[0].next({ folio: 'A', deposits: [] });
    expect(c.detailData().folio).toBe('B');
  });
});
