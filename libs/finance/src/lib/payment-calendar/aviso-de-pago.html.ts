import type { AvisoDePago } from '@megadulces/contracts/finance/aviso-de-pago';
import { esc, money } from '../shared/chromium-pdf';

/**
 * `[PGP.194]` **El aviso de pago, en HTML para el PDF.** Puro: lo que dice sale de `AvisoDePago`. El estilo es el del
 * estado de cuenta de clientes (`[CC.20.2]`): los documentos que salen a terceros se ven igual.
 *
 * Primero lo que la cobranza del proveedor busca para su complemento de pago —cuándo, cuánto, la clave de rastreo—,
 * después cada factura en SUS documentos (referencia, UUID) con las notas aplicadas, y al final lo que no se pudo decir.
 * El PDF de la transferencia va anexo después de esta hoja (`anexarPdfs`).
 */
const fecha = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : 'sin fecha');

export function htmlDelAviso(a: AvisoDePago, logo = '', anexo = false): string {
  const filas = a.facturas.map((f) => {
    const notas = f.notas.map((n) => `<tr class="apl"><td colspan="3">↳ ${esc(n.nombre)} ${esc(n.referencia ?? '')} <span class="int">(${esc(n.documento)})</span></td>
      <td class="mono">${fecha(n.fecha)}</td><td class="r mono">−${money(n.importe)}</td><td></td></tr>`).join('');
    const desc = f.descuento > 0.005
      ? `<tr class="apl"><td colspan="3">↳ Descuento al pagar (su nota de crédito por emitir)</td><td></td><td class="r mono">−${money(f.descuento)}</td><td></td></tr>`
      : '';
    return `<tr>
      <td class="b">${esc(f.referencia ?? '—')}<div class="int">${esc(f.documento ?? '')}</div></td>
      <td class="mono uuid">${f.uuid ? esc(f.uuid.toUpperCase()) : '<span class="falta">sin CFDI ligado</span>'}</td>
      <td>${f.metodo ?? '—'}</td>
      <td class="mono">${fecha(f.fecha)}</td>
      <td class="r mono">${f.total != null ? money(f.total) : '—'}</td>
      <td class="r mono b">${money(f.pagado)}</td></tr>${notas}${desc}`;
  }).join('');
  const totalPagado = Math.round(a.facturas.reduce((s, f) => s + f.pagado, 0) * 100) / 100;
  const faltantes = a.faltantes.length
    ? `<div class="faltan"><b>Lo que este aviso no puede decir</b><ul>${a.faltantes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
    : '';

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
:root{--ink:#1c1917;--ink-2:#44403c;--muted:#78716c;--line:#e7e5e4;--soft:#f5f5f4;--accent:#c2410c;--bad:#b91c1c}
*{box-sizing:border-box}
body{margin:0;padding:0 3mm;font-family:'Segoe UI',Arial,sans-serif;font-size:8.5pt;color:var(--ink);font-variant-numeric:tabular-nums}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:8mm;padding-bottom:4mm;border-bottom:2px solid var(--accent)}
.marca{display:flex;align-items:center;gap:4mm}.marca img{height:16mm}
.emisor{font-size:7.5pt;color:var(--ink-2);line-height:1.35}.emisor b{display:block;font-size:10pt}
.titulo{text-align:right}.titulo h1{margin:0;font-size:17pt;letter-spacing:-.01em}.titulo .s{font-size:8.5pt;color:var(--ink-2);margin-top:1mm}
.prov{margin:5mm 0 3mm}.prov .nom{font-size:12pt;font-weight:700}.prov .rfc{color:var(--muted)}
.res{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:2mm;overflow:hidden;margin-bottom:4mm}
.res>div{padding:3mm 4mm;border-right:1px solid var(--line)}.res>div:last-child{border-right:0}
.res .l{font-size:7pt;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
.res .v{font-size:13pt;font-weight:700;margin-top:1mm}.res .s{font-size:7.5pt;color:var(--muted)}.res .total{background:var(--soft)}
h2{font-size:9pt;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);margin:4mm 0 2mm}
table{width:100%;border-collapse:collapse}
thead th{font-size:7pt;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);text-align:left;padding:1.6mm 1.5mm;border-bottom:1.5px solid var(--ink)}
tbody td{padding:1.5mm;border-bottom:1px solid var(--line);vertical-align:top}
tr{page-break-inside:avoid}thead{display:table-header-group}
tr.total td{padding:2mm 1.5mm;border-top:1.5px solid var(--ink);border-bottom:0;font-weight:700}
tr.apl td{padding:.6mm 1.5mm .6mm 5mm;border-bottom:1px dotted var(--line);font-size:7.5pt;color:var(--ink-2)}
.r{text-align:right}.mono{font-family:Consolas,'Courier New',monospace;font-size:8pt}.b{font-weight:700}
.uuid{font-size:7pt;word-break:break-all}.int{font-size:7pt;color:var(--muted);font-weight:400}.falta{color:var(--bad)}
.nota{font-size:7.5pt;color:var(--ink-2);margin-top:3mm;line-height:1.4}
.faltan{margin-top:4mm;padding:2.5mm 3mm;border:1px solid var(--line);border-left:3px solid var(--bad);font-size:7.5pt}
.faltan ul{margin:1mm 0 0 4mm;padding:0}
</style></head><body>
<div class="head">
  <div class="marca">${logo ? `<img src="${logo}" alt="">` : ''}<div class="emisor">${a.emisor ? `<b>${esc(a.emisor.nombre)}</b>RFC ${esc(a.emisor.rfc)}` : '<b>Mega Dulces</b>'}</div></div>
  <div class="titulo"><h1>Aviso de pago</h1><div class="s">Transferencia del ${fecha(a.fecha_pago)}</div></div>
</div>
<div class="prov"><div class="nom">${esc(a.proveedor.nombre)}</div>${a.proveedor.rfc ? `<div class="rfc">RFC ${esc(a.proveedor.rfc)}</div>` : ''}</div>
<div class="res">
  <div class="total"><div class="l">Importe pagado</div><div class="v mono">${money(a.importe)}</div><div class="s">Transferencia SPEI</div></div>
  <div><div class="l">Clave de rastreo</div><div class="v mono" style="font-size:9.5pt">${esc(a.rastreo ?? '—')}</div><div class="s">${fecha(a.fecha_pago)}</div></div>
  <div><div class="l">Cuentas</div><div class="v" style="font-size:9.5pt">${esc(a.origen ?? '—')}</div><div class="s">a su cuenta ${esc(a.destino ?? '—')}</div></div>
</div>
<h2>Facturas que paga esta transferencia</h2>
<table><thead><tr><th>Su referencia</th><th>UUID</th><th>Método</th><th>Fecha</th><th class="r">Total</th><th class="r">Pagado</th></tr></thead>
<tbody>${filas}
<tr class="total"><td colspan="5">Total pagado con esta transferencia</td><td class="r mono">${money(totalPagado)}</td></tr></tbody></table>
<p class="nota">Las notas de crédito y devoluciones son las que Mega Dulces aplicó a cada factura; entre paréntesis, su documento interno.
Con estos datos su área de cobranza puede emitir el <b>complemento de pago (REP)</b> de las facturas PPD.${anexo ? ' El comprobante de la transferencia va en la(s) página(s) siguiente(s).' : ''}</p>
${faltantes}
</body></html>`;
}
