#!/usr/bin/env node
/**
 * [UIM.1] — Una tabla que declara un ancho mínimo grande ya confesó que no cabe en un teléfono.
 * Esta compuerta exige que, además de confesarlo, haga algo al respecto.
 *
 * ── Qué mide, y por qué ese umbral ───────────────────────────────────────────────────────────
 * Un `[tableStyle]="{ 'min-width': 'NNrem' }"` es un PISO: por debajo de NN la tabla no se
 * encoge, desplaza. Con NN >= 48rem (768 px) no hay teléfono que la contenga — el más ancho de
 * la flota anda por 430 px. A partir de ahí la tabla tiene que declarar qué hace cuando el
 * contenedor es estrecho:
 *
 *   · .dt-stack                   → apila el renglón (libs/ui-web/src/dense-table.css)
 *   · .dt-matrix-ok               → es un PIVOTE y pierde un eje por su cuenta; el eje se elige
 *                                   arriba como alcance. Apilar una matriz da N renglones por
 *                                   registro, que es peor que el scroll — ver DESIGN_TABLES.md.
 *
 * Y si lleva .dt-stack, alguien tiene que establecer el contenedor: sin un .dt-scope en el mismo
 * archivo, la consulta de contenedor no tiene contra qué medir y el CSS entero es INERTE. Ese es
 * el modo de falla que importa: la clase puesta, el archivo importado, el build verde, y la
 * pantalla exactamente igual de rota. Un gate que no mira el .dt-scope se pone verde sobre eso.
 *
 * ── Prueba negativa ──────────────────────────────────────────────────────────────────────────
 * `node scripts/check-dense-tables.js --self-test` construye en memoria los cuatro casos malos
 * y verifica que los cuatro salgan ROJOS. Si un día alguien afloja el regex, el self-test cae
 * antes que la compuerta, que es el orden que sirve. Un gate sin prueba negativa es una
 * intención (regla del repo).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const APPS = ['apps/view/src', 'apps/vendor/src', 'apps/portal/src'];

/** A partir de acá ningún teléfono la contiene. 48rem = 768 px; la flota tope ronda 430 px. */
const UMBRAL_REM = 48;

/**
 * DEUDA DECLARADA — las que ya estaban rotas cuando se escribió la compuerta (2026-09-28).
 *
 * No se silencian: se CUENTAN y se imprimen en cada corrida. La compuerta existe para que no
 * entre una número doce, no para fingir que las once no están. Sacar un archivo de esta lista
 * es el trabajo; agregarle uno nuevo es hacer trampa, y por eso la lista se revisa en review.
 *
 * ⛔ La lista también se cae sola: si un archivo de acá deja de tener tabla ancha (porque lo
 * arreglaron) la compuerta lo dice y hay que sacarlo. Una lista de excepciones que no avisa
 * cuando sobra es una lista que crece para siempre.
 */
/**
 * ⛔ LIMITE CONOCIDO DE ESTA COMPUERTA, y el que la obligo a existir con motivo:
 * analiza por ARCHIVO, y la unidad real es la TABLA. Un archivo con dos tablas anchas donde se
 * arreglo UNA pasa entero, porque basta con que aparezca un dt-stack en el texto. Se detecto en
 * vivo: al apilar la tabla de inventario muerto de compras-pedido-real, la compuerta declaro
 * saldada la rejilla de pedido, que sigue sin apilarse.
 *
 * Mirar por tabla exigiria amarrar cada min-width con el elemento que lo lleva, y en esa misma
 * pantalla el ancho NI SIQUIERA esta en el template: es `readonly tableStyle = {...}` en la clase.
 * En vez de fingir precision, la entrada `parcial` lo DICE: no se poda sola y se imprime como lo
 * que es, media pantalla.
 */
const DEUDA = new Map([
  ['apps/view/src/app/modules/compras/pages/compras-pedido-real.component.ts', {
    parcial: true,
    motivo:
      'La rejilla de PEDIDO (78rem) son 15 columnas de captura con teclado estilo Excel y dos ' +
      'tablas anidadas en la fila expandida. Apilar es TECNICAMENTE correcto (son campos de un ' +
      'producto) pero da 15 renglones por SKU, y varios son secundarios para quien pide desde un ' +
      'telefono. Cual de los 15 se queda NO es decision de CSS: la toma quien usa la pantalla. ' +
      'La otra tabla del archivo (inventario muerto, 60rem) YA quedo apilada.',
  }],
]);

