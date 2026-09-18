# Fase CG — Caja General: del Access "Control" a la plataforma

> **Estado:** 🔨 DISEÑADO (planeación) 2026-09-18 · **ADR-070 propuesto**
>
> Esta fase ya tiene código en producción (CG.0–CG.7: espejo + pantalla de lectura) **pero nunca
> tuvo documento ni entrada en el tracker ni ADR**. Este archivo cierra esa deuda y plantea la
> segunda mitad: pasar de espejar a **operar**.
>
> ⭐ **DECISIÓN DE DIRECCIÓN (2026-09-18):** la plataforma pasa a ser **la fuente principal de
> información de los ingresos y egresos de efectivo** → se adopta el **camino C** del §6. Y **cada
> movimiento debe vincularse a un concepto de Kepler** (§7). Eso mueve el sub-módulo de captura
> —§8 `CG.13`/`CG.14`— de "etapa 3" a **razón de ser de la fase**, y hace del vínculo contable un
> requisito de diseño, no un enriquecimiento posterior.

---

## 0. El pedido

> *"necesito que me armes un plan de cómo funciona actualmente (visualmente) para replicarlo y
> mejorarlo… cómo se integra hoy en las cuentas… un plan de implementación estricto pensando en
> innovar la forma y utilizando lo existente… mejorando así el control y la administración."*

Tres preguntas: **cómo se ve**, **cómo aterriza en las cuentas**, **qué hacemos**. Las tres se
contestan abajo contra medición, no contra impresión.

---

## 1. Cómo se midió

Todo read-only, sobre **copias-sombra** en scratchpad — nunca contra el `.mdb` vivo.

| Qué | Con qué |
|---|---|
| Esquema de las tablas | `database/importers/lib/access-schema.ps1` (Jet 32-bit, `Mode=Read`) |
| Mapa tabla → back-end | DAO `DBEngine.36` · `TableDefs.Connect` (⛔ `MSysObjects` no es legible por OLEDB) |
| **Las 274 pantallas, reportes y módulos** | `Access.Application` 16 + `SaveAsText` con watchdog que mata `MSACCESS` si el `Autoexec` cuelga |
| Volúmenes y defectos | consultas OLEDB sobre la copia de `BDatos.mdb` (39.8 MB, sucursal 20) |
| Nuestro lado | código del repo + `analytics.*` |

**No se pudo medir (se declara, ADR-056):** la frescura del espejo **en producción** — este entorno
no tiene credencial de prod; el `.env` local apunta a `platform_test`, que está en cero. Queda como
primer paso verificable de CG.8.

---

## 2. Cómo funciona hoy — el mapa visual

### 2.1 El arranque

```
Autoexec  →  CompruebaVinculoBDatos()
                │
                ├─ SELECT * FROM nada      ← centinela sobre BDatos.mdb  (Kepler / "cxc")
                ├─ SELECT * FROM cajas     ← centinela sobre Wincaja
                │
                ├─ error 3024/3043/3044 →  "Error Grave, No Encuentro los Datos"
                │                          └─ form VincularBDWC  → re-apunta rutas y RefreshLink
                └─ ok →  form Usuario  (login)
                            └─ form UsuarioAct  (sesión viva: usuario + 7 niveles)
                                  └─ MenusDisp() + MenuXxx()  → habilita la CommandBar "Solin"
```

`UsuarioAct` es un formulario oculto que hace de **sesión**. Todo el sistema lee permisos de ahí
con `Forms!UsuarioAct!NivelXxx`.

### 2.2 El menú real — CommandBar `"Solin"`, 7 módulos

| Menú | Submenús | Nivel que lo gatea |
|---|---|---|
| **Solic Mercancia** | 2 Genera · 3 Edita · 4 Consulta · 5 Edita Máx y Mín en WinCaja · 6 Elimina | `NivelSMe` |
| **C x Cobrar** | 2 Pagar Guía · 3 Pagos Sin Guía · 6 Utilerías · 8 Alta Repartidor | `NivelCxC` |
| **Vendedores** | — | `NivelVen` |
| **Pedidos** | — | `NivelPed` |
| **Mod Precios** | — | `NivelCPr` |
| **Flujo** | 1 Morralla · 2 Central · 3 Reportes | `NivelFlu` |
| **Bancos** | — | ⚠️ **`NivelVen`** (ver §5.1) |

Semántica de los niveles: **9 = sin acceso** · **2 y 4 = acceso parcial** (apagan submenús
distintos) · cualquier otro = acceso completo. No hay más granularidad: es un byte por módulo.

### 2.3 Las pantallas de captura — 6 formas, **una sola tabla**

Las seis comparten el mismo `RecordSource`:

```sql
SELECT Doctos.*, Personal.NombrePers, Cuenta.NombreLargoCta
FROM (Doctos LEFT JOIN Personal …) LEFT JOIN Cuenta ON Doctos.Cuenta = Cuenta.IdCuenta
WHERE Doctos.TipoDto = <n>
```

| Forma | Título que ve el usuario | `TipoDto` | Campos visibles |
|---|---|---|---|
| `Fichas1` | **Fichas de Efectivo por Cobranza** | 1 | Numero · Fecha · Cuenta · Recibido de |
| `Fichas2` | ídem, `Tipo = 2` | 1 | ídem |
| `FichasVarios` | **Fichas de Otros Ingresos** | 1 | Numero · Fecha · Cuenta · Recibido de |
| `Gastos` | **Comprobante de Gasto** | 2 | Numero · Fecha · Cuenta · Observaciones |
| `CompGtos` | **Comprobación de Gasto** | 2 | hija de `Gastos` vía `TipoDtoCG;IdDoctoCG` |
| `Depositos` | **Depósitos al banco** | 3 | Numero · Fecha · A la Cuenta · Observaciones |

Más el **desglose por denominación** (15 campos `B1000 … Mor` + `BM`) y el **saldo corrido de
caja** (`SaldoD`), que es lo que convierte la pantalla en un arqueo.

### 2.4 El resto de la aplicación

164 formularios y 96 reportes en total. Además del bloque de caja:

- **Cobranza de ruta** (el más grande): `Guias`, `GuiaAPagar`, `PagosGuia{Cheques,Vales,CPag,AbonosWC}`,
  `ChequeDevuelto`, `EntregaCHDev`, `FichaCheques`, `RelacionChequeDocto`, `KardexCliente`,
  `ValesCSaldoXPersona`.
