/**
 * Mapa de responsabilidades de un conjunto de PE por su tabla de imports.
 * Solo lee los archivos; no los ejecuta ni los carga.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/** Agrupa DLLs de Windows por el subsistema que delatan. */
const SUBSYSTEM = [
  ["red / sockets", /^(ws2_32|wsock32|winhttp|wininet|mswsock|iphlpapi|dnsapi)\b/i],
  ["criptografia / TLS", /^(crypt32|bcrypt|ncrypt|secur32|schannel|advapi32)\b/i],
  ["base de datos", /^(odbc32|libpq|oledb|msdasql|sqlncli|mysql|sqlite)/i],
  ["COM / automatizacion", /^(ole32|oleaut32|combase)\b/i],
  ["interfaz grafica", /^(user32|gdi32|comctl32|comdlg32|shell32|uxtheme|msimg32|gdiplus)\b/i],
  ["runtime C/C++", /^(msvcp|vcruntime|api-ms-win-crt|ucrtbase|concrt)/i],
  ["sistema", /^(kernel32|kernelbase|ntdll|api-ms-win-core|rpcrt4|version|psapi)/i],
];

const classify = (dll) =>
  SUBSYSTEM.find(([, pattern]) => pattern.test(dll))?.[0] ?? "otro";

const parseImports = (path) => {
  const bytes = readFileSync(path);
  const pe = bytes.readUInt32LE(0x3c);
  const sections = bytes.readUInt16LE(pe + 6);
  const optMagic = bytes.readUInt16LE(pe + 24);
  const optSize = bytes.readUInt16LE(pe + 20);
  const directories = pe + 24 + (optMagic === 0x20b ? 112 : 96);
  const table = [];
  for (let i = 0; i < sections; i += 1) {
    const at = pe + 24 + optSize + i * 40;
    table.push({
      virtual: bytes.readUInt32LE(at + 12),
      virtualSize: bytes.readUInt32LE(at + 8),
      raw: bytes.readUInt32LE(at + 20),
      rawSize: bytes.readUInt32LE(at + 16),
    });
  }
  const offsetOf = (rva) => {
    for (const section of table)
      if (rva >= section.virtual && rva < section.virtual + Math.max(section.virtualSize, section.rawSize))
        return section.raw + (rva - section.virtual);
    return undefined;
  };
  const stringAt = (rva) => {
    const start = offsetOf(rva);
    if (start === undefined) return undefined;
    let end = start;
    while (bytes[end] !== 0) end += 1;
    return bytes.toString("latin1", start, end);
  };

  const importRva = bytes.readUInt32LE(directories + 1 * 8);
  if (!importRva) return [];
  let cursor = offsetOf(importRva);
  const modules = [];
  while (cursor !== undefined) {
    const lookup = bytes.readUInt32LE(cursor);
    const nameRva = bytes.readUInt32LE(cursor + 12);
    const address = bytes.readUInt32LE(cursor + 16);
    if (lookup === 0 && nameRva === 0 && address === 0) break;
    const name = stringAt(nameRva) ?? "(ilegible)";
    const functions = [];
    let thunk = offsetOf(lookup || address);
    while (thunk !== undefined) {
      const entry = optMagic === 0x20b ? bytes.readBigUInt64LE(thunk) : BigInt(bytes.readUInt32LE(thunk));
      if (entry === 0n) break;
      const ordinalFlag = optMagic === 0x20b ? 1n << 63n : 1n << 31n;
      if (entry & ordinalFlag) functions.push(`#${entry & 0xffffn}`);
      else {
        const hintName = offsetOf(Number(entry & 0x7fffffffn));
        if (hintName !== undefined) {
          let end = hintName + 2;
          while (bytes[end] !== 0) end += 1;
          functions.push(bytes.toString("latin1", hintName + 2, end));
        }
      }
      thunk += optMagic === 0x20b ? 8 : 4;
    }
    modules.push({ name, functions });
    cursor += 20;
  }
  return modules;
};

const dir = process.argv[2];
const files = readdirSync(dir).filter((name) => /\.(dll|exe)$/i.test(name));
const interesting = /^(socket|connect|send|recv|bind|listen|WSA|getaddrinfo|inet_|closesocket|select)/i;

for (const file of files) {
  const modules = parseImports(join(dir, file));
  const groups = new Map();
  for (const module of modules) {
    const group = classify(module.name);
    groups.set(group, (groups.get(group) ?? []).concat(module));
  }
  console.log(`\n=== ${basename(file)} — ${modules.length} modulos importados ===`);
  for (const [group, mods] of [...groups].sort()) {
    const total = mods.reduce((sum, mod) => sum + mod.functions.length, 0);
    console.log(`  ${group.padEnd(22)} ${String(total).padStart(4)} fn   ${mods.map((m) => m.name).join(" ")}`);
  }
  const net = modules.flatMap((module) => module.functions.filter((fn) => interesting.test(fn)));
  if (net.length > 0) console.log(`  >> RED: ${[...new Set(net)].join(" ")}`);
}
