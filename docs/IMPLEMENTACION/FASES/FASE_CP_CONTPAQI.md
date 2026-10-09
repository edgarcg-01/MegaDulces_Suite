# FASE CP — Conector ContPAQi (SoR contable externo)

> **Estado:** CP.0–CP.4 ✅ (lectura, en prod) · **CP.7 (SDK) 🔍 INVESTIGADO 2026-10-08, sin código — ver §CP.7** · **ADR:** ADR-040 (propuesto).
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
- `libs/contpaqi` + esquema `contpaqi.*` (staging) + ADR-040 + este doc.
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
- **Tool Maat `maat_contpaqi_balanza` ✅ 2026-07-27:** en `maat-tools.service.ts` (definición + dispatch + `contpaqiBalanza()` + describeStep + ALCANCE del prompt). Balanza fiscal CONSOLIDADA por cuenta/familia/mes/agrupador_sat; el LLM la distingue de `maat_balanza` (Kepler, operativo, por sucursal). Validado en vivo: Ingresos fam4 ≈ $569M/año. `nx build api` verde. → el chat de `/finanzas/maat` ya responde sobre los libros fiscales reales.
- **Pendiente:** wire en `run-prod-feeds nightly` + `contpaqi.sync_state` + `CONTPAQI_SQL_PASSWORD` en `.env` de la máquina de feeds (el importer default a `superoot`). **Valor #1 ✅: Maat sobre los libros fiscales reales, sin reconstruir desde Kepler.**

### CP.2 — Ledger bancario ContPAQi → `analytics.contpaqi_bank_movements` 🔨 PULL ✅ 2026-07-27 (local)
- **Corrección de decode:** los módulos `Egresos`/`Cheques`/`DocumentosBancarios` de ContPAQi **cayeron en desuso** (solo 2018-2019). El lado-banco **vivo** son los **movimientos de póliza sobre cuentas `102xxxxxxx`** (2024=57k, 2025=59k, 2026=32k). `CuentasCheques` = maestro de cuentas bancarias (número + banco), sin `IdCuenta` contable.
- **Migración** `20260727130000_analytics_contpaqi_bank_movements.js` (Batch 217 local): tabla por movimiento (cuenta banco, fecha, `flujo` deposito/retiro, importe, folio de póliza, `concepto` de la póliza, `es_conciliado`). PK `(tenant_id, id_movimiento)`.
- **Importer** `import-contpaqi-bank-movements.js` (`--from` año, default 2024, UPSERT). **Cargado: 147,952 movimientos** (2024+). Cargo=depósito / abono=retiro (cuenta de activo). `Referencia` de línea va vacía → `concepto` = `Polizas.Concepto`.
- **✅ Validado vs Fase CB:** enero 2026 → ContPAQi **4,848 movimientos** ≈ workbook CB **4,865** (mismo universo). Depósitos $79.2M = ingresos CB $52.9M + traspasos $25.4M. **El ledger bancario de ContPAQi ES el del workbook, reconciliable.**
- **Smoke** `test-newdb-contpaqi-bank.js` **17/17** + registrado en `run-all-tests`.

**Integración con la Fase CB (backend) ✅ 2026-07-27 (local):**
- **Migración** `20260727140000_finance_bank_contpaqi_link.js` (Batch 218): `finance.bank_accounts` + `contpaqi_cuenta` / `contpaqi_cuenta_nombre`.
- **Servicio** `FinanceBankService.linkContpaqi()` (auto-match por familia de banco + `account_label` contenido en el nombre `102xxx`) + `contpaqiCompare(period)` (por cuenta: Excel vs LIBROS ContPAQi + deltas, ancla en todas las cuentas). **Endpoints** `POST /finance/bank/contpaqi/link` (GESTIONAR) + `GET /finance/bank/contpaqi-compare?period=` (VER).
- **Smoke** `test-newdb-contpaqi-bank-link.js` **6/6**: **16/18 cuentas de banco auto-enlazan** a su cuenta contable ContPAQi. `nx build api` verde.

**Frontend ✅ 2026-07-27 (local):** nueva tab **"vs ContPAQi"** en `/finanzas/bancos` (`WORK_VIEWS` + `BankView`). Componente `bancos-contpaqi.component.ts` (presentacional, answer-first calcado de `conciliacion`): veredicto Depósitos/Retiros **Excel vs LIBROS ContPAQi** + Δ + estado (cuadra/no), tabla por cuenta (enlazada/sin enlazar/sin Excel), botón **Enlazar cuentas**. Service `contpaqiCompare()`+`linkContpaqi()`. Shell wireado (carga lazy + toast + reset por periodo). Solo tokens (dark-safe), PrimeNG. `nx build view` verde.
- **Tool Maat `maat_contpaqi_banco` ✅ 2026-07-27:** auxiliar bancario por banco (depósitos/retiros/neto por cuenta o por mes) desde `analytics.contpaqi_bank_movements`. **Llena un hueco explícito de Maat** (el prompt decía "AÚN NO tienes auxiliar bancario por banco — las 17 cuentas comparten el 102"; actualizado). Validado en vivo (BBVA 0174915712 ~$84M dep/ret 2026-H1). `nx build api` verde.
- **CP.2 = 🟢 rebanada vertical completa** (staging + crosswalk + endpoints + UI + tool Maat). **Pendiente prod:** aplicar migs (bank movements + link) a Railway + correr importers en la máquina de feeds + llamar al endpoint link una vez. **Valor #2: conciliación bancaria anclada en la contabilidad real, no en el proxy Kepler-102.**