- **Pagarés**: `ImpresionPagares` + reportes `Pagares`, `PagaresXDocto`, `PagaresReImpGuia`.
- **Cambio masivo de precios**: `CambiarMultiplesPrecios`, `HistoricoCMP`, tope
  `AumentoMaximoCMP = 10`, y `RedondeoEnPrecios` = 6 niveles de precio con regla de redondeo
  distinta sin IVA y con IVA (1-3 → 4/1 · 4-5 → 4/2 · 6 → 4/4).
- **Pedidos y surtido**, incluido surtido **por pasillo** (`ImpParaSurtirPasillo`).
- **Detectores de desincronización Kepler↔Wincaja**: `DatosOmitidosWC`, `GuiasNoActualizadasWC`,
  `PagosFaltantesEnWC`, `SaldoClientesWCaja`.

---

## 3. Cómo se integra en las cuentas

### 3.1 `Doctos` es el libro de caja, y `Cuenta` el catálogo

`Doctos` tiene 36 columnas. Las que importan para la contabilidad:

```
TipoDto  IdDocto  Fecha  UsuarioD  NombreCliente  Cuenta  Ingreso  Gasto  Deposito
Efectivo  NumPers  Tipo  ObservDocto  Corte  B1000…Mor  BM  SaldoD  DolarD  TipoCambD
DepClienteD  HoraD  ConceptoD
```

La cuenta contable **se elige en la captura** (`Doctos.Cuenta → Cuenta.IdCuenta`). No hay póliza,
no hay partida doble, no hay cierre: es un **libro de efectivo con una dimensión de concepto**.

### 3.2 Volumen real (sucursal 20, medido 2026-09-18)

| `TipoDto` | Qué es | Movs | Desde → hasta | Monto |
|---|---|---|---|---|
| 1 | Ingreso | 23,174 | 2010-09-18 → **2026-09-17** | $654,706,744.79 |
| 2 | Gasto | 93,127 | 2008-07-10 → **2026-09-18 (hoy)** | $647,725,753.08 |
| 3 | Depósito | 166 | 2010 → **2016** (muerto) | — |
| 5 / 6 | residuos | 1 / 12 | 2008 / 2012-2019 | — |

**116,480 movimientos · $1,302M · capturado hoy mismo.** Sólo 2026: **12,253 movimientos,
$153,993,522.72**.

### 3.3 El catálogo de cuentas — 122 filas, y ahí está el problema

Sólo **114 cuentas de nivel 0 + 8 de nivel 1**, todas marcadas afectables. No es un plan contable:
es un catálogo plano donde **concepto y sucursal están fundidos en la misma dimensión**, con la
sucursal codificada en el prefijo del id **y repetida en el texto del nombre**:

```
1xxx      Matriz          1005 Matriz Compras Mercancia · 1009 Matriz Viaticos · 1010 Matriz Gastos X Comprobar
10xxx     PHidalgo       10004 PHidalgo Nomina · 10009 PHidalgo Viaticos
20xxx     Comisionistas  20003 Comisionistas Agua · 20009 Comisionistas Viaticos
30xxx     Morelia        30009 Morelia Viaticos
40xxx     8 Esquinas     40007 8Esquinas Mant. Sucursal
50xxx     Abastos LP     50001 ABASTOS LA PIEDAD
90xxx     Genéricos      90009 Estacionamientos · 90017 Apoyo Inventario Canindo
41000xxx  Ventas ruta    41000001 VENTAS RD LA PIEDAD · 41000002 VENTAS RD ZAMORA
```

**Consecuencia medible:** "cuánto gastamos en viáticos en toda la empresa" exige saber de memoria
que `1009`, `10009`, `20009` y `30009` son lo mismo. No hay ninguna columna que lo diga.

Top de 2026 por actividad:

| Cuenta | Nombre | Movs | Monto |
|---|---|---|---|
| 1005 | Matriz Compras Mercancia | 2,703 | $51,432,287 gasto |
| 41000001 | VENTAS RD LA PIEDAD | 1,292 | $25,892,897 ingreso |
| 1010 | Matriz Gastos X Comprobar | 1,174 | $4,675,504 gasto |
| 1009 | Matriz Viaticos | 1,109 | $1,646,794 gasto |
| 1013 | Matriz Telefono | 715 | $959,807 gasto |
| 1990 | **Deposito En El Banco** | 14 | $216,321 — el único puente a bancos |

### 3.4 Dónde conecta con lo contable de verdad

**En ningún lado, automáticamente.** `Cuenta.IdCuenta` no mapea a la cuenta de ContPAQi (Fase CP)
ni a la póliza de Kepler. El único puente es `1990 Deposito En El Banco`, y hoy tiene 14
movimientos en todo 2026 — o sea que la salida de efectivo hacia banco **casi no se registra por
esa vía**. La conciliación real la hace nuestra pantalla a posteriori (§4).

---

## 4. Lo que YA tenemos construido (inventario honesto)

| Pieza | Dónde | Estado |
|---|---|---|
| Espejo de `Doctos` | `analytics.caja_general_movimientos` (mig `20260814120000`) | ✅ 36 col + `denom` jsonb |
| Espejo de `Cuenta` | `analytics.caja_general_cuentas` | ✅ con `acumula_a`, `afectable` |
| Espejos legados | `caja_ventas_diarias`, `caja_depositos`, `caja_arqueos`, `caja_bancos_catalog`, `caja_sucursales_catalog` | sistema "Base Movimientos SI/NO", abandonado Q1-2026 |
| Lector | `database/importers/movimientos-caja/import-caja-general.js` + `extract-mdb.ps1` | UPSERT churn-free, scope ene-2026 → hoy |
| API | `libs/finance/src/lib/caja/` — **15 GET + 1 POST** | todo `FINANCE_BANK_VER` |
| Pantalla | `/finanzas/caja` — 7 pestañas: General · Cuadre · Arqueos · Resumen · Depósitos · Conciliación · Enlace de cuentas | **read-only** |
| Triangulación | la pestaña Conciliación ya cruza **`.mdb (operativo)` vs `Manual (workbook)` vs `Kepler (ERP)`**, con una columna que el equipo ya llama **"Control"** | ✅ |
| Crosswalk caja→banco | `finance.caja_bank_crosswalk` (mig `20260812170000`, CG.7) | HITL, patrón RA-PRO.3 |

