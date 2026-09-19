/**
 * Mide la GEOMETRÍA de la etiqueta de anaquel sobre el corpus congelado.
 *
 * Existe porque la etiqueta sólo se puede juzgar renderizada, y el chequeo ad-hoc de ETQ.3
 * **dio verde estando mal**: medía el `scrollWidth` del texto del precio, pero el recorte lo
 * hace el `overflow:hidden` de la caja amarilla, así que el texto siempre "cabe". De ahí las
 * dos reglas de este arnés:
 *
 *   1. se mide la CAJA y los bordes de tinta, nunca el texto contra sí mismo;
 *   2. el aire de un bloque flex con contenido centrado se mide por EXTENSIÓN DE LOS HIJOS —
 *      `scrollHeight` nunca baja de `clientHeight` y reporta 0 de aire donde hay 6 mm.
 *
 * El CSS y las constantes se EXTRAEN del propio componente, no se copian. Y el comportamiento
 * de los ajustes se deriva de qué constantes existen: sin `PRECIO_MAX_MM` no crece (o sea mide
 * la versión de hoy), con ella crece. Así el mismo arnés produce el "antes" y el "después".
 *
 * ⚠️ Este arnés REIMPLEMENTA los bucles del componente, así que puede dar verde estando mal.
 * Por eso el plan exige además un contraste contra la app corriendo (pata 3).
 *
 * Uso:  node scripts/etiqueta-geometria.js [etiqueta] [--pdf salida.pdf] [--skus 70079,70043]
 *
 * `--pdf` deja una hoja para mirar con los ojos, que es la única forma de juzgar una etiqueta;
 * `--skus` recorta el corpus a unos pocos para inspección visual sin perder el corpus completo.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const RAIZ = path.join(__dirname, '..');
const SRC = path.join(RAIZ, 'apps/view/src/app/modules/tienda/components/label.component.ts');
const CORPUS = path.join(__dirname, 'fixtures/etiqueta-corpus.json');
const argv = process.argv.slice(2);
const etiqueta = argv.find((a) => !a.startsWith('--')) || 'medicion';
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const PDF = arg('--pdf');
const SKUS = (arg('--skus') || '').split(',').map((s) => s.trim()).filter(Boolean);

const STYLES_CSS = path.join(RAIZ, 'apps/view/src/styles.css');
const FONTS_DIR = path.join(RAIZ, 'apps/view/src/assets/fonts');

const src = fs.readFileSync(SRC, 'utf8');
const css = /styles:\s*\[`([\s\S]*?)`\],/.exec(src)[1];
const num = (re, def) => { const m = re.exec(src); return m ? Number(m[1]) : def; };

/**
 * ⭐ Las tipografías REALES de la etiqueta, embebidas.
 *
 * El `styles:[...]` del componente NO lleva `@font-face` a propósito (viven en
 * `apps/view/src/styles.css`, para que existan desde que arranca la app). Como este arnés sólo
 * extraía ese bloque, medía con **Impact / Arial Narrow** y lo daba por bueno: `document.fonts`
 * quedaba vacío mientras `fonts.check("5mm 'Bebas Neue'")` devolvía `true` — es la
 * especificación (sin ninguna cara declarada no hay nada que cargar), la misma rareza que el
 * componente documenta en `familiasFaltantes()`.
 *
 * No es cosmético: `$1,370.28` a 50 px mide 158.8 px con Bebas Neue y 188.3 px con el respaldo
 * (+18.6% de ancho), así que `fitAmts` encogía montos que en producción caben. Los 30 SKUs que
 * el arnés reportaba como "montos NO uniformes" eran ESO, no un defecto de la etiqueta.
 *
 * Se EXTRAEN de `styles.css`, no se copian: un literal acá se separaría del original en silencio.
 */
