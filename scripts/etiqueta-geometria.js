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

const src = fs.readFileSync(SRC, 'utf8');
const css = /styles:\s*\[`([\s\S]*?)`\],/.exec(src)[1];
const num = (re, def) => { const m = re.exec(src); return m ? Number(m[1]) : def; };

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
  return { nombre, heroWord, heroVal, tiers, content: m.content, sku: m.sku };
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
      <div class="etq-barcode">${BARRAS}</div>
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
  await page.setContent(`<meta charset="utf-8"><style>${css}
    wrap{ display:inline-block; vertical-align:top; margin:2mm }
    body{ margin:0; font-size:0; text-align:center }
    .etq-label{ border-radius:0 !important }</style>${vistas.map(html).join('')}`, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    await Promise.all(['11mm Anton', "5mm 'Bebas Neue'", "4mm 'Baloo 2'"].map((f) => document.fonts.load(f)));
    for (let i = 0; i < 100; i++) {
      if (['11mm Anton', "5mm 'Bebas Neue'"].every((f) => document.fonts.check(f))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

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
      const extension = () => {
        const h = hijos(); if (!h.length) return 0;
        const gap = parseFloat(getComputedStyle(tb).rowGap) || 0;
        return h.reduce((a, e) => a + e.getBoundingClientRect().height, 0) + (h.length - 1) * gap;
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
