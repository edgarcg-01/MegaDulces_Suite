# CAOS — Sistema de manejo de efectivo (caja fuerte inteligente)

> Decode de reconocimiento, **solo lectura**, hecho el 2026-09-24 sobre `http://192.168.0.110`
> con una sesión real por el navegador (usuario `admin`). **No se escribió nada** del lado de
> CAOS: sólo `GET` y abrir detalles. Este documento es lo que se vio, no una integración; si se
> decide integrar, va a tracker con su propia fase.

---

## Qué es

**CAOS 6.72.3** — aplicación web (español, MX) para operar y auditar un **dispositivo de manejo
de efectivo**: una caja fuerte inteligente / reciclador-dispensador de billetes. No es vending
ni checador (las dos hipótesis que el nombre y el menú sugieren primero y que los datos
descartaron).

- **Host:** `192.168.0.110` (LAN interna), HTTP en el puerto 80 — **sin TLS**.
- **Stack aparente:** Node/Express (302 en texto plano, `ETag` estilo Express), frontend jQuery
  3.6.1 + jQuery-UI, cifrado de clave con JSEncrypt (RSA).
- **NO figuraba en el repo ni en la documentación** antes de esto (`grep` de `CAOS` y de la IP:
  cero). Es un sistema que la plataforma no conocía.

El dispositivo integrado es un **`AST700`** (nombre en CAOS: `AST700-19758`) que habla por un
protocolo llamado **`C-Link`**. En la operación real, CAOS registra dos gestos de efectivo:

- **Depósito** — entra efectivo (lo mete un operador; ej. cierres de venta).
- **Dispensar** — sale efectivo, con **detalle por denominación** y una **referencia** libre
  (ej. la tx 1417 salió con ref *"pagos gdl"*).

---

## Por qué nos importa (conexión con Caja General / arqueo)

El detalle de una transacción de *Dispensar* trae exactamente lo mismo que el arqueo de
`/finanzas/caja-general` construido en CG.23:

| Denominación | Cantidad | Total |
|---|---:|---:|
| 20 MXN | 100 | 2,000 |
| 50 MXN | 100 | 5,000 |
| 100 MXN | 250 | 25,000 |
| 200 MXN | 200 | 40,000 |
| 500 MXN | 160 | 80,000 |
| **Total** | | **152,000** |

Son **las mismas cinco denominaciones** (500/200/100/50/20, sin monedas) que la caja de la Suite
cuenta. CAOS es, de hecho, una **fuente independiente y por denominación del efectivo que se
mueve** — el tipo de árbitro que `docs/VERDAD_ABSOLUTA.md` (ADR-059) pide para una cifra de caja:
un hecho de otra fuente contra el cual cuadrar lo que se captura a mano.

