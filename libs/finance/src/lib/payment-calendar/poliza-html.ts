import type { PolizaDeCheque } from '@megadulces/contracts';
// ⛔ Sólo tipos: este módulo no carga nada en tiempo de ejecución (lo usa también un script de verificación fuera de Nest).

/**
 * `[PGP.168.1]` **La póliza del cheque en papel**: media carta vertical (139.7 × 215.9 mm, el tamaño del talonario que
 * se usa hoy), **dos hojas** — ORIGINAL y COPIA — como las dos que se meten a la impresora detrás del cheque
 * (Francisco, 2026-11-19). DCH10-b: se imprime completa en hoja blanca, no sobre el talonario.
 *
 * Lo que va a mano, con su línea: el número de póliza, la firma y el nombre de quien recibe, la fecha, quién revisa y
 * el sello de captura. Lo demás lo escribe la Suite, con las mismas cadenas que el cheque.
 */

export const POLIZA_ANCHO_MM = 139.7;
export const POLIZA_ALTO_MM = 215.9;

const FUENTE = `Arial, 'Liberation Sans', 'DejaVu Sans', Helvetica, sans-serif`;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

const CSS = `@page{size:${POLIZA_ANCHO_MM}mm ${POLIZA_ALTO_MM}mm;margin:0}`
  + `html,body{margin:0;padding:0;background:#fff;color:#000;font-family:${FUENTE}}`
  + `.copia{box-sizing:border-box;width:${POLIZA_ANCHO_MM}mm;padding:9mm 9mm 6mm;font-size:2.7mm;line-height:1.3}`
  + `.copia+.copia{break-before:page}`
  + `.cab{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:.4mm solid #000;padding-bottom:1.5mm}`
  + `.cab h1{margin:0;font-size:4.2mm;letter-spacing:.04em}.cab .banco{font-size:2.8mm;margin-top:.6mm}`
  + `.cab .tipo{font-size:3.2mm;font-weight:700;letter-spacing:.08em;text-align:right}`
  + `.cab .num{font-size:2.6mm;font-weight:400;letter-spacing:0;margin-top:1.2mm;white-space:nowrap}`
  + `.linea{display:inline-block;border-bottom:.25mm solid #000;min-width:24mm;height:3.4mm;vertical-align:bottom}`
  + `.cheque{border:.3mm solid #000;border-radius:1.2mm;padding:2mm 2.5mm;margin:3mm 0 2.5mm}`
  + `.cheque .fila{display:flex;justify-content:space-between;gap:3mm;margin-bottom:1.2mm}`
  + `.cheque .imp{white-space:nowrap;font-size:3.4mm}.cheque .letra{font-size:2.6mm;font-weight:600}`
  + `.concepto{margin:0 0 2.5mm}`
  + `table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:2.5mm}`
  + `th{font-size:2.2mm;text-transform:uppercase;letter-spacing:.03em;border-top:.3mm solid #000;border-bottom:.3mm solid #000;padding:1mm .8mm;text-align:left}`
  + `td{border-bottom:.15mm solid #999;padding:.9mm .8mm;vertical-align:top;overflow-wrap:anywhere}`
  + `tr{break-inside:avoid}.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}`
  + `td .det{display:block;font-size:2mm;color:#333;margin-top:.3mm}`
  + `td.parcial-nombre{padding-left:4mm}tr.doc td{padding-top:.6mm;padding-bottom:.6mm}`
  + `tfoot td{border-bottom:.3mm solid #000;border-top:.3mm solid #000;font-weight:700}`
  + `.recibi{margin-top:4mm}.recibi p{margin:0 0 6mm;font-weight:600}`
  + `.firmas,.pie{display:flex;gap:4mm}.firmas>div,.pie>div{flex:1;font-size:2.3mm}`
  + `.firmas .linea,.pie .linea{display:block;min-width:0;width:100%;margin-bottom:.8mm}`
  + `.pie{margin-top:6mm}.pie b{display:block;font-size:2.6mm;min-height:3.4mm;border-bottom:.25mm solid #000;margin-bottom:.8mm}`
  + `.sello{display:block;height:11mm;border:.25mm dashed #000;margin-bottom:.8mm}`
  + `.impreso{margin-top:3mm;font-size:2mm;color:#333}`;

