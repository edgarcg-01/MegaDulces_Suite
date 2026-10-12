# FASE AT — Automatización del trabajo: qué dejar de hacer a mano

> Pedido de Edgar (2026-10-12): *"ya no sólo dejarlo al análisis, sino a la automatización de
> trabajo. Documentos que ya no tienen que subir, procesos que hoy son complicados o quitan
> tiempo."*
>
> **Todo lo de abajo está medido contra PROD** (`system_identifier 7688376744939610156`) el
> **2026-10-12**, en lectura. Los cruces por importe llevan **control de placebo**: sin eso, un
> porcentaje alto no significa nada.

---

## 1. ⛔ La primera idea, refutada de entrada

**"El PDF de la factura ya lo tenemos, que no lo suban."** Medido: `fiscal.cfdis` tiene
**428,846 CFDIs**, de los cuales **1,015 traen el XML** y **CERO traen el PDF**.

Tenemos los **datos** del comprobante (emisor, totales, impuestos, UUID), no el **archivo**. Los
archivos viven en el ADD de ContPAQi, del que `[CP.9]` midió que **leemos 1 de sus 4
repositorios**. Traerlos es una ola de esa fase, no un atajo disponible hoy.

---

## 2. Dónde se va el tiempo hoy, medido

| Proceso | Volumen medido | Qué hace la persona |
|---|---|---|
| Comprobantes de **pago a proveedor** | **1,350** (ago–oct) | elige el pago, sube el archivo, corre OCR, valida |
| Comprobantes de **órdenes de entrada** | **797** (ago–oct) | ídem |
| Comprobantes de **cobranza** | **0** | nadie lo usa |
| **Estados de cuenta** bancarios (XLSX) | 88 ago · 56 sep · 18 oct | exporta de cada banco y sube |
| **Asociación de CFDI** en ContPAQi | ~**1,100–1,250/mes** | atar factura ↔ póliza, a mano |

---

## 3. ⛔⛔ El hallazgo que manda: **se sube y nadie lo mira**

No es que falten documentos. Es que **el 92 % de lo que se sube se queda parado**.

| | ago-2026 | sep-2026 | oct-2026 | Última validación humana |
|---|---:|---:|---:|---|
| Pagos — subidos | 1,202 | 0 | 148 | |
| Pagos — validados | **7** | — | 83 | de los 83, **82 los hizo el sistema** |
| Entradas — subidos | 150 | 324 | 323 | |
| Entradas — validados | 8 | **0** | **0** | **2026-09-01** |

⭐⭐ **La validación humana de órdenes de entrada lleva seis semanas detenida: 647 documentos
subidos desde el 1-sep que nadie abrió.** Y en pagos, de 1,350 comprobantes, las validaciones
*humanas* de toda la historia son **nueve** (`superoot` 4, `superuser` 5); las otras 82 las firmó
`Sistema · 4 coincidencias`.

> Subir un documento que nadie mira es trabajo **puro** perdido: cuesta en el extremo de la
> captura y no produce nada en el otro. Es el mismo patrón que `finance.findings`, con 157,184
> hallazgos en `nuevo` y 172 descartados.

---

## 4. ⭐ Y el auto-validador YA EXISTE — está casi apagado

El sistema calcula un cruce de **cuatro señales** (banco, fecha, monto, proveedor) y auto-valida
cuando las cuatro dan `ok`. Funciona: firmó **82 de las 83** validaciones de octubre. Repartido
sobre los 1,350 comprobantes de pago:

| Estado del cruce | Total | **Pendientes** | Qué toca |
|---|---:|---:|---|
| ⛔ **sin cruce calculado** | 746 | **737** | *el sistema no sabe nada de ellos* — falta correr el cruce |
| ✅ **4/4 `ok`** | 271 | **189** | **auto-validables hoy**, y están parados |
| ⚠️ `monto` difiere | 201 | 201 | sí necesita a una persona |
| ⚠️ parcial | 132 | 132 | sí necesita a una persona |

⭐⭐ **La cola humana no son 1,196: son ~333.** Las otras 926 o se auto-validan o ni siquiera se
han clasificado. Eso cambia el problema de *"falta gente"* a *"falta correr dos cosas"*.

---

## 5. El comprobante de pago: el hecho **ya lo teníamos**