### CP.3 — Proveedores ContPAQi × lista negra SAT (EFOS) 🔨 SLICE ✅ 2026-07-27 (local)
- **Migración** `20260727150000_analytics_contpaqi_suppliers.js` (Batch 221) + **importer** `import-contpaqi-suppliers.js`: `analytics.contpaqi_suppliers` (RFC + retenciones). **Cargado: 3,411 proveedores, 3,398 con RFC** (99.6%).
- **Tool Maat `maat_contpaqi_efos`**: cruza los proveedores de la contabilidad vs `fiscal.sat_list_rfcs` (69/69B). El `nota` prioriza **69B = EFOS** (operaciones simuladas, CFDI no deducible, riesgo alto).
- **Hallazgo fiscal real:** **109 proveedores en listas SAT — 103 en '69' + 6 en '69B' (EFOS)**. Grants `app_runtime` verificados en ambas tablas del cruce. Smoke `test-newdb-contpaqi-efos.js` **9/9** + en `run-all-tests`. `nx build api` verde.
- **Detector persistente `contpaqi_proveedor_efos` en `MaatDetectorService`** (regla + case + `detContpaqiEfos`): el cron nocturno de Maat empuja un hallazgo por (rfc, lista) a `finance.findings` — **69B = crítico**, 69 = warn. Así los EFOS aparecen en la bandeja `/finanzas/hallazgos` (HITL), no solo en el chat. Auto-registrado vía `ensureRules`. `nx build api` verde.
- **Diferido:** materialidad CFDI↔póliza vía `DocumentosAdministrativos`(UUID) + `AsocCFDIs` (integración con el módulo MAT — surface más grande). Los XML/PDF del ADD quedan disponibles.

### CP.4 — "Libros vs Operación" en Maat 🔨 TOOL ✅ 2026-07-27 (local)
- **Tool `maat_libros_vs_operacion`** en `maat-tools.service.ts`: contrasta ingresos (fam4) **ContPAQi (fiscal)** vs **Kepler (operación, CEDIS 00)** mes a mes → Δ + ratio %. Read-only, determinista, sin schema nuevo.
- **Hallazgo validado en vivo (2026 ene-jun):** Kepler ~$52-58M/mes vs ContPAQi ~$41-46M/mes → **gap estable ~$12M/mes (~78% ratio)**. El tool trae un `nota` que obliga a Maat a narrarlo como **estructural** (IVA / alcance de la entidad fiscal = 1 RFC vs operación completa / timing), **no como error/fraude**. Solo ingresos (fam4 es limpio en ambos; egresos 5/6/7 no mapean 1:1). `nx build api` verde.
- **Diferido:** detector persistente en `finance.findings` — NO se hace ahora porque el gap es estructural y constante (un hallazgo recurrente sería ruido); un detector futuro debería marcar solo CAMBIOS anómalos del ratio mes a mes, no el gap en sí.

### CP.5 — Push: pólizas por archivo (HITL)
- Generador desde eventos operativos (ventas `fulfilled`, `expense_documents`, bancos conciliados) → **layout de importación de pólizas de ContPAQi** (modelo `Ejercicio/Periodo/TipoPol/Folio` + `MovimientosPoliza` `IdCuenta`/`TipoMovto`(0=cargo,1=abono)/`Importe`/`IdSegNeg`).
- Endpoint `POST /finanzas/contpaqi/polizas/export` + `contpaqi.poliza_exports`. **Motor arma, contador importa** (ADR-028, cero escritura directa).
- ⚠️ Confirmar el formato de importación que acepta ContPAQi Contabilidad 2022 (layout TXT/Excel de "Pólizas", o SDK).

### CP.6 — Puerto + binding + bandeja `/finanzas/contpaqi`
- `CONTPAQI_LEDGER_PORT` (+ `CONTPAQI_POLIZA_SINK_PORT`) en `libs/contracts`, binding `@Optional()` condicional en composition root; `libs/contpaqi` aislada (frontera limpia, patrón `libs/whatsapp`).
- Bandeja: estado de sync + balanza + pólizas generadas + diff libros-vs-operación. Perms `CONTPAQI_VER/GESTIONAR` con backfill (patrón `feedback_seed_perm_not_in_prod_roles`).

### CP.7 — SDK de ContPAQi 🔍 INVESTIGADO 2026-10-08 (sin código)

> Pedido: *"investigá cómo podemos implementar el SDK de ContPAQi"*. Lo que sigue separa lo
> **medido en vivo** de lo **leído en documentación de terceros** de lo que **sigue sin medir**.

#### 7.1 Qué es (documentación, no medido acá)

El **SDK de Contabilidad** es una **librería COM** que publica ContPAQi. Para pólizas, el
módulo es `Poldll32.dll`, con el ciclo `Login → IniciaPolizaEnLote → ActualizaPoliza →
CommitPolizaEnLote → FinalizaPolizaEnLote → LogOut` sobre los objetos `TSdkPoliza` /
`TSdkMovimientoPoliza`. Requisitos declarados por la documentación disponible: **SDK instalado
en la máquina**, aplicación **.NET de escritorio en C#** (consola/WinForms/WPF), **ejecución
como administrador**, y **no cruzar versiones** (desarrollar contra una versión del SDK y
desplegar contra otra del sistema está desaconsejado). ContPAQi **no entrega documentación
oficial con el instalador**: la referencia práctica es el explorador de objetos de Visual
Studio más repos de terceros.

