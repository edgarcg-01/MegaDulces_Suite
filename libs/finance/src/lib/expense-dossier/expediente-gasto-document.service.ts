import { Injectable, Logger } from '@nestjs/common';
import { ObjectStorageService } from '@megadulces/platform-core';
// `[GX.74]` El detalle del pago puede traer varios renglones: se muestran como `1234 · 5678`.
// `[GX.75]` La transferencia XD2601 que pagó el gasto: su resumen sale del contrato.
import { detallesParaMostrar, resumenTransferencias, type TransferenciaGasto } from '@megadulces/contracts';
import { esc, htmlAPdf, money } from '../shared/chromium-pdf';
import { ExpedienteGastoService, type ExpedienteGasto } from './expediente-gasto.service';
import {
  anexarPdfs, htmlEvidencias, prepararEvidencias, type Achicar, type ArchivoEvidencia, type EvidenciasPreparadas,
} from './evidencias-pdf';

// `sharp` es opcional, igual que en `CloudinaryService`: sin él la foto entra sin reducir (y se dice).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharp: any = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

/** `[GX.76]` La foto reducida: lado mayor 1400 px, JPEG 78, orientada por su EXIF. */
const achicarImagen: Achicar = async (bytes) => {
  if (!sharp) return null;
  return sharp(bytes).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78 }).toBuffer();
};

/**
 * `[GX.76]` Los archivos de evidencia del expediente, con de dónde vienen: lo que aportó quien
 * gastó y lo de cada comprobación. Pura: se prueba sin bucket.
 */
export function archivosDeEvidencia(x: Pick<ExpedienteGasto, 'expediente' | 'comprobaciones'>): { origen: string; archivo: ArchivoEvidencia }[] {
  const out: { origen: string; archivo: ArchivoEvidencia }[] = [];
  const lista = (v: unknown): ArchivoEvidencia[] => (Array.isArray(v) ? v as ArchivoEvidencia[] : []);
  for (const a of lista((x.expediente as { files?: unknown } | null)?.files)) out.push({ origen: 'Expediente', archivo: a });
  for (const c of (x.comprobaciones || []) as { folio_comprobacion?: string | null; folio_gasto?: string | null; files?: unknown }[]) {
    const origen = `Comprobación ${c.folio_comprobacion || c.folio_gasto || ''}`.trim();
    for (const a of lista(c.files)) out.push({ origen, archivo: a });
  }
  return out;
}

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

/**
 * `[GX.75]` La fecha del documento, «5 oct 2026».
 *
 * ⚠️ `pg` entrega las columnas `date`/`timestamp` como **objeto `Date`** (el repo no fija
 * `setTypeParser`), y `String(date).slice(0, 10)` daba **«Mon Oct 05»** — en inglés y sin año —
 * en la solicitud y el gasto de todo PDF desde `[GX.15]`. Con `Date` se leen los getters LOCALES:
 * `pg` lo armó en hora local, así que son los que devuelven el día que guardó Kepler.
 */