**Conclusión del inventario: ya replicamos la lectura. Lo que falta es la escritura y el control.**

### 4.1 Herramientas nuestras que aplican directo

| Necesidad de esta fase | Lo que ya existe, y dónde |
|---|---|
| Folio sin carrera | `commercial.order_sequences` — UPSERT atómico Postgres (Fase B.2) |
| OCR de comprobante | `LlmExtractorService.extractDepositSlip()` / `extractRemision()` — Haiku vision, imagen **y PDF** (Fase CC) |
| Adjunto + cuadre + HITL | `finance.collection_deposits` / `goods_receipt_proofs` — adjunto, `monto_match`, validar/rechazar (Fase CC) |
| Preparar ≠ autorizar | `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` fuera de todo `MODULE_GROUP` (TP.6) · `COMPRAS_ENTRADAS_GESTIONAR/VALIDAR` |
| Hallazgos a la bandeja | `FINANCE_FINDINGS_SINK_PORT` → `finance.findings` + triage + feedback L2 (CB.7, MAAT.2) |
| El trámite en pantalla | `finance.purchase_book_runs` — estados borrador→generado→entregado→aplicado (LC.6) |
| Aviso al humano | `FINANCE_NOTIFIER_PORT` → alerta WS (MAAT 3.0 P2) |
| Access → Postgres continuo | `database/importers/lib/access-adapter.js` — reader Jet 32-bit sobre copia-sombra, CDC de dos carriles (Fase WR, in vivo) |
| Búsqueda | `applySmartSearch` |
| Procedencia | `libs/contracts/http/provenance.contract.ts` (VP.2.1) |

---

## 5. Los defectos medidos

Cada uno con su número. Ninguno es una impresión.

### 5.1 ⛔ El permiso de Bancos está atado al de Vendedores

```vb
Public Function NBco() As Byte
NBco = Forms!UsuarioAct!NivelVen     ' ← lee NivelVen, no NivelBco
End Function
```

`bas_Configuracion`. **Quien tiene nivel de Vendedores tiene el menú de Bancos.** Es un typo de
copiar-pegar que lleva por lo menos desde 2014 y nadie lo ha visto porque el menú *funciona*.

### 5.2 ⛔ El folio se calcula con `DMax + 1` en el cliente — y ya cobró

```vb
IdDocto = Nz(DMax("IdDocto", "Doctos", "TipoDto = 1"), 0) + 1
```

Sin transacción ni bloqueo, sobre un `.mdb` compartido por 5 capturistas. **Medido: 34 folios
repetidos** (2 en ingresos, 31 en gastos, 1 en depósitos). No es teórico.

### 5.3 ⛔ El 19.5 % de los movimientos de 2026 no tiene concepto — y es el 46.7 % del dinero

**2,387 de 12,253 movimientos, por $71,958,648.16**, con `ObservDocto` vacío. Sobre $153,993,522.72
totales del año. Un movimiento de caja sin descripción es indefendible ante cualquier auditoría.

### 5.4 ⚠️ Concepto y sucursal fundidos en una sola dimensión

122 cuentas ≈ 15 conceptos × 6 sucursales, cruzados a mano en el nombre (§3.3).

### 5.5 ⚠️ La jerarquía `AcumulaACta` es basura

- `40002 8Esquinas Luz` → acumula a `1001 Matriz Renta`
- `90004 Departamento Comida` → acumula a `1003`
- `1014 DONATIVOS` → acumula a `0`

Y `NombreCuenta` contradice a `NombreLargoCta` en varias: `40002` se llama "8Esquinas Luz" pero su
nombre largo es "MANTENIMIENTO SUCURSAL"; `50001` es "ABASTOS LA PIEDAD" con nombre largo
"SINIESTRO". **Cualquier rollup que use `acumula_a` hoy da un número falso.**

### 5.6 ⚠️ Un capturista genérico

5 usuarios en 2026: `Krmn` (6,981) · `ivonne` (2,815) · **`Auxiliar` (1,625)** · `Jesus` (573) ·
`Mayra` (259). **1,625 movimientos sin persona identificable.**

### 5.7 ⚠️ $4.68M de gastos por comprobar, sin cierre visible

`1010 Matriz Gastos X Comprobar`: 1,174 movimientos / $4,675,503.50 en 2026. La comprobación existe
como pantalla (`CompGtos`, hija por `TipoDtoCG;IdDoctoCG`) pero **nada mide cuántos anticipos
quedaron sin comprobar ni por cuánto**.

### 5.8 ⚠️ El lector no está agendado y no late

`import-caja-general.js` **no aparece en `ops/vl/crontab.feeds`, ni en `run-prod-feeds.js`, ni
llama a `cron-heartbeat`**. Es exactamente el modo de falla que fundó la Fase OBS (ADR-053): una
pantalla publicando con confianza sobre un carril que nadie vigila. Y como necesita `Z:` (SMB) +
`powershell` + ACE, **no puede correr en `md`** — mismo blocker que Wincaja (VL.5).

### 5.9 ⚠️ Un filtro de alguien quedó guardado en la pantalla de Gastos

`frm_Gastos` tiene `Filter = "((Gastos.ObservDocto=\"COMISIONES DEL 9-14 DE NOVIEMBRE \"))"`.
No verifiqué `FilterOnLoad`, así que **no afirmo que se aplique al abrir** — pero es el tipo de
residuo que en Access sí llega a ocultarle filas al usuario sin avisar.

### 5.10 ⚠️ La configuración se copió mal entre sucursales

Las copias `Control CC` (apunta a la 99) y `Control MKT 7` (apunta a la 7) tienen
`Parametros.Almacen = 20`. Las otras tres copias sí lo tienen coherente, así que el campo **sí se
usa**. No verifiqué qué formularios lo leen.

---

## 6. La decisión de fondo — ADR-070 · ✅ **RESUELTA 2026-09-18**

> **¿La plataforma pasa a ser el sistema de registro de la caja general, o sigue siendo un espejo?**
>
> **Dirección: la plataforma es la fuente principal de los ingresos y egresos de efectivo → camino C.**

