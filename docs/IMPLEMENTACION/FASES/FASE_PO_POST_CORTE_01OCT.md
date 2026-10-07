# Fase PO — Ajustes posteriores al corte del 1 de octubre de 2026

> **Estado:** 🔨 DISEÑADO (planeación) · 2026-10-02 · sin código todavía
> **Para quien llega en frío:** este documento es autocontenido. No hace falta leer otra
> conversación: todo lo que se afirma acá dice **cómo se midió** y **cómo re-verificarlo**.

---

## 1. Qué pasó el 1 de octubre (el hecho de negocio)

Contexto dado por el usuario (Edgar) el 2026-10-02, textual en lo esencial:

> *Del 1 de enero de 2026 al 30 de septiembre de 2026 la sucursal `00` funcionó como
> **concentrador** para transitar la migración entre Wincaja y Kepler conforme iban avanzando.
> A partir del 1 de octubre deja de hacerla de concentrador y sólo recibe la operación de
> **CEDIS, logística y corporativo**. Las otras sucursales, conforme iban avanzando, sólo
> operaban como **puntos de venta y resguardo de inventario y cuentas por cobrar**. A partir
> del 1 de octubre toda la operación se lleva por **centro de costo independiente** y
> SuiteMegaDulces hace de concentrador de toda la operación.*

En una línea: **el `00` dejó de ser el embudo por el que pasaba todo.**

---

## 2. Por qué eso rompe cosas que hoy se ven bien

Durante enero–septiembre, filtrar `sucursal = '00'` era **correcto**: ahí estaba todo. Varias
vistas del repo codificaron esa realidad.

⛔ **Esas vistas siguen filtrando a `'00'`.** Desde el 1 de octubre eso ya no es «todo»: es
CEDIS + logística + corporativo. Lo que emiten los centros de costo nuevos **queda fuera, sin
un solo error**. Las pantallas no se rompen — muestran menos filas, y nadie tiene con qué
notarlo.

⚠️ **No fue un descuido de nadie.** Fue una decisión correcta para un periodo que terminó. El
error sería dejarla, no haberla tomado.

---

## 3. Lo medido (2026-10-02)

### 3.1 Método

Contra el catálogo de `platform_local` (`DATABASE_URL_NEW`), leyendo la definición real de cada
vista con `pg_get_viewdef()` y buscando el patrón `sucursal = '00'` / `btrim(c1) = '00'`.

```
64 vistas y matvistas revisadas en analytics, kepler_ods, finance, commercial
 6 resultaron ancladas a la sucursal 00
```

### 3.2 El inventario

| Vista | Anclas al `00` | Usa `c1 = sucursal` | Consumidores (`.ts`) | Estado |
|---|---:|---|---:|---|
| `analytics.erp_goods_receipts` | 1 (join de dedupe, legítima) | **SÍ** | 20+ | ✅ **ya corregida** |
| `analytics.erp_goods_receipts_lean` | 1 (ídem) | **SÍ** | — | ✅ **ya corregida** |
| `analytics.kepler_cancelled_docs` | **4** | no | 3 | ⛔ pendiente |
| `analytics.erp_supplier_payments` | 2 | no | **16** | ⛔ pendiente |
| `analytics.erp_collections` | 2 | no | **11** | ⛔ pendiente |
| `finance.kepler_accounts` | 1 | no | 3 | ⛔ pendiente |

### 3.3 ⚠️ Caveat grande sobre este inventario

**Se midió contra `platform_local`, no contra prod.** Y se comprobó que local **va atrasada**:
la migración `20261001290000_goods_receipts_con_origen.js` **no está aplicada** ahí, así que
localmente esa vista todavía se ve anclada mientras que su archivo ya está corregido.

⛔ **Lo primero que hay que hacer es re-correr el escaneo contra prod.** El conteo de arriba es
una hipótesis fundada, no el estado de producción. Script listo:
`database/scripts/check-corte-01oct.js` (ver §7).

---

## 4. El arreglo canónico — y por qué NO lleva fecha

### 4.1 La forma correcta ya existe en el repo, dos veces

La migración **`[DM.19.3]` del 1 de octubre** (`20261001290000_goods_receipts_con_origen.js`)
desancló `erp_goods_receipts` **sin usar ninguna fecha de corte**. Usó esto:

```sql
AND btrim(ap.c1) = ap.sucursal      -- el documento es de SU plaza
```

Y `analytics.expense_documents` ya usaba exactamente la misma forma desde antes.

### 4.2 Por qué funciona en las dos épocas sin saber el día del corte

| Época | Qué pasaba | `btrim(c1) = sucursal` |
|---|---|---|
| ene–sep 2026 | todo concentrado en `00`, con `c1 = '00'` | ✅ se cumple (`'00' = '00'`) |
| desde oct 2026 | cada centro emite con su propia clave | ✅ se cumple (`'03' = '03'`) |

**Una sola condición cubre las dos eras.** No hay constante de fecha que mantener en seis
lugares, ni que recordar actualizar.

### 4.3 ⛔ Por qué se RECHAZA la solución con fecha

