import { readFileSync } from 'fs';
import { join } from 'path';
import { ReceivingAuditorService } from './receiving-auditor.service';
import { resolverPerfil, type PoliticaCaducidad } from './receiving-expiry-profile';
import { motivoValido, renglonesSinFecha, type RenglonParaFecha } from './receiving-expiry-gate';
import { CLAIMABLE_KINDS, CLAIM_KINDS, RULES_CADUCIDAD_CORTA, claimDedupKeyCaptura } from './receiving-claim';

/**
 * Anexo CE de la Fase WMS — **toda entrada con caducidad**.
 *
 * Lo que se cuida acá se puede romper sin base: el semáforo, la cascada de la política y el candado
 * de cierre. El comportamiento contra una base real lo ejerce `database/tests/test-newdb-receiving-auditor.js`.
 */

const verdict = ReceivingAuditorService.computeVerdict;
const base = { existingMinExpiry: null, minShelfLifeDays: null, allowOlder: false };

describe('[CE.1.2] una fecha ya vencida nunca entra en verde', () => {
  // Las tres capturas reales que entraron en verde en prod (2026-11-11), sin ninguna política.
  it.each([
    ['chiles, jul-2023', '2023-07-29', -1166],
    ['limpiador, feb-2024', '2024-02-28', -951],
    ['sal, jun-2026', '2026-06-03', -126],
  ])('%s → rojo expired', (_n, fecha, dias) => {
    expect(verdict({ ...base, confirmedExpiry: fecha, daysOfLife: dias })).toEqual({ verdict: 'red', rule_broken: 'expired' });
  });

  it('vencido gana aunque la política permita lo más viejo que lo existente', () => {
    const r = verdict({ confirmedExpiry: '2026-01-01', daysOfLife: -10, existingMinExpiry: '2027-01-01', minShelfLifeDays: null, allowOlder: true });
    expect(r.rule_broken).toBe('expired');
  });

  it('vence hoy (0 días) no es vencido', () => {
    expect(verdict({ ...base, confirmedExpiry: '2026-11-11', daysOfLife: 0 }).rule_broken).not.toBe('expired');
  });
});

describe('[CE.1.3] una fecha que no cabe en la vida útil se sospecha (amarillo, nunca rojo)', () => {
  it('180 días de vida y la fecha a 3 años → amarillo beyond_shelf_life', () => {
    expect(verdict({ ...base, confirmedExpiry: '2029-12-12', daysOfLife: 1127, shelfLifeDays: 180 })).toEqual({
      verdict: 'yellow',
      rule_broken: 'beyond_shelf_life',
    });
  });
  it('dentro de 1.5× la vida útil → verde', () => {
    expect(verdict({ ...base, confirmedExpiry: '2027-05-01', daysOfLife: 170, shelfLifeDays: 180 }).verdict).toBe('green');
  });
  it('sin vida útil conocida no se sospecha', () => {
    expect(verdict({ ...base, confirmedExpiry: '2029-12-12', daysOfLife: 1127 }).verdict).toBe('green');
  });
});

describe('[CE.1.1] sin fecha', () => {
  it('producto sin decir → verde (como antes)', () => {
    expect(verdict({ ...base, confirmedExpiry: null, daysOfLife: null }).verdict).toBe('green');
  });
  it('el catálogo dice que caduca → amarillo no_expiry_on_perishable', () => {
    expect(verdict({ ...base, confirmedExpiry: null, daysOfLife: null, tracksExpiry: true }).rule_broken).toBe('no_expiry_on_perishable');
  });
  it('el catálogo dice que no caduca → verde', () => {
    expect(verdict({ ...base, confirmedExpiry: null, daysOfLife: null, tracksExpiry: false }).verdict).toBe('green');
  });
});

