import type { CarteraDetalle } from './cartera.service';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

/**
 * `[CXC.47]` El periodo que eligió quien envía. `pdfUrl` es la liga pública al PDF de ESE periodo (sale del enlace del
 * cliente); `porDefecto` dice si es el mismo que trae el PDF de la página del enlace (3 meses), y entonces no hace
 * falta una segunda liga en el mensaje del cliente.
 */
export interface PeriodoMensaje { etiqueta: string; pdfUrl: string | null; porDefecto: boolean }

/**
 * `[CXC.47]` La liga pública al PDF con un periodo, a partir del enlace del cliente (`<origen>/deposito/<token>`). La
 * autoriza el mismo token (`GET /api/finance/deposito/:token/estado-de-cuenta.pdf`). Sin enlace, no hay liga: el PDF
 * se adjunta a mano.
 */
export function pdfPublicoDelEnlace(enlace: string | null | undefined, dateFrom: string): string | null {
  const m = (enlace || '').match(/^(https?:\/\/[^/]+)\/deposito\/([^/?#]+)$/);
  return m ? `${m[1]}/api/finance/deposito/${m[2]}/estado-de-cuenta.pdf?date_from=${encodeURIComponent(dateFrom)}` : null;
}

/** Lo que decide el pago, igual para el cliente y para el vendedor: las MISMAS cifras del diálogo y del PDF. */
function resumen(det: CarteraDetalle): { corte: string; lineas: string[]; masVieja: string | null } {
  const abiertas = det.partidas.filter((p) => !p.saldada);
  const vencidas = abiertas.filter((p) => p.vencida);
  const vieja = [...vencidas].sort((a, b) => (b.dias_vencido ?? 0) - (a.dias_vencido ?? 0))[0];
  // Igual que el PDF: las facturas al corriente, no `saldo − vencido` (eso mete lo no asignado).
  const porVencer = Math.round(abiertas.filter((p) => !p.vencida).reduce((s, p) => s + p.saldo_documento, 0) * 100) / 100;
  const f = det.hoy;
  const corte = `${Number(f.slice(8, 10))} de ${MESES[Number(f.slice(5, 7)) - 1]} de ${f.slice(0, 4)}`;
  const lineas = [`• Saldo total: *${MXN.format(det.saldo)}*`];
  if (det.vencido > 0) lineas.push(`• Vencido: *${MXN.format(det.vencido)}* (${vencidas.length} factura${vencidas.length === 1 ? '' : 's'})`);
  if (porVencer > 0.005) lineas.push(`• Por vencer: ${MXN.format(porVencer)}`);
  if (det.saldo_a_favor > 0) lineas.push(`• Saldo a su favor: ${MXN.format(det.saldo_a_favor)}`);
  const masVieja = vieja
    ? `La factura pendiente más antigua es la ${vieja.folio_digital}, vencida hace ${vieja.dias_vencido} día${vieja.dias_vencido === 1 ? '' : 's'}.`
    : null;
  return { corte, lineas, masVieja };
}

/**
 * `[CXC.40]` El mensaje de WhatsApp que acompaña al estado de cuenta en PDF.
 *
 * Formato de WhatsApp (`*negritas*`, viñetas), sin emojis: es un mensaje de Crédito y Cobranza a
 * un cliente. Dice lo que decide el pago —total, vencido, por vencer y la factura más vieja—; el
 * detalle factura por factura va en el PDF. Las cifras son las MISMAS del diálogo (y del PDF):
 * salen del mismo auxiliar.
 */
export function mensajeEstadoCuenta(det: CarteraDetalle, enlaceDeposito?: string | null, periodo?: PeriodoMensaje | null): string {
  const r = resumen(det);
  const l: string[] = [
    `Buen día, *${det.cliente.cliente_nombre.trim()}*.`,
    '',
    `Le compartimos su estado de cuenta con *Mega Dulces* al ${r.corte}:`,
    '',
    ...r.lineas,
  ];
  if (r.masVieja) l.push('', r.masVieja);
  // `[CC.20]` Con enlace, el comprobante se sube ahí (foto o captura, sin usuario ni contraseña) y le llega directo a
  // Cobranza. `[CC.20.2]` Y el PDF también está ahí: wa.me sólo lleva texto, así que «le adjuntamos» sólo se dice
  // cuando no hay enlace (y entonces quien envía lo adjunta a mano). Sin enlace, como antes: que nos lo comparta.
  if (enlaceDeposito) {
    // `[CXC.47]` El PDF de la página del enlace trae los últimos 3 meses. Si se eligió otro periodo, va su liga aparte.
    if (periodo?.pdfUrl && !periodo.porDefecto) {
      l.push('', `Su estado de cuenta en PDF, con las facturas pagadas y pendientes (${periodo.etiqueta.toLowerCase()}):`, periodo.pdfUrl);
    }
    l.push(
      '',
      'En su enlace personal puede descargar el PDF con el detalle de cada factura y, *si ya pagó*, subir la foto de su ficha de depósito o la captura de su transferencia, sin usuario ni contraseña:',
      enlaceDeposito,
      'Es personal de su cuenta; en ese mismo enlace verá cuando su pago quede aplicado.',
      '',
      'Quedamos a sus órdenes para cualquier aclaración.',
    );
  } else {
    l.push('', 'Le adjuntamos el PDF con el detalle de cada factura.');
    l.push('Si ya realizó su pago, le agradeceremos compartirnos el comprobante para aplicarlo a su cuenta. Quedamos a sus órdenes para cualquier aclaración.');
  }
  l.push('', '*Mega Dulces* · Crédito y Cobranza');
  return l.join('\n');
}

/**
 * `[CXC.47]` El mismo estado de cuenta, para el VENDEDOR que atiende la cuenta (Edgar, 2026-11-20: «que se pueda mandar
 * al vendedor y al cliente»). Tutea (es de la casa), nombra al cliente con su código y trae las mismas cifras. Con
 * enlace, lleva la liga al PDF del periodo elegido y el enlace del cliente para que se lo reenvíe si ya pagó.
 *
 * ⚠️ Ni Kepler (`kduv`) ni los usuarios de la Suite guardan el teléfono del vendedor (medido el 2026-11-20): el chat
 * se elige en WhatsApp. El nombre de `kduv.c3` trae el número de ruta delante («501 Victor Manuel…»): se quita.
 */
export function mensajeVendedor(det: CarteraDetalle, enlaceDeposito?: string | null, periodo?: PeriodoMensaje | null): string {
  const r = resumen(det);
  const c = det.cliente;
  const nombre = (c.vendedor_nombre || '').replace(/^\d+\s+/, '').trim();
  const l: string[] = [
    nombre ? `Hola, *${nombre}*.` : 'Hola.',
    '',
    `Estado de cuenta de tu cliente *${c.cliente_nombre.trim()}* (${c.cliente_code}) al ${r.corte}:`,
    '',
    ...r.lineas,
  ];
  if (r.masVieja) l.push('', r.masVieja);
  if (periodo?.pdfUrl) {
    l.push('', `PDF con las facturas pagadas y pendientes (${periodo.etiqueta.toLowerCase()}):`, periodo.pdfUrl);
  } else {
    l.push('', 'Te adjunto el PDF con el detalle de cada factura.');
  }
  if (enlaceDeposito) {
    l.push('', 'Si ya pagó, el cliente puede subir la foto de su ficha en su enlace personal. Es de su cuenta: compártelo sólo con él.', enlaceDeposito);
  }
  l.push('', '*Mega Dulces* · Crédito y Cobranza');
  return l.join('\n');
}