Se deja el análisis de los tres caminos porque explica **por qué B queda prohibido** y qué hereda C.
**No son combinables**: el punto intermedio es doble captura, y doble captura es doble verdad.

| | **A · Seguir espejando** | **B · Capturar en paralelo** | **C · Migrar y cortar** |
|---|---|---|---|
| Qué es | Leemos, mejoramos el análisis, Access sigue capturando | Las dos pantallas escriben | La plataforma captura, Access se retira |
| Arregla 5.2 / 5.3 / 5.6 | ❌ no — son defectos de la captura | parcial | ✅ |
| Riesgo | bajo | **inaceptable** — dos folios, dos saldos | medio, acotable |
| Precedente en casa | — | — | **Fase CV** (ADR-058): migrar, verificar en vivo, cortar el servicio |
| Costo | bajo | alto y permanente | alto una vez |

**Adoptado: C, por etapas, con A como estado intermedio explícito y fechado.** Es el único que toca
la causa: los tres defectos caros (folio duplicado, concepto vacío, usuario genérico) **nacen en el
momento de teclear**, y ningún reporte los arregla después.

**Lo que C hereda de CV, tal cual:** verificar contra el sistema vivo antes de cortar; cortar un
módulo a la vez; dejar el original intacto y reversible hasta el último día.

**La tensión con la regla principal del proyecto, dicha de frente.** La regla es *cero importers,
todo del ODS, de una tabla principal normalizada*. `Doctos` **no está en el ODS** y hoy se lee con
un importer (`import-caja-general.js`) que además está mudo (§5.8). Hay dos salidas honestas:

1. **Mientras Access capture** (etapas 1-2): `BDatos.mdb` entra por **el mismo carril que Wincaja**
   — `access-adapter.js`, CDC de dos carriles, réplica cruda continua (Fase WR) — y `analytics.*`
   pasa a ser **vista derivada**, no tabla poblada por script. El importer desaparece.
2. **Cuando la plataforma capture** (etapa 3): deja de haber fuente externa. El dato es nuestro y
   vive en `finance.*` con RLS, y la regla se cumple por construcción.

En ninguna de las dos sobrevive un importer. Eso es lo que hace que el plan cierre con la regla en
vez de pedirle una excepción.

---

## 7. El vínculo con el concepto de Kepler — el corazón del sub-módulo

Requisito de Dirección: *"este mismo se debe vincular con un concepto de Kepler"*. Antes de
diseñarlo hay que saber **qué es un concepto en Kepler** — investigado, no supuesto.

### 7.1 La jerarquía contable de Kepler son TRES niveles, no dos

Ya está decodificada en la Fase GX (mig `20260707130000`, GX.5):

| Nivel | Origen | Catálogo | Ejemplo |
|---|---|---|---|
| **Mayor** | `split_part(kdc.c3,'-',1)` | `kdc126` (fallback `kdc125`) | `601` = SUELDOS Y SALARIOS |
| **Subcuenta** | `kdc.c3` completo | `kdc126` | `601-001` = SUELDOS |
| **Concepto** | **`kdc.c20`** | **`kdco`**, llave `(c3 subcuenta, c1 concepto)` → `c2` nombre | `001` = NÓMINA BANCOS |

⚠️ **Trampas ya pagadas por GX, no re-descubrirlas:**
- **`kdco` es catálogo de CONCEPTOS, no de cuentas.** Tiene N nombres por subcuenta; usarlo para
  nombrar la cuenta da nombres arbitrarios. El nombre de cuenta sale de `kdc126`.
- **En gastos, `kdc.c6` NO es el proveedor: es el concepto.** El beneficiario real es `kdm1.c32`.
- La glosa del documento es `kdm1.c24`.
- Centro de costo / departamento: `kdc3` (`c1` código `1-01-10-00` → `c2` `PADRE HIDALGO PISO`).

### 7.2 El catálogo ya llega al ODS, y nadie lo consume

`kdco`, `kdc3` y `kdc2*` **ya viajan por el carril hash del ODS**
([`ops/vl/docker-compose.yml:119-120`](../../../ops/vl/docker-compose.yml)) —
catálogos mutables, refrescados solos. Pero **ninguna línea del repo lee `kepler_ods.kdco`**: está
shipeado y sin consumidor.

Eso es exactamente lo que la regla principal pide: **el concepto se deriva del ODS con una vista,
sin importer y sin copia**. Y el molde ya está escrito y medido —
[`20260826190000_kepler_accounts_live_view.js`](../../../database/migrations-newdb/20260826190000_kepler_accounts_live_view.js)
(Fase FKJ): `security_invoker = true`, **filtro de tenant DENTRO de la vista** (una vista no hereda
RLS), y gate de costo antes de convertir.

Del lado de la cuenta ya no hay que construir nada: **`finance.kepler_accounts` ya es una vista viva**
sobre `analytics.ledger_monthly`, con `cuenta`, `cuenta_nombre`, `cuenta_mayor`, `cuenta_mayor_nombre`.
Falta sólo el **tercer nivel**.

### 7.3 Por qué hoy no está vinculado: el campo existe y nunca se llenó

`Doctos` **ya tiene una columna `ConceptoD`**. Medido en 2026:

| `ConceptoD` | Movimientos |
|---|---|
| `0` | 9,634 |
| vacío / NULL | 2,532 |
| `1` | 87 |

**99.3 % en cero o vacío.** Y el catálogo que debía alimentarlo, `ConceptosMB`, **tiene 2 filas, y
son la misma basura duplicada** (`venta refrigertador cedis` / `venta refrigertador cedi`, con
typo).

O sea: quien diseñó `Control` **dejó el gancho puesto para el concepto y nadie lo usó nunca**. El
pedido de Dirección no agrega una función: **cierra un hueco de 18 años**. Por eso los $154M de
2026 no se pueden explicar contra la contabilidad sin que alguien los reclasifique a mano.

### 7.4 El diseño del vínculo

Cada movimiento del libro nuevo nace con el par contable completo:

