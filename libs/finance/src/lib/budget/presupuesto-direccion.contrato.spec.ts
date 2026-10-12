import { obligacionNoEsDePruebaSql } from '@megadulces/platform-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `[TES.21]` **El candado del contrato de la vista «Dirección».**
 *
 * Lo pidió el carril de Gastos y lo corre él; se escribe acá porque el código es de este carril.
 * No toca la base: vigila la FORMA, que es donde nacieron los dos defectos del dominio.
 *
 * ⭐ El candado 2 es una **prueba negativa que reproduce un error real**: el atajo
 * `budget_line_id IS NULL` para separar el ejercicio de prueba. Medido contra prod el
 * 2026-10-12, **las 312 obligaciones tienen partida**, así que ese atajo devuelve
 * *0 de prueba y 312 reales* — publica el doble, y se ve perfectamente normal porque los dos
 * universos difieren en $4,666.67 sobre $74.8 millones.
 *
 * ⚠️ El origen de ese error merece quedar escrito porque es reutilizable: el script que lo
 * produjo imprimía `String(x.folio ?? 'SIN LINEA')`. Lo que venía NULL era **el folio** —el
 * ejercicio de prueba no tiene— y la cadena de respaldo **le puso nombre a la ausencia
 * equivocada**. La misma salida decía `prueba=true`, que sólo puede salir de un join de dos
 * saltos que funcionó: *se contradecía consigo misma y se leyó la etiqueta*.
 */

const RAIZ = path.resolve(__dirname, '../../../../..');
const CONTRATO = path.join(RAIZ, 'libs/contracts/src/http/budget-direccion.contract.ts');
const SERVICIO = path.join(__dirname, 'presupuesto-direccion.service.ts');

const leer = (p: string) => fs.readFileSync(p, 'utf8');

/**
 * ⭐ **Las reglas de AUSENCIA miran código, no prosa.** La primera versión de este candado se
 * puso rojo dos veces por los comentarios de los archivos que vigila: el servicio documenta el
 * atajo prohibido (`budget_line_id IS NULL`) para que nadie lo reintroduzca, y el contrato
 * explica por qué `dias_en_borrador` se retiró. Las dos menciones son **la documentación de la
 * trampa**, no la trampa.
 *
 * ⇒ Un candado que castiga a quien documenta el defecto empuja a borrar la advertencia, que es
 * exactamente al revés de lo que se busca. Los `toContain` positivos sí leen el archivo entero:
 * ahí un comentario que promete algo que el código no hace es otro defecto, y se quiere ver.
 */
