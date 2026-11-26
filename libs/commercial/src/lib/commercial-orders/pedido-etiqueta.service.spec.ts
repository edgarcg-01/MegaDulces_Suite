import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { folioDeLectura } from '@megadulces/contracts';
import { PedidoEtiquetaService, VIGENCIA_LIGA_DIAS } from './pedido-etiqueta.service';

/**
 * `[MCP.36]` La firma de la liga de la etiqueta: quién la abre y quién no. Base falsa: aquí se prueba la FIRMA y la
 * forma de la respuesta; la lectura contra Postgres real va aparte (NO MEDIDO en esta suite).
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** Un `trx` de knex mínimo: devuelve `pedido` en `.first()` y `renglones` en `.select()`. */
function trxFalso(pedido: Record<string, unknown> | null, renglones: Record<string, unknown>[] = []) {
  const qb = () => {
    const q: Record<string, unknown> = {};
    for (const m of ['leftJoin', 'where', 'whereNull', 'orderBy']) q[m] = () => q;
    q['first'] = async () => pedido;
    q['select'] = async () => renglones;
    return q;
  };
  const trx = ((/* tabla */) => qb()) as unknown as Record<string, unknown> & ((t: string) => unknown);
  (trx as Record<string, unknown>)['raw'] = (s: string) => s;
  return trx;
}

function servicio(pedido: Record<string, unknown> | null = { id: 'x' }, renglones: Record<string, unknown>[] = []) {
  const tk = { run: (fn: (t: unknown) => unknown) => fn(trxFalso(pedido, renglones)) };
  const ctx = {
    requireTenantId: () => TENANT,
    run: vi.fn((_c: unknown, fn: () => unknown) => fn()),
  };
  const svc = new PedidoEtiquetaService(tk as never, ctx as never, new JwtService({}));
  return { svc, ctx };
}

const PEDIDO = {
  id: 'id-1', code: 'PD-2026-00039', status: 'confirmed', created_at: new Date('2026-11-24T16:00:00Z'),
  requested_delivery_date: '2026-11-26', currency: 'MXN', subtotal: '100.50', tax_total: '0', total: '100.50',
  basket_discount_amount: null, cliente: 'ABARROTES DE PRUEBA', sucursal: 'Sucursal de prueba', vendedor: 'Vendedor de prueba',
  pick_started_at: new Date(), pick_finished_at: new Date(), pick_outcome: 'completo', reviewed_at: null,
};

describe('[MCP.36] PedidoEtiquetaService', () => {
  beforeAll(() => {
    process.env['JWT_SECRET'] = 'clave-de-prueba-de-al-menos-32-bytes-xxxxxxxx';
    delete process.env['PUBLIC_LINK_URL'];
    delete process.env['APP_PUBLIC_URL'];
  });

  it('la liga lleva el dominio PÚBLICO aunque se imprima desde la IP de la oficina, y se lee de vuelta', async () => {
    const { svc } = servicio();
    const f = await svc.firmar('PD-2026-00039', 'http://192.168.0.10:30080');
    expect(f.liga.startsWith('https://megadulcessuite.com/pedido/PD-2026-00039?k=')).toBe(true);
    expect(folioDeLectura(f.liga)).toBe('PD-2026-00039');
    const dias = (new Date(f.vence).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(dias)).toBe(VIGENCIA_LIGA_DIAS);
  });

  it('abre el pedido con montos, en la empresa de la firma y sin campos internos', async () => {
    const { svc, ctx } = servicio(PEDIDO, [
      { producto: 'PALETA DE PRUEBA', sku: '123', quantity: '2', qty_unit: 'caja', unit_price: '50.25', line_total: '100.50' },
    ]);
    const { k } = await svc.firmar('PD-2026-00039');
    const p = await svc.leer('PD-2026-00039', k);
    expect(ctx.run).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }), expect.any(Function));
    expect(p.paso.clave).toBe('surtido');
    expect(p.total).toBe(100.5);
    expect(p.renglones).toEqual([{ producto: 'PALETA DE PRUEBA', sku: '123', cantidad: 2, unidad: 'caja', precio: 50.25, importe: 100.5 }]);
    expect(p.descuento).toBeNull(); // sin dato no es 0
    expect(Object.keys(p)).not.toContain('id');
    expect(p.liga_vence).not.toBeNull();
  });

  it('negativa: firma alterada, de OTRO pedido o vacía → 403', async () => {
    const { svc } = servicio(PEDIDO);
    const { k } = await svc.firmar('PD-2026-00039');
    await expect(svc.leer('PD-2026-00039', k.slice(0, -2) + 'xx')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.leer('PD-2026-00040', k)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.leer('PD-2026-00039', '')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('negativa: un token firmado con la clave de SESIÓN no abre la liga (y la liga no es una sesión)', async () => {
    const { svc } = servicio(PEDIDO);
    const sesion = new JwtService({ secret: process.env['JWT_SECRET'] });
    const deSesion = sesion.sign({ t: 'pe', tn: TENANT, f: 'PD-2026-00039' });
    await expect(svc.leer('PD-2026-00039', deSesion)).rejects.toBeInstanceOf(ForbiddenException);
    const { k } = await svc.firmar('PD-2026-00039');
    expect(() => sesion.verify(k)).toThrow();
  });

  it('negativa: una liga vencida → 403', async () => {
    const { svc } = servicio(PEDIDO);
    const { k } = await svc.firmar('PD-2026-00039');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (VIGENCIA_LIGA_DIAS + 1) * 86_400_000);
    try {
      await expect(svc.leer('PD-2026-00039', k)).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      vi.useRealTimers();
    }
  });

  it('firmar un pedido que no existe en la empresa → 404 (no se firma a ciegas)', async () => {
    const { svc } = servicio(null);
    await expect(svc.firmar('PD-2026-00039')).rejects.toBeInstanceOf(NotFoundException);
  });
});
