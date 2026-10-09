/**
 * `[CP.8.8]` — Candado del motor de cuadre. Carga el `.ts` REAL vía ts-node.
 *
 * Lo que este candado defiende, que es lo que hace al puente auditable:
 *
 *  1. **Token = certeza, importe = sospecha.** Casar por fecha e importe NO asciende a
 *     `aplicada`. Es la lección de `[LC.14]`: ninguna de las dos llaves es superconjunto de la
 *     otra, y tratar la heurística como certeza es cómo se cuela un duplicado.
 *  2. **Las dos ausencias son distintas** (ADR-056): `esperando` devuelve `verificada = null`,
 *     `no_aparecio` devuelve `false`. Colapsarlas haría que un evento recién entregado se vea
 *     igual que uno perdido.
 *  3. **Un centavo de diferencia es `difiere`**, no "cuadró más o menos".
 *  4. El porcentaje del latido **excluye** lo que todavía se espera, y es `null` —no 0— cuando
 *     no hay nada juzgable.
 *
 * Sin base de datos: lógica pura.
 */
'use strict';

const path = require('path');

require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});

const SRC = path.resolve(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib', 'contpaqi');
const { cuadrar, resumirCuadre, diasEntre, PLAZO_DIAS } = require(path.join(SRC, 'cuadre.engine.ts'));

let ok = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};

const HOY = '2026-03-10';
const PEND = {
  evento_tipo: 'bank_movement', evento_id: 'e-1',
  fecha: '2026-03-01', tipo_poliza: 2, total: 155535.47, periodo: '2026-03',
  token: 'MD:a1b2c3d4', entregada_en: '2026-03-02',
};
// La póliza real de ContPAQi (traslado de efectivo, folio 260).
const CAND = {
  ejercicio: 2026, periodo: 3, tipo_pol: '2', folio: '260',
  guid: 'B0B034F5-5731-441C-8892-EAA8C425C064', fecha: '2026-03-01',
  concepto: 'MD:a1b2c3d4 PAGO TRASLADO DE EFECTIVO',
  cargos: 155535.47, abonos: 155535.47,
};