function fontFaceCss() {
  const hoja = fs.readFileSync(STYLES_CSS, 'utf8');
  const caras = hoja.match(/@font-face\s*\{[\s\S]*?\}/g) || [];
  if (!caras.length) throw new Error('etiqueta-geometria: styles.css no declara ninguna @font-face');
  return caras.map((cara) => cara.replace(/url\((['"]?)([^'")]+)\1\)/g, (_, __, u) => {
    const f = path.join(FONTS_DIR, path.basename(u));
    if (!fs.existsSync(f)) throw new Error(`etiqueta-geometria: falta el archivo de tipografia ${f}`);
    return `url(data:font/woff2;base64,${fs.readFileSync(f).toString('base64')})`;
  })).join('\n');
}

/** Las familias que deciden el tamaño, leídas del componente (no escritas a mano acá). */
const FUENTES_SPECS = (() => {
  const m = /export const FUENTES_SPECS[^=]*=\s*\[([^\]]+)\]/.exec(src);
  if (!m) throw new Error('etiqueta-geometria: no se pudo leer FUENTES_SPECS del componente');
  return m[1].split(',').map((s) => s.trim().replace(/^["'`]|["'`]$/g, '')).filter(Boolean);
})();

/** Constantes leídas del fuente. Las `*_MAX` ausentes = la versión que sólo encoge. */
const K = {
  PRECIO_MM: num(/const PRECIO_MM = ([\d.]+)/, 10),
  PRECIO_MAX_MM: num(/const PRECIO_MAX_MM = ([\d.]+)/, null),
  MONTO_MM: num(/const MONTO_MM = ([\d.]+)/, 5.4),
  MONTO_MAX_MM: num(/const MONTO_MAX_MM = ([\d.]+)/, null),
  BARCODE_MIN_MM: num(/const BARCODE_MIN_MM = ([\d.]+)/, null),
  BARCODE_MAX_MM: num(/const BARCODE_MAX_MM = ([\d.]+)/, null),
  MAYOREO_MIN_DESC: num(/const MAYOREO_MIN_DESC = ([\d.]+)/, null),
  UNIDAD_MM: num(/const UNIDAD_MM = ([\d.]+)/, null),
};

/**
 * Casos límite CONOCIDOS y declarados: el arnés los reporta pero no los cuenta como rojo.
 * Son datos reales que la etiqueta no puede satisfacer, no defectos del layout — y estaban
 * igual antes del rediseño. Lo que no se puede arreglar se DECLARA, no se pinta de verde
 * (ADR-056); si aparece un sku nuevo en cualquiera de estas banderas, el arnés se pone rojo.
 */
const CONOCIDOS = {
  '01001': 'GLOBO PARA 120KG: base $18,345 y caja $342,299.99 — 6 cifras no caben en la celda de 22 mm ni al piso de 2.4 mm, así que ese monto se encoge solo y rompe la uniformidad',
  '00422': 'promo de 83 caracteres de nombre ("3 EXH SUIZO... = GRATIS...") — la banda tiene 78 mm y ni al piso de 2.3 mm entra',
  '59325': 'promo de 79 caracteres de nombre',
  '62253': 'promo de 81 caracteres de nombre',
  '89037': 'el "nombre" son 60 caracteres de nota al capturista del ERP ("**DUPLICADO 89004 NO BORRAR '
    + 'PURO TAMARINDO CHICO /4 JHONY $5"), no el nombre del producto — la banda tiene 78 mm y no entra '
    + 'ni al piso. Es un dato a limpiar en Kepler, no un defecto del layout',
};

const n = (v) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dinero = (v) => '$' + n(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Réplica de los getters del componente, con el hero por default. */
function vista(m) {
  const ub = String(m.unit_base || '').toUpperCase();
  const agrupada = ub === 'PAQ' || ub === 'CJA';
  const gramos = m.sold_by_kg ? (ub === 'KG' ? 1000 : (/^\d+$/.test(ub) ? parseInt(ub, 10) : 0)) : 0;
  const granel = gramos > 0;
  const base = n(m.piece_price);
  const porKg = granel ? base * 1000 / gramos : 0;

  let heroWord, heroVal;
  if (granel && (base > 0 || porKg > 0)) { heroWord = 'kg'; heroVal = porKg; }
  else if (base > 0) { heroWord = agrupada ? (ub === 'PAQ' ? 'paquete' : 'caja') : 'pieza'; heroVal = base; }
  else if (n(m.pack_price) > 0) { heroWord = 'paquete'; heroVal = n(m.pack_price); }
  else if (n(m.box_price) > 0) { heroWord = 'caja'; heroVal = n(m.box_price); }
  else { heroWord = granel ? 'kg' : 'pieza'; heroVal = 0; }

  // Umbral del mayoreo por pieza: con MAYOREO_MIN_DESC en el fuente ya no se inventa el 3.
  const minPza = K.MAYOREO_MIN_DESC != null
    ? (n(m.wholesale_piece_min_qty) > 1 ? n(m.wholesale_piece_min_qty) : null)
    : (m.wholesale_piece_min_qty || 3);
  const minPaq = n(m.wholesale_pack_min_qty) > 1 ? n(m.wholesale_pack_min_qty) : null;

  const wPza = n(m.wholesale_piece_price);
  const wPaq = n(m.wholesale_pack_price);
  const desc = (w) => (base > 0 && w > 0 ? (base - w) / base : 0);
  const realce = (w) => (K.MAYOREO_MIN_DESC == null ? true : desc(w) >= K.MAYOREO_MIN_DESC);

  const tiers = [];
  if (granel && gramos < 1000 && base > 0) {
    tiers.push({ txt: heroWord === 'kg' ? `Por ${gramos} g` : 'Por 1 kg',
      amt: heroWord === 'kg' ? base : porKg });
  }
  if (!agrupada && wPza > 0 && (base <= 0 || wPza < base) && (K.MAYOREO_MIN_DESC == null || minPza !== null)) {
    tiers.push({ txt: `Mayoreo <span class="etq-red">${minPza ?? ''}+</span> pzas`, amt: wPza,
      cu: true, may: realce(wPza) });
  }
  if (n(m.pack_price) > 0 && n(m.pack_size) > 0) {
    tiers.push({ txt: `Paquete <span class="etq-red">${m.pack_size}</span> pzas`, amt: n(m.pack_price) });
  }
  if (agrupada && base > 0 && wPaq > 0 && wPaq < base && (K.MAYOREO_MIN_DESC == null || minPaq !== null)) {
    tiers.push({ txt: minPaq ? `Mayoreo <span class="etq-red">${minPaq}+</span> paquetes` : 'Mayoreo',
      amt: wPaq, cu: true, may: realce(wPaq) });
  }
  if (n(m.box_price) > 0 && n(m.box_size) > 0) {
    tiers.push({ txt: `Caja <span class="etq-red">${m.box_size}</span> paquetes`, amt: n(m.box_price) });
  }
  const nombre = String(m.name || '').replace(/\s+\d+(?:[.,]\d+)?\s*(?:kg|g|gr|grs|ml|l)\s*\/?\s*\d*\s*$/i, '').trim() || m.name;
  // Los dígitos legibles bajo las barras — espejo de `barcodeDigits` en label.component.ts.
  // ⚠️ El arnés los OMITÍA: son ~2.2 mm de alto que el bloque del código ocupa en producción y
  // que acá se le regalaban a los renglones, o sea que medía una columna más holgada que la real.
  // `null` para el CODE128 de respaldo: el componente tampoco los pinta (ya está el SKU arriba).
  const d = String(m.barcode || '').trim();
  const bcDigits = m.barcode_format === 'EAN13' && d.length === 13 ? `${d[0]} ${d.slice(1, 7)} ${d.slice(7)}`
    : m.barcode_format === 'UPC' && d.length === 12 ? `${d[0]} ${d.slice(1, 6)} ${d.slice(6, 11)} ${d[11]}`
    : m.barcode_format === 'EAN8' && d.length === 8 ? `${d.slice(0, 4)} ${d.slice(4)}`
    : null;
  return { nombre, heroWord, heroVal, tiers, content: m.content, sku: m.sku, bcDigits };
}

const SPROUT = '<svg class="etq-sprout" viewBox="0 0 40 40" fill="hsl(141, 60%, 38%)">'
  + '<path transform="translate(12,15) rotate(120)" d="M0 -11 C4.5 -5 5.5 0 4 4.5 C2.8 7.5 -2.8 7.5 -4 4.5 C-5.5 0 -4.5 -5 0 -11 Z"/>'
  + '<path transform="translate(22,10) rotate(150) scale(0.7)" d="M0 -11 C4.5 -5 5.5 0 4 4.5 C2.8 7.5 -2.8 7.5 -4 4.5 C-5.5 0 -4.5 -5 0 -11 Z"/></svg>';
const BARRAS = '<svg viewBox="0 0 200 30" preserveAspectRatio="none">'
  + Array.from({ length: 46 }, (_, i) => `<rect x="${i * 4.3}" y="0" width="${[1, 2, 1, 3, 2, 1][i % 6]}" height="30" fill="#1b1b1b"/>`).join('')
  + '</svg>';
/** El brote va en la banda del nombre si el CSS lo colgó de ahí (se detecta por el selector). */
const BROTE_EN_BANDA = /\.etq-head\s+\.etq-sprout|\.etq-head\.[\w-]*\s*\.etq-sprout|\.etq-sprout\{[^}]*right:/.test(css);
/** La franja de unidad tiene marcado propio si el CSS declara `.etq-pieza-txt`. */
const FRANJA_NUEVA = /\.etq-pieza-txt\{/.test(css);

function html(v) {
  const ent = dinero(v.heroVal).slice(1).split('.');
  const franja = FRANJA_NUEVA
    ? `<div class="etq-pieza"><span class="etq-pieza-txt"><span class="pre">Precio por</span><span class="u">${esc(v.heroWord)}</span></span></div>`
    : `<div class="etq-pieza">Precio por ${esc(v.heroWord)}</div>`;
  return `<wrap data-sku="${esc(v.sku)}"><div class="etq-label">
  <div class="etq-head">${BROTE_EN_BANDA ? SPROUT : ''}<span class="etq-head-txt">${esc(v.nombre)}</span></div>
  <div class="etq-body">
    <div class="etq-left">
      <div class="etq-meta">${v.content ? `<span>${esc(v.content)}</span><span class="sep">|</span>` : ''}<span>Código: <span class="etq-red">${esc(v.sku)}</span></span></div>
      <div class="etq-pricebox">${BROTE_EN_BANDA ? '' : SPROUT}
        <div class="etq-price"><span class="cur">$</span>${ent[0]}<span class="dot">.</span>${ent[1]}</div>
        ${franja}
      </div>
    </div>
    <div class="etq-right${v.tiers.length === 0 ? ' is-solo' : ''}">
      <div class="etq-tiers">${v.tiers.map((t) => `<div class="etq-tier${t.may ? ' is-mayoreo' : ''}">
        <div class="txt">${t.txt}</div>
        <div class="pricecell"><span class="amt">${dinero(t.amt)}</span>${t.cu ? '<span class="unit">c/u</span>' : ''}</div></div>`).join('')}</div>
      <div class="etq-barcode">${BARRAS}${v.bcDigits ? `<div class="etq-bc-digits">${v.bcDigits}</div>` : ''}</div>
    </div>
  </div></div></wrap>`;
}

(async () => {
  const leido = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  const pesos = leido.pesos_catalogo_pct;
  const corpus = SKUS.length ? leido.corpus.filter((c) => SKUS.includes(c.sku)) : leido.corpus;
  if (!corpus.length) { console.error('El filtro --skus no dejó ninguna fila.'); process.exit(1); }
  const vistas = corpus.map(vista);

  const b = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await b.newPage();
  await page.setViewport({ width: Math.round(263 / 25.4 * 96), height: 1000 });
  await page.setContent(`<meta charset="utf-8"><style>${fontFaceCss()}
    ${css}
    wrap{ display:inline-block; vertical-align:top; margin:2mm }
    body{ margin:0; font-size:0; text-align:center }
    .etq-label{ border-radius:0 !important }</style>${vistas.map(html).join('')}`, { waitUntil: 'networkidle0' });
  // La espera usa la MISMA regla que `familiasFaltantes()` del componente: no alcanza con
  // `check()` (miente cuando no hay ninguna cara declarada), hace falta una cara `loaded`.
  const faltan = await page.evaluate(async (specs) => {
    await Promise.all(specs.map((f) => document.fonts.load(f).catch(() => undefined)));
    const cargadas = () => {
      const s = new Set();
      for (const c of document.fonts) if (c?.status === 'loaded') s.add(String(c.family || '').replace(/^["']|["']$/g, ''));
      return s;
    };
    const pendientes = () => {
      const ok = cargadas();
      return specs.filter((sp) => !ok.has(sp.replace(/^[\d.]+mm /, '').replace(/^["']|["']$/g, '')));
    };
    for (let i = 0; i < 100 && pendientes().length; i++) await new Promise((r) => setTimeout(r, 50));
    return pendientes();
  }, FUENTES_SPECS);
  // ⛔ Lo que no se puede medir se DECLARA, no se publica (ADR-056). Medir con la tipografía de
  // respaldo y reportar los números como si fueran los de la etiqueta es justo lo que hacía antes.
  if (faltan.length) {
    console.error(`\n⛔ No se pudieron cargar las tipografias: ${faltan.join(', ')}.`);
    console.error('   El arnes NO reporta: con la de respaldo el ancho cambia hasta 18.6% y los numeros no serian los de la etiqueta.');
    await browser.close();
    process.exit(1);
  }

  const filas = await page.evaluate((K) => {
    const MM = (px) => +(px / 96 * 25.4).toFixed(2);
    const out = [];
    document.querySelectorAll('wrap').forEach((wr) => {
      const lab = wr.querySelector('.etq-label');
      const pr = lab.querySelector('.etq-price');
      const box = pr.parentElement;
      const cs = getComputedStyle(box);
      const availW = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const availHtot = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      // Guarda de obstáculo: se MIDE, no se escribe. Sin obstáculo en la caja, es 0.
      const sp = box.querySelector('.etq-sprout');
      const guarda = sp ? Math.max(0, sp.getBoundingClientRect().bottom - (box.getBoundingClientRect().top + parseFloat(cs.paddingTop))) : 0;
      const availH = availHtot - guarda;

      // ── nombre
      const head = lab.querySelector('.etq-head'), htxt = lab.querySelector('.etq-head-txt');
      let hs = 3.9; head.style.fontSize = hs + 'mm';
      for (let g = 0; htxt.scrollWidth > htxt.clientWidth && hs > 2.3 && g < 40; g++) { hs -= 0.12; head.style.fontSize = hs + 'mm'; }

      // ── franja de unidad (sólo si el CSS trae el marcado nuevo)
      const ptxt = lab.querySelector('.etq-pieza-txt');
      const pieza = lab.querySelector('.etq-pieza');
      let us = K.UNIDAD_MM || parseFloat(getComputedStyle(pieza).fontSize) / 96 * 25.4;
      if (ptxt && K.UNIDAD_MM) {
        pieza.style.fontSize = us + 'mm';
        for (let g = 0; ptxt.scrollWidth > ptxt.clientWidth && us > 2.4 && g < 60; g++) { us -= 0.1; pieza.style.fontSize = us + 'mm'; }
      }

      // ── precio: encoge siempre; crece sólo si el fuente trae PRECIO_MAX_MM
      let s = K.PRECIO_MM;
      pr.style.fontSize = s + 'mm';
      const cabe = () => pr.offsetWidth * 1.12 <= availW && pr.offsetHeight <= availH;
      if (availW > 0 && availH > 0) {
        if (!cabe()) { for (let g = 0; !cabe() && s > 4.5 && g < 200; g++) { s -= 0.25; pr.style.fontSize = s + 'mm'; } }
        else if (K.PRECIO_MAX_MM) {
          for (let g = 0; g < 200; g++) {
            const t = s + 0.25; if (t > K.PRECIO_MAX_MM) break;
            pr.style.fontSize = t + 'mm';
            if (!cabe()) { pr.style.fontSize = s + 'mm'; break; }
            s = t;
          }
        }
      }

      // ── montos: uniforme por alto, después individual por ancho
      const tb = lab.querySelector('.etq-tiers');
      const amts = [...lab.querySelectorAll('.amt')];
      const hijos = () => [...tb.children];
      // Alto que los renglones NECESITAN, no el que el navegador les dejó: `.etq-tier` es flex
      // item y si lleva `min-height:0` se APLASTA en vez de desbordar, así que sumar su rect no
      // puede superar nunca la caja — la medida daba 0 de desborde mientras el papel salía con un
      // renglón cortado. Se miden las CELDAS (grid items con align-items:center, no se estiran).
      // Espejo de `altoFila()` en label.component.ts.
      const altoFila = (f) => {
        const rect = f.getBoundingClientRect().height;
        const celdas = [...f.children];
        if (!celdas.length) return rect;
        const cs = getComputedStyle(f);
        const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        return Math.max(rect, Math.max(...celdas.map((c) => c.getBoundingClientRect().height)) + pad);
      };
      const extension = () => {
        const h = hijos(); if (!h.length) return 0;
        const gap = parseFloat(getComputedStyle(tb).rowGap) || 0;
        return h.reduce((a, e) => a + altoFila(e), 0) + (h.length - 1) * gap;
      };
      const set = (v) => amts.forEach((a) => { a.style.fontSize = v + 'mm'; });
      let t = K.MONTO_MM;
      if (amts.length && tb.clientHeight > 0) {
        set(t);
        const techoMonto = K.MONTO_MAX_MM ? Math.min(K.MONTO_MAX_MM, s * 0.7) : K.MONTO_MM;
        if (extension() > tb.clientHeight + 1) {
          for (let g = 0; extension() > tb.clientHeight + 1 && t > 2.6 && g < 80; g++) { t -= 0.2; set(t); }
        } else if (K.MONTO_MAX_MM) {
          for (let g = 0; g < 80; g++) {
            const v = t + 0.2; if (v > techoMonto) break;
            set(v);
            const anchoOk = amts.every((a) => a.parentElement.scrollWidth <= a.parentElement.clientWidth);
            if (extension() > tb.clientHeight + 1 || !anchoOk) { set(t); break; }
            t = v;
          }
        }
      }
      const finales = amts.map((a) => {
        const c = a.parentElement;
        let u = parseFloat(a.style.fontSize) || K.MONTO_MM;
        for (let g = 0; c.scrollWidth > c.clientWidth && u > 2.4 && g < 200; g++) { u -= 0.15; a.style.fontSize = u + 'mm'; }
        return +u.toFixed(2);
      });

      // ── barcode: se lleva el aire que quedó
      const svg = lab.querySelector('.etq-barcode svg');
      let bc = parseFloat(getComputedStyle(svg).height) / 96 * 25.4;
      const aire = MM(tb.clientHeight - extension());
      if (K.BARCODE_MAX_MM && aire > 0) {
        bc = Math.max(K.BARCODE_MIN_MM, Math.min(K.BARCODE_MAX_MM, K.BARCODE_MIN_MM + aire - 0.3));
        svg.style.height = bc + 'mm';
      }

      const rb = pr.getBoundingClientRect();
      const rf = pieza.getBoundingClientRect();
      const rs = sp ? sp.getBoundingClientRect() : null;
      out.push({
        sku: wr.dataset.sku,
        renglones: amts.length,
        precio_mm: +s.toFixed(2),
        precio_llenado_ancho: Math.round(pr.offsetWidth * 1.12 / availW * 100),
        precio_llenado_alto: Math.round(pr.offsetHeight / availHtot * 100),
        unidad_mm: +us.toFixed(2),
        monto_mm: finales.length ? Math.min(...finales) : null,
        montos_uniformes: finales.length <= 1 || new Set(finales).size === 1,
        aire_tiers_mm: aire,
        barcode_mm: +bc.toFixed(2),
        realces: lab.querySelectorAll('.etq-tier.is-mayoreo').length,
        // banderas de no-regresión: todas tienen que ser 0
        precio_desborda: pr.offsetWidth * 1.12 > availW + 1 || pr.offsetHeight > availHtot + 1,
        monto_desborda: amts.some((a) => a.parentElement.scrollWidth > a.parentElement.clientWidth + 1),
        tiers_recortado: extension() > tb.clientHeight + 1,
        unidad_recortada: !!(ptxt && ptxt.scrollWidth > ptxt.clientWidth + 1),
        nombre_recortado: htxt.scrollWidth > htxt.clientWidth + 1,
        precio_toca_brote: !!(rs && !(rb.right < rs.left || rb.left > rs.right || rb.bottom < rs.top || rb.top > rs.bottom)),
        precio_tapa_franja: rb.bottom > rf.top + 1,
        jerarquia_ok: finales.length === 0 || Math.max(...finales) <= s * 0.7 + 0.01,
      });
    });
    return out;
  }, K);

  if (PDF) {
    await page.pdf({ path: PDF, format: 'Letter', landscape: true, printBackground: true,
      margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' } });
    console.log(`\nhoja para mirar: ${PDF}`);
  }
  await b.close();

  // ── reporte ponderado por el catálogo COMPLETO (no por la muestra)
  const porSku = new Map(filas.map((f) => [f.sku, f]));
  const wDig = (k) => {
    let acc = 0;
    for (const [d, p] of Object.entries(pesos.digitos)) {
      const set = corpus.filter((c) => String(c._digitos) === d).map((c) => porSku.get(c.sku)).filter(Boolean);
      if (set.length) acc += (set.reduce((a, f) => a + f[k], 0) / set.length) * (p / 100);
    }
    return acc;
  };
  const wRen = (k) => {
    let acc = 0;
    for (const [r, p] of Object.entries(pesos.renglones)) {
      const set = corpus.filter((c) => String(c._renglones) === r).map((c) => porSku.get(c.sku)).filter(Boolean);
      const vals = set.map((f) => f[k]).filter((v) => v != null);
      if (vals.length) acc += (vals.reduce((a, v) => a + v, 0) / vals.length) * (p / 100);
    }
    return acc;
  };
  const cuenta = (pred) => filas.filter(pred).length;

  console.log(`\n=== etiqueta · geometría · ${etiqueta} ===`);
  console.log(`corpus ${filas.length} filas · constantes del fuente: ${JSON.stringify(K)}`);
  console.log('\nponderado por catálogo:');
  console.log(`  precio                    ${wDig('precio_mm').toFixed(2)} mm`);
  console.log(`  llenado de la caja        ancho ${Math.round(wDig('precio_llenado_ancho'))}% · alto ${Math.round(wDig('precio_llenado_alto'))}%`
    + `  → área ~${Math.round(wDig('precio_llenado_ancho') * wDig('precio_llenado_alto') / 100)}%`);
  console.log(`  palabra de la unidad      ${wDig('unidad_mm').toFixed(2)} mm`);
  console.log(`  monto de renglón          ${wRen('monto_mm').toFixed(2)} mm`);
  console.log(`  aire en la columna        ${wRen('aire_tiers_mm').toFixed(2)} mm`);
  console.log(`  alto del código de barras ${wRen('barcode_mm').toFixed(2)} mm`);
  console.log('\npor estrato de dígitos del precio:');
  for (const d of [1, 2, 3, 4]) {
    const set = corpus.filter((c) => c._digitos === d).map((c) => porSku.get(c.sku)).filter(Boolean);
    if (set.length) console.log(`  ${d} dígito(s) (${pesos.digitos[d]}% del catálogo, ${String(set.length).padStart(3)} filas): `
      + `precio ${(set.reduce((a, f) => a + f.precio_mm, 0) / set.length).toFixed(2)} mm`);
  }
  console.log('\ninvariantes (todos tienen que ser 0):');
  const inv = ['precio_desborda', 'monto_desborda', 'tiers_recortado', 'unidad_recortada', 'nombre_recortado', 'precio_tapa_franja'];
  const culpables = (pred) => filas.filter(pred).map((f) => f.sku).slice(0, 6).join(' ');
  for (const k of inv) {
    const n = cuenta((f) => f[k]);
    console.log(`  ${k.padEnd(22)} ${n}${n ? '   sku: ' + culpables((f) => f[k]) : ''}`);
  }
  const nu = cuenta((f) => !f.montos_uniformes);
  console.log(`  ${'montos NO uniformes'.padEnd(22)} ${nu}${nu ? '   sku: ' + culpables((f) => !f.montos_uniformes) : ''}`);
  const nj = cuenta((f) => !f.jerarquia_ok);
  console.log(`  ${'jerarquía violada'.padEnd(22)} ${nj}${nj ? '   sku: ' + culpables((f) => !f.jerarquia_ok) : ''}   (monto > 70% del precio)`);
  console.log(`\nobservaciones: precio solapa el brote en ${cuenta((f) => f.precio_toca_brote)} filas`
    + ` · realces de mayoreo ${filas.reduce((a, f) => a + f.realces, 0)}`);

  // Rojo SÓLO por lo que no está declarado. Un sku conocido se reporta y no cuenta.
  const falla = (f) => inv.some((k) => f[k]) || !f.montos_uniformes || !f.jerarquia_ok;
  const nuevos = filas.filter((f) => falla(f) && !CONOCIDOS[f.sku]);
  const conocidos = filas.filter((f) => falla(f) && CONOCIDOS[f.sku]);
  if (conocidos.length) {
    console.log('\ncasos límite DECLARADOS (no cuentan como rojo, ver CONOCIDOS en este script):');
    for (const f of conocidos) console.log(`  ${f.sku}  ${CONOCIDOS[f.sku]}`);
  }
  console.log(nuevos.length
    ? `\n⛔ ${nuevos.length} etiqueta(s) rompen un invariante SIN estar declaradas: ${nuevos.map((f) => f.sku).join(' ')}`
    : '\n✅ sin invariantes rotos fuera de los casos declarados');
  process.exit(nuevos.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