```
finance.cash_ledger
  ├─ kepler_cuenta        text NOT NULL   -- subcuenta, ej '601-001'   → finance.kepler_accounts
  ├─ kepler_concepto      text NOT NULL   -- código,    ej '001'       → analytics.v_kepler_conceptos
  ├─ kepler_centro_costo  text NULL       -- kdc3, ej '1-01-10-00'     → analytics.v_kepler_centros
  └─ legacy_cuenta_access text NULL       -- la cuenta de Control (1009…), sólo para trazar
```

Tres piezas, dos ya existen:

1. **Cuenta** → `finance.kepler_accounts` *(ya construida, vista viva)*.
2. **Concepto** → **`analytics.v_kepler_conceptos`**, vista `derive-no-copy` sobre `kepler_ods.kdco`
   con llave `(cuenta, concepto)` → nombre. **Es el único objeto nuevo de datos que esta fase
   agrega**, y sale de una tabla que ya está en el ODS.
3. **Mapa de arranque** → `finance.caja_kepler_concept_map`: las 122 cuentas de Control →
   `(kepler_cuenta, kepler_concepto)`. **HITL**, una sola vez, con el molde de
   `finance.caja_bank_crosswalk` (CG.7) y `RA-PRO.3`: se **propone** por derivación (nombre y
   familia de gasto) y **lo confirma un humano**; lo que no se pueda proponer queda `NULL` y **se
   declara en pantalla**, nunca se adivina.

### 7.5 Reglas duras del vínculo

- ⛔ **Un movimiento no se guarda sin `(cuenta, concepto)` válidos.** No es una advertencia: es
  `NOT NULL` + FK lógica contra el catálogo vigente. Es la única forma de que §5.3 (los $71.96M sin
  concepto) no se repita en el sistema nuevo.
- ⛔ **El par se valida contra el catálogo, no contra una lista escrita a mano.** `(cuenta,
  concepto)` debe existir en `v_kepler_conceptos`; si Kepler retira un concepto, el movimiento viejo
  conserva el suyo (snapshot del nombre) pero uno nuevo ya no puede usarlo.
- ⚠️ **El concepto NO reemplaza al concepto en texto libre.** `ObservDocto`/glosa sigue siendo
  obligatoria: el concepto dice *a qué cuenta va*, la glosa dice *qué pasó*. Confundirlos es cómo se
  llega a 2,387 movimientos sin explicación.
- ⚠️ **Sucursal y centro de costo son dimensiones aparte**, no van fundidas en el concepto — es
  precisamente el error de las 122 cuentas de Control (§3.3, §5.4).
- ⭐ **Lo que el vínculo desbloquea, y es el argumento de negocio:** con `(cuenta, concepto)` el
  movimiento de efectivo queda en **el mismo lenguaje que `analytics.expense_entries` (GX) y que la
  balanza `analytics.ledger_monthly`**. La conciliación de `/finanzas/caja` deja de cuadrar sólo por
  monto y fecha y pasa a cuadrar **por cuenta contra la póliza** — que es lo que hoy nadie puede
  hacer.

---

## 8. ⭐ Autorrelleno — el movimiento se arma solo hasta donde el dato alcance

Directiva de Dirección (2026-09-18): *"ya que nosotros tenemos acceso a toda la información, debes
autorrellenar cada movimiento en lo que sea posible"*.

Es la respuesta correcta al riesgo del §8 `CG.14` (si capturar se vuelve más lento, el sub-módulo
fracasa). Pero **"en lo que sea posible" tiene un límite exacto, y el límite es la procedencia**:
un campo lleno sin saber de dónde salió es indistinguible de uno inventado, y el proyecto ya pagó
esa factura (ADR-056). Así que el autorrelleno se diseña por **niveles de certeza**, no como una
sola función que "adivina".

### 8.1 Los cinco niveles, de más a menos certeza

| Nivel | Qué llena | De dónde | ¿Confirma el humano? |
|---|---|---|---|
| **0 · Contexto** | fecha, hora, usuario, sucursal, folio, tipo de movimiento | sesión + JWT + `order_sequences` | no — es certeza |
| **1 · Documento origen** | monto, beneficiario, fecha del doc, UUID/folio, **y la liga** | ver §8.2 | no el dato; sí **elegir** el documento |
| **2 · Aprendido de la contabilidad** | **`kepler_cuenta` + `kepler_concepto`** | `analytics.expense_entries` | **sí**, con el soporte a la vista |
| **3 · Reglas explícitas** | cuenta, concepto, familia | `finance.caja_classify_rules` (molde CB.6) | **sí** |
| **4 · OCR del papel** | monto, fecha, folio, RFC | `extractRemision()` / `extractDepositSlip()` | **sí**, con cuadre por monto |

### 8.2 Nivel 1 — el movimiento no se teclea, se LIGA

Es el más fuerte y el que más tiempo ahorra: **si el dinero corresponde a un documento que ya
existe, no se captura, se elige.** Todas estas fuentes ya están construidas y pobladas:

| Operación | Documento que ya tenemos | Qué hereda el movimiento |
|---|---|---|
| Comprobante de gasto con factura | **`fiscal.cfdis`** — 167,135 CFDIs recibidos 2018→hoy, con `emisor_rfc`, `uuid`, `total`, `fecha`, `impuestos` (índice por emisor) | proveedor, monto, fecha, UUID, impuestos |
| Gasto contra recepción / OC | `analytics.erp_goods_receipts` · `commercial.purchase_requisitions` (RA.15) | proveedor, monto, folio |
| Pago a proveedor | `analytics.erp_supplier_payments` — 4,010 pagos / $346M, con método | beneficiario, monto, método |
| Ficha de efectivo por cobranza | `analytics.erp_collections` — 23,771 cobros / $369.5M · cartera `kdue` | cliente, monto, folio del cobro |
| Depósito al banco | `finance.bank_movements` (CB) | banco, monto, fecha, referencia |

⭐ **El beneficio no es sólo velocidad: es la trazabilidad que hoy no existe.** Un gasto de caja
ligado a su CFDI deja de ser un renglón de texto libre y pasa a tener origen verificable — que es
exactamente lo que le falta a los 2,387 movimientos sin concepto de §5.3.

### 8.3 Nivel 2 — el concepto se aprende de lo que contabilidad YA hizo

`analytics.expense_entries` (GX) es el registro de lo que contabilidad **efectivamente posteó**:
`beneficiario`, `beneficiario_doc`, `cuenta`, `cuenta_nombre`, `familia`, `concepto`,
`concepto_nombre`, `dpto`, `sucursal`, `fecha`, `importe`.

