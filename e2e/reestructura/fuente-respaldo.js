// [GP.RF.40] Calcula las caras de respaldo de libs/design-tokens/tokens.css ('Hanken Respaldo' y
// 'Geist Mono Respaldo'): la letra LOCAL de Windows escalada al ancho de la letra web (size-adjust)
// y con su ascenso/descenso. Mide en Chromium con canvas; imprime el CSS y el error de ancho por
// texto antes/después. Recalcular si cambia la letra web, sus pesos o la letra local.
//
//   node e2e/reestructura/fuente-respaldo.js
//
// Controles: una cara local() con un nombre inexistente NO debe resolver; la letra web contra sí
// misma da error 0. Necesita red a fonts.googleapis.com (baja las letras web, nada más).
const { chromium } = require('playwright');

const CADENAS = [
  'Surtir pedidos de preventa y Telemarketing', 'Almacén CEDIS · Zamora Centro · Ruta 05',
  'Abarrotes La Esperanza de Jiquilpan', 'Dulcería El Arcoíris del Centro, S.A. de C.V.',
  '12 piezas · 3 cajas · 1,250.00', 'mañana, atrasados, próximos', '¿Cuánto levantaste?',
  'PEDIDOS DE · ALMACÉN · POR SURTIR', 'Tomar siguiente', 'Ver la lista de pedidos',
  'Elige tu almacén', 'Faltan 4 paquetes. ¿Con qué lo cambias?', 'Cambiar por otro producto',
  'Ubicación BA053 · Pasillo 7 · Nivel 2', 'Caja General · Ventanilla · Arqueo del día',
  'Conciliación bancaria — movimientos sin categoría', 'Calendario de pagos a proveedores',
  'Requisición 0001234 · Orden de compra 98765', 'Gómez Hernández, María Guadalupe', 'Rosy Martínez',
];
const FAMILIAS = [
  {
    web: 'Hanken Grotesk', respaldo: 'Hanken Respaldo', google: 'Hanken+Grotesk:wght@300;400;500;600;700;800',
    // peso → caras locales que lo sustituyen (nombre completo y PostScript). 500→Semibold y 800→Bold: Segoe no tiene esos pesos.
    caras: { 300: ['Segoe UI Light', 'SegoeUI-Light'], 400: ['Segoe UI', 'SegoeUI'], 500: ['Segoe UI Semibold', 'SegoeUI-Semibold'],
      600: ['Segoe UI Semibold', 'SegoeUI-Semibold'], 700: ['Segoe UI Bold', 'SegoeUI-Bold'], 800: ['Segoe UI Bold', 'SegoeUI-Bold'] },
  },
  {
    web: 'Geist Mono', respaldo: 'Geist Mono Respaldo', google: 'Geist+Mono:wght@400;500;600;700',
    caras: { 400: ['Consolas'], 500: ['Consolas'], 600: ['Consolas Bold', 'Consolas-Bold'], 700: ['Consolas Bold', 'Consolas-Bold'] },
  },
];
const pct = (x) => `${+(x * 100).toFixed(2)}%`;

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const crudas = FAMILIAS.flatMap((f) => Object.entries(f.caras).map(([w, n]) =>
    `@font-face{font-family:'Cruda ${f.web}';font-weight:${w};src:${n.map((x) => `local('${x}')`).join(',')};}`)).join('\n')
    + `\n@font-face{font-family:'Control Nada';src:local('Fuente Que No Existe 123');}`;
  await p.setContent(`<!doctype html><html><head><style>${crudas}</style><link rel="stylesheet"
    href="https://fonts.googleapis.com/css2?${FAMILIAS.map((f) => `family=${f.google}`).join('&')}&display=swap"></head><body></body></html>`);
  for (const f of FAMILIAS) {
    const pesos = Object.keys(f.caras).map(Number);
    const r = await p.evaluate(async ({ f, pesos, CADENAS }) => {
      for (const w of pesos) { await document.fonts.load(`${w} 20px '${f.web}'`); await document.fonts.load(`${w} 20px 'Cruda ${f.web}'`); }
      const c = document.createElement('canvas').getContext('2d');
      const anchos = (fam, w) => { c.font = `${w} 100px ${fam}, monospace`; return CADENAS.map((t) => c.measureText(t).width); };
      const met = (fam, w) => { c.font = `${w} 100px ${fam}`; const m = c.measureText('Hxg'); return { asc: m.fontBoundingBoxAscent / 100, desc: m.fontBoundingBoxDescent / 100 }; };
      const out = { web: {}, cruda: {}, met: met(`'${f.web}'`, 400), cargada: document.fonts.check(`400 20px '${f.web}'`) };
      for (const w of pesos) { out.web[w] = anchos(`'${f.web}'`, w); out.cruda[w] = anchos(`'Cruda ${f.web}'`, w); }
      c.font = "400 100px 'Control Nada', monospace"; const a = c.measureText('Hxg').width; c.font = '400 100px monospace';
      out.controlNada = a === c.measureText('Hxg').width;
      return out;
    }, { f, pesos, CADENAS });
    if (!r.cargada) throw new Error(`${f.web} no cargó (¿sin red a Google Fonts?)`);
    if (!r.controlNada) throw new Error('control: local() resolvió un nombre que no existe');
    const suma = (a) => a.reduce((x, y) => x + y, 0);
    const css = [];
    const tabla = [];
    for (const w of pesos) {
      const s = suma(r.web[w]) / suma(r.cruda[w]);
      css.push(`@font-face { font-family: '${f.respaldo}'; font-weight: ${w}; src: ${f.caras[w].map((x) => `local('${x}')`).join(', ')};\n  size-adjust: ${pct(s)}; ascent-override: ${pct(r.met.asc / s)}; descent-override: ${pct(r.met.desc / s)}; line-gap-override: 0%; }`);
      const err = (k) => { const e = r.web[w].map((x, i) => Math.abs((r.cruda[w][i] * k) / x - 1)).sort((a, z) => a - z); return pct(e[e.length >> 1]); };
      tabla.push(`${w}: size-adjust ${pct(s)} · error mediano por texto ${err(1)} → ${err(s)}`);
    }
    console.log(`\n/* ${f.web}: ascenso ${r.met.asc.toFixed(2)} em, descenso ${r.met.desc.toFixed(2)} em */\n${css.join('\n')}`);
    console.log(tabla.map((t) => `  ${t}`).join('\n'));
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