/**
 * DEUDA DECLARADA DE LA 2a AGUJA -- las 79 que la compuerta escondia hasta el 2026-09-29.
 *
 * No se silencian: se CUENTAN y se imprimen en cada corrida. La compuerta nacio mirando
 * `min-width` y por eso daba VERDE a toda tabla que declarara su ancho como anchos de columna
 * en CSS. Al abrirle el segundo ojo aparecieron 79 de golpe: no son una regresion, son lo que
 * ya estaba y no se veia. La peor tiene 30 columnas.
 *
 * La IDENTIDAD importa, no el conteo: un archivo nuevo que no este en esta lista ROMPE la
 * compuerta aunque ese mismo dia se haya arreglado otro. Un techo numerico dejaria pasar el
 * cambio uno-por-uno.
 *
 * Podar esta lista AVISA pero no rompe, al reves que DEUDA: son 79 entradas repartidas entre
 * ~10 sesiones, y hacer fallar el build del que arreglo una pantalla ajena es exactamente como
 * se termina apagando una compuerta.
 */
const DEUDA_COLUMNAS = new Set([
  'apps/view/src/app/modules/almacen/pages/almacen-analisis-bi.component.ts',
  'apps/view/src/app/modules/almacen/pages/almacen-autoabasto.component.ts',
  'apps/view/src/app/modules/almacen/pages/almacen-cuadre.component.ts',
  'apps/view/src/app/modules/almacen/pages/almacen-movimientos.component.ts',
  'apps/view/src/app/modules/almacen/pages/almacen-recepcion-sesion.component.ts',
  'apps/view/src/app/modules/almacen/pages/almacen-recepcion-sesiones.component.ts',
  'apps/view/src/app/modules/almacen/pages/almacen-riesgo.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-comisiones.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-customers-360.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-dead-stock.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-egreso-detalle.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-egresos.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-inventory-expiring.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-inventory-health.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-inventory-session-detail.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-inventory-variance.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-inventory.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-order-detail.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-pricing.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-promotions.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-razonamiento.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-rentabilidad.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-route-tickets.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-salidas.component.ts',
  'apps/view/src/app/modules/comercial/pages/comercial-tickets.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-catalogo.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-cuadre-proveedor.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-entradas-control.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-entradas.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-existencia-critica.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-flujo.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-hallazgos.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-oc-abiertas.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-ordenes.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-proveedores.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-que-toca.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-requisicion-detalle.component.ts',
  'apps/view/src/app/modules/compras/pages/compras-requisiciones.component.ts',
  'apps/view/src/app/modules/contabilidad/pages/contabilidad-cfdi.component.ts',
  'apps/view/src/app/modules/contabilidad/pages/contabilidad-descarga.component.ts',
  'apps/view/src/app/modules/contabilidad/pages/contabilidad-diagnostico.component.ts',
  'apps/view/src/app/modules/contabilidad/pages/contabilidad-facturar.component.ts',
  'apps/view/src/app/modules/contabilidad/pages/libro-compras/libro-compras.component.ts',
  'apps/view/src/app/modules/contabilidad/pages/libro-compras/movimientos-no-asociados.component.ts',
  'apps/view/src/app/modules/dashboard/routes-analysis/routes-analysis.component.ts',
  'apps/view/src/app/modules/finanzas/pages/bancos/bancos-capturas.component.ts',
  'apps/view/src/app/modules/finanzas/pages/bancos/bancos-contpaqi.component.ts',
  'apps/view/src/app/modules/finanzas/pages/bancos/bancos-cuentas.component.ts',
  'apps/view/src/app/modules/finanzas/pages/bancos/bancos-three-way.component.ts',
  'apps/view/src/app/modules/finanzas/pages/bancos/caja-ingreso-ref.component.ts',
  'apps/view/src/app/modules/finanzas/pages/caja-general/finanzas-caja-general.component.ts',
  'apps/view/src/app/modules/finanzas/pages/caos/finanzas-caos.component.ts',
  'apps/view/src/app/modules/finanzas/pages/finanzas-caja.component.ts',
  'apps/view/src/app/modules/finanzas/pages/finanzas-cancelados.component.ts',
  'apps/view/src/app/modules/finanzas/pages/finanzas-cartera-dia.component.ts',
  'apps/view/src/app/modules/finanzas/pages/finanzas-cartera.component.ts',
  'apps/view/src/app/modules/finanzas/pages/finanzas-cobranza.component.ts',
  'apps/view/src/app/modules/finanzas/pages/finanzas-pagos-comprobantes.component.ts',
  'apps/view/src/app/modules/finanzas/pages/finanzas-presupuesto.component.ts',
  'apps/view/src/app/modules/finanzas/pages/finanzas-programa-pagos.component.ts',
  'apps/view/src/app/modules/finanzas/pages/finanzas-solicitudes.component.ts',
  'apps/view/src/app/modules/logistica/pages/logistica-actividad.component.ts',
  'apps/view/src/app/modules/logistica/pages/logistica-costs.component.ts',
  'apps/view/src/app/modules/logistica/pages/logistica-fleet.component.ts',
  'apps/view/src/app/modules/logistica/pages/logistica-gasto-ruta.component.ts',
  'apps/view/src/app/modules/logistica/pages/logistica-guides.component.ts',
  'apps/view/src/app/modules/logistica/pages/logistica-payroll.component.ts',
  'apps/view/src/app/modules/logistica/pages/logistica-reports.component.ts',
  'apps/view/src/app/modules/logistica/pages/logistica-shipments.component.ts',
  'apps/view/src/app/modules/logistica/pages/logistica-staff.component.ts',
  'apps/view/src/app/modules/reparto/pages/home-delivery-tracking.component.ts',
  'apps/view/src/app/modules/televenta/pages/televenta-quote-new.component.ts',
  'apps/view/src/app/modules/tienda/analisis/analisis-cascada.component.ts',
  'apps/view/src/app/modules/tienda/analisis/analisis-clientes.component.ts',
  'apps/view/src/app/modules/tienda/analisis/analisis-productos.component.ts',
  'apps/view/src/app/modules/tienda/analisis/analisis-top.component.ts',
  'apps/view/src/app/modules/tienda/pages/tienda-arqueo.component.ts',
  'apps/view/src/app/modules/tienda/pages/tienda-caducidades-expediente.component.ts',
  'apps/view/src/app/modules/tienda/pages/tienda-cajas.component.ts',
]);

