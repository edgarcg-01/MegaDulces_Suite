#!/usr/bin/env node
/**
 * Hook UserPromptSubmit — hace que el análisis por capas OCURRA, no que se pida.
 *
 * ⭐ POR QUE EXISTE. Una skill se carga cuando Claude decide que el pedido coincide con su
 * descripción, no en cada mensaje. La skill `criterio` (pensar antes de tocar: capas, fuente
 * de verdad, impacto, reglas, verificación) se saltaba justo en los pedidos que más la
 * necesitan: los cortos ("arregla el total", "agrega un campo"), que suenan triviales.
 * Es la misma lección de `bloquea-python.js`: una regla que solo vive en la prosa no es una
 * regla.
 *
 * Qué hace: si el mensaje del usuario PIDE UN CAMBIO (verbo de cambio, o síntoma de bug), le
 * agrega a Claude un recordatorio de una línea para cargar `criterio` y entregar la ficha
 * antes de escribir código. No bloquea nada, no pregunta nada, y si no entiende la entrada
 * sale callado (exit 0).
 *
 * Qué NO hace: no se dispara en preguntas, explicaciones ni slash commands ("/entrega").
 * La prueba negativa vive en el bloque de --self-test, abajo:
 *     node scripts/hooks/recuerda-criterio.js --self-test
 */
'use strict';

const CAMBIO = new RegExp(
  [
    // verbos de cambio (imperativo, infinitivo y "quiero que …")
    '\\b(agreg|añad|anad|cambi|arregl|corrig|corrij|cre[ae]|implement|quit|elimin|borr|mueve|mover|migr|refactoriz|optimiz|renombr|actualiz|modific|conect|integr|construy|program|haz|hag|pon|ponle|reemplaz|sustitu|separ|junt|divid)',
    // "quiero que …" / "necesito que …" (salvo que pida una explicación)
    "\\b(quiero|necesito) que\\b(?!.*\\bexpli)",
    // síntomas de bug
    '\\b(no funciona|no jala|no sirve|truena|tronó|falla|da error|sale vac[ií]o|sale en cero|no guarda|no cuadra|bug|500|403)\\b',
    // inglés, por si acaso
    '\\b(add|change|fix|create|implement|remove|delete|refactor|migrate|rename|update|build)\\b',
  ].join('|'),
  'i',
);

const RECORDATORIO =
  'Este mensaje pide un cambio. Antes de escribir código, carga la skill `criterio` y entrega ' +
  'su FICHA (pedido · capas C0–C4 y tope · fuente leída · impacto · reglas en juego · plan · ' +
  'cómo verificas cada capa · decisiones D1…Dn). Proporcional al tamaño: un cambio chico son ' +
  'tres renglones. Al terminar, `cierre-por-capas` antes de decir "listo".';

function debeRecordar(prompt) {
  const p = String(prompt || '').trim();
  if (!p) return false;
  if (p.startsWith('/')) return false; // slash command: ya trae su propia skill
  return CAMBIO.test(p);
}

function salida(prompt) {
  if (!debeRecordar(prompt)) return null;
  return {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: RECORDATORIO },
  };
}

if (process.argv.includes('--self-test')) {
  const casos = [
    // [mensaje, ¿debe recordar?]
    ['agrega un campo de descuento a la pantalla de pedidos', true],
    ['arregla el total de mis pedidos', true],
    ['el endpoint de carga sale vacío', true],
    ['quiero que la vista de existencias use el resolvedor', true],
    ['haz la migración para la columna nueva', true],
    ['no guarda la indicación del surtidor', true],
    ['fix the RLS bug in carga', true],
    // negativos — sin esto el gate es una intención (regla 12)
    ['¿qué hace TenantKnexService?', false],
    ['explícame cómo funciona el ODS', false],
    ['quiero que me expliques las capas', false],
    ['/entrega', false],
    ['/criterio agrega un campo', false],
    ['', false],
    ['gracias, se ve bien', false],
  ];
  let malos = 0;
  for (const [msg, esperado] of casos) {
    const real = debeRecordar(msg);
    if (real !== esperado) {
      malos++;
      console.error(`✗ "${msg}" → ${real}, esperaba ${esperado}`);
    }
  }
  if (malos) {
    console.error(`\nrecuerda-criterio: ${malos} de ${casos.length} casos mal.`);
    process.exit(1);
  }
  console.log(`recuerda-criterio: ${casos.length}/${casos.length} casos ✓`);
  process.exit(0);
}

let crudo = '';
process.stdin.on('data', (d) => (crudo += d));
process.stdin.on('end', () => {
  let entrada;
  try {
    entrada = JSON.parse(crudo || '{}');
  } catch {
    process.exit(0); // si no entiendo la entrada, no estorbo
  }
  const out = salida(entrada?.prompt);
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
});
