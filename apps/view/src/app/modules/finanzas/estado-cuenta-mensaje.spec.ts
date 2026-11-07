import { mensajeEstadoCuenta } from './estado-cuenta-mensaje';
import type { CarteraDetalle, Partida } from './cartera.service';

/**
 * `[CXC.40]` El mensaje de WhatsApp del estado de cuenta. Caso tomado de la pantalla (2026-11-06,
 * cliente C1026): todo vencido, la más vieja a 103 días.
 */
const P = (folio: string, over: Partial<Partida> = {}) => ({
  folio_digital: folio, saldada: false, vencida: true, dias_vencido: 50, ...over,
}) as unknown as Partida;

const DET = {
  hoy: '2026-11-06',
  cliente: { cliente_nombre: 'ANAHI ELIZABETH NAVEDA LOPEZ ' },
  saldo: 471609.4, vencido: 471609.4, saldo_a_favor: 0,
  partidas: [
    P('00UD1301-0005449', { dias_vencido: 93 }),
    P('00UD1301-0004714', { dias_vencido: 103 }),
    P('00UD1301-0001111', { saldada: true, vencida: false, dias_vencido: 400 }),
  ],
} as unknown as CarteraDetalle;

describe('[CXC.40] mensaje del estado de cuenta', () => {
  it('saluda por nombre, da la fecha de corte y las cifras del diálogo', () => {
    const m = mensajeEstadoCuenta(DET);
    expect(m.split('\n')[0]).toBe('Buen día, *ANAHI ELIZABETH NAVEDA LOPEZ*.');
    expect(m).toContain('al 6 de noviembre de 2026');
    expect(m).toContain('• Saldo total: *$471,609.40*');
    expect(m).toContain('• Vencido: *$471,609.40* (2 facturas)');
    expect(m).toContain('Le adjuntamos el PDF');
  });

  it('nombra la factura vencida más antigua, sin contar las pagadas', () => {
    expect(mensajeEstadoCuenta(DET)).toContain('la 00UD1301-0004714, vencida hace 103 días');
  });

  it('NEGATIVA — sin nada vencido no habla de vencido ni de factura más antigua', () => {
    const m = mensajeEstadoCuenta({ ...DET, vencido: 0, partidas: [P('00UD1301-0009999', { vencida: false, dias_vencido: null, saldo_documento: 471609.4 })] } as CarteraDetalle);
    expect(m).not.toContain('Vencido');
    expect(m).not.toContain('más antigua');
    expect(m).toContain('• Por vencer: $471,609.40');
  });

  it('NEGATIVA — sin emojis: es un mensaje de Crédito y Cobranza', () => {
    expect(mensajeEstadoCuenta(DET)).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
