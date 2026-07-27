# FASE CP — Conector ContPAQi (SoR contable externo)

> **Estado:** 🔨 DISEÑADO (planeación) — 2026-07-27 · **ADR:** ADR-035 (propuesto) · Sin código aún.
> **Tesis:** ContPAQi es el **system of record contable/fiscal**; la plataforma es el **system of engagement/inteligencia**. NO reinventamos la contabilidad (contabilidad electrónica / DIOT / estados financieros = commodity regulado, moving-target del SAT, cero diferenciación). Integramos: **pull** por lectura de DB (balanza + catálogo → Maat/CB) y **push** por importación de archivo (pólizas armadas por el motor, importadas por el contador). **Jamás escritura directa a la DB de ContPAQi.** Hereda ADR-016/028 (motor arma / humano aprueba-importa / LLM fuera del libro).
> **Pedido de Edgar:** "¿existe forma de conectarnos con ContPAQi? ¿algún valor agregado que podamos tomar? ¿es mejor hacer nuestro propio 'ContPAQi' o tratar de que haya un funcionamiento igual?" → respuesta: integrar, no construir; SoR externo + engagement propio.

---

## 0. La decisión (por qué integrar y no construir)

**Construir "nuestro ContPAQi"** = ser dueños de contabilidad electrónica (XML SAT: catálogo + balanza + pólizas con UUID), DIOT, estados financieros y libros auditables. Es superficie **regulada**, cambia con el SAT, y **no diferencia** el producto — es exactamente el núcleo que Maat ya decidió no tocar (ADR-028: "cero números del LLM", "nunca escribir a Kepler").

**El split correcto (el mismo que ya se aplica con Kepler):**

| Capa | Dueño | Qué hace |
|---|---|---|
| **System of Record contable** | ContPAQi (o Kepler) | El libro legal, compliance, timbrado fiscal |
| **System of Engagement** | La plataforma | Lee del SoR, agrega Maat + CB + analytics + UX, empuja artefactos estructurados (pólizas) de vuelta |

La plataforma **nunca** es el libro legal. Ya NO dependemos de ContPAQi para timbrado — se construyó emisión CFDI 4.0 propia vía SW SmarterWeb (Fase FE). Lo único que ContPAQi aporta y no tenemos: **la capa contable-fiscal formal que el contador y el SAT aceptan.**

## 1. Cómo se conecta (3 vías, de más segura a más profunda)

ContPAQi corre en Windows sobre base local: **Firebird** (`.FDB` en Contabilidad y ediciones básicas de Comercial) o **SQL Server** (Comercial Pro/Premium según versión). Encaja en el patrón de puentes on-prem ya operado (Wincaja por Jet/ODBC 32-bit, Kepler por Firebird/Postgres — ver [`../../reference`] memorias `project_fase_w_wincaja`, `reference_kepler_branch_databases`).

- **A) Importación por archivo (push — soportada oficialmente).** ContPAQi Contabilidad importa **pólizas** desde layout Excel/TXT y CFDI XML. Generamos pólizas desde eventos operativos y las empujamos. Cero reversa, cero riesgo, puerta bendecida por ContPAQi.
- **B) Lectura directa de la DB (pull).** Igual que Kepler/Wincaja: leer balanza, catálogo de cuentas, pólizas → alimentar Maat/CB. Read-only, no soportado formalmente pero dominado.
- **C) SDK COM (two-way).** ContPAQi publica SDK de Comercial y de Contabilidad (DLLs COM 32-bit, Windows) para crear/leer documentos y pólizas. Mismo puente 32-bit on-prem que Wincaja. Solo si el file-import no basta.

> Hay además una API cloud de ContPAQi, pero es limitada y no vale como base.

## 2. Valor agregado concreto que sí tomamos

- **Catálogo de cuentas + balanza** → mejor fuente que reconstruir desde Kepler (`analytics.ledger_monthly`, `expense_doc_chain` de Maat) y **crosswalk más limpio para CB** (reemplaza el mapeo "Kepler 102").
- **Contabilidad Electrónica (XML SAT), DIOT, estados financieros** → todo el compliance regulado, ya resuelto y mantenido por ellos.
- **Metadata CFDI** ya conciliada en ContPAQi → apoya materialidad / fiscal.