export function fecha(v: unknown): string {
  if (!v) return '—';
  const iso = v instanceof Date
    ? (Number.isNaN(v.getTime()) ? '' : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`)
    : String(v).slice(0, 10);
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso ? esc(iso) : '—';
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${d} ${MESES[m - 1]} ${y}`;
}
function fechaHora(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Mexico_City' });
}

/**
 * `[GX.75]` La sección «La transferencia» del PDF: el documento `XD2601` de «Alta
 * transferencias» que pagó cada gasto, leído de Kepler (`kdm5`). Pura y exportada para
 * probarla sin levantar Chromium.
 *
 * ⛔ Cada ausencia se dice distinto: sin gasto no hay qué pagar; `null` es «no se pudo
 * consultar» (no «nadie pagó»); `[]` es «Kepler no tiene transferencia aplicada». Y la
 * cancelada se lista tachada pero NO entra a la suma: Kepler conserva su aplicación.
 */
export function bloqueTransferenciasHtml(ts: readonly TransferenciaGasto[] | null, hayGastos: boolean): string {
  const vacio = (t: string) => `<p class="vacio">${esc(t)}</p>`;
  if (!hayGastos) return vacio('Todavía no hay gasto que pagar.');
  if (ts == null) return vacio('No se pudo consultar Kepler para saber con qué transferencia se pagó.');
  if (!ts.length) return vacio('Kepler no tiene una transferencia (XD2601) aplicada a este gasto.');
  const filas = ts.map((t) => `<tr${t.cancelada ? ' class="cancelada"' : ''}>
      <td class="mono">${esc(t.folio)}</td>
      <td>${fecha(t.fecha)}</td>
      <td class="mono">${esc(t.gasto_folio)}</td>
      <td>${t.cancelada ? 'Cancelada — no cuenta' : 'Vigente'}</td>
      <td class="num">${t.importe == null ? '—' : money(t.importe)}</td>
      <td class="num">${money(t.aplicado)}</td>
    </tr>`).join('');
  // Con más de una, la cifra que importa es la SUMA de las vigentes: contra ella se compara el gasto.
  const total = ts.length > 1
    ? `<tr class="tot"><td colspan="5">Aplicado por transferencias vigentes</td><td class="num">${money(resumenTransferencias(ts).aplicado)}</td></tr>`
    : '';
  return `<table class="tabla">
      <thead><tr><th>Folio</th><th>Fecha</th><th>Al gasto</th><th>Estado</th><th class="num">Importe del documento</th><th class="num">Aplicado</th></tr></thead>
      <tbody>${filas}${total}</tbody></table>`;
}

/**
 * `[GX.15]` — **El expediente del gasto, imprimible.**
 *
 * Un solo documento con los eslabones del trámite: la solicitud de Kepler, lo que aportó quien
 * gastó (forma de pago + fotos), el gasto aplicado, la transferencia que lo pagó (`[GX.75]`)
 * y la comprobación. Es lo que hoy obliga a abrir tres pantallas y copiar a mano.
 *
 * ## Lo que este documento NO es
 * **No es un comprobante fiscal ni una póliza.** No lo emite Kepler, no se sube a
 * ContPAQi y no reemplaza a la factura: es el **respaldo interno** de un trámite, armado
 * a partir de lo que ya existe. Lo dice en el pie, en el propio papel, para que nadie lo
 * presente como lo que no es.
 *
 * ## `[GX.76]` Las evidencias SÍ viajan en el archivo (antes no, a propósito)
 * `[GX.15]` decidió no embeberlas —tamaño, y una evidencia con URL que caduca convertida en
 * copia permanente—. El usuario pidió lo contrario el 2026-10-07: el expediente debe bastarse
 * solo. Las fotos van reducidas en la sección «Las evidencias» y los PDF (71 % de los archivos)
 * se anexan al final, marcados página por página. Ver `evidencias-pdf.ts`.
 *
 * Usa el Chromium compartido de `libs/finance` (`shared/chromium-pdf.ts`), no una cuarta
 * copia del singleton.
 */
@Injectable()
export class ExpedienteGastoDocumentService {
  private readonly logger = new Logger(ExpedienteGastoDocumentService.name);

  constructor(
    private readonly svc: ExpedienteGastoService,
    /**
     * `[GX.76]` Para bajar las evidencias del bucket. Ya está en este módulo: lo provee
     * `CloudinaryModule` (ver `finance-expediente-gasto.module.ts`, la caída del 2026-09-24).
     */
    private readonly storage: ObjectStorageService,
  ) {}

  async render(
    sucursal: string,
    folio: string,
    user?: { sub?: string; role_name?: string; permissions?: Record<string, boolean> },
  ): Promise<{ pdf: Buffer; nombre: string }> {
    const x = await this.svc.expediente(sucursal, folio, user);
    const evid = await prepararEvidencias(archivosDeEvidencia(x), (k) => this.storage.getDataUri(k), achicarImagen);
    const principal = await htmlAPdf(this.html(x, evid), { footer: this.pie(x) });
    const etiqueta = `Expediente ${x.sucursal}-${x.folio_solicitud}`;
    let pdf: Buffer = principal;
    try {
      pdf = Buffer.from(await anexarPdfs(principal, evid.pdfs, etiqueta));
    } catch (e) {
      // ⛔ El documento ya dice «anexados al final»: entregarlo sin ellos sería afirmar algo falso.
      // Se vuelve a armar declarándolos como no incluidos, y se registra.
      this.logger.warn(`${etiqueta}: no se pudieron anexar los PDF de evidencia: ${(e as Error)?.message || e}`);
      const sinAnexos: EvidenciasPreparadas = {
        ...evid,
        pdfs: [],
        omitidas: [...evid.omitidas, ...evid.pdfs.map((p) => ({ etiqueta: p.etiqueta, motivo: 'no se pudo anexar al archivo: se consulta en el expediente' }))],
      };
      pdf = await htmlAPdf(this.html(x, sinAnexos), { footer: this.pie(x) });
    }
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
        ? `${esc(FORMA_PAGO_LABEL[p.forma_pago] || p.forma_pago)}${p.forma_pago_detalle ? ` · <span class="mono">${esc(detallesParaMostrar(p.forma_pago_detalle))}</span>` : ''}`
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

  private html(x: ExpedienteGasto, evid: EvidenciasPreparadas): string {
    const s = x.solicitud as any;
    const faltan = x.tramite.falta.length
      ? `<div class="falta"><strong>Qué falta</strong><ul>${x.tramite.falta.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>`
      : '<div class="ok"><strong>No falta nada.</strong> El trámite está completo.</div>';

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
  table.tabla tr.cancelada td { color: #991B1B; }
  table.tabla tr.cancelada td.mono, table.tabla tr.cancelada td.num { text-decoration: line-through; }
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
  /* [GX.76] Las evidencias arrancan en página nueva, y una foto nunca se parte entre dos. */
  .evidencias { break-before: page; }
  .evidencias h2 { margin-top: 0; }
  figure.evid { margin: 10px 0 14px; break-inside: avoid; }
  figure.evid figcaption { font-size: 9pt; color: #52525B; margin-bottom: 4px; font-weight: 600; }
  figure.evid img { display: block; max-width: 100%; max-height: 225mm; border: 1px solid #E4E4E7; border-radius: 4px; }
  .anexos { margin: 6px 0 4px; font-size: 9.5pt; }
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

  <h2><span class="n">4</span>La transferencia<span class="fuente">Kepler · XD2601</span></h2>
  ${bloqueTransferenciasHtml(x.transferencias, x.gastos.length > 0)}

  <h2><span class="n">5</span>La comprobación<span class="fuente">Suite · comprobación</span></h2>
  ${this.bloqueComprobaciones(x)}

  ${faltan}

  <section class="evidencias">
    <h2><span class="n">6</span>Las evidencias<span class="fuente">Suite · archivos del expediente</span></h2>
    ${htmlEvidencias(evid)}
  </section>
</body></html>`;
  }

  private pie(x: ExpedienteGasto): string {
    return `<div style="width:100%;font-size:7pt;color:#71717A;font-family:'Segoe UI',system-ui,sans-serif;padding:0 9mm;">
      <span>Expediente ${esc(x.sucursal)}-${esc(x.folio_solicitud)} · armado el ${esc(fechaHora(x.generado_at))} ·
      <strong>respaldo interno, no es comprobante fiscal ni póliza</strong>. Las fotos van en la sección 6; los PDF de evidencia, anexados al final.</span>
      <span style="float:right;">Pág. <span class="pageNumber"></span> de <span class="totalPages"></span></span>
    </div>`;
  }
}
