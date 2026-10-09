/**
 * `[PU.VG.4b]` — **El cuadre del ledger de egresos: el único que puede fallar.**
 *
 * ⭐ El cuadre que todo el mundo escribe —`vigente − (reservado + comprometido + ejercido) =
 * disponible`— **NO PUEDE FALLAR**, y por eso no sirve: `available_amount` no es una columna, se
 * calcula con esa misma resta en `budget-lines.service.ts`. Auditarlo es auditar una expresión
 * contra sí misma, y da «cuadre exacto en N de N partidas» sobre cualquier cosa.
 *
 * Lo que SÍ puede derivar es el acumulador guardado en `budget_lines` contra la **suma de los
 * movimientos** de `line_movements`. Ahí se ven un UPDATE directo, una transacción a medias, un
 * arreglo a mano — y sobre todo el dinero movido entre partidas para que ninguna salga
 * sobregirada, que es lo que un contralor persigue de verdad.
 *
 * ── Dos implementaciones, a propósito ───────────────────────────────────────────────────────
 * La máquina de estados se reproduce acá en JS **sin llamar** a la del servicio
 * (`libs/finance/src/lib/budget/budget-ledger.reconstruct.ts`, probada aparte con 15 aserciones y
 * mutada a rojo). Si las dos coinciden sobre datos reales, la coincidencia significa algo; si el
 * servicio cambia una transición y esto no, el candado se pone rojo. Verificar una implementación
 * contra sí misma pasa bugs en verde.
 *
 * ── Lo que NO se puede reconstruir se DECLARA (ADR-056) ─────────────────────────────────────
 * Tres casos devuelven `no_reconstruible` con su motivo, **nunca un número inventado**:
 *   · `cancelacion` sin `cancel_target` → no se sabe qué bucket bajó;
 *   · `compromiso` sin `from_reserva` → no se sabe si movió una reserva o consumió disponible;
 *   · un `movement_type` no modelado (p. ej. `reversion`, que está en el CHECK de la tabla y
 *     **ningún código produce**).
 * Las dos primeras las cierra la migración `20261008181201` `[PU.VG.4a]`; mientras no esté
 * aplicada, las filas viejas caen ahí y el reporte lo dice.
 *
 * ⚠️ **Medido el 2026-10-08: el ledger de prod está VIRGEN** — 139 movimientos y los 139 son
 * `apertura`. O sea que hoy este candado no puede encontrar nada, y eso es exactamente por qué se
 * escribe ahora: tiene que estar puesto ANTES de la primera `reserva` real, no después.
 *
 * READ-ONLY: no escribe una sola fila. Se puede correr contra prod.
 * Uso: PROD_DB_URL=... node database/tests/test-newdb-budget-ledger-cuadre.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const { Client } = require('pg');

const URL = process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;
if (!URL) { console.error('Falta PROD_DB_URL (o DATABASE_URL_NEW)'); process.exit(1); }

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (m) => console.log(`  ⚠️  NO MEDIDO · ${m}`);
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n) => '$' + Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** GEMELO en JS de `reconstruirAcumuladores`. Escrito aparte a propósito (ver cabecera). */
function reconstruir(movs) {
  const a = { vigente: 0, reserved: 0, committed: 0, exercised: 0, paid: 0 };
  for (const m of movs) {
    const amt = Number(m.amount);
    if (!Number.isFinite(amt)) return { ...a, reconstruible: false, motivo: 'monto no numérico' };
    switch (String(m.movement_type)) {
      case 'apertura': case 'ampliacion': case 'transferencia_in': a.vigente = r2(a.vigente + amt); break;
      case 'reduccion': case 'transferencia_out': a.vigente = r2(a.vigente - amt); break;
      case 'reserva': a.reserved = r2(a.reserved + amt); break;
      case 'compromiso':
        if (m.from_reserva === null || m.from_reserva === undefined) {
          return { ...a, reconstruible: false, motivo: 'compromiso sin from_reserva' };
        }
        a.committed = r2(a.committed + amt);
        if (m.from_reserva === true) a.reserved = r2(a.reserved - amt);
        break;
      case 'ejercido': a.committed = r2(a.committed - amt); a.exercised = r2(a.exercised + amt); break;
      case 'pago': a.paid = r2(a.paid + amt); break;
      case 'cancelacion':
        if (m.cancel_target === 'reserva') a.reserved = r2(a.reserved - amt);
        else if (m.cancel_target === 'compromiso') a.committed = r2(a.committed - amt);
        else return { ...a, reconstruible: false, motivo: 'cancelacion sin cancel_target' };
        break;
      default: return { ...a, reconstruible: false, motivo: `movement_type no modelado: ${m.movement_type}` };
    }
  }
  return { ...a, reconstruible: true, motivo: null };
}