## 3. Arquitectura (puerto + SoR/SoE)

El conector se construye **como puerto** (patrón `libs/contracts/src/ports/*.port.ts` + binding `@Optional()` en `apps/api/src/composition/`, como `finance-findings-sink`):

- `CONTPAQI_LEDGER_PORT` — read: catálogo + balanza + pólizas.
- `CONTPAQI_POLIZA_SINK_PORT` — write: recibe pólizas armadas y produce el archivo de importación.

Nueva `libs/contpaqi` (`@megadulces/contpaqi`) — aislada del dominio finance salvo por contracts + composition root (frontera limpia, patrón `libs/whatsapp`). Multi-tenant: config por tenant (motor de DB, ruta, edición) → el conector se vuelve **activo de producto reusable** (la mayoría de las distribuidoras MX corren ContPAQi).

## 4. Schema previsto (`contpaqi.*`, RLS forzado, `tenant_id`)

| Tabla | Propósito |
|---|---|
| `contpaqi.sync_state` | idempotencia del pull (último corte por feed × tenant) |
| `contpaqi.account_map` | crosswalk cuenta ContPAQi ↔ categoría interna (para CB + Maat) |
| `contpaqi.poliza_exports` | pólizas generadas para importar (estado: armada / exportada / importada; HITL) |
| balanza | reusa `analytics.ledger_monthly` (misma forma que Maat ya consume) |

Migraciones idempotentes (`database/migrations-newdb/`), grants `app_runtime`, seeds del catálogo.

## 5. Sprints

### CP.0 — Cimientos + decode ✅ COMPLETADO 2026-07-27
- `libs/contpaqi` + esquema `contpaqi.*` (staging) + ADR-035 + este doc.
- **Conexión CONFIRMADA + decodificada:** ContPAQi sobre **SQL Server 2022** — servidor `SERVCONTABILIDA` (`192.168.0.35`), **instancia `COMPAC`**, puerto TCP dinámico (resolver por SQL Browser UDP 1434 — `options.instanceName='COMPAC'`, no hardcodear puerto). Driver **`mssql`** v12 (verificado conectando desde la LAN de feeds).
- **Credenciales:** login read-only `platform_ro` / `superoot` creado en la instancia (`db_datareader` en todas las DBs + `VIEW ANY DATABASE/DEFINITION`; `CHECK_POLICY=OFF`). Script versionado en `database/importers/contpaqi/00-create-readonly-login.sql` (pendiente de guardar).
- **Topología decodificada:** `GeneralesSQL` (sistema Contabilidad), **`ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ` = la Contabilidad real** (el mismo "Luis Francisco" de las cuentas bancarias de la Fase CB), `ctLFLG` = Nóminas (tablas `nom*`), `nomGenerales` = sistema Nóminas, `ADD_Catalogos`+`document_*`/`other_*` = ADD (repositorio CFDI XML/PDF). **No hay Comercial (`ad*`)** en este server.

**Esquema núcleo de `ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ` (ContPAQi Contabilidad, decodificado):**

| Tabla | Filas | Rol | Columnas clave |
|---|--:|---|---|
| `Cuentas` | 8,765 | Catálogo de cuentas | `Id`, `Codigo`, `Nombre`, `Tipo`, `EsBaja`, `CtaMayor`, `IdRubro`(→estados fin.), `IdAgrupadorSAT`(→cont. electrónica), `IdSegNeg`, `Afectable` |
| `Polizas` | 108,319 | Header de póliza | `Id`, `Ejercicio`(año), `Periodo`(1–14; 14=ajuste), `TipoPol`(1=Ingreso/2=Egreso/3=Diario), `Folio`, `Concepto`, `Fecha`, `Cargos`, `Abonos`, `Guid`(UUID), `tieneDoctoBancario` |
| `MovimientosPoliza` | 1,125,972 | Líneas (cargo/abono) | link por `Ejercicio+Periodo+TipoPol+Folio+NumMovto`; `IdCuenta`(→Cuentas.Id), `TipoMovto`(bit cargo/abono), `Importe`, `Referencia`, `Fecha`, `IdSegNeg`, `Guid`, `EsConciliado`(← útil para CB) |
| `SaldosCuentas` | 187,350 | Balanza pre-agregada | `IdCuenta`, `Ejercicio`, `Tipo`, `SaldoIni`, `Importes1..12`(movto mensual), `Importes13/14` |
| + | | Sinergia | `Bancos`/`Cheques`/`DocumentosBancarios`/`Egresos` (CB), `AsocCFDIs`(917k)/`DocumentosAdministrativos`(102k) (materialidad/fiscal), `AgrupadoresSAT`/`RubrosNIF` (cont. electrónica) |

