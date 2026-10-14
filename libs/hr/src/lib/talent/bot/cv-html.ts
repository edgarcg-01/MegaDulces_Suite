import { esc } from '@megadulces/platform-core';
import {
  edadDesde, empleos, esNoAplica, esSi, escolaridad, habilidades, idiomas, nombreCompleto, referencias, type Respuestas,
} from './solicitud';

/**
 * Fase RH · `[RH.3.3.3]` — el CV que el bot ARMA con la solicitud, como HTML para convertir a PDF (Chromium compartido).
 * Puro: recibe las respuestas y la foto, devuelve el HTML. El contenido es el de `cv-pdf.js` de Mega Talento:
 *
 *  · La DECLARACIÓN PERSONAL se arma con SUS palabras; no la escribe un modelo (es lo que más se leería como inventado).
 *  · Sin experiencia NO se deja el hueco: se escribe un «Objetivo» honesto.
 *  · Los datos que RH busca de un vistazo (edad, originario de, licencia, puesto) van en «Datos personales», porque esta
 *    hoja sustituye a la solicitud de papel. El ESTADO CIVIL ya no se imprime (es dato sensible: queda en la solicitud,
 *    que sólo ve RH; el CV puede circular más).
 *
 * TODO lo que viene del candidato pasa por `esc` (es texto libre de WhatsApp). La foto es un data URI de imagen ya
 * validada por firma, o nada.
 */

export interface OpcionesCv { fotoDataUri?: string | null; hoy?: Date }

const limpio = (v: unknown): string => (v && !esNoAplica(v) ? String(v).trim() : '');

function declaracion(d: Respuestas): string {
  const partes: string[] = [];
  const emp = empleos(d);
  const est = escolaridad(d);
  const puesto = limpio(d['puesto_solicitado']).toLowerCase();
  if (emp.length) {
    const puestos = [...new Set(emp.map((e) => e.puesto).filter(Boolean))].slice(0, 2).join(' y ');
    const donde = emp.map((e) => e.compania).filter(Boolean).slice(0, 2).join(' y ');
    partes.push(`Con experiencia como ${puestos || 'trabajador'}${donde ? ` en ${donde}` : ''}.`);
  } else if (est.length) {
    partes.push(`${est[0].nivel} en ${est[0].escuela}. Busco mi primera oportunidad laboral${puesto ? ` como ${puesto}` : ''}.`);
  }
  const fuerte = [d['otros_conocimientos'], d['funciones_oficina'], d['maquinas']].map(limpio).find(Boolean);
  if (fuerte) partes.push(`Manejo ${fuerte.toLowerCase().replace(/\.$/, '')}.`);
  const meta = limpio(d['meta_vida']);
  if (meta) partes.push(`Mi meta: ${meta.charAt(0).toLowerCase() + meta.slice(1)}${/[.!?]$/.test(meta) ? '' : '.'}`);
  if (puesto && emp.length) partes.push(`Busco integrarme como ${puesto}.`);
  return partes.join(' ');
}

function sinExperiencia(d: Respuestas): string {
  const est = escolaridad(d);
  const puesto = limpio(d['puesto_solicitado']) || 'el puesto';
  const formacion = est.length ? `, con formación de ${est[0].nivel.toLowerCase()} en ${est[0].escuela}` : '';
  const cuando = limpio(d['fecha_presentarse']);
  return `Sin experiencia laboral previa. Busco mi primera oportunidad como ${puesto}${formacion}.${cuando ? ` Disponible para empezar: ${cuando.toLowerCase()}.` : ''}`;
}

/** Las funciones en viñetas: por punto o punto y coma, NO por coma («acomodo, rotación, surtido» es una idea). */
function vinetas(texto: string): string[] {
  const t = texto.trim();
  if (!t) return [];
  const partes = t.split(/\.\s+|\n+|\s*;\s*/).map((x) => x.trim().replace(/\.$/, '')).filter((x) => x.length > 3);
  return (partes.length > 1 ? partes : [t.replace(/\.$/, '')]).slice(0, 5);
}

function datosDuros(d: Respuestas, hoy?: Date): string[] {
  const out: string[] = [];
  const edad = limpio(d['edad']) || (d['fecha_nacimiento'] ? `${edadDesde(d['fecha_nacimiento'], hoy)} años` : '');
  if (edad) out.push(`Edad: ${edad}`);
  const origen = limpio(d['lugar_nacimiento']);
  if (origen) out.push(`Originario de: ${origen}`);
  if (d['licencia']) out.push(`Licencia de manejo: ${esSi(d['licencia']) ? (limpio(d['licencia_datos']) || 'Sí') : 'No'}`);
  const puesto = limpio(d['puesto_solicitado']);
  if (puesto) out.push(`Puesto solicitado: ${puesto}`);
  return out;
}

const seccion = (titulo: string, cuerpo: string): string => (cuerpo ? `<section><h2>${esc(titulo)}</h2>${cuerpo}</section>` : '');