(async () => {
  const c = new Client({ connectionString: URL, ssl: false, statement_timeout: 60000 });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  const id = (await c.query(`SELECT current_database() db, (SELECT system_identifier FROM pg_control_system()) sid`)).rows[0];
  console.log(`destino: ${id.db} · system_identifier ${id.sid} · READ-ONLY\n`);

  // La columna puede no existir todavía (la mig 20261008181201 va aparte): el candado tiene que
  // correr igual y DECLARAR, no reventar.
  const cols = (await c.query(`SELECT column_name FROM information_schema.columns
                               WHERE table_schema='budget' AND table_name='line_movements'`)).rows.map((r) => r.column_name);
  const hayCancelTarget = cols.includes('cancel_target');
  const hayFromReserva = cols.includes('from_reserva');
  console.log(`[0] columnas de reconstrucción: cancel_target=${hayCancelTarget} from_reserva=${hayFromReserva}`);
  if (!hayCancelTarget || !hayFromReserva) nm('la migración [PU.VG.4a] no está aplicada acá: toda cancelación y todo compromiso caerán en "no reconstruible"');

  const sel = ['movement_type', 'amount', 'budget_line_id']
    .concat(hayCancelTarget ? ['cancel_target'] : [])
    .concat(hayFromReserva ? ['from_reserva'] : []).join(', ');

  const lines = (await c.query(`
    SELECT l.id, l.concept, l.line_type, l.original_amount, l.vigente_amount, l.reserved_amount,
           l.committed_amount, l.exercised_amount, l.paid_amount, b.name AS budget, b.fiscal_year, b.is_test
      FROM budget.budget_lines l JOIN budget.budgets b ON b.id = l.budget_id
     ORDER BY b.fiscal_year, l.concept`)).rows;
  const movs = (await c.query(`SELECT ${sel} FROM budget.line_movements ORDER BY budget_line_id, created_at, id`)).rows;

  const porLinea = new Map();
  for (const m of movs) {
    if (!porLinea.has(m.budget_line_id)) porLinea.set(m.budget_line_id, []);
    porLinea.get(m.budget_line_id).push(m);
  }

  // ⛔ [PU.VG.4b] ESTA GUARDA EXISTE PORQUE ESTE CANDADO YA DIO UN FALSO VERDE. En su segunda
  // corrida, el bloque [3b] comparaba contra `l.original_amount` y el SELECT no traía esa columna:
  // `Number(undefined)` es NaN, `Math.abs(NaN) >= 0.01` es **false**, así que cero filas se
  // marcaron y el bloque imprimió ✅ sobre una diferencia real de $49M. Una columna ausente se lee
  // EXACTAMENTE igual que "no hay diferencia". Comparar contra un campo que no se seleccionó no
  // puede volver a pasar en silencio.
  // ⭐ Y la guarda pregunta `== null` ANTES de convertir, no `Number.isFinite` después. El refinamiento
  // vino del carril de ventas, medido: **`Number(null)` es `0`, no `NaN`**. O sea que una columna
  // que llega NULL —no ausente— pasa `isFinite` sin chistar y se compara como cero. Un NaN al menos
  // es inverosímil; un 0 es PLAUSIBLE, y acá lo es de verdad (hay partidas legítimas en cero).
  const camposNum = ['original_amount', 'vigente_amount', 'reserved_amount', 'committed_amount', 'exercised_amount', 'paid_amount'];
  for (const l of lines.slice(0, 1)) {
    for (const k of camposNum) {
      if (l[k] === undefined || l[k] === null || !Number.isFinite(Number(l[k]))) {
        console.error(`❌ ABORTA: el SELECT no trae un "${k}" utilizable (llegó ${JSON.stringify(l[k])}). Comparar contra eso daría verde: ausente da NaN y NULL da 0.`);
        process.exit(1);
      }
    }
  }

  console.log(`\n[1] universo: ${lines.length} partidas · ${movs.length} movimientos`);
  const tipos = {};
  for (const m of movs) tipos[m.movement_type] = (tipos[m.movement_type] || 0) + 1;
  console.log('    tipos:', Object.entries(tipos).map(([k, v]) => `${k}=${v}`).join(' · ') || '(ninguno)');

  console.log('\n[2] cuadre de los buckets de CONSUMO (reservado/comprometido/ejercido/pagado)');
  // ⚠️ El `vigente` NO va acá y el motivo se midió: `materialize` reescribe `original_amount` y
  // `vigente_amount` EN SITIO, sin movimiento, cuando la partida no tiene consumo
  // (`budget-materialize.service.ts`, rama `if (!consumed)`). Sólo `adjustVigente` —la rama CON
  // consumo— escribe `ampliacion`/`reduccion`. Así que exigirle al ledger que explique el vigente
  // de una partida virgen es pedirle algo que por diseño no registra: sería un falso positivo.
  // Los buckets de consumo sí salen 100% del ledger, siempre. El vigente va en [3].
  let cuadran = 0; const difieren = []; const noRec = [];
  for (const l of lines) {
    const ms = porLinea.get(l.id) || [];
    if (!ms.length) { noRec.push({ l, motivo: 'la partida no tiene un solo movimiento: ni su apertura' }); continue; }
    const calc = reconstruir(ms);
    if (!calc.reconstruible) { noRec.push({ l, motivo: calc.motivo }); continue; }
    const d = [];
    for (const [campo, col] of [['reserved', 'reserved_amount'],
      ['committed', 'committed_amount'], ['exercised', 'exercised_amount'], ['paid', 'paid_amount']]) {
      const g = Number(l[col]);
      if (Math.abs(r2(g - calc[campo])) >= 0.01) d.push(`${campo}: guardado ${money(g)} vs ledger ${money(calc[campo])}`);
    }
    if (d.length) difieren.push({ l, d }); else cuadran++;
  }
  console.log(`    cuadran: ${cuadran} · difieren: ${difieren.length} · no reconstruibles: ${noRec.length}`);
  for (const x of difieren.slice(0, 10)) console.log(`      ❌ FY${x.l.fiscal_year} «${String(x.l.concept).slice(0, 34)}» → ${x.d.join(' | ')}`);
  for (const x of noRec.slice(0, 10)) console.log(`      ⚠️  FY${x.l.fiscal_year} «${String(x.l.concept).slice(0, 34)}» → ${x.motivo}`);

  ok(difieren.length === 0, `ninguna partida contradice a su ledger (difieren: ${difieren.length})`);
  if (noRec.length) nm(`${noRec.length} partidas no se pueden juzgar; NO cuentan como verdes`);

  console.log('\n[3] el vigente sale de sus adecuaciones — EXIGIBLE sólo donde hay consumo');
  // original + ampliaciones − reducciones + transferencias == vigente. Es donde se escondería
  // mover dinero entre partidas al cierre para que ninguna salga sobregirada.
  let okVig = 0; const malVig = []; let sinConsumo = 0; let noExplicado = 0;
  for (const l of lines) {
    const ms = porLinea.get(l.id) || [];
    let v = 0;
    for (const m of ms) {
      const a = Number(m.amount);
      if (['apertura', 'ampliacion', 'transferencia_in'].includes(m.movement_type)) v = r2(v + a);
      else if (['reduccion', 'transferencia_out'].includes(m.movement_type)) v = r2(v - a);
    }
    const consumido = r2(Number(l.reserved_amount) + Number(l.committed_amount) + Number(l.exercised_amount) + Number(l.paid_amount));
    const delta = r2(Number(l.vigente_amount) - v);
    if (consumido <= 0) {
      sinConsumo++;
      if (Math.abs(delta) >= 0.01) noExplicado = r2(noExplicado + Math.abs(delta));
      continue; // por diseño: materialize la reescribe sin movimiento
    }
    if (Math.abs(delta) < 0.01) okVig++;
    else malVig.push(`FY${l.fiscal_year} «${String(l.concept).slice(0, 30)}»: vigente ${money(l.vigente_amount)} vs adecuaciones ${money(v)}`);
  }
  console.log(`    con consumo → cuadran: ${okVig} · difieren: ${malVig.length}`);
  for (const m of malVig.slice(0, 10)) console.log(`      ❌ ${m}`);
  ok(malVig.length === 0, `toda partida CON consumo explica su vigente por movimientos (difieren: ${malVig.length})`);
  if (sinConsumo) {
    nm(`${sinConsumo} partidas sin consumo: su vigente lo reescribe materialize sin movimiento, así que el ledger NO lo explica — y eso NO cuenta como verde. Importe que el ledger no explica: ${money(noExplicado)}`);
  }

  console.log('\n[3b] ⭐ la "autorización original" del ledger vs el original vigente de la partida');
  // El movimiento de apertura se rotula «Autorización original» y NUNCA se corrige, pero
  // `materialize` sí reescribe `original_amount`. Cuando difieren, el libro dice que se autorizó
  // una cifra y la partida dice otra — y la que manda es la de la partida.
  const mentira = [];
  for (const l of lines) {
    const ap = (porLinea.get(l.id) || []).filter((m) => m.movement_type === 'apertura')
      .reduce((s, m) => r2(s + Number(m.amount)), 0);
    const d = r2(Number(l.original_amount) - ap);
    if (Math.abs(d) >= 0.01) mentira.push({ l, ap, d });
  }
  mentira.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  for (const x of mentira.slice(0, 6)) {
    console.log(`      ⚠️  FY${x.l.fiscal_year} «${String(x.l.concept).slice(0, 30)}»: la partida dice ${money(x.l.original_amount)}, su apertura dice ${money(x.ap)} (Δ ${money(x.d)})`);
  }
  if (mentira.length) {
    nm(`${mentira.length} de ${lines.length} partidas tienen una apertura que ya no coincide con su original_amount: el ledger NO es "inmutable de cada transición" como dice el comentario de su migración`);
  } else {
    ok(true, 'toda apertura sigue coincidiendo con el original de su partida');
  }

  console.log('\n[4] el cuadre OBVIO es una tautología — se demuestra, no se afirma');
  // `disponible` no es columna: se calcula. Reproducirlo acá tiene que dar 100% SIEMPRE, y por eso
  // NO sirve de auditoría. Esta aserción existe para que nadie lo vuelva a proponer como candado.
  let tauto = 0;
  for (const l of lines) {
    const disp = r2(Number(l.vigente_amount) - Number(l.reserved_amount) - Number(l.committed_amount) - Number(l.exercised_amount));
    if (Math.abs(r2(Number(l.vigente_amount) - Number(l.reserved_amount) - Number(l.committed_amount) - Number(l.exercised_amount) - disp)) < 0.01) tauto++;
  }
  ok(tauto === lines.length, `el cuadre obvio da ${tauto}/${lines.length} — cumple SIEMPRE, por construcción, y por eso no audita nada`);

  console.log('\n[5] estado del ledger');
  const soloApertura = movs.length > 0 && movs.every((m) => m.movement_type === 'apertura');
  if (soloApertura) {
    nm(`el ledger está VIRGEN (${movs.length} movimientos, los ${movs.length} son apertura): este candado no puede encontrar deriva todavía. Está puesto ANTES de la primera reserva real, que es el punto`);
  } else {
    ok(true, 'el ledger tiene movimientos de operación: el candado está midiendo de verdad');
  }

  await c.end();
  console.log(`\n${fail === 0 ? '✅ SIN FALLAS' : `❌ ${fail} FALLA(S)`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n❌ EXCEPCIÓN:', e.message); process.exit(1); });