Entonces el par `(cuenta, concepto)` **no se adivina y no hace falta que alguien lo escriba a mano**:
se deriva de la historia real de ese proveedor / RFC / familia.

> *"Las últimas 47 veces que se le pagó a este proveedor, contabilidad lo mandó a `611-003` /
> concepto `002 MANTENIMIENTO`."*

Reglas de esta capa, y son duras:

- **Se muestra el soporte** (`n` veces, `%` de dominancia) junto a la propuesta. Molde exacto:
  `finance.caja_bank_crosswalk.match_count` + `source ∈ (manual, kepler_auto)` (CG.7 / RA-PRO.3).
- ⛔ **Soporte bajo o empate → NO propone.** Deja el campo vacío y dice *"sin propuesta: 3 usos
  repartidos en 3 conceptos"*. **Un default disfrazado es peor que un campo vacío**, porque se
  acepta sin mirarlo.
- **La propuesta se recalcula sola** conforme contabilidad postea: es una vista, no una tabla
  congelada.

### 8.4 Nivel 3 — reglas explícitas, editables sin redeploy

Para lo que la historia no cubre (gasto nuevo, proveedor nuevo, concepto genérico):
`finance.caja_classify_rules`, **calcado de `finance.bank_classify_rules` (CB.6, ADR-033)** —
regex sobre glosa / beneficiario, ordenadas por `priority`, **la primera que aplica gana**, y si
ninguna aplica → `sin_clasificar` (no un default). Editable desde Admin, igual que las de bancos.

La razón de que exista esta capa está escrita en CB.6: *"cada patrón nuevo hoy exige cambio de
código + redeploy, y arriesga que las dos copias se desincronicen"*. No repetir ese error.

### 8.5 Las cinco reglas que hacen que el autorrelleno no se vuelva el problema

1. ⛔ **Nada se guarda sin que un humano lo vea.** El motor propone, el humano confirma — es el
   patrón de la casa (ADR-016: *el motor decide, el agente comunica*), y aquí además hay dinero.
2. ⛔ **Cada campo autorrellenado declara su procedencia y su confianza**, con el contrato que ya
   existe (`libs/contracts/http/provenance.contract.ts`, VP.2.1). En pantalla se ve *de dónde salió*
   cada cosa, no sólo el valor.
3. ⛔ **Lo que no se puede proponer se deja vacío y se dice por qué.** Nunca un default disfrazado
   — es la regla que más caro ha salido en este proyecto.
4. ⚠️ **Se mide la tasa de corrección por regla y por fuente.** Si el humano cambia la propuesta más
   de un umbral, esa regla se **suprime sola** (molde `precision_score` de MAAT.2 / Horus L2). Una
   propuesta que se corrige siempre entrena a la gente a ignorar el tablero.
5. ⚠️ **La captura a mano nunca deja de existir.** El autorrelleno es un acelerador, no un embudo:
   si la fuente está caída, la caja sigue operando.

### 8.6 Lo que el autorrelleno desbloquea

**La decisión abierta #1 deja de ser bloqueante.** El mapa de las 122 cuentas de Control →
`(cuenta, concepto)` ya no hay que escribirlo a mano antes de arrancar: se **siembra** con lo
aprendido del Nivel 2 y contabilidad sólo **confirma o corrige** lo que el motor no pudo resolver,
con el soporte a la vista. Pasa de *"alguien tiene que llenar 122 renglones"* a *"alguien tiene que
revisar los N que el motor no resolvió"* — y N se mide antes de pedir la reunión.

---

## 9. Plan de implementación

Ruta crítica: **CG.8 → CG.9 → CG.10b → CG.17 → CG.13 → CG.14**. Lo demás paraleliza.

> Reordenado tras las decisiones del §6 y §8: el sub-módulo de captura (CG.13/CG.14), el vínculo
> con Kepler (CG.10b) y el motor de autorrelleno (CG.17) son la fase. CG.11 (comprobación con OCR)
> baja a paralelo: es valioso pero ya no es el primer paso.

### Etapa 1 — Dejar de mentir (no toca la captura)

#### `CG.8` · Medir la frescura y ponerle latido al carril
- Verificar contra **prod** qué tiene hoy `analytics.caja_general_movimientos` (conteo, `max(fecha)`,
  `max(computed_at)`) — es lo único que esta investigación **no pudo medir** y que la pantalla ya
  está publicando.
- `cron-heartbeat` en `import-caja-general.js` con clave `feed_caja_general`, umbral registrado en
  `CRON_JOBS`. **Con prueba negativa**: romperlo a propósito una vez y ver el rojo (ADR-056).
- **Declarar el rezago en pantalla** con el contrato de procedencia
  (`libs/contracts/http/provenance.contract.ts`). Veredicto ternario: `fresh | stale | unknown`.
- ⛔ Sin esto, todo lo demás se construye sobre una cifra que nadie sabe de cuándo es.

#### `CG.9` · `BDatos.mdb` al carril de réplica (retirar el importer)
- Reusar `access-adapter.js` + `access-mirror.js` de Fase WR. Carril incremental por watermark para
  `Doctos` (append-only por `TipoDto+IdDocto`), hash-delta para `Cuenta` (catálogo).
- `analytics.caja_general_*` pasa de tabla poblada por script a **vista `derive-no-copy`** sobre la
  réplica cruda.
- Alcance completo **2008 → hoy**, no sólo 2026 (hoy perdemos 104,227 movimientos de historia).
- ⚠️ Sigue necesitando Jet 32-bit → **vive en `.249` junto a Wincaja hasta VL.5**, declarado con
  dueño y fecha. No se disfraza de resuelto.

#### `CG.10b` · ⭐ El concepto de Kepler, derivado del ODS — **ruta crítica**
- **Vista `analytics.v_kepler_conceptos`** `derive-no-copy` sobre `kepler_ods.kdco`:
  llave `(cuenta, concepto)` → nombre. Molde exacto: `20260826190000_kepler_accounts_live_view.js`
  (`security_invoker = true`, **filtro de tenant DENTRO de la vista**, gate de costo medido antes de
  convertir). Vista hermana `analytics.v_kepler_centros` sobre `kdc3` si el centro de costo entra al
  alcance.