La primera propuesta de esta fase fue un filtro consciente de la fecha:

```sql
(fecha < '2026-10-01' AND sucursal = '00') OR fecha >= '2026-10-01'   -- ❌ NO
```

Se descartó por dos razones medidas:

1. **Mete una constante en N lugares.** Seis copias de la misma fecha es seis lugares donde
   corregir mal.
2. ⚠️ **La columna de fecha es una trampa.** `docs/ERP_KEPLER.md` lo documenta: `kdm1.c9`
   (fecha del documento) **puede venir en el FUTURO** — medido hasta `2026-12-31`. Un corte
   sobre `c9` clasificaría documentos de septiembre como posteriores al corte. La columna que
   sirve para ventanas es `c68` (fecha de captura). La forma `c1 = sucursal` **elimina** ese
   cabo suelto en vez de administrarlo.

---

## 5. Las cuatro pendientes, por riesgo (no por tamaño)

### 5.1 `analytics.kepler_cancelled_docs` — **primero, aunque tenga menos consumidores**

**4 anclas**, 3 consumidores. Es el único que **afirma de más**: si lo cancelado en las plazas
nuevas no se ve como cancelado, **sigue contando como vivo**. Los otros tres muestran de menos
—se nota— éste infla.

### 5.2 `analytics.erp_supplier_payments` — **16 consumidores**

Pagos a proveedor (`X-D-25/26/60` filtrados a `c10 LIKE 'C%'`). El mayor radio de impacto.
⚠️ Ojo: además del ancla al `00`, esta vista es la base del expediente de pagos de Compras —
coordinar con quien esté en eso.

### 5.3 `analytics.erp_collections` — **11 consumidores**

Cobranza (Fase CC, `U-A-5`). Si las plazas nuevas cobran y no se ve, la cartera queda
sobredeclarada.

### 5.4 `finance.kepler_accounts` — catálogo

1 ancla, 3 consumidores. Rompe **clasificación**, no conteo: las cuentas de los centros nuevos
no existen para la app, así que lo que las use cae a «sin clasificar».

---

## 6. Cabos sueltos que harían ruido después

### 6.1 ⛔ ¿El dato siquiera llega al ODS?

Las vistas derivan de `kepler_ods`, que se alimenta de réplicas por sucursal. **Si una plaza
nueva emite documentos pero su réplica no está en el carril, la vista corregida sigue vacía.**

Son **dos problemas distintos** (el filtro y la ingesta) y producen **exactamente la misma
pantalla**. Arreglar uno sin verificar el otro deja el trabajo hecho a medias y pareciendo
completo. **Verificar los dos antes de declarar nada.**

### 6.2 Las llaves pueden colisionar

`docs/ERP_KEPLER.md` documenta: *«el folio colisiona entre doctypes de egreso»* — `0000011`,
`0000029`… existen a la vez en `X-A-45`, `X-D-26` y `X-D-60` — y que la llave real de un
movimiento de tesorería es **`(sucursal, doc_tipo, folio, clave_banco)`**.

Mientras todo vivía en el `00`, `(sucursal, doc_prefix, folio)` alcanzaba. Con N centros
emitiendo hay que **medir si sigue siendo único antes** de que un UPSERT pise una fila.

### 6.3 Las comparaciones cruzan el corte

Cualquier KPI de «este mes contra el anterior» va a ver un salto cuando las vistas empiecen a
traer todas las plazas, y **se va a leer como crecimiento**. No lo es: es cobertura.

El repo ya tiene el mecanismo —`comparable: false`, de `[IC.8]`— y hay que **marcarlo antes**,
no explicarlo después de que alguien lo presente en una junta.

### 6.4 Centros fuera de catálogo

La vista corregida (`erp_goods_receipts`) ya declara `centro_fuera_de_catalogo` y
`sin_centro` sobre un catálogo de **138 centros** (`c12`). **Las otras cuatro no tienen ese
concepto**: un centro que no esté en el catálogo va a caer en `NULL` y leerse como «no hay
problema» (ADR-056).

### 6.5 Hay otras dos sesiones en el mismo corte

| Track | Qué cubre | Señal |
|---|---|---|
| `IC.CEDIS.1` … `.12` | inventario, CEDIS Wincaja→Kepler | commits muy recientes |
| `DM.19.1` … `.3` | origen de plaza (`c12`), ya desancló goods receipts | `20261001290000` |

**Coordinar antes de tocar.** Esta fase (PO) se queda en el lado de **documentos** —las cuatro
vistas de §5— y no entra a inventario ni al resolvedor de origen.

---

## 7. El plan, de menor a mayor esfuerzo