#### 7.2 Lo medido hoy en vivo (read-only contra `192.168.0.35\COMPAC`)

| Dato | Valor | Por qué importa para el SDK |
|---|---|---|
| `ListaEmpresas.ModulosIntegrados` | **`CT`** | **Sólo Contabilidad.** No hay Comercial — ver §7.3 |
| `VersionBDD` (GeneralesSQL / empresa) | **1841 / 1912** | Esquema. La versión del **producto** hay que leerla en la máquina |
| `Parametros.EstructCta` / `Mascarilla` | **`3-3-4`** / `XXX-XXX-XXXX` | La cuenta de cada movimiento debe cumplir esta máscara de 10 dígitos |
| `Parametros.EjerActual` / `PerActual` | **29 / 12** | `Ejercicio` es **Id**, no año (ya conocido de CP.1) |
| `Parametros.CtaFlujo` | `1020000000` | Cuenta de flujo de la empresa |
| `ListaEmpresas.RutaDatos` / `RutaResp` | `localhost` / `C:\Compac\Empresas\ct…\` | **La `.35` ES el servidor de datos** → es ahí donde tendría que vivir el agente |
| `Parametros.GuidDSL` | `12677b5d-…` | Mismo ADD que ya consume `import-contpaqi-cfdis.js` (LC.1) — consistente |

#### 7.3 ⛔ La asimetría que decide el esfuerzo

Todo el ecosistema abierto **maduro** de SDK ContPAQi es de **Comercial**, no de Contabilidad:
paquetes NuGet mantenidos (`ARSoftware.Contpaqi.Comercial.Sdk` / `.Extras`), wiki, ejemplos.
Para **Contabilidad** hay un repo de ejemplos y un *API service* de terceros **con licencia
comercial de pago**. Y el NuGet genérico `Contpaqi.Sdk` está **deprecado desde 2021** y además
envuelve Comercial/Adminpaq/Factura — **no** Contabilidad.

**Nosotros corremos `CT` (sólo Contabilidad), medido arriba.** O sea: nos toca el lado con
menos herramienta y menos documentación. Eso no lo vuelve inviable, pero sí mueve el
estimado — hay que escribir el envoltorio, no instalar uno.

#### 7.4 ⛔ El choque con la arquitectura (el costo real, no el técnico)

**COM es local.** No viaja por red como el `mssql` que ya usamos: un objeto COM se instancia
en la misma máquina donde está instalado el sistema. Producción corre en **`md` (Linux,
`192.168.0.222`)** desde el 2026-09-22, y la ingesta se mudó entera ahí el 2026-09-11.

→ El SDK **exige un agente Windows residente en `.35`**. Es exactamente la clase de
dependencia que la Fase VL viene retirando: hoy lo único que queda en Windows son los **3
carriles de Wincaja** (VL.5), descritos en su propio plan como *"el único blocker de todo en
Linux"*. **Agregar un segundo blocker con nombre es una decisión de arquitectura, no un
detalle de implementación**, y hereda sus modos de falla ya medidos: la `.249` perdió **9.5 h
de ingesta** por un Windows Update porque su motor sólo arrancaba con la sesión del usuario.

#### 7.5 Qué compra el SDK — y qué NO

**Compra (en orden de valor medido):**

1. ⭐ **Mata el `SEP` sin probar.** `libs/finance/src/lib/purchase-book/poliza-txt.ts` declara
   que el separador es **lo único del layout que nunca se verificó contra un archivo real**
   (19 campos validados contra `Polizas`/`MovimientosPoliza` = qué *significa* cada campo, no
   cómo se *serializa*). Con SDK no hay serialización: hay llamadas a métodos. **Desaparece la
   única incógnita del camino del dinero en LC**, y con ella el bloque 4 del smoke
   `test-newdb-libro-compras-txt.js` que hoy *skipea limpio* esperando un TXT de la contadora.
2. ⭐ **La asociación formal del UUID** (`AsocCFDIs`). El layout TXT **no tiene campo de UUID**
   — por eso hay 5,521 patas de compras sin CFDI contra 97% en el resto del diario. Hoy se
   compensa con **dos muletas**: el UUID metido en `Concepto` (LC.15, rastro inmediato pero
   texto libre) y el **CSV para el Asociador de CFDI** (vínculo formal, pero **lo ejecuta una
   persona** — y `purchase-book.service.ts:1444` ya contempla el caso de que ese paso no esté
   ocurriendo). El SDK hace la asociación sin intermediario humano.
3. **ContPAQi valida con sus propias reglas de negocio** y **rechaza** la póliza mala, en vez de
   aceptarla corrida de campo. Es el modo de falla que LC.9 encontró: `padR(null,30)` mete 30
   espacios y el renglón *se ve bien*.
4. El CP.7 original: **empujar la conciliación bancaria de vuelta** (ContPAQi no usa la suya —
   `EsConciliado` vacío/false en todo el universo, medido en CP.0).

**NO compra: la lectura.** Ya está resuelta por SQL directo (4 staging + 4 tools Maat + 1
detector, en prod). La propia documentación del SDK lo dice: para consultas, ir directo a la
base es más eficiente porque el SDK no expone todos los métodos de consulta. **Ningún importer
existente se reescribe.**

#### 7.6 Forma de implementación propuesta (si se aprueba)

El puerto **ya está diseñado** en §3 — el SDK es una **segunda implementación del mismo
`CONTPAQI_POLIZA_SINK_PORT`**, no una arquitectura nueva:

```text
libs/finance (purchase-book)  →  CONTPAQI_POLIZA_SINK_PORT
                                      ├── TxtSinkAdapter    (hoy: genera archivo, HITL)
                                      └── SdkSinkAdapter    (nuevo: HTTP → agente .35)