describe('[WMS-REC] reglas previas siguen igual', () => {
  it('bajo la mínima → rojo', () => {
    expect(verdict({ ...base, confirmedExpiry: '2027-01-01', daysOfLife: 20, minShelfLifeDays: 30 }).rule_broken).toBe('min_shelf_life');
  });
  it('más viejo que lo existente → rojo', () => {
    expect(verdict({ ...base, confirmedExpiry: '2027-01-01', daysOfLife: 400, existingMinExpiry: '2027-06-01' }).rule_broken).toBe('older_than_existing');
  });
  it('cerca de la mínima → amarillo', () => {
    expect(verdict({ ...base, confirmedExpiry: '2027-01-01', daysOfLife: 40, minShelfLifeDays: 30 }).rule_broken).toBe('near_min_shelf_life');
  });
});

const pol = (p: Partial<PoliticaCaducidad>): PoliticaCaducidad => ({
  product_id: null,
  category: null,
  supplier_code: null,
  min_shelf_life_days: null,
  allow_older_than_existing: false,
  tracks_expiry: null,
  shelf_life_days: null,
  ...p,
});

describe('[CE.1.1] cascada producto → departamento → proveedor, campo por campo', () => {
  it('sin nada: no se sabe si caduca y la vida útil sale de Kepler', () => {
    const r = resolverPerfil({ producto: null, departamento: null, proveedor: null, department: 'DULCES', diasKepler: 180 });
    expect(r).toMatchObject({ tracks_expiry: null, shelf_life_days: 180, shelf_life_source: 'kepler', fuente: 'ninguna' });
  });
  it('el departamento dice que no caduca', () => {
    const r = resolverPerfil({
      producto: null,
      departamento: pol({ category: 'DESECHABLES', tracks_expiry: false }),
      proveedor: null,
      department: 'DESECHABLES',
      diasKepler: null,
    });
    expect(r.tracks_expiry).toBe(false);
    expect(r.fuente).toBe('departamento');
  });
  it('una política de producto que sólo fija la mínima NO borra el «no caduca» del departamento', () => {
    const r = resolverPerfil({
      producto: pol({ product_id: 'p', min_shelf_life_days: 30 }),
      departamento: pol({ category: 'DESECHABLES', tracks_expiry: false }),
      proveedor: null,
      department: 'DESECHABLES',
      diasKepler: null,
    });
    expect(r).toMatchObject({ tracks_expiry: false, min_shelf_life_days: 30, fuente: 'producto' });
  });
  it('el producto corrige al departamento («este sí caduca»)', () => {
    const r = resolverPerfil({
      producto: pol({ product_id: 'p', tracks_expiry: true }),
      departamento: pol({ category: 'ARTICULOS DE FIESTAS', tracks_expiry: false }),
      proveedor: null,
      department: 'ARTICULOS DE FIESTAS',
      diasKepler: null,
    });
    expect(r.tracks_expiry).toBe(true);
  });
  it('la vida útil de la política gana a Kepler; 0 en Kepler es «sin dato»', () => {
    expect(resolverPerfil({ producto: pol({ product_id: 'p', shelf_life_days: 90 }), departamento: null, proveedor: null, department: null, diasKepler: 180 }))
      .toMatchObject({ shelf_life_days: 90, shelf_life_source: 'politica' });
    expect(resolverPerfil({ producto: null, departamento: null, proveedor: null, department: null, diasKepler: 0 }).shelf_life_days).toBeNull();
  });
});

const r = (p: Partial<RenglonParaFecha>): RenglonParaFecha => ({
  line_id: 'l',
  product_id: 'p',
  sku: '1',
  product_name: 'X',
  received_qty: 10,
  declared_qty: 0,
  tracks_expiry: null,
  ...p,
});

describe('[CE.2.1] el vale no cierra con mercancía sin fecha', () => {
  it('recibido sin declarar → falta', () => {
    expect(renglonesSinFecha([r({})])).toEqual([
      { line_id: 'l', sku: '1', product_name: 'X', received_qty: 10, declared_qty: 0, missing_qty: 10 },
    ]);
  });
  it('declarado parcial → falta lo que queda', () => {
    expect(renglonesSinFecha([r({ declared_qty: 4 })])[0].missing_qty).toBe(6);
  });
  it('declarado completo, no recibido, sin catálogo o «no caduca» → no falta', () => {
    expect(
      renglonesSinFecha([
        r({ declared_qty: 10 }),
        r({ received_qty: 0 }),
        r({ product_id: null }),
        r({ tracks_expiry: false }),
      ]),
    ).toEqual([]);
  });
  it('el motivo para cerrar sin fecha es texto real', () => {
    expect(motivoValido('   ')).toBeNull();
    expect(motivoValido('abc')).toBeNull();
    expect(motivoValido(' camión sin etiqueta legible ')).toBe('camión sin etiqueta legible');
  });
});