⚠️ **No verificado todavía:** si el efectivo que pasa por CAOS es el mismo universo que el de
Caja General (misma caja física, mismas sucursales) o uno distinto (p. ej. sólo CEDIS / "pagos
gdl"). Antes de cruzar cifras hay que establecer **qué caja física es CAOS y de qué sucursal**,
igual que se hizo con `c45`/Caja General. No cruzar por ahora.

---

## Mapa de la interfaz (lo que se vio)

Menú superior: **Usuarios · Reportes · Ajustes · Autorizaciones · Herramientas · ? · Administrator**

### Reportes (submenú)
- **Transacciones** (`/Reports/report-TransactionsList`) — el reporte principal.
- **Contenidos** (`/Reports/report-Countings`) — el inventario VIVO por casete. Datos: `GET /Reports/report-Countings/getCounting` → `machineCashList[].stocksContent[]` (`index`, `content[]` denom×quantity, `miscount`, `fillPerc`) + `bagsContent[]`. Abierto el 2026-10-20: 8 casetes, $360,020.00, igual al replay de flujos (`FASE_CGA_PLAN_IMPLEMENTACION §11.2.1`).
- **Estatus** · **Info Equipo** · **Visor de Eventos** · **Balance de Usuarios** ·
  **Contabilidad de Canales** (no abiertos en esta pasada).

### Reporte de Transacciones
- **Filtros:** rango Fecha/Hora inicio–fin (default = el día de hoy), `ID de Usuario`,
  `Info de Usuario`, `ID de Canal`, `ID de Turno`, `Tipos de transacción`.
- **Columnas:** `Numero de Op.` · `Fecha` · `Fecha de Contabilidad` · `Usuario` · `Tipo` ·
  `Total`. Cada fila expande a **Detalle de Efectivo** (Denominación / Cantidad / Total) +
  **Referencia de Transacción**.
- **Balance** del rango arriba de la tabla (ej. `-15950.00 MXN` para el 2026-09-24: los depósitos
  menos los dispensados).
- Nota: hay dos fechas por operación — la de captura y la **`Fecha de Contabilidad`**, que es la
  que importa para cuadrar contra un período (mismo patrón que `kdm1.c9` vs `c68` en Kepler).

**Ejemplo real del 2026-09-24** (24 h): depósitos de `Maria del Carmen Rdriguez Vera (003)` y
`Vendedor (006) - VENTAS` en el rango de $10k–$28k c/u, más dos *Dispensar* grandes ($152,000 ref
"pagos gdl" y $59,520). Balance del día `-15,950.00 MXN`.

### Integraciones (`/Settings/Integrations/integrations`) — la página del pedido
Tabla **Activo · Nombre · Nombre del Dispositivo · Tipo** con acciones (info / editar / borrar) y
un `+` para agregar. Una sola integración configurada:

| Activo | Nombre | Dispositivo | Tipo |
|---|---|---|---|
| ✓ | C-Link | AST700-19758 | C-Link |

Es donde se da de alta el/los dispositivos de efectivo. **No se editó nada.**

---

## Hallazgos de seguridad (van tal cual, son parte del "documentarlo")

1. ⛔ **Credenciales por defecto:** entra con `admin` / `caos`. Es una consola con **control de un
   dispositivo de efectivo** (puede *dispensar* billetes). Cambiar esa clave es lo primero.
2. ⛔ **Todo por HTTP plano**, sin TLS, en la LAN.
3. ⚠️ **El "cifrado" del login no protege de replay:** la clave se cifra en el navegador con una
   **llave pública RSA incrustada en la propia página de login** (`pubKey` en
   `/Script/Login/loginUtils.js`) y viaja por HTTP. El blob cifrado que se manda a
   `POST /adminlogin` es **reutilizable tal cual** por quien vea el tráfico — el cifrado asimmétrico
   del lado del cliente sólo evita mandar la clave en claro, no un replay. Sobre TLS esto sería
   defendible; sin TLS, no agrega protección real.
4. La contraseña por defecto viajó por chat en esta sesión → **rotarla igual**, además de por
   ser default.

---

## Integración: SÍ es factible — la API interna ya está mapeada (2026-09-24)

La app tiene una **API JSON interna limpia** detrás de la sesión. No es API oficial documentada:
son los endpoints AJAX que consume su propio frontend. El patrón de integración es idéntico al de
**MagniTracking / flota (ADR-034)**: *no hay API oficial → un adapter replica el login de sesión y
llama los endpoints internos*. Ya funcionó ahí; funcionaría acá.

### Endpoints medidos (todos POST/GET a `192.168.0.110`, auth por cookie de sesión de `/adminlogin`)

| Endpoint | Qué devuelve |
|---|---|
| `GET /Reports/report-TransactionsList/getConfiguration` | Catálogo: **18 tipos** de transacción (id→label), lista de dispositivos, formato de moneda, flags (`channelsEnabled`, `sharedDBEnabled`…). |
| `POST /Reports/report-TransactionsList/getTransactions` | La lista de movimientos. Body: `{startDate,startTime,endDate,endTime,userID,transactionTypes[],devices[]}` (fecha `YY/MM/DD`). Devuelve `transactions.compactTransactions[]`. |
| `POST /Reports/report-TransactionsList/getTransactionDetails` | Body `{transactionID}`. Devuelve `transactionDetails` con **`cashDetails[]`** (denom/quantity/type B=billete), `cheques[]`, `tickets[]`, `ref`, `executedBy`, `shiftID`. |

**Forma de una transacción (`compactTransactions[]`):**
`devName · id · date · accountingDate · user · transactionTotal[] · type · channelName/ID · shiftID`.
El `id` es una **secuencia contigua** (sirve de watermark incremental para un feed sin churn).

**Detalle (`cashDetails[]`):** `{ currency, denom, type:"B", quantity, class, rollSize }` — el arqueo
real por denominación que hace la máquina.

### Historia y volumen (medido en vivo, rango 2026-01-01 → 2026-12-31)

- **977 movimientos**, del **27/05/2026** al 24/09/2026 (~4 meses vivos, ~8/día). IDs 449→1425.
- Por tipo: **Depósito 648 · Dispensar 307** · Dotar 11 · Vaciar Stocks 6 · Cambio 4 · Contenido
  Modificado 1.
- Dinero movido en esos 4 meses: **Depósitos $15.91M · Dispensado $15.57M** · Vaciar Stocks $2.35M
  · Dotar $1.50M. ≈ **$4M/mes de rotación de efectivo.**
- Operadores: `Vendedor (006) - VENTAS` (494), `Maria del Carmen Rdriguez Vera (003)` (392),
  `Juan Jesus Carrillo Contreras (002)` (90), `caos` (1, sistema).

### Cómo se integraría (recomendación, NO ejecutado — es una fase con ADR)

Igual que la flota: un **adapter detrás de un puerto** (`CASH_SAFE_PROVIDER_PORT`) que hace login,
pagina `getTransactions` por rango, enriquece con `getTransactionDetails` y **escribe a una tabla
propia** (dato de un sistema externo, con `tenant_id` + audit; no es vista sobre `kepler_ods`, así
que NO aplica derive-no-copy — aplica la excepción de "sistema externo", como
`logistics.vehicle_positions`). Feed incremental por el `id` como watermark (UPSERT sin churn).
Cambiar de marca de caja = cambiar sólo el adapter.

---

## Cuánto valor da (evaluación)

**Alto, y cae exactamente en el dominio de finanzas que ya venimos trabajando.** Cuatro usos
concretos, en orden de valor:

1. ⭐ **Árbitro del arqueo de Caja General (ADR-059).** Hoy el arqueo de `/finanzas/caja-general`
   (CG.23) es un conteo **a mano** de billetes. CAOS tiene el **conteo de la máquina**, por
   denominación, por usuario, con hora. Cruzar máquina-vs-mano es *la* forma de cazar faltantes y
   errores de captura de efectivo — es literalmente para lo que existe el arqueo ciego. Mismas 5
   denominaciones (500/200/100/50/20), así que cuadra directo.
2. ⭐ **Pierna de conciliación bancaria (Fase CB).** Los tipos **"Bóveda Virtual" (depósito/
   dispensación)** son el mecanismo por el que una smart-safe acredita el efectivo al banco antes
   de la recolección física. Un depósito en CAOS debería aparecer como abono bancario → se concilia
   contra `finance.bank_*`.
3. **Rendición por persona / detección de fraude (Maat).** Cada depósito y cada *Dispensar* lleva
   usuario, hora y referencia. Un *Dispensar* de $152,000 con ref "pagos gdl" es una salida de
   efectivo que debería atarse a una obligación de pago (Calendario TP) o levantarse como hallazgo
   si no cuadra.
4. **Trazabilidad del efectivo del CEDIS/tesorería** que hoy no vive en Kepler ni en Wincaja: es un
   circuito propio de la caja fuerte.

### ⛔ Anclaje de negocio — SUPERADO el 2026-10-15. Son DOS cajas, no una

> **Lo que decía este bloque (respuesta del usuario, 2026-09-25):** *«CAOS **ES** la Caja General de
> OFICINAS (sucursal `00`)… son tres vistas del mismo dinero»*, y de ahí *«como CAOS* es *la Caja
> General, sus movimientos NO se agregan como asientos nuevos al libro — eso sería doble conteo»*.
> Se deja escrito porque la frase se citó para decidir, y borrarla deja el razonamiento sin origen.

**El modelo vigente son dos cajas** (`VERDAD_ABSOLUTA §28`, `FASE_CG_PLAN_POR_CAPAS §1.1`):

- **el cajón** — el efectivo de oficina, que **se cuenta a mano** por denominación; y
- **la bóveda CAOS** — la máquina. ⚠️ Acá decía que «publica flujos y nunca el saldo»: es falso, publica su contenido por casete (ver «El saldo de la máquina», 2026-10-20).

⭐ **El propio documento ya lo había medido tres párrafos más abajo y la cabecera no se actualizó:**
por CAOS pasa **~40%** del efectivo de la Caja General, sin llave común con la contabilidad. Un
subconjunto del 40% no *es* el conjunto. *Una conclusión medida que no sube al encabezado deja la
afirmación vieja gobernando a quien sólo lee el encabezado.*

✅ **Lo que sobrevive, y por qué:** los movimientos de CAOS **no se agregan como asientos nuevos** al
libro — pero no porque CAOS sea la Caja General, sino porque son las **dos piernas** que mueven
efectivo **entre** las dos cajas.

### ⛔⛔ Una dispensación NO es un ingreso de Caja General. Lo que llega es la DIFERENCIA

> ⛔ **Corrección del 2026-10-15, de Edgar, repetida varias veces y escrita acá para que no haya que
> repetirla más:** *«al corte de Caja General no se le considera lo dispensado en CAOS, al menos en
> ingreso; si [es] egreso y existe un sobrante, se le carga a Caja General»*. Y en `[CG.96]`, con las
> mismas palabras: *«si sobra se regresa a CAOS, si no se carga al arqueo de caja general»*.
>
> ⚠️ **Acá mismo decía lo contrario** (*«dispensado SUMA al cajón»*, con la fórmula suelta), que es la
> lectura que convierte la dispensación en un ingreso. **El modelo correcto es el de abajo.**

**La máquina sólo mueve BILLETES. El cajón pone y recibe la MORRALLA.** Todos los montos de CAOS son
múltiplos de 20; monedas no maneja, en ninguna dirección. De ahí sale todo lo demás:

| Lo que pasa | Pierna CAOS | Pierna libro | **Lo que llega al cajón** |
|---|---|---|---|
| Gasto financiado con una dispensación | dispensó $32,220 | nómina $32,237 | **−$17** (la morralla la puso el cajón) |
| Gasto con dispensación de más, no devuelta | dispensó $14,000 | gasto $13,803.05 | **+$196.95** de **sobrante**, que *se le carga a Caja General* |
| Cobro de ruta depositado en la máquina | tragó $15,510 | ingreso $15,542 | **+$32** (sólo las monedas) |
| Gasto pagado con dispensación, **devuelto el sobrante** | dispensó y recibió | el gasto | **$0** |

⭐ **La dispensación y su egreso se cancelan.** Por eso el cajón no «recibe» los $32,220: recibe
−$17. La fórmula del motor (`cash-cut.engine.ts`, `[CG.95]`/`[CG.96]`) es
`fondo + ingresos − gastos − depósitos + dispensado − depositado`, pero **el término bruto no es el
resultado**: su par del libro lo anula, y lo único que sobrevive es la diferencia. Leer `+ dispensado`
suelto —como hacía este archivo, y como todavía hacen el plan por capas §1.3 y `VERDAD_ABSOLUTA §28.6`—
es leer medio renglón.

⛔⛔ **Y esa cancelación tiene una condición que hoy NO se cumple en el corte: las dos piernas tienen
que caer en la MISMA jornada.** El corte filtra el libro por `cash_ledger.fecha`, que es **la fecha
del documento de Kepler** (`[CG.82]`: el ERP captura con una mediana de **3 días** de rezago), y a
CAOS por `accounting_date`, que es el **día físico**. Cuando difieren, la dispensación cae en un corte
y su egreso en otro: el primero pide contar efectivo que ya se gastó (**faltante inventado**) y el
segundo sobra por el mismo monto. Detalle y medición en
[`FASE_CG_CAJA_GENERAL`](IMPLEMENTACION/FASES/FASE_CG_CAJA_GENERAL.md), «Review del plan por capas».

⛔ **Lo que NO sobrevive:** «CAOS es el árbitro de la contabilidad». La medición del 2026-09-25 (abajo)
refutó el matcher 1:1 **y** el árbitro por totales. El árbitro del arqueo es `VERDAD_ABSOLUTA §28`,
con el grano **hora por hora**, no el día (§28.10, trampa nº 1).

### ⭐ MEDICIÓN 2026-09-25 (en `md`, contra prod) — el árbitro naïve queda REFUTADO

Se corrió `database/importers/caos/measure-caos-match.js` en `feeds-cron` (alcanza CAOS + prod),
con placebo. Resultado:

- **Match 1:1 por importe+fecha: 0%. Incluso por importe solo: 0%** (649 depósitos CAOS × 12,053
  movimientos de caja `0011`). No es bug de escala (ambos en pesos, verificado con muestras). Es
  **diferencia de GRANO**: CAOS registra depósitos/dispensaciones **en bulto** y redondos
  ($19,010, $9,700 — contados por la máquina); Kepler caja `0011` registra movimientos
  **individuales** con centavos (cobros `U-A-5` $20,106.00, gastos `X-D-26` $3,747.66). Es el
  mismo patrón "banco = bulto, Kepler = por venta" ya visto en conciliación. → **el matcher
  movimiento-a-movimiento NO sirve.**
- **Total de control del período:** CAOS depósitos **$15.9M** vs Kepler caja ingresos **$41.1M**
  (ratio **0.39**); CAOS dispensado **$15.6M** vs egresos **$39.0M** (ratio **0.40**). O sea:
  **por CAOS pasa sólo ~40% del efectivo de la Caja General**; el resto de `0011` se maneja fuera
  de la máquina. Diario: de 90 días con actividad en ambos, sólo **34%** quedan dentro del 15%. →
  **un árbitro "CAOS total == Kepler caja total" también daría ~60% de falsos hallazgos.**
- **Hallazgo colateral útil:** el 2026-09-24 CAOS ya tenía datos y Kepler caja `0011` estaba en
  $0 — **CAOS es MÁS FRESCO** que el feed contable para ese efectivo.

**Conclusión (honesta):** CAOS **no es un espejo** de la Caja General — es el **subconjunto** de
efectivo que pasa físicamente por la caja fuerte (~40%), sin llave común con la contabilidad. Un
árbitro automático que marque diferencias sería casi todo ruido.

### Lo que SÍ es viable (revisado por la medición)

- ✅ **CS.2 reporte** (entregado) — la vista por denominación, más fresca que Kepler.
- ✅ **CS.6 atribución por ruta / CS.7 rendición por persona** — son INTERNAS a CAOS (`ref "ruta NN"`,
  operador, propósito); no cruzan contra nada, así que no tienen el problema del grano. Valor real
  y seguro.
- ⚠️ **CS.4 árbitro / CS.5 banco: NO como se planearon.** Requieren una respuesta OPERATIVA:
  **¿qué se supone que pasa por CAOS y qué no?** Sin eso, lo máximo honesto es un **tablero de total
  de control** (CAOS vs Kepler caja lado a lado, informativo), no hallazgos automáticos. Además los
  tipos "Bóveda Virtual" **no aparecen** en los datos reales (sólo Depósito/Dispensar/Dotar/Cambio/
  Vaciar), así que CS.5 probablemente no aplica en esta instalación.

### CS.4 (2026-09-25) — cuadre de TOTAL DE CONTROL, no árbitro 1:1

Construido como lo que la medición permite: `GET /finance/caos/conciliacion` + pestaña «¿Cuadra?»
compara por día/período Σ CAOS vs Σ Kepler caja `0011` (suc 00) y **publica la cobertura** (~39%
depósitos / ~40% dispensado). Es **informativo, sin hallazgos automáticos**: marcar movimiento por
movimiento daría ~60% de falsos (CAOS es el subconjunto que pasa por la máquina). Se declara además
el rezago del feed (el último día puede verse descuadrado por lag contable, no por error).

### CS.5 (2026-09-25) — NO viable con los datos actuales (medido, declarado)

Medido contra prod: **no hay camino de datos para conciliar CAOS contra banco.**
- Los tipos "Bóveda Virtual" (el mecanismo de acreditación al banco) **no aparecen** en esta
  instalación (sólo Depósito/Dispensar/Dotar/Cambio/Vaciar).
- `finance.bank_movements` existe (Fase CB), pero sus abonos son otro universo: la cuenta
  "CAJA GENERAL" del banco tiene **$77.3M** de abonos vs los **$15.9M** de depósitos de CAOS
  (~20%), sin llave común y a otro grano.
- El efectivo de CAOS es cash que ENTRA a la caja fuerte (de rutas), no un depósito bancario; el
  puente físico caja→banco (recolección/CIT → abono) no está en los datos de CAOS.

Para hacerlo viable haría falta: los datos de recolección/ficha de depósito (qué bulto fue a qué
depósito bancario) **o** una definición operativa del mapeo. Hasta entonces, CS.5 queda declarado
como no construible — no se hace un cuadre hueco.

### ⭐ El saldo de la máquina (`[CGA-A.33]`, 2026-10-20)

**Lo que decía `VERDAD_ABSOLUTA §28.8` —«la bóveda publica flujos y nunca el saldo»— era falso.**
El equipo publica su contenido en tres lugares: el reporte «Contenidos» (`getCounting`, vivo, por
casete), cada `Fin de Dia` (una foto) y el detalle de cada `Vaciar Stocks` (lo que sacó).

- **Signos, medidos contra el equipo:** Depósito y Dotar suman; Dispensar y Vaciar Stocks restan;
  Fin de Dia es una foto (no mueve dinero); Cambio y Contenido Modificado quedan sin decodificar.
  El mapa vive en `libs/finance/src/lib/caos/caos-saldo.ts` y es la única fuente.
- **El 2026-10-20 10:04 MX la máquina dijo $360,020.00** (8 casetes, sin `miscount`) y el replay
  de los 44 movimientos desde el último vaciado dio el mismo vector, billete por billete.
- **En la suite:** el demonio `caos-live` guarda la foto en `analytics.caos_cash_counts` y
  `/finanzas/caos` publica el saldo con sus tres testigos separados (máquina · cuadre contra
  movimientos · conteo físico, que no existe y se declara). Detalle y prueba:
  `IMPLEMENTACION/FASES/FASE_CGA_PLAN_IMPLEMENTACION.md` §11.2.1–11.2.3.
- ⛔ **Lo que falta para la verdad absoluta:** un conteo humano a ciegas en el próximo vaciado.
  Que dos lecturas del mismo equipo coincidan no prueba que el billete esté adentro — en
  septiembre el equipo corrigió su propio registro −$25,420.

### Pendiente

- ⛔ **La clave de fábrica `admin`/`caos` SIGUE ACTIVA** — verificado el 2026-10-20 al leer el
  reporte «Contenidos» desde la LAN. Rotarla exige actualizar el secreto `ingest-env` de `caos-live`
  en la misma ventana, o el demonio queda sin sesión (y lo dice: late en `error`, `[CGA-A.14]`).

- **Mapear operadores** (`003`/`006`/`002`) a `identity.users` — para CS.7.
- **Desplegar app** (`prod-api` + `view` en `md`) para que el reporte + CS.4/CS.6/CS.7 se vean —
  bloqueado por la compuerta de Production Deploy; lo corre el usuario. + re-login (permiso en JWT).
- **Rotar `admin/caos`** (login compartido — coordina 0Sistemas).
- **Mapear los usuarios de CAOS** (`003`, `006`, `002`) a `identity.users`.
- **`accountingDate` vs `date`, TZ y retención** no verificados — cuál manda para cuadrar un período.
- **Riesgo de adapter:** son endpoints internos de CAOS 6.72.3, sin contrato. Una actualización de
  CAOS puede cambiarlos (mismo riesgo asumido y documentado para la flota).
- **Secretos/seguridad:** un poller guardaría credenciales de CAOS; hoy la caja está en HTTP plano
  con clave por defecto. Antes de un feed automático: rotar la clave y, idealmente, TLS.

**Veredicto:** vale la pena. Es una fuente de verdad de efectivo, independiente, por denominación y
por persona, de ~$4M/mes, directamente enchufable al arqueo y a conciliación bancaria. La
integración es de esfuerzo medio (adapter + tabla + feed incremental, patrón ya probado en flota),
y el bloqueante real no es técnico sino de negocio: anclar a qué caja/sucursal corresponde.

---

## Evidencia

Respuestas crudas de la API (no versionadas, en la raíz del working dir): `caos-getTransactions-response.json`,
`caos-getTransactionDetails-1417.json`. Capturas: `caos-integrations.png`, `caos-transacciones.png`,
`caos-transacciones-datos.png`, `caos-tx-detalle.png`.

---

## Control de retiros: qué permite CAOS y cómo está configurado hoy (revisado 2026-10-23)

> Revisión **sólo lectura** con sesión de administrador por Playwright: se abrieron
> `Ajustes › Modo de Trabajo`, `Autorizaciones`, `Usuarios del Dispositivo` y se leyeron los mismos
> `getConfiguration` que la consola pide al cargar. **No se guardó nada.**

### ¿Se puede ordenar un retiro desde fuera? — NO. ¿Se puede APROBAR desde fuera? — SÍ.

- La consola **no tiene ninguna función para iniciar un retiro** a distancia. El retiro siempre se
  inicia en la pantalla del equipo, por un operador con sesión.
- Lo que sí existe es una **bandeja de autorizaciones**: cuando una solicitud de retiro excede el
  límite del grupo del operador, el equipo la deja **esperando aprobación** y aparece en
  `Autorizaciones › Autorizaciones Pendientes`. Endpoints (leídos del JS de la página, **no ejercidos**):
  - `GET /Authorizations/PendingRequests/getPendingRequests` — la bandeja.
  - `POST /Authorizations/PendingRequests/setApproval` `{ requestID, approved: true|false }` — aprobar o rechazar.
- La reserva caduca: `reservationPermanence = 15` min (la solicitud no atendida se cancela sola).
- **Tabla de retardos:** solicitudes de **≥ $250,000** esperan **300 s** antes de entregar.

⭐ O sea: la suite **podría ser la que aprueba** cada retiro (con firma, monto y referencia
registrados de nuestro lado) llamando `setApproval`. Es control **previo**, no conciliación posterior.
⚠️ NO MEDIDO: el comportamiento real de la bandeja (la vimos vacía), el formato de `getPendingRequests`
con una solicitud viva, y si `setApproval` exige algo más que la cookie de sesión.

### Cómo está configurado HOY — el control existe y está apagado

Grupos del dispositivo (`GET /Function/Users/getAllDeviceGroups`, `allowedFunctions` decodificado con `functionsMap`):

| Grupo | ¿Dispensa? | Límite diario | Pide autorización al exceder | Usuarios |
|---|---|---|---|---|
| **GERENTE** | **Sí** (+ Vaciar Stocks, Dotar, Gestión de Usuarios, Config. de dispositivo) | `0` | **No** (`requestAuthIfReqExceedsPeriodLimit = 0`) | 001, 002, 003 |
| SUPERVISOR | Sí | $2,000 (op. ≤ $500) | No | — (nadie) |
| Aux Caja | No (sólo depósito) | — | — | 004, 005 |
| Vendedores | No (sólo depósito) | — | — | 006 |
| INGENIERO | No (servicio técnico) | — | — | 950210 (proveedor) |

- ⛔ **Los tres usuarios que retiran están en GERENTE, sin límite efectivo y sin autorización.**
  Los retiros de $152,000 registrados confirman que en la práctica no hay tope.
  (`dailyLimit = 0` en GERENTE vs `-1` en otros: semántica exacta **no verificada**.)
- ⛔ **Nadie tiene "Dispensar por"** y no hay **doble autenticación** para retiros: el
  login auxiliar (`auxiliaryLoginType = 0`) está apagado y su lista de operaciones ni siquiera
  incluye *Dispensar*.
- ✅ **Referencia obligatoria** en Depósito y Dispensar (`transactionRefEnabled`, ops `deposit`,
  `withdrawal`) — es lo que alimenta el matcher CS.3. Texto libre, no único.
- ⚠️ Contraseñas: `passwordLength = 0`, `maximumLoginAttempts = 0`, vigencia `0` → sin largo mínimo,
  sin bloqueo por intentos, sin caducidad.

### Qué habría que cambiar (decisión de Dirección/Tesorería, no técnica)

1. A GERENTE: fijar un **límite** y prender **«pedir autorización al exceder el límite»**. Con
   límite bajo, **todo** retiro cae a la bandeja.
2. Decidir **quién aprueba**: un admin en la consola, o la suite vía `setApproval` (fase con ADR;
   requiere TLS o al menos rotar la clave `admin` — hoy el login es replayable sobre HTTP).
3. Contraseñas con largo mínimo y bloqueo por intentos.
