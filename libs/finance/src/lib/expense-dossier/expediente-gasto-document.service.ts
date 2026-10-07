import { Injectable } from '@nestjs/common';
import { esc, htmlAPdf, money } from '../shared/chromium-pdf';
import { ExpedienteGastoService, type ExpedienteGasto } from './expediente-gasto.service';

const CLASIFICACION_LABEL: Record<string, string> = {
  fiscal: 'Con factura',
  no_fiscal_comprobable: 'Sólo ticket o recibo',
  no_comprobable: 'Sin comprobante',
};
const FORMA_PAGO_LABEL: Record<string, string> = {
  efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia',
  cheque: 'Cheque', vales: 'Vales', otro: 'Otro',
};
const ESTADO_KEPLER: Record<string, string> = {
  F: 'Aplicada', A: 'Autorizada', N: 'Por ejercer', C: 'Cancelada',
};
const ESTADO_NUESTRO: Record<string, string> = {
  recibida: 'Recibida', aprobada: 'Aprobada', validada: 'Validada',
  rechazada: 'Rechazada', revision: 'En revisión',
};

function fecha(v: unknown): string {
  if (!v) return '—';
  const iso = String(v).slice(0, 10);
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return esc(iso);
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${d} ${MESES[m - 1]} ${y}`;
}
function fechaHora(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Mexico_City' });
}

/**
 * `[GX.15]` — **El expediente del gasto, imprimible.**
 *
 * Un solo documento con los cuatro eslabones: la solicitud de Kepler, lo que aportó quien
 * gastó (forma de pago + fotos), el gasto aplicado y la comprobación. Es lo que hoy
 * obliga a abrir tres pantallas y copiar a mano.
 *
 * ## Lo que este documento NO es
 * **No es un comprobante fiscal ni una póliza.** No lo emite Kepler, no se sube a
 * ContPAQi y no reemplaza a la factura: es el **respaldo interno** de un trámite, armado
 * a partir de lo que ya existe. Lo dice en el pie, en el propio papel, para que nadie lo
 * presente como lo que no es.
 *
 * ## Las fotos NO se embeben
 * Las evidencias viven en un bucket privado y se sirven con URL firmada temporal. Meterlas
 * en el PDF (a `data:`) haría un archivo de decenas de MB **y** convertiría una evidencia
 * con caducidad en una copia permanente que viaja por correo sin control. El documento
 * **lista** cada archivo con su rol, su sello de captura y su hora; quien necesite verlas
 * entra al expediente. Se declara acá porque es una decisión, no un olvido.
 *
 * Usa el Chromium compartido de `libs/finance` (`shared/chromium-pdf.ts`), no una cuarta
 * copia del singleton.
 */
@Injectable()
export class ExpedienteGastoDocumentService {
  constructor(private readonly svc: ExpedienteGastoService) {}

  async render(
    sucursal: string,
    folio: string,
    user?: { sub?: string; role_name?: string; permissions?: Record<string, boolean> },
  ): Promise<{ pdf: Buffer; nombre: string }> {
    const x = await this.svc.expediente(sucursal, folio, user);
    const pdf = await htmlAPdf(this.html(x), { footer: this.pie(x) });
    return { pdf, nombre: `expediente-${x.sucursal}-${x.folio_solicitud}.pdf` };
  }

  /** Una fila de la tabla de datos (etiqueta + valor). */
  private fila(k: string, v: string): string {
    return `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
  }

  /** Un bloque ausente se DICE, no se deja en blanco: en blanco no se distingue de un bug. */
  private vacio(txt: string): string {
    return `<p class="vacio">${esc(txt)}</p>`;
  }

  private bloqueSolicitud(x: ExpedienteGasto): string {
    const s = x.solicitud as any;
    if (!s) return this.vacio('No hay solicitud con ese folio.');
    return `<table class="datos">
      ${this.fila('Fecha', fecha(s.fecha))}
      ${this.fila('Importe', `<strong>${money(s.importe)}</strong>${Number(s.iva) > 0 ? ` <span class="mut">(IVA ${money(s.iva)})</span>` : ' <span class="mut">(sin IVA)</span>'}`)}
      ${this.fila('Solicita', esc(s.solicitante || '—'))}
      ${this.fila('Beneficiario', esc(s.acreedor || s.beneficiario || '—'))}
      ${this.fila('Concepto', esc(s.concepto || '—'))}
      ${this.fila('Cuenta', `<span class="mono">${esc(s.cuenta_clave || '—')}</span>`)}
      ${this.fila('Autoriza', esc(s.autoriza || '—'))}
      ${this.fila('Estado en Kepler', esc(ESTADO_KEPLER[s.estado] || s.estado || '—'))}
    </table>`;
  }

  private bloqueExpediente(x: ExpedienteGasto): string {
    const p = x.expediente as any;
    if (!p) return this.vacio('Nadie capturó el expediente de esta solicitud: no hay forma de pago declarada ni foto del comprobante.');
    const archivos = (p.files || []) as any[];
    const lista = archivos.length
      ? `<ul class="files">${archivos.map((f) => {
        const sello = f.live
          ? `<span class="viva">EN VIVO</span>${f.captured_at ? ` <span class="mut">${esc(fechaHora(f.captured_at))}</span>` : ''}`
          : '<span class="mut">archivo (sin sello de cámara)</span>';
        return `<li><span class="rol">${esc(f.role || '—')}</span> ${sello}</li>`;
      }).join('')}</ul>`
      : this.vacio('Sin archivos adjuntos.');
    return `<table class="datos">
      ${this.fila('Tipo de gasto', esc(CLASIFICACION_LABEL[p.clasificacion] || p.clasificacion || '—'))}
      ${this.fila('Cómo se pagó', p.forma_pago
        ? `${esc(FORMA_PAGO_LABEL[p.forma_pago] || p.forma_pago)}${p.forma_pago_detalle ? ` · <span class="mono">${esc(p.forma_pago_detalle)}</span>` : ''}`
        : '<em class="mut">no se declaró — el expediente es anterior a que se pidiera</em>')}
      ${this.fila('Estado', esc(ESTADO_NUESTRO[p.status] || p.status || '—'))}
      ${this.fila('Capturó', `${esc(p.created_by || '—')} <span class="mut">${esc(fechaHora(p.created_at))}</span>`)}
      ${p.validated_by ? this.fila('Validó', `${esc(p.validated_by)} <span class="mut">${esc(fechaHora(p.validated_at))}</span>`) : ''}
      ${p.motivo_rechazo ? this.fila('Motivo del rechazo', esc(p.motivo_rechazo)) : ''}
      ${p.comprobacion_nota ? this.fila('Por qué no se comprueba', esc(p.comprobacion_nota)) : ''}
      ${this.fila('Evidencias', lista)}
    </table>`;
  }

  private bloqueGastos(x: ExpedienteGasto): string {
    if (!x.gastos.length) return this.vacio('Kepler todavía no aplicó el gasto de esta solicitud.');
    const suma = x.gastos.reduce((a, g: any) => a + Number(g.importe), 0);
    const filas = x.gastos.map((g: any) => `<tr>
      <td class="mono">${esc(g.doc_folio)}</td>
      <td>${fecha(g.fecha)}</td>
      <td>${esc(g.beneficiario || '—')}</td>
      <td>${esc(g.usuario || '—')}</td>
      <td class="num">${money(g.importe)}</td>
    </tr>`).join('');
    // Con más de un gasto la cifra que importa es la SUMA: es contra ella que se juzga si
    // lo aplicado cuadra con lo pedido.
    const total = x.gastos.length > 1
      ? `<tr class="tot"><td colspan="4">Suma de los ${x.gastos.length} gastos</td><td class="num">${money(suma)}</td></tr>`
      : '';
    return `<table class="tabla">
      <thead><tr><th>Folio</th><th>Fecha</th><th>Beneficiario</th><th>Usuario</th><th class="num">Importe</th></tr></thead>
      <tbody>${filas}${total}</tbody></table>`;
  }

  private bloqueComprobaciones(x: ExpedienteGasto): string {
    if (!x.comprobaciones.length) {
      return this.vacio(x.gastos.length
        ? 'El gasto ya se aplicó y todavía nadie subió su comprobación.'
        : 'Todavía no hay gasto que comprobar.');
    }
    return x.comprobaciones.map((c: any) => `<table class="datos">
      ${this.fila('Del gasto', `<span class="mono">${esc(c.folio_gasto)}</span>`)}
      ${this.fila('Folio de comprobación', `<span class="mono">${esc(c.folio_comprobacion || '—')}</span>`)}
      ${this.fila('Fecha', fecha(c.fecha_comprobacion))}
      ${this.fila('Importe', c.importe == null ? '<em class="mut">sin capturar</em>' : money(c.importe))}
      ${this.fila('Estado', esc(ESTADO_NUESTRO[c.status] || c.status || '—'))}
      ${this.fila('Capturó', `${esc(c.created_by || '—')} <span class="mut">${esc(fechaHora(c.created_at))}</span>`)}
      ${c.validated_by ? this.fila('Validó', `${esc(c.validated_by)} <span class="mut">${esc(fechaHora(c.validated_at))}</span>`) : ''}
      ${c.motivo_rechazo ? this.fila('Motivo del rechazo', esc(c.motivo_rechazo)) : ''}
      ${this.fila('Evidencias', ((c.files || []) as any[]).length
        ? `<ul class="files">${(c.files as any[]).map((f) => `<li><span class="rol">${esc(f.role || '—')}</span></li>`).join('')}</ul>`
        : '<em class="mut">sin archivos</em>')}
    </table>`).join('');
  }

  private html(x: ExpedienteGasto): string {
    const s = x.solicitud as any;
    const faltan = x.tramite.falta.length
      ? `<div class="falta"><strong>Qué falta</strong><ul>${x.tramite.falta.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>`
      : '<div class="ok"><strong>No falta nada.</strong> Los cuatro eslabones están completos.</div>';

    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Expediente ${esc(x.folio_solicitud)}</title>
<style>
  @page { size: Letter; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Hanken Grotesk", "Segoe UI", system-ui, sans-serif; color: #09090B; font-size: 10.5pt; }
  .mono { font-family: "Geist Mono", ui-monospace, "Courier New", monospace; }
  .mut { color: #71717A; font-size: 9pt; }
  h1 { margin: 0; font-size: 17pt; letter-spacing: -.01em; }
  .head { display: flex; align-items: flex-start; gap: 12px; border-bottom: 2px solid #09090B; padding-bottom: 10px; }
  .head .id { margin-left: auto; text-align: right; }
  .head .id .folio { font-family: "Geist Mono", monospace; font-size: 15pt; font-weight: 600; }
  .etapa { display: inline-block; margin-top: 10px; padding: 4px 10px; border-radius: 4px;
           background: #F4F4F5; border: 1px solid #E4E4E7; font-size: 9.5pt; font-weight: 600; }
  h2 { font-size: 11pt; margin: 16px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #E4E4E7;
       text-transform: uppercase; letter-spacing: .05em; color: #52525B; }
  h2 .n { display: inline-block; width: 16px; height: 16px; line-height: 16px; text-align: center;
          background: #09090B; color: #fff; border-radius: 3px; font-size: 8pt; margin-right: 6px; }
  h2 .fuente { float: right; text-transform: none; letter-spacing: 0; font-weight: 400; color: #A1A1AA; font-size: 8.5pt; }
  table { width: 100%; border-collapse: collapse; }
  table.datos th { width: 150px; text-align: left; vertical-align: top; font-weight: 500; color: #71717A;
                   padding: 3px 8px 3px 0; font-size: 9.5pt; }
  table.datos td { padding: 3px 0; vertical-align: top; }
  table.tabla th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .04em;
                   color: #71717A; border-bottom: 1px solid #E4E4E7; padding: 4px 6px; }
  table.tabla td { padding: 5px 6px; border-bottom: 1px solid #F4F4F5; }
  table.tabla .num, td.num, th.num { text-align: right; font-family: "Geist Mono", monospace; }
  table.tabla tr.tot td { font-weight: 700; border-top: 1px solid #09090B; border-bottom: none; }
  ul.files { margin: 0; padding-left: 14px; }
  ul.files li { margin-bottom: 2px; }
  .rol { font-family: "Geist Mono", monospace; font-size: 9pt; }
  .viva { background: #DC2626; color: #fff; border-radius: 3px; padding: 0 5px; font-size: 7.5pt; font-weight: 700; }
  .vacio { margin: 4px 0; padding: 8px 10px; background: #FAFAFA; border: 1px dashed #D4D4D8;
           border-radius: 4px; color: #71717A; font-size: 9.5pt; }
  .falta { margin-top: 14px; padding: 10px 12px; border: 1px solid #FDE68A; background: #FFFBEB;
           border-radius: 4px; font-size: 9.5pt; color: #92400E; }
  .falta ul { margin: 5px 0 0; padding-left: 16px; }
  .ok { margin-top: 14px; padding: 10px 12px; border: 1px solid #BBF7D0; background: #F0FDF4;
        border-radius: 4px; font-size: 9.5pt; color: #15803D; }
</style></head><body>
  <div class="head">
    <div>
      <h1>Expediente de gasto</h1>
      <div class="mut">Mega Dulces · respaldo interno del trámite</div>
      <div class="etapa">${esc(x.tramite.label)}</div>
    </div>
    <div class="id">
      <div class="mut">Solicitud</div>
      <div class="folio">${esc(x.folio_solicitud)}</div>
      <div class="mut">Sucursal ${esc(x.sucursal)}${s?.fecha ? ` · ${fecha(s.fecha)}` : ''}</div>
    </div>
  </div>

  <h2><span class="n">1</span>La solicitud<span class="fuente">Kepler · XA1501</span></h2>
  ${this.bloqueSolicitud(x)}

  <h2><span class="n">2</span>Lo que aportó quien gastó<span class="fuente">Suite · expediente</span></h2>
  ${this.bloqueExpediente(x)}

  <h2><span class="n">3</span>El gasto aplicado<span class="fuente">Kepler · XA1001</span></h2>
  ${this.bloqueGastos(x)}

  <h2><span class="n">4</span>La comprobación<span class="fuente">Suite · comprobación</span></h2>
  ${this.bloqueComprobaciones(x)}

  ${faltan}
</body></html>`;
  }

  private pie(x: ExpedienteGasto): string {
    return `<div style="width:100%;font-size:7pt;color:#71717A;font-family:'Segoe UI',system-ui,sans-serif;padding:0 9mm;">
      <span>Expediente ${esc(x.sucursal)}-${esc(x.folio_solicitud)} · armado el ${esc(fechaHora(x.generado_at))} ·
      <strong>respaldo interno, no es comprobante fiscal ni póliza</strong>. Las evidencias no viajan en este archivo: se consultan en el expediente.</span>
      <span style="float:right;">Pág. <span class="pageNumber"></span> de <span class="totalPages"></span></span>
    </div>`;
  }
}
