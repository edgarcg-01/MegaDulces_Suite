import { decidirLiberar, decidirOcupar, type CarretaHechos, type PedidoHechos } from './carretas.reglas';

/** `[GP.11.3]` Las reglas de la carreta: D7 (un pedido por carreta) y quién la suelta antes del embarque. */

const YO = 'u-yo';
const hora = (iso: string) => iso.slice(11, 16);
const C = (p: Partial<CarretaHechos> = {}): CarretaHechos => ({ code: 'C07', tipo: 'carreta', estado: 'activa', motivo_estado: null, ocupacion: null, ...p });
const P = (p: Partial<PedidoHechos> = {}): PedidoHechos => ({ order_id: 'o-1', pedido: 'PD-000123', surtidor_id: YO, surtidor_nombre: 'Yo', terminado: false, ...p });
const ocupar = (c: CarretaHechos | null, p: PedidoHechos | null) => decidirOcupar(c, p, YO, hora, 'C07', 'Padre Hidalgo');

describe('[GP.11.3] decidirOcupar', () => {
  it('⭐ quien surte el pedido toma una carreta libre', () => {
    expect(ocupar(C(), P())).toEqual({ ok: true, accion: 'ocupar' });
  });

  it('volver a escanear la misma carreta para el mismo pedido no hace nada (idempotente)', () => {
    const c = C({ ocupacion: { order_id: 'o-1', pedido: 'PD-000123', occupied_by: YO, occupied_by_name: 'Yo', occupied_at: '2026-11-20T10:42:00' } });
    expect(ocupar(c, P())).toEqual({ ok: true, accion: 'ya_estaba' });
  });

  it('⭐ NEGATIVA D7: una carreta con otro pedido no se toma, y dice de quién es y desde cuándo', () => {
    const c = C({ ocupacion: { order_id: 'o-9', pedido: 'U-D-40 12345', occupied_by: 'u-ana', occupied_by_name: 'Ana', occupied_at: '2026-11-20T10:42:00' } });
    const d = ocupar(c, P());
    expect(d).toMatchObject({ ok: false, status: 409 });
    expect(d.ok === false && d.motivo).toBe('La carreta C07 ya trae el pedido U-D-40 12345, de Ana desde las 10:42. Usa otra.');
  });

  it('NEGATIVA: una carreta que no existe, bloqueada o dada de baja no se toma, y lo dice', () => {
    expect(ocupar(null, P())).toMatchObject({ ok: false, status: 404 });
    expect(ocupar(C({ estado: 'bloqueada', motivo_estado: 'rueda rota', tipo: 'carrito' }), P())).toEqual({ ok: false, status: 409, motivo: 'El carrito C07 está bloqueado (rueda rota): usa otra.' });
    expect(ocupar(C({ estado: 'baja', motivo_estado: 'se perdió' }), P())).toEqual({ ok: false, status: 409, motivo: 'La carreta C07 está dada de baja (se perdió): usa otra.' });
  });

  it('NEGATIVA: la carreta se toma al EMPEZAR y la toma quien surte — no antes, no después, no otro', () => {
    expect(ocupar(C(), null)).toMatchObject({ ok: false, status: 404 });
    expect(ocupar(C(), P({ surtidor_id: null }))).toMatchObject({ ok: false, status: 409 });
    expect(ocupar(C(), P({ terminado: true }))).toMatchObject({ ok: false, status: 409 });
    expect(ocupar(C(), P({ surtidor_id: 'u-ana', surtidor_nombre: 'Ana' }))).toEqual({ ok: false, status: 403, motivo: 'El pedido PD-000123 lo está surtiendo Ana.' });
  });
});

describe('[GP.11.3] decidirLiberar', () => {
  const oc = { occupied_by: YO, pedido: 'PD-000123' };
  it('⭐ quien la escaneó por error la deshace mientras el pedido sigue en surtido', () => {
    expect(decidirLiberar(oc, 'deshecho', YO, false, false)).toEqual({ ok: true });
  });
  it('el coordinador la libera a mano (provisional hasta E4)', () => {
    expect(decidirLiberar({ occupied_by: 'u-ana', pedido: 'PD-1' }, 'manual', YO, true, true)).toEqual({ ok: true });
  });
  it('NEGATIVA: deshacer la de otro, deshacer con el pedido ya surtido, o liberar sin ser coordinador', () => {
    expect(decidirLiberar({ occupied_by: 'u-ana', pedido: 'PD-1' }, 'deshecho', YO, true, false)).toMatchObject({ ok: false, status: 403 });
    expect(decidirLiberar(oc, 'deshecho', YO, false, true)).toMatchObject({ ok: false, status: 409 });
    expect(decidirLiberar(oc, 'manual', YO, false, false)).toMatchObject({ ok: false, status: 403 });
  });
  it('NEGATIVA: «cargado» es del embarque (E4), una libre no se libera, y un motivo inventado se rechaza', () => {
    expect(decidirLiberar(oc, 'cargado', YO, true, false)).toMatchObject({ ok: false, status: 409 });
    expect(decidirLiberar(null, 'manual', YO, true, false)).toEqual({ ok: false, status: 409, motivo: 'Esa carreta ya está libre.' });
    expect(decidirLiberar(oc, 'se_perdio', YO, true, false)).toMatchObject({ ok: false, status: 409 });
  });
});