const RE_MINWIDTH = /'min-width'\s*:\s*'([0-9.]+)rem'/g;

/**
 * ⛔ SEGUNDA AGUJA — el falso negativo que esta compuerta tuvo desde el día uno (hallado 2026-09-29
 * revisando `/compras/costo-estandar`).
 *
 * La primera aguja busca `min-width`, porque así declaran su ancho las tablas que la compuerta
 * nació mirando. Pero **el ancho se puede declarar de otra forma**: esa pantalla lo ponía como
 * anchos de columna en su CSS —`6 + 4 + 4.5 + 8×3 + 6 + 6.5 + 11 = 62rem = 992 px`— y la compuerta
 * imprimía *"ninguna NUEVA sin salida en estrecho"* sobre una tabla que desborda 2.3× un teléfono.
 * Una compuerta que sólo conoce una sintaxis miente sobre su propia cobertura.
 *
 * Sumar los `width:` del CSS sería frágil (hay que saber qué selector cae en un `<th>`). El
 * proxy robusto es **cuántas columnas tiene la fila de encabezado más ancha**: se lee del
 * template, no depende de cómo se escribió el ancho, y 8 columnas densas no entran en 430 px
 * aunque ninguna declare nada.
 *
 * Se cuenta POR `<tr>`, no por archivo: un archivo con tres tablas de cuatro columnas suma doce
 * y ninguna de las tres es ancha. El máximo de un solo encabezado es la cifra que importa.
 */