- ⛔ **Primer paso verificable: confirmar que `kepler_ods.kdco` tiene filas en prod.** Está
  configurado en el carril hash pero **ningún consumidor lo lee todavía** → nunca se comprobó que
  aterrice. Configurado ≠ poblado.
- **`finance.caja_kepler_concept_map`** — las 122 cuentas de Control → `(kepler_cuenta,
  kepler_concepto)`. RLS forzado, molde `finance.caja_bank_crosswalk` (CG.7): propuesta derivada +
  **confirmación humana**, `source ∈ (manual, derivado)`, `confirmed_by` / `confirmed_at`.
- **La cobertura se publica en pantalla**: *"X de 122 cuentas mapeadas · Y sin mapear"*. Sin eso, un
  `NULL` en un `LEFT JOIN` se lee como cero (ADR-056).
- **Prueba de aceptación:** tomar un mes cerrado, sumar el efectivo por `(cuenta, concepto)` y
  cuadrarlo contra `analytics.expense_entries` del mismo mes. Lo que no cuadre **se declara con
  monto**, no se ajusta.

#### `CG.10` · Normalizar el catálogo de Control sin tocarlo
- Vista `analytics.v_caja_cuenta` que **descompone** `1009 Matriz Viaticos` en
  `(concepto = 'Viáticos', sucursal = 'Matriz', cuenta_origen = 1009)`, derivando del prefijo del id
  y validando contra el texto del nombre. **No se materializa una segunda tabla** (§regla principal).
- Lo que no se pueda descomponer se marca `concepto = NULL` con motivo — **nunca se adivina**.
- ⛔ **`acumula_a` se marca como no confiable y se deja de usar** en cualquier rollup (§5.5), hasta
  que exista una jerarquía firmada.
- Publicar la cobertura en pantalla: *"X de 122 cuentas descompuestas"*. Sin eso, un `NULL` en un
  `LEFT JOIN` se lee como cero.

#### `CG.12` · Los defectos, a la bandeja de Maat
- Detectores sobre el espejo → `finance.findings` vía `FINANCE_FINDINGS_SINK_PORT` (el sink ya
  existe, CB.7): `caja_sin_concepto`, `caja_folio_duplicado`, `caja_usuario_generico`,
  `caja_anticipo_sin_comprobar`, `caja_cuenta_sin_descomponer`.
- Cada uno con evidencia y link al movimiento. Feedback L2 (precision_score) ya viene del molde.
- **Valor inmediato sin tocar Access**: los $71.96M sin concepto se vuelven una lista accionable
  el día uno.

### Etapa 2 — ⭐ El sub-módulo: ser el sistema de registro

> Es la razón de ser de la fase (§6). Todo lo de la Etapa 1 existe para que esto se pueda construir
> sobre cifras que no mienten.

#### `CG.17` · ⭐ El motor de autorrelleno — **ruta crítica, antes de la pantalla**
- `CajaAutofillService` con la cascada del §8: contexto → documento → aprendido → reglas → OCR.
  Devuelve **por campo**: `value`, `source`, `confidence`, `support` (n y %), `reason` cuando no
  propone. Nunca un valor pelón.
- **Vista de aprendizaje** (nivel 2) sobre `analytics.expense_entries`: `(beneficiario|rfc|familia)`
  → `(cuenta, concepto)` dominante con su soporte. Derivada, no materializada.
- `finance.caja_classify_rules` + su vista Admin, calcado de `bank_classify_rules` (CB.6).
- **Telemetría de corrección desde el día uno**: qué propuso, qué guardó el humano, por campo y por
  fuente. Sin eso no se puede aplicar la regla 4 del §8.5 y el motor se degrada sin que nadie lo
  note.
- ⚠️ **Prueba negativa obligatoria**: un caso donde el motor **no debe** proponer (soporte repartido)
  y se verifica que deja el campo vacío con motivo. Un gate sin prueba negativa es una intención.
- **Medición de arranque**: correr el motor contra los 12,253 movimientos de 2026 ya capturados y
  reportar **qué porcentaje de campos habría acertado**. Eso dimensiona el ahorro real y el N de la
  revisión de contabilidad (§8.6) **antes** de construir la pantalla.

#### `CG.13` · El libro de caja en `finance.*` — **ruta crítica**
- `finance.cash_ledger` + `finance.cash_ledger_denominations`, `tenant_id` + audit completo + RLS
  forzado, `client_uuid` para idempotencia.
- **Folio atómico** con el patrón `commercial.order_sequences` (UPSERT Postgres) → mata §5.2 por
  construcción.
- ⭐ **`kepler_cuenta` y `kepler_concepto` NOT NULL**, validados contra `finance.kepler_accounts` y
  `analytics.v_kepler_conceptos` (§7.4). **Snapshot del nombre** al guardar, para que un cambio
  posterior del catálogo no reescriba la historia.
- **`glosa` NOT NULL con CHECK de longitud mínima** → mata §5.3 por construcción. El concepto dice
  *a qué cuenta va*; la glosa dice *qué pasó*. Los dos, siempre (§7.5).
- `created_by` = `user_id` real del JWT, no un texto → mata §5.6 por construcción.
- Sucursal y centro de costo como **dimensiones propias**, nunca fundidas en el concepto (§5.4).
- `legacy_cuenta_access` conserva la cuenta de Control para trazar los dos mundos durante el
  traslape.
- **Se conserva tal cual lo que hoy funciona**: desglose por 15 denominaciones y saldo corrido de
  caja. Es lo que convierte la pantalla en un arqueo y la gente ya lo usa así.

#### `CG.11` · Comprobación de gasto con evidencia y OCR *(paralelo, no bloquea)*
- `finance.caja_expense_settlements`: adjunto (imagen/PDF), OCR con `extractRemision()`, cuadre por
  monto contra el anticipo con tolerancia, `status` + validar/rechazar. Calca `collection_deposits`
  de Fase CC línea por línea.
- Ataca los **$4,675,503.50** de `1010` con el aging que hoy no existe.
- Es aditivo: si falla, nada más se cae.

#### `CG.14` · Las 6 pantallas de captura, superficie Operations
- `/finanzas/caja-general` con las mismas 6 operaciones, mismos nombres que la gente ya usa
  (*"Ficha de Efectivo por Cobranza"*, *"Comprobante de Gasto"*…). **Reestructurar es renombrar y
  reordenar, no rediseñar**: el organismo que funciona no se tira.