describe('[CE.2.1] el candado está en el cierre, antes de dar de alta', () => {
  const SESION = readFileSync(join(__dirname, 'receiving-session.service.ts'), 'utf8');
  const cierre = SESION.slice(SESION.indexOf('async close('), SESION.indexOf('private async renglonesParaFecha('));
  it('el 409 expiry_missing va antes del alta de stock', () => {
    const candado = cierre.indexOf("code: 'expiry_missing'");
    const alta = cierre.indexOf('recordMovementInTx');
    expect(candado).toBeGreaterThan(0);
    expect(alta).toBeGreaterThan(candado);
  });
  it('declarado = accepted + authorized (lo retenido o rechazado no fecha nada)', () => {
    expect(SESION).toMatch(/c\.status IN \('accepted', 'authorized'\)/);
  });
});

describe('[CE.2.4] el rojo rechazado se le reclama a quien lo mandó', () => {
  const AUDITOR = readFileSync(join(__dirname, 'receiving-auditor.service.ts'), 'utf8');
  const CLAIMS = readFileSync(join(__dirname, 'receiving-claims.service.ts'), 'utf8');
  const MIG = readFileSync(
    join(__dirname, '../../../../../database/migrations-newdb/20261111132543_ce_caducidad_en_entrada.js'),
    'utf8',
  );
  it('sólo por reglas que son culpa del origen; la llave es por captura', () => {
    expect([...RULES_CADUCIDAD_CORTA].sort()).toEqual(['expired', 'min_shelf_life', 'older_than_existing']);
    expect(claimDedupKeyCaptura('abc')).toBe('recv-capture:abc');
    expect(CLAIM_KINDS).toContain('caducidad_corta');
    expect(CLAIMABLE_KINDS).not.toContain('caducidad_corta'); // no es discrepancia de renglón
  });
  it('el reclamo va en la MISMA transacción que el rechazo, y sólo si el rechazo ganó', () => {
    const reject = AUDITOR.slice(AUDITOR.indexOf('async reject('), AUDITOR.indexOf('async listCaptures('));
    const tx = reject.slice(reject.indexOf('this.tk.run('));
    expect(tx.indexOf("status: 'rejected'")).toBeGreaterThan(0);
    expect(tx).toMatch(/if \(n\) await this\.claims\.raiseForRejectedCaptureInTx\(trx,/);
  });
  it('la migración acepta el tipo nuevo en el CHECK', () => {
    expect(MIG).toMatch(/CHECK \(kind IN \('faltante','dañado','producto_incorrecto','caducidad_corta'\)\)/);
  });
  it('el contexto del reclamo es UNO para los dos caminos', () => {
    expect((CLAIMS.match(/this\.contextoDeReclamoTx\(trx,/g) || []).length).toBe(2);
  });
});

describe('[CE.2.3] el traspaso propone la fecha del origen', () => {
  const TE = readFileSync(join(__dirname, 'receiving-transfer-expiry.ts'), 'utf8');
  it('propone lo que el origen despacharía primero: fechado, con existencia, no vencido, el más próximo', () => {
    expect(TE).toMatch(/sl\.quantity > 0 AND sl\.expiry_date IS NOT NULL/);
    expect(TE).toMatch(/sl\.expiry_date >= \(now\(\) AT TIME ZONE 'America\/Mexico_City'\)::date/);
    expect(TE).toMatch(/ORDER BY sl\.product_id, sl\.expiry_date ASC/);
  });
  it('nunca escribe: sólo lee stock_lots', () => {
    expect(TE).not.toMatch(/\.insert\(|\.update\(|INSERT INTO|UPDATE /);
  });
});