const UMBRAL_COLS = 8;

function maxColumnas(src) {
  let max = 0;
  for (const chunk of src.split(/<tr[\s>]/)) {
    const n = chunk.split(/<th[\s>]/).length - 1;
    if (n > max) max = n;
  }
  return max;
}

function analizar(src) {
  const anchos = [];
  let m;
  RE_MINWIDTH.lastIndex = 0;
  while ((m = RE_MINWIDTH.exec(src)) !== null) anchos.push(parseFloat(m[1]));

  const grandes = anchos.filter((n) => n >= UMBRAL_REM);
  const cols = maxColumnas(src);
  // Ancha por columnas SOLO cuando no declaró min-width: si lo declaró y es chico, la pantalla ya
  // dijo cuánto mide y se le cree — el conteo de columnas es el sustituto de una declaración que falta.
  const anchaPorColumnas = !anchos.length && cols >= UMBRAL_COLS;
  if (!grandes.length && !anchaPorColumnas) return null;

  const porColumnas = !grandes.length;
  const tieneStack = /\bdt-stack\b/.test(src);
  const tieneMatrix = /\bdt-matrix-ok\b/.test(src);
  const tieneScope = /\bdt-scope\b/.test(src);

  if (!tieneStack && !tieneMatrix) {
    return {
      anchos: grandes,
      cols,
      motivo: porColumnas
        ? 'su encabezado más ancho tiene ' + cols + ' columnas y NO declara min-width, así que ' +
          'nada dice qué hace en estrecho: le falta dt-stack (+ dt-scope), o dt-matrix-ok si es ' +
          'un pivote. (Declarar el min-width real tampoco la salva: la deja del otro lado del umbral.)'
        : 'declara min-width >= ' + UMBRAL_REM + 'rem y no dice qué hace en estrecho: ' +
          'le falta dt-stack (+ dt-scope), o dt-matrix-ok si es un pivote.',
    };
  }
  if (tieneStack && !tieneScope) {
    return {
      anchos: grandes,
      cols,
      motivo:
        'lleva dt-stack pero NINGÚN dt-scope: sin contenedor declarado la consulta no mide nada ' +
        'y el apilado no ocurre. Se ve igual de roto, pero en verde.',
    };
  }
  return null;
}

// ── Prueba negativa ────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  const casos = [
    ['sin nada', "[tableStyle]=\"{ 'min-width': '60rem' }\"", true],
    ['justo en el umbral', "[tableStyle]=\"{ 'min-width': '48rem' }\"", true],
    ['stack sin scope', "[tableStyle]=\"{ 'min-width': '60rem' }\" styleClass=\"dt-stack\"", true],
    ['stack ancho sin scope', "[tableStyle]=\"{ 'min-width': '78rem' }\" styleClass=\"dt-stack\"", true],
    ['stack con scope', "<div class=\"dt-scope\"> [tableStyle]=\"{ 'min-width': '60rem' }\" styleClass=\"dt-stack\"", false],
    ['pivote declarado', "[tableStyle]=\"{ 'min-width': '60rem' }\" styleClass=\"dt-matrix-ok\"", false],
    ['angosta, no aplica', "[tableStyle]=\"{ 'min-width': '32rem' }\"", false],

    // ── 2ª aguja: ancho declarado como COLUMNAS, sin min-width ───────────────────────────────
    // El caso REAL que se coló: /compras/costo-estandar, 10 columnas y 62rem repartidos en CSS.
    ['10 columnas sin min-width ni salida', '<tr>' + '<th>x</th>'.repeat(10) + '</tr>', true],
    ['justo en el umbral de columnas', '<tr>' + '<th>x</th>'.repeat(8) + '</tr>', true],
    ['10 columnas con scope+stack', '<div class="dt-scope"><tr>' + '<th>x</th>'.repeat(10) + '</tr> styleClass="dt-stack"', false],
    ['10 columnas con stack pero sin scope', '<tr>' + '<th>x</th>'.repeat(10) + '</tr> styleClass="dt-stack"', true],
    ['7 columnas: cabe, no aplica', '<tr>' + '<th>x</th>'.repeat(7) + '</tr>', false],
    // ⛔ El falso positivo que obliga a contar POR FILA y no por archivo: tres tablas chicas
    // suman 15 <th> y ninguna de las tres es ancha.
    ['tres tablas de 5, ninguna ancha', ('<tr>' + '<th>x</th>'.repeat(5) + '</tr>').repeat(3), false],
    // Si ya declaró un ancho y es chico, se le cree: el conteo sustituye a una declaración
    // AUSENTE, no la contradice.
    ['angosta declarada, con muchas columnas', "[tableStyle]=\"{ 'min-width': '32rem' }\" <tr>" + '<th>x</th>'.repeat(10) + '</tr>', false],
  ];
  let fallos = 0;
  for (const [nombre, src, debeFallar] of casos) {
    const r = analizar(src);
    const fallo = r !== null;
    if (fallo !== debeFallar) {
      console.error(`  ❌ self-test "${nombre}": esperaba ${debeFallar ? 'ROJO' : 'verde'} y dio ${fallo ? 'ROJO' : 'verde'}`);
      fallos++;
    } else {
      console.log(`  ✅ self-test "${nombre}": ${debeFallar ? 'rojo' : 'verde'}, como debe`);
    }
  }
  if (fallos) {
    console.error(`\n❌ La compuerta no detecta ${fallos} caso(s) que debería. Arreglala antes de confiar en su verde.\n`);
    process.exit(1);
  }
  console.log(`\n✅ ${casos.length} casos: la compuerta se pone roja exactamente donde debe.\n`);
  process.exit(0);
}