- Master-detail + tabla densa, tokens de `libs/design-tokens/tokens.css`, `applySmartSearch`.
- Desglose por denominación y saldo corrido: se conservan tal cual.
- ⭐ **El selector de concepto es el control central de la captura.** Buscador sobre
  `v_kepler_conceptos` (`applySmartSearch`), en cascada cuenta → concepto, con los usados
  recientemente arriba. Si teclear el concepto cuesta más que el gasto, la gente va a elegir el
  primero de la lista y habremos cambiado $71.96M sin concepto por $71.96M mal clasificados.
- ⚠️ **Prueba de aceptación de la pantalla**, no del código: un capturista real registra un gasto
  típico en **menos tiempo** que en Access. Hoy hacen 6,981 movimientos al año (Krmn): si se vuelve
  más lento, el sub-módulo fracasa aunque el dato sea perfecto.
- Permisos **propios**: `FINANCE_CAJA_VER` / `_GESTIONAR` / **`_AUTORIZAR`** (este último fuera de
  todo `MODULE_GROUP`, patrón TP.6). Hoy todo cuelga de `FINANCE_BANK_VER`.
- ⚠️ **Un módulo no está entregado hasta que su permiso está REPARTIDO en prod**, no sólo declarado
  en el enum (lección LC.6.2).

#### `CG.15` · Corte de caja con doble llave
- Capturar ≠ autorizar. El corte lo cierra alguien con `_AUTORIZAR`; el capturista no.
- Estados `borrador → cerrado → autorizado`, molde `purchase_book_runs` (LC.6).
- Aviso WS al cerrar con diferencia, vía `FINANCE_NOTIFIER_PORT`.

#### `CG.16` · Corte del Access (sólo el módulo Flujo/Bancos)
- Doble corrida con cuadre al centavo durante un periodo acordado.
- Apagar **sólo** los menús `Flujo` y `Bancos` en `Control` (los otros 5 módulos siguen).
- Reversible hasta el último día. Patrón CV.15.

### Fuera de alcance de esta fase, con nombre

Cobranza de ruta y guías · pagarés · cambio masivo de precios · pedidos y surtido. Son los otros 5
módulos de `Control` y cada uno es su propia fase. **Se declaran aquí para que nadie los dé por
cubiertos.**

---

## 10. Lo que NO se hace, y por qué

| Descartado | Motivo |
|---|---|
| Un importer nuevo | Regla principal del proyecto. El camino es réplica + vista (CG.9, CG.10b) |
| Copiar `kdco` a una tabla nuestra | Es derivable del ODS → **vista**. Molde FKJ (§7.2) |
| Inventar un catálogo de conceptos propio | Kepler ya tiene el suyo y es el que usa contabilidad. Inventar otro es crear una segunda verdad |
| "Arreglar" el catálogo de 122 cuentas en Access | Es el sistema de otro. Se **deriva** (CG.10), no se edita |
| Capturar en los dos lados | Doble folio, doble saldo. Es el camino B del §6, rechazado |
| Reescribir los 164 formularios | 6 son de caja. El resto es otra fase |
| Mapear `Cuenta` → ContPAQi ahora | Necesita a la contadora. Se abre como decisión, no como sprint |
| Tomar `acumula_a` como jerarquía | Medido falso (§5.5) |
| Reusar `Doctos.ConceptoD` | Está en 99.3 % cero/vacío y su catálogo tiene 2 filas basura (§7.3). No hay nada que migrar |

---

## 11. Decisiones abiertas

~~1. **§6: ¿A, B o C?**~~ → **RESUELTA 2026-09-18: camino C** (§6).

1. **¿Quién revisa lo que el motor no resolvió?** ~~Bloquea CG.13~~ → **degradada por el §8.6**: el
   mapa ya no se escribe a mano, se siembra con lo aprendido de `expense_entries` (Nivel 2) y
   contabilidad sólo confirma el resto. Pero **alguien tiene que confirmar ese resto**, y el tamaño
   se mide en `CG.17` antes de pedir la reunión. Sigue siendo una persona, ya no son 122 renglones.
2. **¿El alcance es sólo la sucursal 20, o las 6?** Hoy leemos únicamente
   `20 Comisionistas\Dulceria\BDatos.mdb`. Las otras sucursales tienen su propio `BDatos.mdb` con su
   propio `Doctos`. Cambia el tamaño de la fase por un factor de ~6. **Y cambia el mapa**: cada
   sucursal tiene su propio catálogo de cuentas de Control.
3. **¿El centro de costo (`kdc3`) entra al alcance?** Si sí, es una tercera dimensión en la captura
   y una vista más. Si no, se declara fuera y la caja no podrá explicarse por departamento.
4. **¿`Cuenta` debe amarrarse además a ContPAQi?** Kepler y ContPAQi son dos planes distintos (Fase
   CP). El vínculo pedido es a **Kepler**; si además hace falta ContPAQi, es otro crosswalk HITL
   (molde CP.2 / CB.15).
5. **El historial 2008-2025** (104,227 movimientos): ¿se trae en CG.9 o se declara fuera? ⚠️ Ese
   historial **no tiene concepto de Kepler** y no se lo podemos inventar — entraría marcado
   `concepto = NULL, motivo = 'legacy_sin_concepto'`.
6. **VL.5**: mientras Wincaja siga en `.249`, este carril también. ¿Se resuelven juntos?

---

## 12. Anexos

- Mapa completo tabla → back-end de `Control`, los 5 vínculos muertos, la config y el arsenal de 22
  utilidades Access de Sistemas: memoria `reference_access_control_app_245`.
- El sistema "Base Movimientos SI/NO" (abandonado Q1-2026): `reference_movimientos_finanzas_access`.
- Adapter Access → Postgres: `reference_access_adapter_jet` · [`FASE_WR`](FASE_WR_WINCAJA_REPLICA.md).
- Fuentes exportadas de `Control` (274 objetos: formularios, reportes, módulos VBA, macros), en el
  scratchpad de la sesión del 2026-09-18. **No están versionadas** — si el plan avanza, conviene
  meterlas al repo como referencia congelada.