- **Ventana de datos:** pólizas **2017-12-31 → 2026-07-31** (108,319 pólizas). Contabilidad viva multi-año.
- **Balanza directa:** `SaldosCuentas` ya trae el movimiento mensual columnar por cuenta → CP.1 lee esto (mucho más limpio que reconstruir desde Kepler `kdc2YYMM`).

### Hallazgos del decode profundo que calibran el plan (2026-07-27)

1. **Entidad única, DB única, 2018–2026.** `GeneralesSQL.ListaEmpresas` = 1 empresa (persona física **"LUIS FRANCISCO LOPEZ GUTIERREZ"**, módulo `CT`, RutaDatos localhost). RFC/RazonSocial en `Parametros`. Mapea al tenant `mega_dulces`. Multi-tenant/multi-empresa = diferido.
2. **⚠️ NO está segmentada por sucursal de forma confiable.** `SegmentosNegocio` SÍ lista las 14 sucursales (PADRE HIDALGO, MORELIA, 8 ESQ, MEGA DULCES, CEDIS, TELEMARKETING, ZAMORA, RD Reparto Directo, MARIANO JIMENEZ, MORELIA MADERO, RD CANINDO, DIRECCIÓN), pero en 2025-26 **~97.6% de los movimientos van con `IdSegNeg=0`** (212,765 sin segmento vs ~5,000 con). → **ContPAQi = verdad fiscal CONSOLIDADA (entidad), NO ledger por sucursal.** El detalle por sucursal se queda en Kepler. (Corrige el supuesto inicial.)
3. **Balanza limpia y reconciliable.** `SaldosCuentas`: `Ejercicio` es un **Id** (join a `Ejercicios.Id→año`; ids no contiguos 1,2,5,9,…), `Tipo` **1=saldo / 2=cargos / 3=abonos**, `Importes1..12` = movimiento por periodo. Validado: banco Santander `1020100000` ~$15M cargos/abonos mensuales → **cuadra en orden de magnitud con el workbook de la Fase CB.**
4. **Cuadre cargo/abono confirmado.** `MovimientosPoliza.TipoMovto` **false=CARGO / true=ABONO**; Σcargos ≈ Σabonos = $24,883M en 8 años (libro cuadrado).
5. **Cuentas de banco = crosswalk directo para CB.** Los bancos viven en `102xxxxxxx` con el número en el nombre (`1020100000 SANTANDER 65503932169`, `1020030000 BANAMEX 8301463`…). Y `Egresos`(3,191)/`Cheques`(1,107) son los **pagos reales** con `BeneficiarioPagador`, `Total`, `Referencia`, `IdPoliza`, `IdCuentaCheques`→banco, `tieneCFD`, `Guid`. ContPAQi **no usa su propia conciliación** (`EsConciliado` todo false/null) → nuestra Fase CB ES la capa de conciliación.
6. **Gastos analíticos por PROVEEDOR.** Las 6,101 cuentas `5xxxxxxxxx` son una subcuenta por proveedor (`5010000001 PRODUCTOS DE LECHE LA HACIENDA`…) → comparable con Kepler `expense_doc_chain` / GX egresos.
7. **CFDI nativo.** `DocumentosAdministrativos`(102k UUID) + `AsocCFDIs`(917k UUID↔movimiento) + `Proveedores`(RFC, retenciones) → materialidad/fiscal directo. Los XML/PDF viven en el ADD (`document_*`/`other_*`).
8. **Contabilidad electrónica / estados financieros:** `AgrupadoresSAT`(1,068) + `RubrosNIF`(326) mapean cada cuenta → CE del SAT y estados financieros. Las tablas de *emisión* (CE/DPIVA/EFOS/presupuestos/activos fijos/portal bancario) están **vacías** → ContPAQi genera esos exportes on-demand; nosotros solo leemos el ledger.