(async () => {
  console.log('\n[1] Token + importes idénticos = sincronizado');
  const r1 = cuadrar(PEND, [CAND], HOY);
  check(r1.veredicto === 'aplicada', 'veredicto = aplicada');
  check(r1.verificada === true, 'verificada = true');
  check(r1.casado_por === 'token', 'casó por token');
  check(r1.contpaqi_folio === 260, 'guarda el folio que ContPAQi asignó');
  check(r1.contpaqi_guid === CAND.guid, 'guarda el Guid');
  check(typeof r1.motivo === 'string' && r1.motivo.length > 0, 'siempre escribe motivo');

  console.log('\n[2] ⭐ Token pero un centavo de diferencia = difiere, no "casi"');
  const r2 = cuadrar(PEND, [{ ...CAND, cargos: 155535.48 }], HOY);
  check(r2.veredicto === 'difiere', 'veredicto = difiere');
  check(r2.verificada === false, 'verificada = false');
  check(r2.casado_por === 'token', 'igual registra que casó (el asiento ES ése)');
  check(/155535\.47/.test(r2.motivo) && /155535\.48/.test(r2.motivo),
    'el motivo dice los DOS importes, no sólo que difieren');

  console.log('\n[3] ⛔ Sin token: coincidir en fecha e importe NO es certeza');
  const sinToken = { ...PEND, token: null };
  const r3 = cuadrar(sinToken, [{ ...CAND, concepto: 'PAGO TRASLADO DE EFECTIVO' }], HOY);
  check(r3.veredicto === 'probable', 'veredicto = probable');
  check(r3.veredicto !== 'aplicada', '⭐ NO asciende a aplicada por coincidir en monto');
  check(r3.verificada === null, 'verificada = null (nadie lo confirmó todavía)');
  check(r3.casado_por === 'importe', 'declara que casó por importe');
  check(/confirmación humana/i.test(r3.motivo), 'el motivo pide confirmación humana');

  console.log('\n[4] Ambigüedad: más de un candidato');
  const dosTokens = cuadrar(PEND, [CAND, { ...CAND, folio: '261' }], HOY);
  check(dosTokens.veredicto === 'ambiguo' && dosTokens.verificada === false,
    'el mismo token en 2 pólizas = ambiguo (no elige una)');
  check(/260/.test(dosTokens.motivo) && /261/.test(dosTokens.motivo),
    'el motivo nombra los dos folios');
  const dosImportes = cuadrar(sinToken, [
    { ...CAND, concepto: 'A' }, { ...CAND, folio: '999', concepto: 'B' },
  ], HOY);
  check(dosImportes.veredicto === 'ambiguo', 'dos pólizas del mismo monto y día = ambiguo');
  check(dosImportes.casado_por === null, 'un ambiguo no se atribuye a ninguna');

  console.log('\n[5] ⭐ Las dos ausencias son DISTINTAS (ADR-056)');
  const esperando = cuadrar(PEND, [], '2026-03-04');  // 2 días
  check(esperando.veredicto === 'esperando', 'dentro del plazo = esperando');
  check(esperando.verificada === null, '⭐ esperando devuelve null, NO false');
  const vencido = cuadrar(PEND, [], '2026-03-20');    // 18 días
  check(vencido.veredicto === 'no_aparecio', 'pasado el plazo = no_aparecio');
  check(vencido.verificada === false, 'no_aparecio devuelve false');
  check(/plazo/.test(vencido.motivo) && /18/.test(vencido.motivo),
    'el motivo dice cuántos días pasaron y cuál era el plazo');

  const borde = cuadrar(PEND, [], '2026-03-07'); // exactamente PLAZO_DIAS
  check(borde.veredicto === 'esperando', `al día ${PLAZO_DIAS} exacto todavía espera (no vence en el borde)`);

  const sinFecha = cuadrar({ ...PEND, entregada_en: null }, [], HOY);
  check(sinFecha.veredicto === 'esperando' && sinFecha.verificada === null,
    'sin fecha de entrega no se puede medir el plazo → se declara, no se vence');

  console.log('\n[6] `diasEntre` no corre el día por zona horaria');
  check(diasEntre('2026-03-01', '2026-03-10') === 9, '9 días exactos');
  check(diasEntre('2026-08-31', '2026-09-01') === 1, 'cruza fin de mes sin corrimiento');
  // ⚠️ Esta aserción nació MAL y la atrapó la primera corrida: decía "2026 bisiesto" y pedía 2
  // días. 2026 NO es bisiesto (2024 sí, 2028 el próximo), así que del 28-feb al 1-mar hay 1.
  // El motor tenía razón. Queda con los dos casos para que el bisiesto se pruebe de verdad.
  check(diasEntre('2026-02-28', '2026-03-01') === 1, 'febrero de 28 días (2026): 28-feb → 1-mar = 1 día');
  check(diasEntre('2024-02-28', '2024-03-01') === 2, 'febrero de 29 días (2024 bisiesto): = 2 días');

  console.log('\n[7] El resumen del latido mide ENTREGA, no corridas');
  const res = resumirCuadre([r1, r2, r3, esperando, vencido]);
  check(res.total === 5, 'cuenta los 5');
  check(res.sincronizados === 1, 'sólo 1 está de verdad sincronizado');
  check(res.juzgables === 4, '⭐ el denominador excluye lo que todavía se espera');
  check(res.pct_sincronizado === 25, '1 de 4 juzgables = 25%');
  const vacio = resumirCuadre([esperando]);
  check(vacio.pct_sincronizado === null,
    '⭐ sin nada juzgable el porcentaje es null, NO 0 (que se leería como "todo mal")');

  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.8 motor de cuadre: ${ok} ✓ / ${fail} ✗\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  fail++;
  console.log(`  ✗ excepción no esperada: ${e && e.message}`);
  console.log(`\n❌ CP.8.8 motor de cuadre: ${ok} ✓ / ${fail} ✗\n`);
  process.exit(1);
});
