import { mensajeEstadoCuenta, mensajeVendedor, pdfPublicoDelEnlace } from './estado-cuenta-mensaje';
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
  cliente: { cliente_nombre: 'ANAHI ELIZABETH NAVEDA LOPEZ ', cliente_code: 'C1026', vendedor: '501', vendedor_nombre: '501 Victor Manuel Zalapa Barri' },
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

describe('[CXC.47] periodo y envío al vendedor', () => {
  const ENLACE = 'https://megadulcessuite.com/deposito/eyJ.abc.def';
  const PDF12 = pdfPublicoDelEnlace(ENLACE, '2025-11-06');

  it('la liga pública al PDF sale del enlace del cliente, con el periodo', () => {
    expect(PDF12).toBe('https://megadulcessuite.com/api/finance/deposito/eyJ.abc.def/estado-de-cuenta.pdf?date_from=2025-11-06');
    expect(pdfPublicoDelEnlace(ENLACE, 'todo')).toContain('date_from=todo');
  });

  it('NEGATIVA — sin enlace (o con uno que no es de depósito) no inventa liga', () => {
    expect(pdfPublicoDelEnlace(null, '2025-11-06')).toBeNull();
    expect(pdfPublicoDelEnlace('https://megadulcessuite.com/otra/cosa', '2025-11-06')).toBeNull();
  });

  it('al cliente: con el periodo por defecto no repite liga; con otro, la agrega con su nombre', () => {
    const def = mensajeEstadoCuenta(DET, ENLACE, { etiqueta: 'Últimos 3 meses', pdfUrl: PDF12, porDefecto: true });
    expect(def).not.toContain('/api/finance/deposito/');
    const otro = mensajeEstadoCuenta(DET, ENLACE, { etiqueta: 'Último año', pdfUrl: PDF12, porDefecto: false });
    expect(otro).toContain('(último año):');
    expect(otro).toContain(PDF12!);
    expect(otro).toContain(ENLACE);
  });

  it('al vendedor: lo saluda sin el número de ruta, nombra al cliente con su código y lleva las mismas cifras', () => {
    const m = mensajeVendedor(DET, ENLACE, { etiqueta: 'Último año', pdfUrl: PDF12, porDefecto: false });
    expect(m.split('\n')[0]).toBe('Hola, *Victor Manuel Zalapa Barri*.');
    expect(m).toContain('tu cliente *ANAHI ELIZABETH NAVEDA LOPEZ* (C1026) al 6 de noviembre de 2026');
    expect(m).toContain('• Saldo total: *$471,609.40*');
    expect(m).toContain('la 00UD1301-0004714, vencida hace 103 días');
    expect(m).toContain('(último año):');
    expect(m).toContain(PDF12!);
    expect(m).toContain(ENLACE);
    expect(m).not.toContain('Te adjunto');
    expect(m).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('al vendedor sin enlace: dice que adjunta el PDF y no inventa ligas', () => {
    const m = mensajeVendedor(DET, null, { etiqueta: 'Últimos 3 meses', pdfUrl: null, porDefecto: true });
    expect(m).toContain('Te adjunto el PDF');
    expect(m).not.toContain('http');
  });
});