// ── Barrido ────────────────────────────────────────────────────────────────────────────────
function recorrer(dir, salida) {
  let entradas;
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return salida;
  }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(p, salida);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) salida.push(p);
  }
  return salida;
}

const archivos = [];
for (const app of APPS) recorrer(path.join(RAIZ, app), archivos);

const malos = [];
/** Las de la 2a aguja que ya estaban: se cuentan e imprimen, no rompen. */
const cohorte = [];
const enDeuda = [];
const vistos = new Set();
let conAncho = 0;

for (const f of archivos) {
  const src = fs.readFileSync(f, 'utf8');
  // ⛔ Acá estaba el agujero: el barrido SALTABA todo archivo sin `min-width`, así que la segunda
  // aguja nunca habría llegado a mirarlo. Ahora entra cualquier archivo que tenga encabezado de
  // tabla; los que no tienen ni `<th` ni ancho declarado siguen sin costar nada.
  if (!src.includes('min-width') && !src.includes('<th')) continue;
  const rel = path.relative(RAIZ, f).replace(/\\/g, '/');
  const r = analizar(src);
  if (r) {
    conAncho++;
    vistos.add(rel);
    if (DEUDA.has(rel)) enDeuda.push({ rel, ...DEUDA.get(rel), ...r });
    // Deuda de la 2a aguja: la pantalla ya estaba asi antes de que la compuerta pudiera verla.
    // Se cuenta y se imprime aparte; lo que NO puede pasar es que entre una nueva.
    else if (!r.anchos.length && DEUDA_COLUMNAS.has(rel)) cohorte.push({ rel, ...r });
    else malos.push({ rel, ...r });
  } else if (/'min-width'\s*:\s*'[0-9.]+rem'/.test(src)) {
    conAncho++;
    vistos.add(rel);
    // Media pantalla arreglada NO es una pantalla arreglada: analizar() ya no la ve, pero su
    // entrada `parcial` sigue mandando. Se cuenta y se imprime igual.
    const d = DEUDA.get(rel);
    if (d && d.parcial) enDeuda.push({ rel, ...d, anchos: [], parcialLabel: ' — PARCIAL' });
  }
}