### CP.1 — Pull balanza CONSOLIDADA → `analytics.contpaqi_ledger_monthly` ✅ COMPLETADO 2026-07-27 (local)
- **Migración** `20260727120000_analytics_contpaqi_ledger.js` (Batch 216 local): tabla `analytics.contpaqi_ledger_monthly` (cuenta, cuenta_nombre/afectable, familia, agrupador_sat, ejercicio-año, periodo 1..14, anio_mes, saldo_ini, cargos, abonos, neto). Sin RLS + `GRANT SELECT app_runtime` + 3 índices. PK `(tenant_id, cuenta, ejercicio, periodo)`.
- **Login read-only** `platform_ro` versionado en `database/importers/contpaqi/00-create-readonly-login.sql`.
- **Importer** `database/importers/contpaqi/import-contpaqi-ledger.js` (`mssql` con `instanceName`, dry-run/`--apply`, BATCH 1000, UPSERT idempotente). Lee `SaldosCuentas` (Tipo2=cargos/Tipo3=abonos × `Importes1..14`) ⋈ `Cuentas` ⋈ `AgrupadoresSAT` ⋈ `Ejercicios`(Id→año). **Filtra `Afectable=1`** (solo cuentas de detalle; los padres son rollup y sumarlos duplicaba → sin filtro daba $185B con Δ$1.3B; con filtro cuadra).
- **Cargado:** 187,350 filas origen → **56,821 filas** destino, ejercicios 2017–2026. **Cuadre: Σcargos $24,883,973,042 ≈ Σabonos $24,883,974,051, Δrel 0.000004%** (= total `MovimientosPoliza`).
- **Smoke** `test-newdb-contpaqi-ledger.js` **18/18** + registrado en `run-all-tests` (tolerante si no hay import).
- **Pendiente:** tool `maat_contpaqi_balanza` (exponer a Maat) + wire en `run-prod-feeds nightly` + `contpaqi.sync_state` + `CONTPAQI_SQL_PASSWORD` en `.env` de la máquina de feeds (el importer default a `superoot`). **Valor #1: Maat sobre los libros fiscales reales, sin reconstruir desde Kepler.**

### CP.2 — Ledger bancario ContPAQi → `analytics.contpaqi_bank_movements` 🔨 PULL ✅ 2026-07-27 (local)
- **Corrección de decode:** los módulos `Egresos`/`Cheques`/`DocumentosBancarios` de ContPAQi **cayeron en desuso** (solo 2018-2019). El lado-banco **vivo** son los **movimientos de póliza sobre cuentas `102xxxxxxx`** (2024=57k, 2025=59k, 2026=32k). `CuentasCheques` = maestro de cuentas bancarias (número + banco), sin `IdCuenta` contable.
- **Migración** `20260727130000_analytics_contpaqi_bank_movements.js` (Batch 217 local): tabla por movimiento (cuenta banco, fecha, `flujo` deposito/retiro, importe, folio de póliza, `concepto` de la póliza, `es_conciliado`). PK `(tenant_id, id_movimiento)`.
- **Importer** `import-contpaqi-bank-movements.js` (`--from` año, default 2024, UPSERT). **Cargado: 147,952 movimientos** (2024+). Cargo=depósito / abono=retiro (cuenta de activo). `Referencia` de línea va vacía → `concepto` = `Polizas.Concepto`.
- **✅ Validado vs Fase CB:** enero 2026 → ContPAQi **4,848 movimientos** ≈ workbook CB **4,865** (mismo universo). Depósitos $79.2M = ingresos CB $52.9M + traspasos $25.4M. **El ledger bancario de ContPAQi ES el del workbook, reconciliable.**
- **Smoke** `test-newdb-contpaqi-bank.js` **17/17** + registrado en `run-all-tests`.
- **Pendiente (integración con CB):** crosswalk `finance.bank_accounts` ↔ cuenta `102xxx` (por número embebido en el nombre) + que `/finanzas/bancos` concilie contra este ledger (folio de póliza) en vez del proxy "Kepler 102" y del matcher token-name (CB.15). **Valor #2: conciliación bancaria anclada en la contabilidad real.**

