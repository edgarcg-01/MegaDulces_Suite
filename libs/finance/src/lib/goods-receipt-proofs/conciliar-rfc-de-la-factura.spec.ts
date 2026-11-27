import { GoodsReceiptProofsService } from './goods-receipt-proofs.service';
import type { RfcsDelProveedor } from './fuente-renglones';

/**
 * `[PQ.150]` segundo tramo, la cañería de punta a punta en `reconcileLines`: el RFC de la factura ligada sale
 * de `fiscal.cfdis` (`fuenteRenglones`), entra a la búsqueda de lo aprendido (`equivalenciasDe`) y la respuesta
 * dice con qué RFC se buscó y se aprende. Medido el 2026-11-27: 453 de 1,077 entradas de 30 días (42.1 %)
 * llegan sin RFC al espejo y la conciliación no buscaba NADA para ellas.
 *
 * Sin TestBed ni base: el servicio sobre su prototipo, un `trx` falso (sólo lo que esta ruta lee) y la carga de
 * equivalencias espiada. La lectura real de alias con dos RFC está en `aprender-alias.servicio-real.spec.ts`.
 */
const T = '00000000-0000-0000-0000-00000000d01c';
const XML = '﻿<?xml version="1.0" encoding="UTF-8"?><cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0">'
  + '<cfdi:Conceptos><cfdi:Concepto NoIdentificacion="GEL-750" Descripcion="GELATINA 750" Cantidad="50" ClaveUnidad="H87" ValorUnitario="10.60" Importe="530.31"/></cfdi:Conceptos></cfdi:Comprobante>';

type Fila = Record<string, unknown> | undefined;
function trxFalso(tablas: Record<string, { first?: Fila; rows?: unknown[] }>) {
  const t = ((tabla: string) => {
    const r = tablas[tabla] ?? {};
    const cadena: Record<string, unknown> = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'orderByRaw']) cadena[m] = () => cadena;
    cadena['first'] = async () => r.first;
    cadena['select'] = async () => r.rows ?? [];
    return cadena;
  }) as unknown as Record<string, unknown> & ((t: string) => unknown);
  (t as unknown as { raw: (s: string) => string }).raw = (s: string) => s;
  return t;
}

function armar({ rfcKepler, cfdi }: { rfcKepler: string | null; cfdi: { emisor_rfc: string; xml: string | null } | null }) {
  const vistos: RfcsDelProveedor[] = [];
  const trx = trxFalso({
    'analytics.erp_goods_receipts': { first: { proveedor_rfc: rfcKepler, proveedor_nombre: 'PROVEEDOR DE PRUEBA' } },
    'analytics.erp_goods_receipt_lines': { rows: [] },
    'fiscal.cfdis': { first: cfdi ?? undefined },
    'finance.goods_receipt_proofs': { rows: [] },
  });
  const svc = Object.create(GoodsReceiptProofsService.prototype) as GoodsReceiptProofsService & Record<string, unknown>;
  Object.assign(svc, {
    tenantCtx: { requireTenantId: () => T },
    tk: { run: (fn: (trx: unknown) => unknown) => fn(trx) },
    expediente: {
      calcularLote: async () => new Map(cfdi ? [['00/0000999', { cfdi: { id: 'cf-1', uuid: 'UUID-1' }, liga: { exacta: true } }]] : []),
    },
    equivalenciasDe: async (_t: unknown, _tenant: string, quien: RfcsDelProveedor) => {
      vistos.push(quien);
      return { aliasMap: new Map(), aliasPorCodigo: new Map(), historiaPorCodigo: new Map() };
    },
  });
  return { svc, vistos };
}

describe('[PQ.150] la conciliación busca y aprende con el RFC de quien factura', () => {
  it('el acreedor sin RFC en Kepler, con su factura ligada: busca y aprende con el de la factura, y lo dice', async () => {
    const { svc, vistos } = armar({ rfcKepler: '', cfdi: { emisor_rfc: 'QWE141008AB4', xml: XML } });
    const r = await svc.reconcileLines('00', '0000999', []);
    expect(vistos).toEqual([{ aprender: 'QWE141008AB4', fuente: 'factura', buscar: ['QWE141008AB4'] }]);
    expect(r).toMatchObject({ proveedor_rfc: 'QWE141008AB4', proveedor_rfc_fuente: 'factura' });
    expect(r.lectura?.fuente).toBe('cfdi');
  });

  it('Kepler trae otro RFC: se busca con los dos, la factura primero', async () => {
    const { svc, vistos } = armar({ rfcKepler: 'QWE14108AB4', cfdi: { emisor_rfc: 'QWE141008AB4', xml: XML } });
    await svc.reconcileLines('00', '0000999', []);
    expect(vistos[0].buscar).toEqual(['QWE141008AB4', 'QWE14108AB4']);
  });

  it('la factura ligada sin su XML todavía: los renglones salen del OCR, pero el RFC de la factura sí se usa', async () => {
    const { svc, vistos } = armar({ rfcKepler: null, cfdi: { emisor_rfc: 'QWE141008AB4', xml: null } });
    const r = await svc.reconcileLines('00', '0000999', []);
    expect(r.lectura?.fuente).toBe('ocr');
    expect(vistos[0]).toMatchObject({ aprender: 'QWE141008AB4', fuente: 'factura' });
  });

  it('CONTROL: sin factura ligada, todo como antes — el de Kepler', async () => {
    const { svc, vistos } = armar({ rfcKepler: 'aaa010101aaa', cfdi: null });
    const r = await svc.reconcileLines('00', '0000999', []);
    expect(vistos).toEqual([{ aprender: 'AAA010101AAA', fuente: 'kepler', buscar: ['AAA010101AAA'] }]);
    expect(r).toMatchObject({ proveedor_rfc: 'AAA010101AAA', proveedor_rfc_fuente: 'kepler' });
  });

  it('sin ningún RFC no busca nada y la respuesta lo dice (no inventa uno)', async () => {
    const { svc } = armar({ rfcKepler: '', cfdi: null });
    const r = await svc.reconcileLines('00', '0000999', []);
    expect(r).toMatchObject({ proveedor_rfc: null, proveedor_rfc_fuente: null });
  });
});