// La lista de deuda se cae sola cuando sobra: un archivo que ya se arregló (o que se renombró)
// tiene que SALIR de la lista, y eso sólo pasa si la compuerta lo reclama.
// La cohorte de la 2a aguja se poda con AVISO, no con rojo: ver el comentario de DEUDA_COLUMNAS.
const podables = [...DEUDA_COLUMNAS].filter((d) => !cohorte.some((e) => e.rel === d));
if (podables.length) {
  console.log(`\n✅ ${podables.length} pantalla(s) de la deuda por columnas ya NO la necesitan:`);
  for (const s of podables.slice(0, 10)) console.log(`   · ${s}`);
  if (podables.length > 10) console.log(`   · …y ${podables.length - 10} más`);
  console.log('   Sacalas de DEUDA_COLUMNAS en scripts/check-dense-tables.js.\n');
}

const sobrantes = [...DEUDA.keys()].filter((d) => !enDeuda.some((e) => e.rel === d));
if (sobrantes.length) {
  console.error('\n❌ Estos archivos están en la lista de deuda y ya no la necesitan:');
  for (const s of sobrantes) console.error(`   · ${s}`);
  console.error('   Sacalos de DEUDA en scripts/check-dense-tables.js. Una lista de excepciones');
  console.error('   que no se poda deja de decir cuánto falta.\n');
  process.exit(1);
}

if (malos.length) {
  console.error('');
  for (const m of malos) {
    console.error(`❌ ${m.rel}`);
    console.error(
      m.anchos.length
        ? `   min-width: ${m.anchos.map((n) => n + 'rem').join(', ')}`
        : `   columnas: ${m.cols} en el encabezado más ancho (sin min-width declarado)`,
    );
    console.error(`   ${m.motivo}`);
  }
  console.error(`\n${malos.length} de ${conAncho} tabla(s) anchas sin salida en estrecho.`);
  console.error('   Cómo se arregla, en DESIGN_TABLES.md §"Tabla estrecha":');
  console.error('     · columnas = CAMPOS de un registro → .dt-scope en el contenedor + .dt-stack en la tabla');
  console.error('       + data-label y role="cell" en cada <td>.');
  console.error('     · columnas = otra DIMENSIÓN (pivote) → el eje se elige arriba como alcance, la');
  console.error('       comparación se muda al detalle, y la tabla se marca .dt-matrix-ok.');
  console.error('   ⛔ Subir el umbral de esta compuerta no es una de las dos salidas.\n');
  process.exit(1);
}

const deudaTxt = enDeuda.length
  ? `\n⚠️  ${enDeuda.length} pantalla(s) en DEUDA DECLARADA — anchas y sin salida en estrecho, con nombre y fecha:\n` +
    enDeuda
      .map((d) => {
        const anchos = d.anchos.length ? ` (${d.anchos.map((n) => n + 'rem').join(', ')})` : '';
        // El motivo se IMPRIME. Una lista de excepciones sin el porqué es una lista que nadie
        // puede evaluar: el que la lee seis meses después no sabe si sigue valiendo.
        const motivo = d.motivo ? `\n       ${d.motivo}` : '';
        return `     · ${d.rel}${anchos}${d.parcialLabel || ''}${motivo}`;
      })
      .join('\n') +
    '\n   No son un aprobado: son el trabajo que falta. Tracker: [UIM.2].'
  : '';

// La cohorte de la 2a aguja se imprime SIEMPRE, con su peor caso. Un número que no se ve cada
// corrida deja de doler, y este mide cuántas pantallas densas no entran hoy en un teléfono.
const cohorteTxt = cohorte.length
  ? `\n⚠️  ${cohorte.length} pantalla(s) en DEUDA por ANCHO DE COLUMNAS (2ª aguja, 2026-09-29):\n` +
    `     ocho columnas o más y sin min-width declarado, o sea nada dice qué hacen en un teléfono.\n` +
    `     Las peores: ` +
    [...cohorte].sort((a, b) => b.cols - a.cols).slice(0, 5)
      .map((c) => `${c.rel.split('/').pop().replace('.component.ts', '')} (${c.cols})`).join(' · ') +
    `\n   No son un aprobado: es lo que la compuerta no podía ver hasta hoy. Tracker: [UIM.2].`
  : '';

console.log(
  `✅ ${archivos.length} componente(s) · ${conAncho} tabla(s) con ancho declarado: ` +
  `ninguna NUEVA sin salida en estrecho.${deudaTxt}${cohorteTxt}`,
);
