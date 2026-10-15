import knex from 'knex';
import { CashCutService } from './cash-cut.service';

/**
 * ⭐⭐ `[CG.160]` — EL CONTEO Y EL CIERRE MEDÍAN UNIVERSOS DISTINTOS.
 *
 * `contar()`, `recontar()` y `saldo()` leen por `movimientosSueltos()`, que aplica
 * `aplicarAlcanceCaja`: el cajón de oficinas es UNO y ve todas las plazas (`[CG.98]`, medido —
 * las nóminas de cuatro sucursales salen de la misma bóveda). `cerrar()` ataba y sumaba
 * **sólo la `00`**.
 *
 * Costó, medido en prod el 2026-10-14 sobre `CC-2026-00001` (12-oct) al centavo:
 *
 *     gastos de la 00 ............. $18,973.00
 *     gastos de 01/05/06/07/08 .... $39,737.05   <- quedaban fuera del cierre
 *
 *     esperado que iba a firmar ..  $43,139.50  ->  −$39,486.00  faltante INVENTADO
 *     esperado real ..............   $3,402.45  ->     +$251.05  sobrante, cuadrable
 *
 * ⛔ **Esto NO es un doble de knex.** Se arma el query builder REAL (cliente `pg`, sin conexión)
 * y se compara el SQL que produce. Un doble no ejecuta SQL y se pondría verde con el defecto
 * puesto — que es justo cómo este defecto sobrevivió a 1,296 pruebas en verde.
 *
 * ⚠️ Afirma la PROPIEDAD («los dos caminos construyen el mismo universo»), no las cifras: un
 * literal `$39,737.05` envejece con los datos y además pasaría igual si alguien reintrodujera el
 * defecto de un modo que hoy dé casualmente lo mismo.
 */
describe('[CG.160] el cierre ata EXACTAMENTE lo que el conteo suma', () => {
  const db = knex({ client: 'pg' });
  const T = '00000000-0000-0000-0000-00000000d01c';
  const DIA = '2026-10-12';
  // `sueltosDe` no toca las dependencias inyectadas: es puro armado de query.
  const svc = new CashCutService(null as never, null as never);
  const universo = (sucursal: string, dia: string | null) =>
    (svc as unknown as {
      sueltosDe: (t: unknown, tid: string, s: string, d: string | null) => { toString(): string };
    }).sueltosDe(db, T, sucursal, dia).toString();

  afterAll(async () => { await db.destroy(); });

  it('⭐ la caja de OFICINAS no se acota por sucursal: el cajón físico es UNO', () => {
    const sql = universo('00', DIA);
    // Si vuelve el `sucursal = '00'`, el cierre deja fuera la nómina que otras plazas pagaron
    // desde este mismo cajón y firma un faltante que no existe.
    expect(sql).not.toMatch(/"sucursal"\s*=/);
    expect(sql).toContain(`"fecha" = '${DIA}'`);
    expect(sql).toContain('"corte_id" is null');
    expect(sql).toContain('"deleted_at" is null');
  });

  it('⛔ [negativa] cualquier OTRA plaza SÍ queda acotada a lo suyo', () => {
    // La prueba que da sentido a la de arriba: si esto también saliera sin filtro, el arreglo
    // habría mezclado cajones en vez de unir el que es uno solo.
    expect(universo('06', DIA)).toMatch(/"sucursal"\s*=\s*'06'/);
  });

  it('⛔ [negativa] sin jornada NO se filtra por fecha — y entonces barre otras jornadas', () => {
    // `[CG.115]`: el `dia` nulo existe (un corte sin fecha), y lo que hace es barrer todo lo
    // suelto. Se afirma explícitamente para que nadie lo lea como «siempre acota por día».
    expect(universo('00', null)).not.toContain('"fecha" =');
  });

  /*
   * ⛔ `[CGP-L.11]` Acá había una cuarta prueba que comparaba `universo('00')` CONSIGO MISMA (T4 del
   * plan): no podía fallar nunca. Medido el 2026-10-15 devolviendo `cerrar()` al filtro viejo
   * (`.where('sucursal', c.sucursal)`): las cuatro de este archivo siguieron verdes.
   *
   * Que `cerrar()` ate el MISMO universo que `contar()` suma no se ve armando SQL: se ve ejecutando.
   * El candado vive contra la base, en `cash-cut.servicio-real.spec.ts` («el cajón de la 00 ata y
   * suma lo que otras plazas pagaron desde él»), y corre en el job `caja-db` del CI. Con esa misma
   * mutación se pone en ROJO (ata 1 movimiento en vez de 2 y el esperado deja de ser 1,300).
   */
});