¿El movimiento que la persona está documentando ya está en el sistema por el lado del banco
(Fase CB)?

| | Pega | De | % |
|---|---:|---:|---:|
| **Real** (mismo importe, ±3 días) | **886** | 1,350 | **65.6 %** |
| ⭐ **Placebo** (fecha corrida 6 meses) | 5 | 1,350 | 0.4 % |

**164× el piso de ruido** — el cruce es real, no una coincidencia aritmética. En la ventana de
120 días: **300 de 429 (69.9 %)** contra un placebo de **0.9 %**.

⚠️ **Esto NO dice "no suban el comprobante".** El archivo es evidencia de *quién* ordenó el pago y
con *qué* referencia, y eso el estado de cuenta no lo trae. Lo que sí dice es que **el dato que el
OCR extrae ya lo tiene el sistema en dos de cada tres casos**, así que la pantalla puede
**proponer el pago ya cuadrado** en vez de pedir que alguien lo busque y lo confirme.

### El mismo cruce en órdenes de entrada, y por qué rinde menos

| | Pega | De | % |
|---|---:|---:|---:|
| Real (mismo RFC, mismo total, ±30 días) | 150 | 462 | 32.5 % |
| ⭐ Placebo (mismo RFC, importe inventado) | **0** | 462 | **0 %** |

Placebo impecable, cobertura baja — y tiene explicación: **la remisión no es la factura**. Se
firma al recibir, antes de facturar, y los totales difieren por entregas parciales. Es el mismo
41 % de desajuste que la Fase RE midió en el Excel de recepción.

---

## 6. ⚠️ Dos lecturas mías que la medición corrigió

1. **"El OCR acierta el 100 %, la validación humana no aporta."** Medido: `monto_match` es `true`
   en 1,350 de 1,350 — pero porque la tolerancia es **$1**, y las diferencias reales van de
   **$0.00 a $1.00** (73 valores distintos). El OCR **sí** lee el documento y **sí** se desvía;
   simplemente nunca más de un peso. La afirmación correcta es más acotada: *el OCR nunca se
   equivoca por más de $1 en 1,350 lecturas*.
2. **"`monto_match` no discrimina."** No discrimina **en esta población**, que no es lo mismo que
   estar roto. ⚠️ Pero sí implica que, como gate, **hoy no puede atrapar una lectura mala**: el
   que de verdad separa es `coincidencias` (§4), que mira cuatro señales y no una.

---

## 7. Qué hacer, por rendimiento

| # | Acción | Elimina | Cuesta |
|---|---|---|---|
| 1 | **Correr el cruce de 4 señales sobre los 737 sin clasificar** | convierte una cola opaca en una lista con dueño | un backfill |
| 2 | **Encender la auto-validación para los 4/4** | **189 revisiones hoy** + las futuras | ya existe, hay que soltarla |
| 3 | ⛔ **Entradas: dueño o apagar el requisito** | 647 documentos sin mirar desde el 1-sep | decisión, no código |
| 4 | **El renglón `AD` del TXT** (`[CP.8.29]`, ya escrito) | ~**1,100 asociaciones/mes** | el clic de `[CPA.3]` |
| 5 | **Proponer el pago ya cuadrado** desde el banco | la búsqueda manual en 2 de cada 3 casos | pantalla |

⛔ **Lo que NO se propone, con motivo:** eliminar la subida del comprobante (es evidencia que sólo
tiene la persona), ni la del estado de cuenta (ContPAQi guarda la *contabilización*, no lo que
dice el banco), ni traer los PDFs del ADD sin antes medir qué hay en sus otros 3 repositorios.

---

## 8. Lo que NO se pudo medir, declarado

- **Cuánto tiempo cuesta cada subida.** No hay telemetría de la pantalla; todo lo de arriba es
  volumen, no minutos. Un documento puede ser 20 segundos o 3 minutos, y eso cambia el orden.
- **Por qué se detuvo la validación de entradas.** El dato dice *cuándo* (1-sep), no *por qué*.
  Puede ser falta de tiempo, de dueño, o que el paso no sirva para nada — y las tres se arreglan
  distinto.
- **Si los 737 sin cruce son del backfill de agosto** o de un fallo del cálculo. Hay que mirar uno.
