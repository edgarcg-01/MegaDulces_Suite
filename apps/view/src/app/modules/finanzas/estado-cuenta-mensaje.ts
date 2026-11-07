import type { CarteraDetalle } from './cartera.service';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

/**
 * `[CXC.40]` El mensaje de WhatsApp que acompaña al estado de cuenta en PDF.
 *
 * Formato de WhatsApp (`*negritas*`, viñetas), sin emojis: es un mensaje de Crédito y Cobranza a
 * un cliente. Dice lo que decide el pago —total, vencido, por vencer y la factura más vieja—; el
 * detalle factura por factura va en el PDF. Las cifras son las MISMAS del diálogo (y del PDF):
 * salen del mismo auxiliar.
 */
export function mensajeEstadoCuenta(det: CarteraDetalle): string {
  const abiertas = det.partidas.filter((p) => !p.saldada);
  const vencidas = abiertas.filter((p) => p.vencida);
  const masVieja = [...vencidas].sort((a, b) => (b.dias_vencido ?? 0) - (a.dias_vencido ?? 0))[0];
  // Igual que el PDF: las facturas al corriente, no `saldo − vencido` (eso mete lo no asignado).
  const porVencer = Math.round(abiertas.filter((p) => !p.vencida).reduce((s, p) => s + p.saldo_documento, 0) * 100) / 100;
  const f = det.hoy;
  const corte = `${Number(f.slice(8, 10))} de ${MESES[Number(f.slice(5, 7)) - 1]} de ${f.slice(0, 4)}`;

  const l: string[] = [
    `Buen día, *${det.cliente.cliente_nombre.trim()}*.`,
    '',
    `Le compartimos su estado de cuenta con *Mega Dulces* al ${corte}:`,
    '',
    `• Saldo total: *${MXN.format(det.saldo)}*`,
  ];
  if (det.vencido > 0) l.push(`• Vencido: *${MXN.format(det.vencido)}* (${vencidas.length} factura${vencidas.length === 1 ? '' : 's'})`);
  if (porVencer > 0.005) l.push(`• Por vencer: ${MXN.format(porVencer)}`);
  if (det.saldo_a_favor > 0) l.push(`• Saldo a su favor: ${MXN.format(det.saldo_a_favor)}`);
  if (masVieja) {
    l.push('', `La factura pendiente más antigua es la ${masVieja.folio_digital}, vencida hace ${masVieja.dias_vencido} día${masVieja.dias_vencido === 1 ? '' : 's'}.`);
  }
  l.push(
    '',
    'Le adjuntamos el PDF con el detalle de cada factura.',
    'Si ya realizó su pago, le agradeceremos compartirnos el comprobante para aplicarlo a su cuenta. Quedamos a sus órdenes para cualquier aclaración.',
    '',
    '*Mega Dulces* · Crédito y Cobranza',
  );
  return l.join('\n');
}
