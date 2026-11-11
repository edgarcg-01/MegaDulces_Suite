# Fase RP — Reporte de problema de producto

> Gobernada por [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> **Se construye como un frente de la Fase MS (Mesa de Servicio)** — una cola nueva + sus
> categorías + puntos de entrada precargados, **no un reporter paralelo**. Reusar MS es la regla
> («una sola interfaz por flujo»); construir otro canal duplicaría el servicio ya en `main`.

```
OBJETIVO: que cualquiera que ve un producto mal (precio, impuesto, código de barras,
          descripción, margen) lo reporte en ≤2 toques desde donde lo vio, y que caiga
          como ticket en la cola de Catálogo para que Compras lo corrija en Kepler.
MÉTRICA:  Canal estructurado para reportar un problema de datos de producto —
          HOY (2026-11-11, MEDIDO): 0 — no existe cola ni categoría de producto en MS;
          hoy se avisa por WhatsApp/voz y se pierde (sin folio, sin dueño, sin SLA).
          META: canal vivo a ≤2 toques desde la ficha del producto y desde el POS, con
          folio y cola de Catálogo, para <fecha a fijar con Edgar>.
CAPA TOPE: C3
ÁREA:      Comercial (reporta cualquiera; atiende Compras/Catálogo)
DUEÑO:     Felipe (0SistemasMD) — ya atiende la cola TI de MS
ESTADO:    ⬜ (el primer item es medir el universo real de errores; ver C0)
```

⛔ El «HOY = 0» es un hecho medido (no existe la categoría ni la cola de producto en el service
desk que ya corre en `main`), no un número inventado. El **tamaño del backlog** de errores reales
sí está sin medir y es el primer item C0.

---

## 1. Qué problema resuelve

Los errores de datos de producto —precio mal, impuesto mal clasificado, código de barras que no
escanea, descripción equivocada, margen imposible— **los ve primero quien está frente al producto**
(cajera en el POS, vendedor, almacenista, encargada de tienda), no Compras. Hoy ese aviso viaja por
WhatsApp o de voz y **se pierde**: sin folio, sin responsable, sin plazo, sin registro de si se
corrigió.

Que el problema es real y grande ya lo evidenciaron otras fases, desde el lado del dato:
- **CE.9/CE.10** (Costo estándar): **270 fichas venden BAJO COSTO hoy** ($326,959 de venta en 30 d,
  margen mediano −5.67 %) — el catálogo lo esconde. Eso es un «error de margen» que nadie reporta.
- **CE** midió **impuesto mal clasificado** escondido en «Monto sin IVA» ($2.2 M) y celdas con
  costo/margen imposibles.
- **PF/NP** publican márgenes por producto y encuentran renglones con unidad o precio equivocados.

Esas fases **miden** el error desde los datos; **ninguna le da a la persona de piso una forma de
reportar el que ella ve**. RP cierra ese lazo: el acto es *reportar un producto mal, en segundos*.

**Prueba de la frase (una sola pregunta, sin «y»):** «¿Qué producto está mal y en qué?»

---

## 2. Qué NO incluye

- **NO escribe en Kepler.** La corrección del dato vive en Kepler/catálogo (ADR-040: ContPAQi y
  Kepler son los sistemas de registro; la Suite no escribe el catálogo). RP **levanta el ticket y
  lo rutea**; corregir el precio/impuesto/EAN lo hace Compras en Kepler, y al resolver se declara
  qué se cambió.
- **NO es un reporter nuevo.** Es una **cola** («Catálogo») + categorías de producto + entradas
  precargadas, todo sobre la Fase MS ya construida (estados, SLA, asignación, Mi trabajo, Reportes).
- **NO clasifica ni prioriza automáticamente el fondo del problema.** Sugiere prioridad por tipo
  (precio/impuesto = alto, tocan dinero y fiscal); quien atiende confirma.
- **NO corrige el margen ni recalcula precios** (eso es Motor de Rentabilidad / CE). RP sólo reporta.

---

## 3. Las capas

### C0 · Dato
| # | Item | Estado | Verificado contra |
|---|---|---|---|
| RP.0.1 | **Medir el universo**: cuántos productos tienen hoy error reportable por tipo (EAN ausente/duplicado, precio vs cobrado, impuesto, margen bajo costo). Reusa lo ya medido por CE/PF, no remide a mano. | ⬜ | Testigos de CE (`v_kepler_standard_cost`), PF (`mv_product_margins_30d`), lo pagado |
| RP.0.2 | Vista `derive-no-copy` **resolución scan → producto**: `kepler_ods.kdii` (`c1`=SKU, `c2`=nombre, `c7`=EAN, `c85` escaneable) → SKU + nombre + sucursal. Para precargar el producto al escanear. | ⬜ | Un EAN real escaneado contra la ficha de Kepler; unidad probada (3 casillas por unidad, §3.y.4) |

⛔ Sin importer. El código de barras **ya existe en el ODS** (`kdii.c7`/`c85`), no se inventa. Lo
que no se pueda resolver (EAN que no cae en ninguna casilla) se **declara** «producto no
identificado», nunca se adivina.

### C1 · Dominio
| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| RP.1.1 | Categorías de producto en `servicedesk` (Precio · Impuesto · Código de barras · Descripción · Margen · Otro) + regla de asignación categoría→persona de Compras | ⬜ | spec de la máquina de estados de MS, extendida con la cola Catálogo |
| RP.1.2 | Prioridad **sugerida** por tipo (precio/impuesto = alto) — confirmada por quien atiende | ⬜ | spec de prioridad sugerida (reusa MS.7.7) |

### C2 · API
| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| RP.2.1 | `POST /service-desk/tickets` con payload de producto (SKU, EAN, sucursal, tipo, actual vs esperado, foto) | ⬜ | sí | ⛔ obligatoria: ejercer el alta contra base real con el payload exacto de la pantalla (reusa el E2E de MS) |
| RP.2.2 | `GET` resolución de producto por EAN/nombre (RP.0.2) para precargar | ⬜ | no | contra el ODS real, EAN verdadero |

### C3 · UI
| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| RP.3.1 | Categoría «Producto» en el botón global «Reportar un problema» (ya en el header de todo el layout) | ⬜ | N → N |
| RP.3.2 | **Entrada desde la ficha del producto** (Compras › Catálogo › Productos) con el producto **precargado** | ⬜ | N → N |
| RP.3.3 | **Entrada desde el POS / caja** con **scan del código de barras** que precarga el producto | ⬜ | N → N |
| RP.3.4 | Form mínimo: producto (precargado o scan/buscador por nombre) · chips de tipo · actual vs esperado · foto opcional · UN botón | ⬜ | N → N |
| RP.3.5 | Cola «Catálogo» en la bandeja de MS para Compras (reusa bandeja, SLA, Reportes) | ⬜ | N → N |

⛔ Cargar la skill `diseno` **antes** del primer archivo. <500 ms. El reportero ve **sólo** su
folio; colas/SLA/estados son para quien atiende.

#### Las 5 preguntas del cuestionario de diseño (contestadas antes de maquetar)

1. **¿Qué ve al entrar y en qué orden?** El **producto identificado** primero (precargado si entró
   desde la ficha o el POS; si no, scan de EAN o buscador por nombre). Luego los **chips de tipo**
   (Precio · Impuesto · Código de barras · Descripción · Margen · Otro). Luego «¿qué está mal?» y
   «¿qué debería ser?». Foto opcional. UN botón «Reportar».
2. **¿Qué NO ve?** Nada de colas, SLA, estados ni catálogo técnico. Sólo reporta y recibe su folio.
3. **¿Qué accesibilidad necesita?** **Máxima** — el objetivo central de la fase. Reportable desde
   (a) el botón global ya existente, (b) la ficha del producto con el dato precargado, (c) el POS
   con scan, (d) scan de EAN directo en el form. Por **nombre**, no por código. Sin mouse. ≤2 toques
   desde donde se ve el error.
4. **¿Está ligada a otro proceso?** Sí: el ticket lleva SKU + EAN + sucursal + el campo que falla;
   la corrección vive en **Kepler** (Compras). Al resolver se abre la ficha del producto y se
   declara qué se cambió. Cola = Catálogo.
5. **¿Este proceso la debe ver?** Reporta **cualquiera** (cajera, vendedor, almacenista, encargada).
   Atiende **Compras/Catálogo** (cola nueva, como Mantenimiento es una cola de MS). No duplica MS.

---

## 4. Decisiones (→ ADR)

| # | Decisión | ADR | Fecha |
|---|---|---|---|
| D1 | RP se construye como **cola de MS**, no como canal nuevo | (deriva de ADR-081 Mesa de Servicio) | 2026-11-11 |
| D2 | La Suite **no corrige el dato en Kepler**; RP reporta y rutea | ADR-040 | 2026-11-11 |
| D3 | El código de barras sale del ODS (`kdii.c7`/`c85`), no de un importer | regla principal | 2026-11-11 |

---

## 5. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| MS no está en prod (⏸️, todo en `main`) | Edgar | RP cuelga de la infra de MS, que aún no se desplegó | Desplegar MS (7 migraciones, runbook) **o** desplegar el sliver que RP necesita |
| Cupo: 5 fases 🔨 contra tope de 4 | Edgar | RP sería la 6ª si se abre a 🔨 | Queda ⬜/🔴 hasta que un slot 🔨 se libere, o entra como frente de MS sin abrir fase |
| EAN que no resuelve a un SKU | Compras | 1 % de cajas trae `C`+clave, no EAN (§3.y.4) | Declarar «no identificado» y dejar reportar igual por nombre |
| Quién atiende la cola Catálogo | Edgar/Compras | hay que nombrar al responsable y miembros | Decisión de Edgar: qué persona de Compras es dueña de la cola |

⛔ Un bloqueo sin dueño es un item olvidado.

---

## 6. Definición de Terminado

- [ ] 1. Métrica remedida: el canal existe y mide cuántos reportes entran/se resuelven
- [ ] 2. Cada capa verificada o declarada NO MEDIDA
- [ ] 3. `POST` de alta ejercido contra base real con el payload de la pantalla
- [ ] 4. Toda compuerta nueva rota a propósito una vez
- [ ] 5. Primitivos en `libs/service-desk` (reuso), nada paralelo
- [ ] 6. Tracker + log + roadmap al día
- [ ] 7. En prod, o escrito por qué no y qué falta

---

## 7. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-11 | Plan creado por pedido de Edgar: proyecto para Felipe/Sistemas. Definido como frente de MS. Testigo del código de barras confirmado (`kdii.c7`/`c85`). | Claude (Edgar firma) |