function unaCopia(p: PolizaDeCheque, tipo: string, impreso: string): string {
  // Un documento es un PARCIAL de la cuenta del beneficiario: no lleva cuenta propia, así que su nombre ocupa también
  // las columnas de cuenta y sub-cuenta (medido: en 45 mm el nombre se partía en 3–4 líneas y 7 documentos no cabían).
  const filas = p.renglones.map((r) => {
    const detalle = r.detalle ? `<span class="det">${esc(r.detalle)}</span>` : '';
    const montos = `<td class="r">${esc(r.parcial)}</td><td class="r">${esc(r.cargo)}</td><td class="r">${esc(r.abono)}</td>`;
    return r.parcial
      ? `<tr class="doc"><td colspan="3" class="parcial-nombre">${esc(r.nombre)}${detalle}</td>${montos}</tr>`
      : `<tr><td>${esc(r.cuenta)}</td><td>${esc(r.subcuenta)}</td><td><b>${esc(r.nombre)}</b>${detalle}</td>${montos}</tr>`;
  }).join('');
  return `<section class="copia">`
    + `<div class="cab"><div><h1>PÓLIZA DE CHEQUE</h1><div class="banco">${esc(p.cheque.banco)}</div></div>`
    + `<div class="tipo">${esc(tipo)}<div class="num">Póliza No. <span class="linea"></span></div></div></div>`
    + `<div class="cheque">`
    + `<div class="fila"><span>Cheque No. <b>${esc(p.cheque.folio)}</b></span><span>Fecha: <b>${esc(p.cheque.fecha)}</b></span></div>`
    + `<div class="fila"><span>Páguese a: <b>${esc(p.cheque.beneficiario)}</b></span><span class="imp">$ <b>${esc(p.cheque.importe)}</b></span></div>`
    + `<div class="letra">${esc(p.cheque.letra)}</div></div>`
    + `<p class="concepto"><b>Concepto:</b> ${esc(p.concepto)}</p>`
    + `<table><colgroup><col style="width:16mm"><col style="width:11mm"><col><col style="width:17.5mm"><col style="width:17.5mm"><col style="width:17.5mm"></colgroup>`
    + `<thead><tr><th>Cuenta</th><th>Sub-cuenta</th><th>Nombre</th><th class="r">Parcial</th><th class="r">Cargo</th><th class="r">Abono</th></tr></thead>`
    + `<tbody>${filas}</tbody>`
    + `<tfoot><tr><td></td><td></td><td class="r">SUMAS IGUALES</td><td></td><td class="r">${esc(p.sumas.cargo)}</td><td class="r">${esc(p.sumas.abono)}</td></tr></tfoot></table>`
    + `<div class="recibi"><p>${esc(p.recibi)}</p>`
    + `<div class="firmas"><div><span class="linea"></span>Firma de quien recibe</div><div><span class="linea"></span>Nombre de quien recibe</div><div><span class="linea"></span>Fecha</div></div></div>`
    + `<div class="pie"><div><b>${esc(p.hechoPor)}</b>Hecho por</div><div><b></b>Revisado por</div><div><span class="sello"></span>Sello de captura</div></div>`
    + `<div class="impreso">Impresa por la Suite el ${esc(impreso)}. La cuenta del beneficiario la escribe Contabilidad.</div>`
    + `</section>`;
}

/** El documento de las dos hojas (ORIGINAL y COPIA). `impreso`: cuándo, ya en palabras («25-nov-2026 18:40»). */
export function polizaHtml(p: PolizaDeCheque, impreso: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Póliza del cheque ${esc(p.cheque.folio)}</title>`
    + `<style>${CSS}</style></head><body>`
    + unaCopia(p, 'ORIGINAL', impreso) + unaCopia(p, 'COPIA', impreso)
    + `</body></html>`;
}

/** Las opciones de `page.pdf` (puppeteer): media carta exacta, sin márgenes, con el tamaño que pide el documento. */
export function opcionesPdfPoliza() {
  return {
    width: `${POLIZA_ANCHO_MM}mm`, height: `${POLIZA_ALTO_MM}mm`, printBackground: true, preferCSSPageSize: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  };
}
