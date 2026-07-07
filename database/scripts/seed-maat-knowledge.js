/* eslint-disable no-console */
/**
 * MAAT.0 — Seed de `finance.knowledge` desde el modelo contable Kepler descifrado
 * (docs/IMPLEMENTACION/KEPLER_CONTABILIDAD_MODELO.md, 2026-07-06).
 *
 * Estas entradas son el "libro de texto" que Maat inyecta a su system prompt:
 * definiciones del schema ofuscado, hechos verificados con cifras, reglas de
 * negocio para no mal-leer los números, e issues conocidos (para no re-descubrir
 * los bugs de captura en cada conversación).
 *
 * Idempotente: UPSERT por (tenant_id, kind, title). Re-run actualiza el body.
 *
 *   node database/scripts/seed-maat-knowledge.js            # dry-run
 *   node database/scripts/seed-maat-knowledge.js --apply    # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

/** @type {{kind:'definicion'|'hecho'|'regla_negocio'|'issue_conocido', title:string, body:string}[]} */
const ENTRIES = [
  // ── Definiciones (el schema ofuscado y los mecanismos) ──────────────────
  {
    kind: 'definicion',
    title: 'Pólizas contables: tablas kdc2YYMM',
    body: 'Una tabla por mes (kdc22607 = jul-2026). Columnas: c2=fecha (puede venir retro-fechada), c3=cuenta (mayor "511" o subcuenta "601-001"; mayor = split_part(c3,\'-\',1)), c4=C cargo / A abono, c5=IMPORTE (usar c5, c9 llega en 0), c6=concepto/beneficiario (texto libre, sucio), c10=línea, c14=sucursal, doc_tipo = c15||c16||lpad(c17,2)||lpad(c18,2) (ej. XA2001), c19=folio (vacío en pólizas de resumen/diario). Regla de oro: filtrar c5>0 — hay cientos de líneas $0 de cancelaciones que inflan conteos.',
  },
  {
    kind: 'definicion',
    title: 'Documentos fuente: kdm1 (cabecera) + kdm2 (líneas)',
    body: 'Llave que une póliza↔documento↔líneas: (sucursal, doc_tipo, folio). kdm1: c6=folio, c9=fecha contable, c18=fecha doc, c14=IVA, c16=total, c22=RFC, c24=concepto, c31=clase, c32=beneficiario, c48=área, c67=usuario que capturó. kdm2 (líneas): c8=SKU, c9=cantidad, c10=nombre producto, c11=presentación, c12=costo unitario, c13=importe. Solo las COMPRAS (XA2001) traen líneas de producto; gastos (XA1001), pagos (XD2601) y solicitudes (XA1501) no.',
  },
  {
    kind: 'definicion',
    title: 'Las 7 familias de cuenta',
    body: 'Familia = primer dígito de la cuenta. 1=Activo (102 bancos, 107 anticipos, 114 inventario, 115 clientes, 116 traspasos, 122 IVA acreditable), 2=Pasivo (201 proveedores, 203 provisiones, 210 préstamos dirección), 4=Ingresos (401 ventas, 403 devoluciones), 5=Costos (509/516 inventario inicial/final, 511 compras, 513 descuentos, 515 traspaso interno), 6=Gastos operación (601 nómina, 609 dirección, 111 subcuentas), 7=Otros gastos/impuestos (702 financiero, 761 ISR, 762 SUA), 9=Presupuestos (999, muerta desde ene-2026).',
  },
  {
    kind: 'definicion',
    title: 'Ciclo de compra: tipos de documento y lineage',
    body: 'XA1501 solicitud → XA3001 cotización → XA3501 orden de compra → XA3701 recepción → XA2001 factura → XA4001 pago programado. Pagos con dinero real = XD2601/XD2501; XD5501 = descuento sobre compra (NO es pago). El lineage entre etapas vive en kdm1.c39 (puntero al folio del documento siguiente/relacionado) y se puede correlacionar además por beneficiario+total idénticos entre etapas (descifrado 2026-07-06).',
  },
  {
    kind: 'definicion',
    title: 'COGS: sistema de inventarios periódico',
    body: 'Costo de ventas = 509 inv.inicial + 511 compras − 513 descuentos − 512 devoluciones + 514 gastos de compra + 517 insumos − 516 inv.final. El conteo físico (516) es el plug → el margen de UN mes es volátil por diseño (se mueve con ΔInventario, no con la operación): no juzgar el margen mensual aislado. 516[mes M] = 509[mes M+1] exacto. Los traspasos 515/116 quedan FUERA del COGS (netean ~$0); sumarlos duplicaría ~$34-40M/mes.',
  },
  {
    kind: 'definicion',
    title: 'Cuenta 999 PRESUPUESTOS: el pivote del P&L 2025',
    body: 'No es control presupuestal: fue el pivote de TODO el P&L 2025 en modo resumen mensual (cargaba contra ventas 401, abonaba contra compras 511 y gastos 6xx; pólizas de diario sin folio). Murió en ene-2026 al arrancar la captura documento-a-documento. Quedó con saldo acreedor residual ~$27.4M que nadie cerró contra resultados.',
  },
  {
    kind: 'definicion',
    title: 'Ventas: el canal vive en c6, no en la subcuenta',
    body: 'Todo el detalle de ventas 2026 cae en 401-002 sin importar canal → las subcuentas de 401 NO sirven para mezcla de canal. El canal real está en el concepto c6: P.V. (punto de venta), TLMKT (televenta), R.D., R.V. (rutas). La venta es 100% a crédito contable (C 115 / A 401, doc UD1301; NO existe póliza de contado) y la cobranza entra por UA0501 (C 102 / A 115). Las pólizas de venta NO traen línea de IVA (C 115 = A 401 exacto).',
  },

  // ── Hechos verificados (cifras ancla) ───────────────────────────────────
  {
    kind: 'hecho',
    title: 'Cutover contable: dic-2025 / ene-2026',
    body: 'La contabilidad documento-a-documento arranca: compras (511) desde dic-2025, gastos (6xx/7xx) y ventas (401) desde ene-2026. Antes TODO era resumen mensual contra 999. Consecuencias: una serie de "12 meses" = ~7 meses reales + ~5 de estimados; dic-2025 está DOBLE en varias cuentas (convivieron presupuesto y facturas); 2025 vs 2026 no son comparables; nov/dic-2025 se postearon el día 7 del propio mes (forecast, no real).',
  },
  {
    kind: 'hecho',
    title: 'Venta real 12m ≈ $671M (no $726M)',
    body: 'Los abonos brutos a 401 suman ~$726M, pero incluyen $54.67M de una reclasificación interna ("VENTAS ABRIL 26", vive en kdc22603, C 401-002 ↔ A 401-001/003/004, neto $0). Venta real ≈ $671M. Además ago-dic 2025 ($339M) son pólizas resumen contra 999. Los "$55M de cargos a 401" NO son devoluciones (son la reclass); devoluciones reales = 403 vía UA2501, solo $668k/12m.',
  },
  {
    kind: 'hecho',
    title: 'Compras 511 = $685.6M en 12m (el dato $1,369M era falso)',
    body: 'Dos capas: presupuesto (C 511 / A 999) ago-dic 2025 = $313.2M + factura (C 511 / A 201) desde dic-2025 = $379.8M. El dato viejo "$1,369M" estaba ~2× inflado por sumar las 4 etapas del ciclo XA20/35/37/40. En dic-2025 conviven presupuesto $75.3M y facturas $63.1M (~$63M duplicado si se suman).',
  },
  {
    kind: 'hecho',
    title: 'Margen bruto real 2026 ≈ 17-24% (banda esperada 18-28%)',
    body: 'Meses limpios: ene 21.8%, feb 17.0%, mar 24.0% (promedio ~23%, sano para distribuidora de dulces). Abril 4.6% es outlier (el conteo físico bajó $5.5M). Agregado ene-abr = 16.8%. 2025 NO es margen real (venta y compra ambos presupuesto). Desde may-2026 el COGS no es computable (cierre de inventario cortado). dic-2025 (34.3%) está inflado.',
  },
  {
    kind: 'hecho',
    title: 'Cobranza cuadra al peso; DSO ≈ 7-8 días',
    body: 'UA0501 abona a 115 exactamente lo que carga a 102: $314,845,460.38 en 7 meses, sin fugas. La cartera se estabiliza en ~$13.3M. El "+$14.6M de crecimiento de cartera" es engañoso: +$18.5M es solo el arranque de enero; feb-jul drena −$3.9M. Ratio C115/A401 = 1.000087 → ventas posteadas SIN IVA trasladado (con IVA sería 1.16) — validar con contabilidad dónde se reconoce.',
  },
  {
    kind: 'hecho',
    title: 'Proveedores 201: la deuda NO crece en régimen',
    body: 'El "+$66M de deuda creciendo" es artefacto de captura: dic-2025 cargó el backlog de facturas sin sus pagos históricos. En régimen 2026 la deuda BAJA (−$14.6M ene-jun). El ciclo de compra cierra al 99.7%: compra (C511/A201) → pago (C201/A102, 94.1%) + descuento (A513, 5.0%). Ojo: NOMINA opera como "proveedor" dentro de 201. La cuenta es plana: el proveedor solo está en c6 (con typos que duplican).',
  },
  {
    kind: 'hecho',
    title: 'Bancos: 17 cuentas comparten el código 102',
    body: 'Las ~17 cuentas bancarias usan el mismo código contable 102; el banco va en c7 como texto libre (a veces es una fecha) → imposible auditar por banco desde la contabilidad. Cobranza entra por UA0501 (C 102 / A 115); pagos a proveedores salen por XD2601/XD2501 (C 201 / A 102).',
  },

  // ── Reglas de negocio (cómo leer los números sin equivocarse) ───────────
  {
    kind: 'regla_negocio',
    title: 'Feed de compras: una capa por mes + exclusiones',
    body: 'Regla implementada en import-expenses-polizas.js: (Fix#1) elegir UNA capa por mes — factura cuando det ≥ 50% del presupuesto (dic-2025+), presupuesto en meses sin captura real (ago-nov 2025, queda como ESTIMADO con folio vacío); (Fix#B) excluir "compras" de sucursal con beneficiario interno (SUCURSAL%, %CEDIS%, %CENTRO DE DIST%, %TRASPASO%) — son traspasos internos, no compra externa (~$28.6M de doble conteo); dropear líneas $0 (BAJA/canceladas).',
  },
  {
    kind: 'regla_negocio',
    title: 'Pagos reales = XD2601 + XD2501 (XD5501 es descuento)',
    body: 'Solo XD2601 y XD2501 son pagos con dinero. XD5501 es descuento sobre compras (se registra en el asiento de PAGO: C 201 / A 513). Sumar TODOS los cargos de 201 como "egresos pagados" sobreestima ~6%.',
  },
  {
    kind: 'regla_negocio',
    title: 'Carga social / IMSS: NO usar la familia 7',
    body: 'La cuenta 762 SUA solo captura ~12% del costo IMSS; el 88% vive en 601 (nómina, 54% de la familia 6 = $38M/año). Usar familia 7 como proxy de carga social subestima brutalmente. Además los impuestos se capturan en ráfagas retro-fechadas (SUA: 30 líneas en un día) → las series mensuales de 7xx no reflejan devengo.',
  },
  {
    kind: 'regla_negocio',
    title: 'Traspasos 515/116 no son compra ni venta',
    body: 'El par 515 (ajuste traspaso interno) ↔ 116 (traspasos) es movimiento de mercancía CEDIS↔sucursal: neteaba $0 exacto ene-mar 2026 y mueve ~$210M/año (~30% del volumen de venta). NO sumarlo a compras, ventas ni COGS — duplicaría. Descuadra desde abr-2026 (−$1.9M en may), vigilarlo.',
  },
  {
    kind: 'regla_negocio',
    title: 'Catálogo kdco: JOIN con cuidado',
    body: 'kdco (c3=código, c2=nombre) NO es llave única: códigos duplicados con nombres distintos (115, 761, 511, 401-00x, 760, 702-002), cuentas fantasma sin fila (107, 122-002, 203, 205, 206, 403, 512, mayores 401/702/517) y nombres incoherentes (140). En familia 6 es un catálogo de CONCEPTOS (N conceptos → 1 subcuenta): un JOIN por c3 duplica filas — usar min(c2) o el concepto de la póliza (c6).',
  },
  {
    kind: 'regla_negocio',
    title: 'Series temporales: separar estimado vs real',
    body: 'Cualquier análisis de tendencia debe partir en dic-2025/ene-2026 (cutover). Comparar 2025 vs 2026 es peras vs manzanas (resumen presupuestal vs documento). Las filas con folio vacío en el feed de egresos son la capa ESTIMADO. Fechas c2 pueden venir retro-fechadas: la fecha de captura real es c68/c69 de kdm1.',
  },

  // ── Issues conocidos (los bugs que Maat no debe re-descubrir) ───────────
  {
    kind: 'issue_conocido',
    title: 'Bug IVA XD5501 (iva_bug): partida doble rota ene-may 2026',
    body: 'Las pólizas de descuento sobre compras XD5501 postean un abono huérfano a 122-001 IVA ACREDITABLE sin contrapartida de cargo (406/447 pólizas). Efecto: partida doble descuadra −$996k acumulado ene-may 2026 y el IVA acreditable queda subestimado ~$996k → riesgo en conciliación fiscal. Se autocorrige en junio. 2025 cuadraba a centavo. Navegable en /finanzas/egresos → Hallazgos (tipo iva_bug, 449 docs).',
  },
  {
    kind: 'issue_conocido',
    title: 'Provisiones 203 nunca descargadas ($13.6M)',
    body: 'La cuenta 203 (fantasma, sin fila en kdco) acumula $13.6M de provisiones (nómina, IMSS/SUA, SAT, Banorte) con 0 cargos — nunca se descargan. Los pagos de nómina salen por 201 → descuadre estructural ~$2.2-2.6M/mes desde may-2026. Hallazgo tipo prov_203 ($14.07M en findings).',
  },
  {
    kind: 'issue_conocido',
    title: 'Anticipos 107 sin aplicar ($11.4M)',
    body: 'La cuenta 107 (fantasma) tiene $11.4M de anticipos a proveedores (C 107 / A 102, doc XD6001) que JAMÁS se aplican (0 abonos) → posible doble conteo del flujo a proveedores (anticipo + pago de factura completa). Hallazgo tipo anticipo_107.',
  },
  {
    kind: 'issue_conocido',
    title: 'Cierre de inventario cortado desde may-2026',
    body: 'El asiento mensual de apertura/cierre (509/516 contra 114, doc 0000) se cortó en abril-2026. Sin 516 no hay COGS ni margen real desde mayo. Cualquier margen reportado may-2026+ es no computable en libros hasta que contabilidad reponga los cierres.',
  },
  {
    kind: 'issue_conocido',
    title: 'IVA capitalizado en 511 ene-mar 2026 ($16.45M)',
    body: 'Pólizas de diario "IMPUESTO EN COMPRAS" cargaron $16.45M de IVA acreditable DENTRO de la cuenta 511 (costo) contra 122 en ene-mar 2026 → costo inflado esos meses (el margen de enero caería de 21.8% a ~13% si se incluye). El feed de egresos las excluye (efecto colateral verificado del Fix#1).',
  },
  {
    kind: 'issue_conocido',
    title: 'Gastos de dirección y partes relacionadas (609/702)',
    body: 'La 609 ($2.4M/año) mezcla tarjetas y compras personales de directores + "préstamos personales GLG/LFLG" registrados como GASTO (no como cuenta por cobrar a socios) — fiscalmente cuestionable. En 702: $1.54M de "intereses en efectivo" pagados a la dirección (parte relacionada) = 39% del gasto financiero. La 210 "FACTORAJE" en realidad son préstamos de la dirección + crédito Banorte.',
  },
  {
    kind: 'issue_conocido',
    title: 'Activo fijo sin depreciación',
    body: 'La 150 no registra depreciación en 12 meses; vehículos usados se compran directo a la cuenta; hay un abono de $967k sin documento; CAPEX (ej. servidor $135k) cargado a gasto. El balance no refleja el valor real del activo fijo ni el gasto su consumo.',
  },
];

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== MAAT.0 seed finance.knowledge (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${ENTRIES.length} entradas ===\n`);
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    let inserted = 0, updated = 0;
    for (const e of ENTRIES) {
      const res = await db.query(
        `INSERT INTO finance.knowledge (tenant_id, kind, title, body, source, created_by)
         VALUES ($1, $2, $3, $4, 'seed', 'seed-maat-knowledge')
         ON CONFLICT (tenant_id, kind, title)
         DO UPDATE SET body = EXCLUDED.body, status = 'active', updated_at = now()
         RETURNING (xmax = 0) AS is_insert`,
        [M, e.kind, e.title, e.body],
      );
      if (res.rows[0].is_insert) inserted++; else updated++;
    }

    const byKind = await db.query(
      `SELECT kind, COUNT(*)::int n FROM finance.knowledge WHERE tenant_id=$1 AND status='active' GROUP BY kind ORDER BY kind`, [M]);
    console.table(byKind.rows);
    console.log(`Insertadas: ${inserted} · actualizadas: ${updated}`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }
    await db.query('COMMIT');
    console.log('\n[APPLY] COMMIT.');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