const sinComentarios = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('[TES.21] contrato de la vista Dirección', () => {
  it('los dos archivos existen donde el contrato dice', () => {
    expect(fs.existsSync(CONTRATO)).toBe(true);
    expect(fs.existsSync(SERVICIO)).toBe(true);
  });

  // ── 1 · NINGÚN campo suma los dos ejercicios ──────────────────────────
  it('⛔ 1 — no existe un escalar que sume FY2026 + FY2027', () => {
    const c = leer(CONTRATO);
    // El ledger expone una LISTA por ejercicio; un `total` escalar es el defecto.
    expect(c).toContain('por_ejercicio: Array<{ fiscal_year: number; monto: number | null }>');
    expect(c).not.toMatch(/\btotal\s*:\s*number/);
    expect(c).not.toMatch(/\bmonto_total\s*:\s*number/);
    expect(c).not.toMatch(/\bgran_total\b/);
  });

  // ── 2 · El ejercicio de prueba, separado — y el ATAJO prohibido ───────
  it('⛔ 2 — obligaciones llegan en DOS universos y sin campo que los sume', () => {
    const c = leer(CONTRATO);
    expect(c).toContain('reales: { n: number; monto: number }');
    expect(c).toContain('prueba: { n: number; monto: number }');
    expect(c).not.toMatch(/ObligacionesResumen[\s\S]{0,400}?\btodas\s*:/);
  });

  it('⭐ 2b — PRUEBA NEGATIVA: el servicio NO separa por `budget_line_id IS NULL`', () => {
    const s = leer(SERVICIO);
    // El atajo que la primera especificación invitaba. Medido: daría 312 reales, el doble.
    expect(sinComentarios(s)).not.toMatch(/budget_line_id\s+is\s+null/i);
    // Y sí usa el resolvedor de dos saltos, no una segunda definición de "es de prueba".
    expect(s).toContain('obligacionNoEsDePruebaSql');
  });

  it('⭐ 2c — el resolvedor compartido sigue haciendo el salto de DOS tablas', () => {
    const sql = obligacionNoEsDePruebaSql();
    expect(sql).toContain('budget.budget_lines');
    expect(sql).toContain('budget.budgets');
    expect(sql).toContain('is_test');
    // NOT EXISTS y no JOIN: un JOIN se comería las obligaciones SIN partida, que no son de prueba.
    expect(sql).toContain('NOT EXISTS');
  });

  // ── 3 · Lo no medible llega null CON motivo, nunca 0 ──────────────────
  it('⛔ 3 — cada bloque es `T | null` y tiene su `*_error`', () => {
    const c = leer(CONTRATO);
    for (const b of ['motor', 'obligaciones', 'ledger']) {
      expect(c).toMatch(new RegExp(`${b}_error:\\s*string \\| null`));
    }
    expect(c).toMatch(/motor:\s*MotorPresupuesto \| null/);
    expect(c).toMatch(/obligaciones:\s*ObligacionesResumen \| null/);
    expect(c).toMatch(/ejercicios_error:\s*string \| null/);
  });

  it('⭐ 3b — `cadencia` admite null y NO se escribe a mano en el servicio', () => {
    expect(leer(CONTRATO)).toMatch(/cadencia:\s*string \| null/);
    const s = leer(SERVICIO);
    expect(s).toContain('derivarCadencia');
    // Un literal de horario sería una afirmación que nadie vuelve a medir.
    expect(s).not.toMatch(/cadencia:\s*'[^']*\d{2}:\d{2}/);
  });

  // ── 4 · Un motor con errores NO puede reportarse como sano ────────────
  it('⛔ 4 — el conteo de errores viaja SIEMPRE, no sólo cuando conviene', () => {
    const c = leer(CONTRATO);
    expect(c).toMatch(/\bok:\s*number/);
    expect(c).toMatch(/\berror:\s*number/);
    expect(c).toMatch(/ultima_error:\s*string \| null/);
    // Sin `error` obligatorio, un bloque con 7 fallas se renderiza igual que uno sano.
    expect(c).not.toMatch(/error\?:\s*number/);
  });

  // ── 5 · Cada bloque declara SU universo ───────────────────────────────
  it('⭐ 5 — el universo va por bloque, no en un copete global', () => {
    const c = leer(CONTRATO);
    expect(c).toContain('interface BloqueUniverso');
    expect(c).toMatch(/MotorPresupuesto extends BloqueUniverso/);
    expect(c).toMatch(/ObligacionesResumen extends BloqueUniverso/);
    // El ledger lo lleva inline, pero lo lleva.
    expect(c).toMatch(/ledger:\s*\{\s*universo: string; as_of: string; fuente: string;/);
  });

  // ── 6 · Los días sin firmar son EXACTOS, no un proxy ──────────────────
  it('⭐ 6 — `dias_sin_firmar` reemplazó al proxy, y declara su límite', () => {
    const c = leer(CONTRATO);
    expect(c).toContain('dias_sin_firmar: number | null');
    expect(sinComentarios(c)).not.toContain('dias_en_borrador');
    expect(sinComentarios(c)).not.toContain('dias_en_borrador_es_proxy');
    // El límite real: no hay historial de estado, así que una reversión contaría mal.
    expect(c).toContain('no hay historial de estado');
    // Y el servicio lo calcula desde el alta con guarda de firma, no desde `updated_at`.
    const s = leer(SERVICIO);
    expect(s).toContain("b.authorized_at != null");
    expect(s).toContain("b.created_at");
  });

  // ── 7 · Los huecos se declaran con nombre y peso ──────────────────────
  it('⭐ 7 — los huecos llevan nombre, motivo y peso; `peso` admite null', () => {
    const c = leer(CONTRATO);
    expect(c).toMatch(/nombre:\s*string;\s*porque:\s*string;\s*peso:\s*string \| null;/);
  });
});
