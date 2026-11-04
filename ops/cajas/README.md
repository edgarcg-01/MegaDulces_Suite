# Censo de cajas de mostrador (`[PDV.6]`)

La caja de la Suite (`/tienda/caja`) necesita saber, de cada una de las 37 cajas, con qué hardware cuenta antes de
decidir cómo maneja la gaveta y la impresora (D-I3 en
[`FASE_PDV_ANEXO_IMPLEMENTACION.md`](../../docs/IMPLEMENTACION/FASES/FASE_PDV_ANEXO_IMPLEMENTACION.md)).

## En cada caja (lo corre el encargado, ~2 minutos)

1. Copiar `censo-caja.ps1` a la caja (o abrirlo desde la carpeta compartida).
2. Abrir **PowerShell** (no ISE) y correr:

   ```powershell
   powershell -ExecutionPolicy Bypass -File censo-caja.ps1
   ```

3. Contestar sucursal, caja, nombre, si el cajón va a la impresora y si hay báscula, y **escanear un producto**
   cuando lo pida (así se mide si el lector termina con Enter).
4. Mandar el `censo-<sucursal>-<caja>-<equipo>.json` que deja junto al script, con **una foto** de la impresora, el
   cajón y el lector.

**Sólo lee**: no abre la gaveta, no imprime, no instala nada. Corre en PowerShell 2 en adelante (Windows 7+).

## Juntar las fichas

```bash
node ops/cajas/consolidar-censo.js <carpeta-con-las-fichas> --universo 37
```

Da la tabla por caja y los conteos que deciden: cuántas tienen la impresora por COM (la gaveta va por el navegador),
cuántas necesitan el agente local, cuántas tienen el navegador a menos de 1280 px (`PDV.UI.8`), lector con Enter y
segunda pantalla para el cliente.

⛔ La tabla lleva nombres de equipo y el repo es público: al doc de la fase va **sólo el resumen por conteos**.

## Qué no mide

- **Si el cajón tiene sensor**: eso lo dice la prueba con la gaveta (abrirla y leer el estado), que sí la abre;
  no va en el censo.
- **La impresora de tickets se reconoce por su nombre**: la que no reconoce sale como «no identificada» y se revisa
  con la foto.
- **La compatibilidad con PowerShell 2 no se probó en un Windows 7 real** (2026-11-03: sólo en Windows 11 con PS 5.1).
