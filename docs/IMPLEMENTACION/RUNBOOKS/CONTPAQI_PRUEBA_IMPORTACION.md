# Prueba de importación a ContPAQi — un minuto

> **Para quien lleva la contabilidad.** Son dos archivos y tres cosas que mirar.
> Genera los archivos: `node database/scripts/generar-prueba-contpaqi.js --out <carpeta>`

---

## Qué es esto

Estamos armando un puente para que las pólizas de egreso salgan solas del sistema y lleguen a
ContPAQi como archivo, en vez de capturarse a mano. **El formato está escrito y validado contra
una exportación real de ContPAQi, pero nunca lo hemos importado.** Hasta que alguien lo importe,
no sabemos si lo acepta.

Son **dos archivos y no uno** a propósito: si fuera uno solo y fallara, no sabríamos qué falló.

---

## Los dos archivos

| | qué trae | qué contesta |
|---|---|---|
| **A** `prueba-A-formato.txt` | Una póliza de **$1.00**, dos renglones | ¿ContPAQi acepta el formato? ¿Conserva el identificador que mandamos? |
| **B** `prueba-B-con-ad.txt` | Lo mismo **+ un renglón de CFDI** | ¿Se puede asociar el CFDI desde el mismo archivo? |

**Importa primero A.** Si A no entra, B no tiene caso. Si A entra y B no, el problema es el
renglón del CFDI y no el formato.

La póliza es de **un peso**, a `5200800000 VARIOS` contra `1020020000 BBVA`, con el concepto
`PRUEBA DE FORMATO PUENTE SUITE - BORRAR DESPUES`. **No mueve nada y se borra al terminar.**

---

## Las tres cosas que hay que mirar

### 1. ¿Entró?

Si ContPAQi la rechaza: **copiar el mensaje de error tal cual**, aunque parezca que no dice nada.
Es la información más valiosa de toda la prueba.

### 2. ¿Conservó el identificador?

El archivo manda un identificador propio al final del encabezado (se ve como
`3AD7167D-93E6-46E8-A9D5-1F91B0F1CA17`). Después de importar, abrir la póliza y ver si ContPAQi
**lo conservó** o **le puso otro**.

Es importante: si lo conserva, podemos reconocer cada póliza sin depender del texto del concepto.
Si le pone el suyo, no se pierde nada — usamos otra marca.

### 3. ¿El renglón del CFDI hizo algo? *(sólo archivo B)*

El archivo B trae un renglón extra con un UUID de CFDI. Después de importarlo, revisar si esa
póliza quedó **asociada a ese comprobante**, o si hay que asociarlo a mano como siempre.

⭐ Esto es lo que más vale de la prueba: si funciona, **se cierra el hueco de los comprobantes
que quedan sin asociar** — y sin comprar ni instalar nada.

---

## Al terminar

**Borrar las dos pólizas de prueba.** Borrarlas deshace también la asociación del CFDI del
archivo B, así que no queda rastro.

---

## Lo que se hace con la respuesta

| Resultado | Qué sigue |
|---|---|
| A entra | El formato sirve. Se puede empezar a generar pólizas de verdad |
| A no entra | El mensaje de error dice qué corregir — es un ajuste de formato, no un rediseño |
| B asocia el CFDI | Se cierra el hueco de los comprobantes sin asociar |
| B no asocia | Se sigue asociando aparte, como hoy |
| Conserva el identificador | Cada póliza se reconoce sola, sin depender del concepto |