```

> ⛔ **CORREGIDO 2026-10-08 — el agente NO va en `.35`.** Este párrafo decía *"servicio Windows
> en `.35`"*. Medición de puertos contra `192.168.0.35`: **WinRM 5985 cerrado · WinRM-S 5986
> cerrado · RDP 3389 cerrado · SMB 445 abierto pero con *Acceso denegado* · RPC 135 abierto**.
> **No hay ninguna vía de administración remota de esa máquina** — instalar y mantener un
> servicio ahí exige consola física, y además pone código nuestro dentro del servidor contable.
>
> ⭐ **La documentación del SDK contempla el modo Servidor/Terminal explícitamente** (*"la
> terminal requiere acceso de red al servidor"*). Entonces el agente vive en una **TERMINAL
> ContPAQi**, no en el servidor: una caja Windows con ContPAQi Contabilidad + SDK instalados,
> apuntando por red a la instancia `COMPAC`. **El servidor contable no se toca.** Y si esa
> terminal es `SISTEMAS` —la máquina que ya es el blocker Windows declarado por VL.5 (Wincaja,
> Caja General)— **no se agrega un segundo blocker**, se usa el que ya tiene dueño y fecha.
>
> ⚠️ Riesgo a medir, no asumir: `ListaEmpresas.RutaDatos` dice **`localhost`**; falta confirmar
> que una terminal resuelva bien la empresa con ese valor.
>
> ⛔ **DCOM queda descartado y se deja escrito para que nadie lo reconstruya:** el 135 está
> abierto y tienta, pero el SDK es in-process y espera rutas locales (`C:\Compac\Empresas\…`);
> ContPAQi no lo soporta y seguiría necesitando un cliente Windows igual.

- **Agente**: servicio Windows en una **terminal ContPAQi**, C#/.NET, **un solo endpoint**
  (`POST /poliza`) que
  recibe la póliza **ya armada y cuadrada** por el motor y la aplica con el ciclo
  `IniciaPolizaEnLote…FinalizaPolizaEnLote` + asociación de UUID. **Sin lógica de negocio
  adentro**: el agente no decide cuentas ni importes, sólo traduce a COM.
- **Dirección única**: la plataforma **nunca lee** por el SDK (§7.5) y **nunca** escribe a la
  DB de ContPAQi (regla 3 de §6, intacta).
- **HITL se conserva**, no se elimina: el botón que hoy dice *"descargar TXT"* pasa a
  *"aplicar"*, pero **sigue siendo una persona la que lo aprieta** y queda el mismo rastro en
  `finance.purchase_book_runs` (borrador→generado→entregado→aplicado). ADR-028 pedía que *el
  contador importe*; lo que cambia es el medio, no quién decide.
- **Reversa**: `TxtSinkAdapter` **no se borra**. Si el agente está caído, el flujo cae al
  archivo, que es el camino que ContPAQi ya acepta en **109,305 de 109,378 pólizas**.
- **Latido obligatorio** (ADR-053/056): el agente late a `analytics.cron_runs` con umbral en
  `CRON_JOBS`, y el latido mide **entrega** (póliza aplicada), no *"el servicio está arriba"*.
- **Prueba negativa** antes de declararlo: mandarle una póliza descuadrada a propósito y
  verificar que **ContPAQi la rechaza** (sin eso, la compuerta es una intención).

#### 7.7 ⛔ Lo que NO se midió — a verificar antes de estimar

⭐ **Las cuatro primeras las contesta de una sola corrida
[`database/importers/contpaqi/01-probe-sdk.ps1`](../../../database/importers/contpaqi/01-probe-sdk.ps1)**
(read-only: no instala, no abre empresa, no consume licencia). Correrlo **en la terminal
ContPAQi**: `powershell -ExecutionPolicy Bypass -File 01-probe-sdk.ps1` y pegar la salida acá.

> El sondeo se ejerció contra su **rama negativa** (`SISTEMAS`, sin ContPAQi) y así encontró
> **dos defectos propios**: (1) filtraba ProgIDs por el nombre `Sdk` suelto y llegó a
> **instanciar 10 objetos COM ajenos** (`aura.sdk`, `JScript.Compact`, 5 `WMSDK*` de Windows) —
> ahora la evidencia es **dónde vive el DLL** (`InprocServer32` bajo una raíz de ContPAQi), no
> cómo se llama la clave; (2) §5 era un `if/else` y dictaminaba *"parece una TERMINAL, la mejor
> ubicación para el agente"* en una máquina **sin ContPAQi** — una ausencia publicada como
> veredicto positivo. Hoy son **tres estados** y la ausencia dice `NO MEDIDO`.

Ninguna de estas se puede contestar desde esta máquina; **no se adivinan**:

1. **¿Está instalado el SDK en `.35`?** Es una casilla del instalador de ContPAQi. Hoy el SMB
   de esa máquina responde **Acceso denegado** con las credenciales que tenemos (ya medido en
   LC.0). → `dir C:\Compac\*SDK*` y buscar `Poldll32.dll` **en la máquina**.
2. **Bitness del SDK de Contabilidad.** El *"32 bits"* que circula está documentado para
   **VBA/Office** y para rutas de **Comercial** — **no** encontré fuente que lo afirme del SDK
   de Contabilidad. Se mide mirando el DLL, no suponiendo.
3. **¿`Login` consume un asiento de licencia?** Si sí, es un usuario adicional (~$1,690/año de
   lista) y además compite con la contadora trabajando.
4. **Versión del producto** (no la de esquema `1912`) para no cruzar versiones — se lee en el
   *Acerca de* del sistema instalado.
5. **¿Quién es dueño de `.35`?** Instalar un servicio ahí es una decisión operativa con dueño.
6. **¿El SDK bloquea** la empresa mientras corre el lote, con la contadora adentro?

#### 7.8 Decisión y orden de trabajo

> ⭐ **DECIDIDO por Edgar el 2026-10-08: va la conexión directa de escritura.** Mi
> recomendación previa era *"no arrancar por el SDK, primero cerrar el `SEP` con un TXT real"*.
> Se planteó, se reafirmó el objetivo, y la decisión es del dueño — queda registrada acá junto
> con lo que la respalda, porque §7.9 la apoya: **cero asociación de UUID en cinco años** no se
> arregla pidiendo que alguien se acuerde de correr el Asociador.

**Orden, con la ruta crítica primero:**

1. ⛔ **RUTA CRÍTICA — conseguir una terminal ContPAQi.** Es lo único que bloquea de verdad.
   Requiere: una caja Windows con **ContPAQi Contabilidad + SDK instalados** (el SDK es una
   casilla del instalador) y, si `Login` consume asiento, **una licencia de usuario**. La `.35`
   **no es candidata** (§7.6). `SISTEMAS` sí lo sería, y no agregaría un blocker nuevo.
2. **Correr `01-probe-sdk.ps1` ahí** (§7.7). Contesta en una corrida si el SDK está, de cuántos
   bits, si expone IDispatch y qué versión. **Sin esto, cualquier estimado es inventado**, y
   además decide la vía: IDispatch → `winax` desde Node es opción; si no → `.exe` en C#.
3. **En paralelo, de este lado (no depende de 1 ni 2):** subir
   `CONTPAQI_POLIZA_SINK_PORT` a `libs/contracts` y meter la generación de TXT de LC detrás de
   él como `TxtSinkAdapter`. Deja el `SdkSinkAdapter` como pieza enchufable y **no cambia ningún
   comportamiento** — el TXT sigue siendo la reversa del día que el agente esté caído.
4. **Construir el agente** y declararlo migrado sólo con **latido de entrega** verde (póliza
   aplicada, no *"el servicio está arriba"*) y con la **prueba negativa**: mandarle una póliza
   descuadrada y verificar que ContPAQi la rechaza.

⚠️ **Lo que la decisión NO vuelve innecesario:** el TXT de jul-2026 sigue valiendo la pena
pedirlo. Cuesta cero, y mientras el agente no exista es el único camino a producción.

#### 7.9 ⭐ El número que decide, medido hoy (2026-10-08, read-only contra `.35`)

La pregunta era: *¿el paso manual del Asociador de CFDI está ocurriendo?* Se puede contestar
sin opinar, cruzando `MovimientosPoliza.Guid` ⋈ `AsocCFDIs.GuidRef` (`AppType='Contabilidad'`).

**Universo declarado primero** (si no, el agregado engaña): el libro de compras es la póliza de
**Diario (`TipoPol=3`) folio 1** de cada mes. Verificado leyendo su `Concepto` en los 20 meses
de 2025–2026: *"REGISTRO DE COMPRAS DEL MES"*, *"COMPRAS DEL MES JULIO"*, etc. — **los 20**.
El **control** es el resto del Diario del mismo ejercicio, que sí usa la asociación.

| Ejercicio | Compras: movs | Compras: con UUID | Control: movs | Control: con UUID |
|---|--:|--:|--:|--:|
| 2022 | 6,946 | **0 (0.0%)** | 35,275 | 203 (0.6%) |
| 2023 | 7,455 | **0 (0.0%)** | 34,812 | 196 (0.6%) |
| 2024 | 7,187 | **0 (0.0%)** | 42,569 | 5,147 (12.1%) |
| 2025 | 7,175 | **0 (0.0%)** | 39,653 | 2,649 (6.7%) |
| 2026 | 4,540 | **0 (0.0%)** | 66,976 | **37,422 (55.9%)** |

⭐ **Cero. No "poco fiable": CERO, en 33,303 movimientos y cinco ejercicios.** Y el control
descarta que sea una limitación del sistema o de mi medición: **el mismo Diario, el mismo
ejercicio, pasó de ~2–4% en ene–may a 71.9% en julio, 88.0% en agosto y 88.9% en septiembre**.
Alguien empezó a asociar este año — **nunca sobre la póliza de compras**.

**Qué cambia esto en la decisión:** el valor #2 de §7.5 deja de ser una mejora y pasa a ser
**el único camino que cierra un hueco que lleva cinco años abierto**. El CSV del Asociador
(LC.15) es correcto y **no se está ejecutando** — `purchase-book.service.ts:1444` ya preveía
exactamente este caso, y acá está medido. La ruta del `Concepto` (LC.15) sigue siendo rastro
útil, pero **no es la asociación formal** que ContPAQi exporta a contabilidad electrónica.

⚠️ **Lo que NO prueba esta medición:** si el SAT reclama por esos movimientos. Eso es una
pregunta para la contadora, y es la que debería cerrar la decisión.

#### 7.10 ¿Y desde Node? — tres preguntas distintas que conviene no mezclar

⚠️ **Corrección a §7.1:** decir *"requiere una app .NET en C#"* es repetir la **configuración
soportada** de ContPAQi, no una ley física. Lo separo bien:

**(a) ¿Hay conexión directa Node ↔ ContPAQi? — SÍ, y lleva meses en producción.**
`database/importers/contpaqi/*` son **cinco importers de Node** hablando con SQL Server en
`.35` por el driver `mssql`. Toda la lectura (balanza, bancos, proveedores, pólizas, CFDIs del
ADD) ya es Node directo. La medición de §7.9 la hice hoy con ese mismo driver. **Para leer, la
conexión directa existe y es la que usamos.**

**(b) ¿Node puede hablar con el SDK (COM)? — técnicamente sí, pero es el camino peor apoyado.**

| Vía | Qué es | Riesgo |
|---|---|---|
| `winax` | Envoltorio COM **IDispatch** en C++ para Node (v3.6.9, mantenido) | ⛔ Sólo sirve si el SDK expone **IDispatch**. Si su typelib es vtable-only, no funciona — y eso **no está medido** |
| `koffi` / `node-ffi-napi` | Llamar exports planos del DLL | Sirve si el SDK expone funciones C planas (como el de **Comercial**, que por eso se usa desde VBA). El de **Contabilidad** se describe con **objetos** (`TSdkPoliza`), no con funciones planas |
| **exe C# invocado por Node** | Node arma el JSON, un `.exe` chico lo aplica | ⭐ Mantiene el contacto con el SDK donde ContPAQi **sí** lo soporta, y Node orquesta |

⛔ **Y hay una fecha de caducidad que decide sola:** si el SDK de Contabilidad resulta **32
bits** (§7.7 punto 2, **sin medir**), un Node que lo cargue in-process tiene que ser **32
bits** — y **Node dejó de publicar binarios x86 de Windows en la v23 (oct-2024)**. Quedaría
clavado en la línea **22, que termina su mantenimiento en abril de 2027**. .NET compila a x86
sin ese acantilado. **Esto solo ya inclina la balanza hacia el `.exe` en C#.**

**(c) ¿Se puede desde `md` (Linux), donde corre prod? — NO.** COM se instancia **en la misma
máquina**; no es un protocolo de red como el `mssql` de (a). ⭐ **La restricción dura es de
LOCALIDAD, no de lenguaje** — y es la de §7.4, que ningún truco de Node evita.

> **Lo que sigue siendo cierto:** el camino que **no** necesita ni COM ni Windows es el que ya
> está construido — **Node escribe un archivo** (`poliza-txt.ts`) y ContPAQi lo importa, como
> hace con 109,305 de sus 109,378 pólizas.

#### 7.11 ⚠️ Hallazgo colateral que toca a la Fase LC — re-medir

`FASE_LC` documenta (2026-09-01) que *"jul y ago-2026 no tienen hoja → **no existe la
póliza**"*, y de ahí sale el pendiente de **ago 724 CFDIs por $48.2M** sin asociar.

**Medido hoy, las dos pólizas existen:**

| Mes | Folio | Fecha | Cargos |
|---|--:|---|--:|
| jul-2026 | 1 | 2026-07-30 | **$33,804,766.23** |
| ago-2026 | 1 | 2026-08-29 | **$40,929,079.98** |

O se capturaron entre el 3-sep y hoy, o aquella medición miraba otra cosa. **No cambio nada de
LC por mi cuenta** — pero el módulo *Movimientos no asociados* parte de ese supuesto, así que
**re-medir antes de generar un TXT de esos dos meses**: con la póliza ya posteada, el riesgo
que LC.2 describe (duplicar lo ya contabilizado) está vivo.

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

---

## 9. CP.8 — La integración REAL (ERP/CRM ↔ ContPAQi) 🔍 MEDIDO 2026-10-08

> ⭐ **El plan de implementación del puente vive aparte:
> [`FASE_CP8_PUENTE_CONTPAQI.md`](FASE_CP8_PUENTE_CONTPAQI.md)** (etapas, ruta crítica y
> definición de terminado). Esta sección §9 es el **decode que lo sostiene**: qué alimenta hoy la
> contabilidad y de dónde sale el mapa evento→cuenta.

> **Pedido de Edgar (2026-10-08):** *"no sólo obtener su póliza, sino tener una comunicación
> ERP/CRM (suite) con ContPAQi"*. Correcto: empujar una póliza al mes no es una integración.
> Antes de diseñar, medí **qué alimenta hoy la contabilidad**. Cambia el planteo.

### 9.1 ⛔ Primero, una corrección a `FASE_LC`: `SistOrig` NO dice el origen

`FASE_LC` §LC.0 afirma que *"109,305 de 109,378 pólizas entran por importación"*, apoyado en
`Polizas.SistOrig = 11`. **La columna no sostiene esa conclusión.** Medido:

| Universo | `SistOrig` |
|---|---|
| Libro de compras (Diario folio 1) — **sí** viene de un archivo | `11` (8 de 8) |
| Egresos `PAGO %` — conceptos tecleados, con variantes y faltas | `11` (3,504 de 3,504) |

Los dos dicen `11`. **`SistOrig` es el id del sistema (Contabilidad), no la vía de captura** —
no distingue importado de tecleado. Lo que sí distingue es la **forma del texto**: el libro de
compras tiene concepto uniforme; los egresos traen `PAGO TELEFONIA` junto a `PAGO TELEFONO`,
`PAGO MANT LOCAL` junto a `PAGO MANT DE LOCAL ` con espacio final. **Eso lo escribe una
persona, no un generador.** ⚠️ No cambio `FASE_LC` por mi cuenta, pero su premisa de *"toda la
contabilidad entra por importación"* queda sin respaldo.

### 9.2 Los TRES flujos que ya alimentan ContPAQi

| Flujo | Volumen 2026 | Cómo se ve | UUID |
|---|---|---|---|
| **Ventas** (Diario, `VTA dd/mm/aaaa <punto>`) | ~140 pól/mes · 22,401 desde 2018 · **$17–18M/mes** | 1 póliza por **día × punto de venta**, 6 puntos | sí, parcial |
| **Egresos** (`PAGO …`) | 4,735 pól · concepto a mano | 1 por pago | **sí** — 7,189 movs sólo en `PAGO COMBUSTIBLE` |
| **Compras** (Diario folio 1) | 1 póliza/mes | desde el Excel de la contadora | **0 en 5 años** (§7.9) |

⭐ **O sea: la comunicación ERP→contabilidad ya existe, hecha a mano, y le faltan dos cosas que
la Suite ya tiene resueltas — la cobertura y la unidad.**

### 9.3 ⛔ Lo que encontré al mirar el flujo de ventas (con su control)

Los últimos renglones repetían importes **al centavo entre días consecutivos**. No lo publiqué
sin contrastarlo: conté **cuántos importes distintos** hay por punto de venta y mes. Si la venta
fuera real, debería haber ~1 distinto por día.

| Mes | Punto de venta | Días | Importes distintos |
|---|---|--:|--:|
| jul-2026 | SUC TLMK MORELIA ABASTOS | 27 | **27** |
| jul-2026 | Suc. 44 Yurécuaro | 31 | **31** |
| ago-2026 | Suc. 54 Zam Centro | 31 | **31** |
| sep-2026 | Suc. 44 Yurécuaro | 30 | **30** |
| **oct-2026** | TLMK PADRE HIDALGO | **31** | **5** |
| **oct-2026** | SUC TLMK MORELIA ABASTOS | **31** | **4** |
| **oct-2026** | Suc. 54 Zam. Cen. | **10** | **1** |

⭐ **El control es limpio: jul/ago/sep dan 1:1 exacto — ésos son días reales.** Octubre no.
**Y hoy es 8 de octubre: el mes entero (31 días, $26.5M) ya está asentado por adelantado**, con
4–5 importes que se repiten. Es un **provisional**, no la venta.

⚠️ **No lo llamo error**: puede ser una práctica deliberada que se ajusta al cierre. Lo reporto
porque **si la Suite entrega la venta real diaria, el provisional deja de hacer falta.**

**Dos cosas más, medidas de paso:**
- **Sólo 6 puntos de venta** llegan a la contabilidad, y suman **$17–18M/mes** contra los
  **~$52–58M/mes que Kepler registra** (el gap que CP.4 ya había visto y narrado como
  estructural). El detalle de las demás plazas **no llega**.
- Los puntos se identifican por **texto libre**: `Suc. 44 Yurecuaro` y `Suc.44.YURECARO`
  conviven; `Suc. 54 Zam Centro` y `Suc. 54 Zam. Cen.` también. **Nadie puede agrupar por
  sucursal de forma confiable** — y eso explica el `IdSegNeg=0` en 97.6% que midió CP.0.

### 9.4 Lo que la Suite ya tiene para cada flujo

| Flujo | Fuente lista en la Suite |
|---|---|
| Ventas | `analytics.mv_kepler_sales_daily` / `sales_daily` — venta real por día × sucursal × canal, con el corte Wincaja→Kepler resuelto (`v_branch_erp_cutover`) |
| Egresos | Fase **CB** (`finance.bank_movements` clasificados + crosswalk `contpaqi_cuenta`, **16/18 cuentas ya enlazadas**) + Fase **CC** (4,010 pagos a proveedor con método) |
| Compras | Fase **LC** (`fiscal.cfdis`, 167k comprobantes con bases gravables por impuesto y tasa) |

**No hay que ir a buscar los datos: ya están, medidos y con árbitro.**

### 9.5 La forma correcta — y dónde está el trabajo de verdad

⛔ **El transporte es la parte chica.** TXT o SDK es *cómo* viaja el asiento; intercambiable, y
es lo que §7 resuelve. **La parte grande es la POLÍTICA CONTABLE**: qué cuenta se carga y cuál
se abona para cada evento. Eso **no lo decide el motor ni yo — lo decide el contador.**

```text
evento de la Suite  →  catálogo de reglas (evento → asiento)  →  póliza armada y cuadrada
                              ↑ la decide el contador                 ↓
                                                        sink: TXT (hoy) | SDK (§7.6)
                                                                        ↓
                                        cuadre de vuelta: lo enviado vs lo que ContPAQi tiene
```

Tres invariantes, heredadas y no negociables:
1. **Idempotencia por evento** — reenviar no duplica. Es el riesgo que `[LC.2]` ya midió
   (271 CFDIs por $32.6M contabilizados sin marca de asociación).
2. **Cuadre de vuelta, siempre.** Mandar no es asentar: hay que releer ContPAQi y comparar. La
   lectura para hacerlo **ya existe** (`analytics.contpaqi_*`).
3. **Lo que no se puede mapear se DECLARA** (ADR-056), nunca se asienta a una cuenta
   "genérica" para que cuadre.

### 9.6 ⛔ El bloqueo real de CP.8 (y no es técnico)

**Falta el mapa evento → cuenta, firmado por el contador.** Hoy no existe en ninguna parte:
`finance.bank_movement_categories.kepler_account` es lo más cercano y es **de Kepler, no de
ContPAQi**; el crosswalk `contpaqi_cuenta` cubre **sólo las 18 cuentas de banco**.

**El orden que propongo:** arrancar por **egresos**, no por ventas. Razones medidas: ya hay
crosswalk (16/18), el volumen es alto (4,735/año tecleados), el grano es 1 evento = 1 póliza
(sin agregación que discutir), y **CB ya clasifica cada movimiento**. Ventas va después, porque
primero hay que decidir el grano (¿día × sucursal? ¿canal?) y cerrar los $35M/mes de cobertura
que hoy no llegan — y eso es una conversación de negocio, no una de código.

### 9.7 ⭐ El mapa evento→cuenta NO hay que inventarlo: se DERIVA de sus libros

§9.6 declaraba como bloqueo *"falta el mapa, firmado por el contador"*. Medido, el bloqueo es
más chico: **el mapa ya está implícito en los 4,735 egresos que ContPAQi tiene asentados**. Se
deriva agrupando por concepto y mirando a qué cuenta de **resultado** cargan.

⚠️ **Primero me equivoqué, y vale escribirlo.** La primera derivación ordenaba por *frecuencia*
sin filtrar familia, y coronó a **`1060000000 IVA ACREDITABLE`** como la cuenta de casi todo
concepto — porque **cada póliza de gasto lleva su renglón de IVA**, así que empata en conteo
con el gasto y gana por uniformidad. *Estaba midiendo el impuesto, no el gasto.* Corregido a
**sólo cuentas 5x/6x y pesando por importe**, que es donde vive la señal.

**Mapa derivado (2026, egresos):**

| Concepto | Cuenta ContPAQi | Concentra |
|---|---|--:|
| `PAGO ARRENDADORA HMS` | `5200510002` RENTA DE BIENES MUEBLES | **100%** |
| `PAGO TRASLADO DE EFECTIVO` | `5200680000` TRASLADO DE EFECTIVO | **100%** |
| `PAGO MANT EQ DE REPARTO` | `5200730000` MANT. EQUIPO DE REPARTO | **98.0%** |
| `PAGO RENTA` | `5200510001` RENTA BIENES INMUEBLES | **97.9%** |
| `PAGO COMBUSTIBLE` | `5200600000` GASOLINA Y LUBRICANTES | **97.2%** |
| `PAGO IMSS, RCV E INFONAVIT` | `5200070004` RCV CEDIS | ⛔ **10.2%** |
| `PAGO FACT …` | `5010xxxxxx` / `5020xxxxxx` — **subcuenta del proveedor** | 90–100% |

**Tres lecturas:**

1. **Las reglas por concepto son deterministas, no difusas.** 97–100% de concentración significa
   que el contador no está decidiendo caso por caso: está aplicando una regla. Esa regla se
   puede escribir, y el **porcentaje es su nivel de confianza** — el contador revisa un borrador
   con números, no una hoja en blanco.
2. ⭐ **Los pagos a proveedor cargan a la SUBCUENTA del proveedor** (`5010…`/`5020…`, las 6,101
   cuentas que CP.0 ya había visto). La regla ahí no es por concepto sino **proveedor → su
   subcuenta**, y el catálogo para resolverla **ya lo importamos**: `analytics.contpaqi_suppliers`,
   3,411 proveedores, **99.6% con RFC**. El RFC es la llave contra nuestro lado.
3. ⛔ **`PAGO IMSS` concentra 10.2% y eso NO se adivina** — se reparte entre subcuentas por
   sucursal (`RCV CEDIS`…). Va **declarado** como `sin_regla` (ADR-056), no forzado a una cuenta
   para que cuadre.

**Qué queda entonces del bloqueo de §9.6:** no el mapa entero, sino **la firma del contador
sobre un borrador derivado**, más las categorías que no concentran. Mucho más barato, y la
conversación con él pasa de *"decime todas las cuentas"* a *"confirmá estas 5 y resolvé estas 2"*.

> ⚠️ **Lo que esto NO resuelve:** el lado del abono (banco) ya está por CP.2 (16/18 cuentas
> enlazadas), pero el **IVA acreditable** de cada póliza es un tercer renglón con su propia
> regla, y la derivación de arriba lo excluyó **a propósito** para encontrar el gasto. Hay que
> medirlo aparte antes de armar la primera póliza: una póliza a la que le falta el IVA **no
> cuadra**, y ContPAQi la rechaza — que es justamente lo que queremos que haga.