### CP.3 — Feed CFDI / proveedores → materialidad + fiscal
- Pull `Proveedores`(RFC, retenciones) + `DocumentosAdministrativos`(UUID) + `AsocCFDIs`(UUID↔movimiento) → alimenta **MAT** (materialidad CFDI↔póliza) y **fiscal** (EFOS/69-B por RFC, Fase FISCAL). Los XML/PDF del ADD quedan disponibles si se requieren.

### CP.4 — "Libros vs Operación" en Maat (detector)
- Detector que cruza la balanza ContPAQi (**fiscal**) vs Kepler `analytics.ledger_monthly` (**operación**) por cuenta/periodo → `finance.findings` de descuadre (`FINANCE_FINDINGS_SINK_PORT`). Encaja con el motor de patrones de Maat (ADR-028) y con "comprehension-first: señalar el diff".

### CP.5 — Push: pólizas por archivo (HITL)
- Generador desde eventos operativos (ventas `fulfilled`, `expense_documents`, bancos conciliados) → **layout de importación de pólizas de ContPAQi** (modelo `Ejercicio/Periodo/TipoPol/Folio` + `MovimientosPoliza` `IdCuenta`/`TipoMovto`(0=cargo,1=abono)/`Importe`/`IdSegNeg`).
- Endpoint `POST /finanzas/contpaqi/polizas/export` + `contpaqi.poliza_exports`. **Motor arma, contador importa** (ADR-028, cero escritura directa).
- ⚠️ Confirmar el formato de importación que acepta ContPAQi Contabilidad 2022 (layout TXT/Excel de "Pólizas", o SDK).

### CP.6 — Puerto + binding + bandeja `/finanzas/contpaqi`
- `CONTPAQI_LEDGER_PORT` (+ `CONTPAQI_POLIZA_SINK_PORT`) en `libs/contracts`, binding `@Optional()` condicional en composition root; `libs/contpaqi` aislada (frontera limpia, patrón `libs/whatsapp`).
- Bandeja: estado de sync + balanza + pólizas generadas + diff libros-vs-operación. Perms `CONTPAQI_VER/GESTIONAR` con backfill (patrón `feedback_seed_perm_not_in_prod_roles`).

### CP.7 — SDK COM two-way + escribir conciliación *(diferido)*
- Como ContPAQi no usa su conciliación bancaria (`EsConciliado` vacío), a futuro CB podría **empujar la conciliación de vuelta** vía SDK COM (puente on-prem 32-bit, patrón Wincaja / plan VPS-Coolify). Y conector genérico multi-empresa/multi-tenant. Solo si el file-import no basta.

## 6. Riesgos y decisiones abiertas

1. **Motor de DB según edición** — Firebird (`node-firebird`) vs SQL Server (`mssql`). Cambia el driver del importer. → se resuelve en CP.0.
2. **Formato de push** — Excel / TXT / XML según versión de Contabilidad. → CP.0.
3. **Nunca `UPDATE` directo a ContPAQi** — solo archivo (CP.3) o SDK (CP.5). Escribir a su DB la corrompe y no está soportado.
4. **HITL obligatorio en pólizas** — el contador importa; la plataforma nunca cierra el libro.
5. **¿Quién usa ContPAQi hoy?** — el contador (libros oficiales), evaluación para reemplazar Excel/Kepler, o futuros tenants. Cambia el énfasis del primer conector; no bloquea (CP.0/CP.1 sirven a los tres).

## 7. Diferidos
- CP.5 (SDK COM two-way), CP.6 (conector multi-tenant configurable).
- Nómina ContPAQi (CFDI nómina / IMSS / SUA) — fuera de scope inicial.

## 8. Prerrequisitos para arrancar CP.1
- Edición + versión de ContPAQi confirmadas.
- Acceso a un `.FDB` de muestra (o credenciales read-only a la DB).
- Regla del repo por fase: migración idempotente + RLS + `tenant_id`, importer BULK con dry-run, smoke en `run-all-tests`, perms backfill si aplica, actualizar `01_TRACKER_PROGRESO.md` + `03_LOG_REVISIONES.md`.
