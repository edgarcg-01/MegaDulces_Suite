/**
 * `[CGA-A.65]` El candado de la hoja de gastos de zona — la decisión, sin base. Edgar, 2026-10-29:
 * *«tiene que estar aprobada, si no está aprobada no se puede pagar»*. Cada regla con su negativa:
 * un candado que nunca dice que no es un adorno.
 */
import { ZONAS_HOJA_GASTOS } from '@megadulces/contracts';
import { textoPagoDeHoja, veredictoPagoDeHoja, type EscrituraDeDinero, type HojaDelPago, type RequisitoDelPago } from './hoja-gastos.gate';

const MORELIA = ZONAS_HOJA_GASTOS.find((z) => z.clave === 'morelia')!;
const REF = '08|X-D-26|0000697|0011';
const RETIRO = { device: 'AST700-19758', external_id: 1830 };
const OTRO = { device: 'AST700-19758', external_id: 1706 };

const hoja = (estado: string, extra: Partial<HojaDelPago> = {}): HojaDelPago => ({
  id: 'h7', numero: 7, estado, medio: null, caos_device: null, caos_external_id: null, ...extra,
});
const pagada = (medio: 'caos' | 'cajon') => hoja('pagada', medio === 'caos'
  ? { medio, caos_device: RETIRO.device, caos_external_id: RETIRO.external_id }
  : { medio });
const req = (h: HojaDelPago | null): RequisitoDelPago => ({ zona: MORELIA, hoja: h });
const gasto = (extra: Partial<EscrituraDeDinero> = {}): EscrituraDeDinero => ({
  origen_ref: REF, tipo: 'gasto', retiros: [], origen_efectivo: null, ...extra,
});

describe('[CGA-A.65] sin hoja pagada, un pago de la hoja no entra al libro', () => {
  it('NEGATIVA: sin hoja todavía → 400, y dice dónde se paga', () => {
    const v = veredictoPagoDeHoja(gasto({ retiros: [RETIRO] }), [], req(null));
    expect(v).toEqual({ ok: false, http: 400, texto: expect.stringContaining('Va en la hoja de gastos de Zona Morelia') });
    expect(v.ok === false && v.texto).toContain('Finanzas › Gastos › Hoja de zona');
  });

  it('NEGATIVA: en una hoja que espera aprobación → 400 «sin aprobación no se paga»', () => {
    const v = veredictoPagoDeHoja(gasto({ origen_efectivo: 'cajon' }), [], req(hoja('cerrada')));
    expect(v).toMatchObject({ ok: false, http: 400 });
    expect(v.ok === false && v.texto).toContain('sin aprobación no se paga');
  });

  it('NEGATIVA: aprobada pero sin pagar → tampoco suelto: se paga con la hoja, de un solo retiro', () => {
    const v = veredictoPagoDeHoja(gasto({ retiros: [RETIRO] }), [], req(hoja('aprobada')));
    expect(v).toMatchObject({ ok: false, http: 400 });
    expect(v.ok === false && v.texto).toContain('de un solo retiro');
  });
});

describe('[CGA-A.65] con la hoja pagada: sólo su retiro, o el cajón', () => {
  it('pagada con un retiro: ligado a ESE retiro, entra', () => {
    expect(veredictoPagoDeHoja(gasto({ retiros: [RETIRO] }), [{ hoja: pagada('caos'), esSuyo: true }], req(pagada('caos')))).toEqual({ ok: true });
  });

  it('pagada con un retiro: la diferencia, del cajón, entra', () => {
    expect(veredictoPagoDeHoja(gasto({ origen_efectivo: 'cajon' }), [], req(pagada('caos')))).toEqual({ ok: true });
  });

  it('NEGATIVA: pagada con un retiro, ligado a OTRO retiro → 409', () => {
    const v = veredictoPagoDeHoja(gasto({ retiros: [OTRO] }), [], req(pagada('caos')));
    expect(v).toMatchObject({ ok: false, http: 409 });
    expect(v.ok === false && v.texto).toContain('se pagó con el retiro 1830');
  });

  it('NEGATIVA: pagada con un retiro, sin retiro ni cajón → 409 (no entra sin decir de dónde salió)', () => {
    expect(veredictoPagoDeHoja(gasto(), [], req(pagada('caos')))).toMatchObject({ ok: false, http: 409 });
  });

  it('pagada con el cajón: del cajón entra; NEGATIVA: con un retiro, no', () => {
    expect(veredictoPagoDeHoja(gasto({ origen_efectivo: 'cajon' }), [], req(pagada('cajon')))).toEqual({ ok: true });
    const v = veredictoPagoDeHoja(gasto({ retiros: [RETIRO] }), [], req(pagada('cajon')));
    expect(v).toMatchObject({ ok: false, http: 409 });
    expect(v.ok === false && v.texto).toContain('se pagó con el cajón');
  });
});

describe('[CGA-A.65] el retiro de una hoja sólo explica pagos de esa hoja', () => {
  it('NEGATIVA: un pago que no es de la hoja (aunque sea de otra sucursal) no se liga a su retiro → 409', () => {
    const ajeno = gasto({ origen_ref: '06|X-D-26|0000344|0011', retiros: [RETIRO] });
    const v = veredictoPagoDeHoja(ajeno, [{ hoja: pagada('caos'), esSuyo: false }], null);
    expect(v).toMatchObject({ ok: false, http: 409 });
    expect(v.ok === false && v.texto).toContain('pagó la hoja HG-7');
  });

  it('un pago que no va en ninguna hoja, con un retiro que no pagó hojas: sigue su camino de siempre', () => {
    expect(veredictoPagoDeHoja(gasto({ origen_ref: '01|X-D-26|0000100|0011', retiros: [OTRO] }), [], null)).toEqual({ ok: true });
  });

  it('un ingreso no es pago de hoja: sólo le aplica la regla del retiro', () => {
    expect(veredictoPagoDeHoja(gasto({ tipo: 'ingreso' }), [], req(null))).toEqual({ ok: true });
  });
});

describe('[CGA-A.65] la frase de la cola', () => {
  it('dice la hoja y su estado, o que todavía no va en una', () => {
    expect(textoPagoDeHoja(req(null))).toContain('Zona Morelia');
    expect(textoPagoDeHoja(req(hoja('cerrada')))).toContain('HG-7');
    expect(textoPagoDeHoja(req(hoja('aprobada')))).toContain('ya aprobada');
  });
});
