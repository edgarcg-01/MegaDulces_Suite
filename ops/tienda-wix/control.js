// Control negativo del resolvedor: respuestas que ya conozco, ANTES de confiar en el.
const { repartir, accionDe, unidadDe } = require('./resolver');
let ok = 0, mal = 0;
const t = (n, cond) => { if (cond) { ok++; console.log('  ok  ', n); } else { mal++; console.log('  FALLA', n); } };

console.log('== el reparto nunca ofrece mas de lo que hay ==');
// 97245 real: 316 piezas, factores 180/10/1 -> antes se ofrecian 540
const r = repartir([
  { variantId: 'cja', f: 180 }, { variantId: 'paq', f: 10 }, { variantId: 'pza', f: 1 },
], 316);
const total = r.get('cja') * 180 + r.get('paq') * 10 + r.get('pza') * 1;
console.log('   97245 -> caja', r.get('cja'), 'paquete', r.get('paq'), 'pieza', r.get('pza'), '=', total, 'pz de 316');
t('no excede la existencia', total <= 316);
t('aprovecha casi todo', total >= 316 - 1);
t('la caja va primero', r.get('cja') === 1);

console.log('\n== casos borde ==');
t('existencia 0 -> todo en 0', [...repartir([{ variantId: 'a', f: 10 }], 0).values()].every(v => v === 0));
t('existencia menor que el factor -> 0', repartir([{ variantId: 'a', f: 180 }], 100).get('a') === 0);
t('respeta el tope de 50', repartir([{ variantId: 'a', f: 1 }], 100000).get('a') === 50);
t('una sola presentacion', repartir([{ variantId: 'a', f: 1 }], 7).get('a') === 7);

console.log('\n== la unidad ==');
const kUno = { u: [{ u: 'KG', p: 63.86, f: 1 }] };
const kTres = { u: [{ u: 'PZA', p: 1, f: 1 }, { u: 'PAQ', p: 10, f: 10 }, { u: 'CJA', p: 180, f: 180 }] };
t('nombre conocido gana', unidadDe('Caja', kTres).u.u === 'CJA');
t('unidad unica resuelve el nombre roto', unidadDe('BOLSA ROLLO ALTA OXXO 25 X 35', kUno).u.u === 'KG');
t('nombre roto con 3 unidades NO se adivina', unidadDe('BOLSA LO QUE SEA', kTres).u === null);

console.log('\n== las acciones ==');
t('sin precio de mostrador -> RETIRAR', accionDe({ nom: 'Caja', k: null }).accion === 'RETIRAR');
t('Pieza sin PZA -> OCULTAR', accionDe({ nom: 'Pieza', k: { u: [{ u: 'PAQ', p: 10, f: 10 }] } }).accion === 'OCULTAR');
t('Pieza CON PZA -> SINCRONIZAR', accionDe({ nom: 'Pieza', k: kTres }).accion === 'SINCRONIZAR');
t('nombre roto ambiguo -> DECLARAR', accionDe({ nom: 'XX', k: kTres }).accion === 'DECLARAR');

console.log('\n' + (mal === 0 ? 'TODOS EN VERDE (' + ok + ')' : '⛔ ' + mal + ' FALLAS de ' + (ok + mal)));
if (mal) process.exitCode = 1;

// --- control de la regla 1b (codigo de unidad como nombre) ---
{
  const { unidadDe } = require('./resolver');
  const k500 = { u: [{ u: '500', p: 84.48, f: 1 }, { u: 'PAQ', p: 156.42, f: 2 }, { u: 'CJA', p: 1439.11, f: 20 }] };
  const kCub = { u: [{ u: 'CUB', p: 430.8, f: 1 }, { u: 'PZA', p: 9, f: 50 }] };
  let o = 0, m = 0;
  const t2 = (n, c) => { if (c) { o++; console.log('  ok  ', n); } else { m++; console.log('  FALLA', n); } };
  console.log('== regla 1b: el codigo de unidad como nombre ==');
  t2('"500" resuelve a la unidad 500', unidadDe('500', k500).u.u === '500');
  t2('"Cub" resuelve a CUB sin importar mayusculas', unidadDe('Cub', kCub).u.u === 'CUB');
  t2('el nombre conocido sigue ganando', unidadDe('Caja', k500).u.u === 'CJA');
  t2('un nombre que NO es unidad sigue sin resolver', unidadDe('PASTA DONITA 1 KG', k500).u === null);
  console.log(m === 0 ? '  regla 1b EN VERDE (' + o + ')' : '  FALLAS: ' + m);
  if (m) process.exitCode = 1;
}