/** El HTML del CV (carta, dos columnas). */
export function htmlCv(d: Respuestas, opciones: OpcionesCv = {}): string {
  const nombre = nombreCompleto(d) || 'Candidato';
  const iniciales = nombre.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  const foto = opciones.fotoDataUri && /^data:image\/(jpeg|png|webp|gif);base64,/.test(opciones.fotoDataUri)
    ? `<img class="foto" src="${opciones.fotoDataUri}" alt="">`
    : `<div class="foto sin">${esc(iniciales)}</div>`;

  const contacto = [
    [limpio(d['domicilio']), limpio(d['colonia'])].filter(Boolean).join(', '),
    limpio(d['telefono_casa']), limpio(d['email']),
    limpio(d['fecha_presentarse']) ? `Disponible: ${limpio(d['fecha_presentarse'])}` : '',
  ].filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join('');

  const emp = empleos(d);
  const experiencia = emp.length
    ? emp.map((e) => `<div class="item"><div class="fila"><strong>${esc(e.puesto || 'Puesto')}</strong><span class="fecha">${esc([e.desde, e.hasta].filter(Boolean).join(' – '))}</span></div>`
      + `<div class="sub">${esc(e.compania)}</div>${vinetas(e.funciones).length ? `<ul>${vinetas(e.funciones).map((v) => `<li>${esc(v)}</li>`).join('')}</ul>` : ''}`
      + `${e.logro ? `<div class="logro">Logro: ${esc(e.logro)}</div>` : ''}</div>`).join('')
    : '';

  const estudios = escolaridad(d).map((e) => `<div class="item"><div class="fila"><strong>${esc(e.nivel)}</strong><span class="fecha">${esc(e.anios)}</span></div>`
    + `<div class="sub">${esc(e.escuela)}${e.titulo ? ` · ${esc(e.titulo)}` : ''}</div></div>`).join('')
    + (esSi(d['estudia_ahora']) && limpio(d['estudia_escuela'])
      ? `<div class="item"><div class="fila"><strong>En curso</strong><span class="fecha">Actualmente</span></div><div class="sub">${esc(limpio(d['estudia_escuela']))}`
        + `${[limpio(d['estudia_curso']), limpio(d['estudia_grado'])].filter(Boolean).length ? ` · ${esc([limpio(d['estudia_curso']), limpio(d['estudia_grado'])].filter(Boolean).join(', '))}` : ''}</div></div>`
      : '');

  const langs = idiomas(d).map((i) => `<div class="idioma"><span>${esc(i.nombre)}${i.nivel ? ` · ${esc(i.nivel)}` : ''}</span>`
    + `${i.pct ? `<span class="barra"><span style="width:${i.pct}%"></span></span>` : ''}</div>`).join('');

  const refs = referencias(d).map((r) => `<div class="item"><strong>${esc(r.nombre)}</strong>`
    + `<div class="sub">${esc([r.ocupacion, r.telefono, r.tiempo ? `la conoce hace ${r.tiempo}` : ''].filter(Boolean).join(' · '))}</div></div>`).join('');

  const hab = habilidades(d).map((h) => `<li>${esc(h)}</li>`).join('');
  const duros = datosDuros(d, opciones.hoy).map((x) => esc(x)).join(' &nbsp;·&nbsp; ');
  const decl = declaracion(d);

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #292524; font-size: 10.5pt; line-height: 1.4; }
    .hoja { display: grid; grid-template-columns: 34% 66%; min-height: 100%; }
    aside { background: #f5f5f4; padding: 22px 18px; }
    main { padding: 22px 24px; }
    .foto { width: 112px; height: 112px; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 16px; }
    .foto.sin { background: #e7e5e4; color: #57534e; font-size: 34pt; font-weight: 700; display: flex; align-items: center; justify-content: center; }
    h1 { font-size: 22pt; line-height: 1.1; margin-bottom: 14px; color: #1c1917; }
    h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: .08em; color: #c2410c; border-bottom: 1px solid #e7e5e4; padding-bottom: 3px; margin: 14px 0 7px; }
    aside ul { list-style: none; } aside li { margin-bottom: 5px; }
    main ul { margin: 3px 0 0 16px; }
    .item { margin-bottom: 9px; page-break-inside: avoid; }
    .fila { display: flex; justify-content: space-between; gap: 8px; }
    .fecha { color: #78716c; font-size: 9pt; white-space: nowrap; }
    .sub { color: #57534e; }
    .logro { color: #57534e; font-style: italic; margin-top: 2px; }
    .idioma { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 5px; }
    .barra { width: 90px; height: 6px; background: #e7e5e4; border-radius: 3px; overflow: hidden; }
    .barra span { display: block; height: 100%; background: #c2410c; }
    .duros { color: #44403c; }
  </style></head><body><div class="hoja">
    <aside>${foto}${seccion('Contacto', contacto ? `<ul>${contacto}</ul>` : '')}${seccion('Declaración personal', decl ? `<p>${esc(decl)}</p>` : '')}${seccion('Habilidades', hab ? `<ul>${hab}</ul>` : '')}</aside>
    <main><h1>${esc(nombre)}</h1>
      ${emp.length ? seccion('Experiencia laboral', experiencia) : seccion('Objetivo', `<p>${esc(sinExperiencia(d))}</p>`)}
      ${seccion('Educación', estudios)}${seccion('Idiomas', langs)}${seccion('Datos personales', duros ? `<p class="duros">${duros}</p>` : '')}${seccion('Referencias personales', refs)}
    </main>
  </div></body></html>`;
}