| # | Item | Migración | Esfuerzo | Depende de |
|---|---|---|---|---|
| **PO.0** | **Medir contra prod**: re-correr el escaneo + contar documentos post-01-oct fuera del `00` en el ODS | ninguna | ~30 min | acceso de lectura a prod |
| **PO.1** | `kepler_cancelled_docs` adopta `c1 = sucursal` | 1 vista | ~1 h | PO.0 |
| **PO.2** | `erp_supplier_payments` ídem | 1 vista | ~1 h | PO.0 + coordinar con Compras |
| **PO.3** | `erp_collections` ídem | 1 vista | ~1 h | PO.0 |
| **PO.4** | `finance.kepler_accounts` ídem | 1 vista | ~1 h | PO.0 |
| **PO.5** | **Compuerta**: una prueba que falle si alguien vuelve a anclar una vista al `00` | ninguna | ~2 h | PO.1–4 |
| **PO.6** | Marcar `comparable:false` en los KPI que cruzan el 1-oct | a definir | ~medio día | PO.1–4 |
| **PO.7** | Verificar unicidad de llaves con N centros emitiendo | a definir | ~medio día | PO.0 |

**PO.0 es un prerrequisito duro, no un trámite.** Si el conteo da **cero documentos fuera del
`00`**, el problema no es el filtro sino la ingesta, y el orden del plan cambia entero.

**PO.5 importa más de lo que parece.** Esto ya volvió a pasar una vez (la vista de goods
receipts se desancló, las otras cuatro no). Sin compuerta, vuelve.

### Cómo se aplica cada vista (PO.1–PO.4)

```sql
-- quitar
AND kdm1.sucursal = '00' AND btrim(kdm1.c1) = '00'
-- poner
AND btrim(kdm1.c1) = kdm1.sucursal
```

⚠️ Después de **cada** `CREATE OR REPLACE VIEW`, **re-aplicar `security_invoker` y el `GRANT`**
— no se heredan, y ya se perdieron una vez en este repo (ADR-057). La omisión no se nota hasta
que alguien abre la pantalla.

---

## 8. Lo que NO se pudo medir, y qué haría falta

| Pregunta abierta | Qué haría falta |
|---|---|
| ¿Cuántos documentos post-01-oct hay fuera del `00` en el ODS? | lectura a Kepler/prod |
| ¿Las 4 vistas siguen ancladas **en prod**? | lectura a prod |
| ¿Las réplicas de las plazas nuevas están en el carril de ingesta? | acceso a `md` |
| ¿Las llaves siguen siendo únicas con N centros? | lectura a prod |

⛔ **Nada de esto se pudo correr el 2026-10-02.** Desde la máquina de trabajo, `fiscal.cfdis`
tiene 0 filas y `kepler_ods.kdm1` tiene 363 filas de semilla; prod vive en el servidor `md`
(`192.168.0.222`), cuyo SSH pide llave que no estaba disponible, y las credenciales de `.245`
fueron rechazadas (`28P01`).

**Las cifras de §3.2 son del catálogo local y hay que re-verificarlas.** Lo que NO depende del
acceso —el patrón del arreglo (§4), el orden de riesgo (§5) y los cabos sueltos (§6)— sí está
firme: salió de leer las definiciones de las vistas y los documentos del repo.

---

## 9. Cómo re-verificar todo

```bash
# El escaneo completo: vistas ancladas + documentos fuera del 00 post-corte
node database/scripts/check-corte-01oct.js

# Contra prod (desde donde se alcance)
DATABASE_URL_NEW=<url-de-prod> node database/scripts/check-corte-01oct.js
```

El script **declara `NO MEDIDO`** cuando no puede preguntar, en vez de imprimir un cero —
«no encontré nada» y «está bien» no son lo mismo (ADR-056).

---

## 10. Dos decodes viejos encontrados de paso

No son de esta fase, pero hacen ruido al investigar acá y conviene cerrarlos:

1. **`FASE_CC` §112** dice *«`XD2601` NO es transferencia a proveedor: es caja chica / gastos
   NF»*. Es del **3-ago**. La migración `20260804120000` del **4-ago**, verificada contra un
   comprobante BBVA real, dice lo contrario: `c31` es la forma de pago, y `XD2601` = `'Tra'`
   transferencia, **16,164 docs / $338M, el 96 % de los pagos**. La línea quedó sin actualizar.
2. **`docs/ERP_KEPLER.md`** dice que en `kdm1`, **`c10` = forma de pago**. La migración
   `20260803130000` lo comenta como **`c10` = código del proveedor**. La evidencia favorece a la
   segunda (`c31` ya es la forma de pago, y los prefijos `C` / `GG` / `GN` / `GB` parten por *a
   quién se le paga*), pero **hay que medirlo**: toda la taxonomía de universos de pago cuelga
   de eso.

---

## 11. Relación con el expediente de gastos (contexto, no alcance)

Esta fase nació investigando el tercer eslabón del expediente de gastos (el pago `XD2601`).
Ese trabajo es **otra fase** y no depende de ésta, salvo en un punto: la vista de pagos de
gastos que se cree debería nacer con `c1 = sucursal`, no heredar el ancla al `00`.

Los universos de pago, por prefijo de `c10` (documentado en `FASE_CC`):

| Prefijo | Paga | Expediente |
|---|---|---|
| `C*` | proveedor de mercancía | Compras |
| `GG*` | caja chica / gastos | el de gastos |
| `GB*` | banco | amortizaciones / créditos |
| `GN*` | nómina | sin dueño definido |
