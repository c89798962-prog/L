#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║           SUPER LUA/LUAU DEOBFUSCATOR — ALL ENGINES FUSED              ║
 * ║  Combina 4 deobfuscadores en uno. Uso: node super-deobfuscator.js      ║
 * ║  <input.lua> [output.lua]                                              ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  Engines incluidos:                                                     ║
 * ║  [1] vmmer true-VM  — pool/order/key/salt XOR decrypt                  ║
 * ║  [2] CodeVault v35  — symbol-map + brute-force key×salt                ║
 * ║  [3] CodeVault alt  — codec string + rolling-XOR (10-char alphabet)    ║
 * ║  [4] General pass   — math, string.char, dead code, anti-debug,        ║
 * ║                       junk code, control-flow, hex/base64/XOR strings, ║
 * ║                       proxy functions, string arrays, silent-corrupt    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

'use strict';
const fs   = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
//  UTIL
// ═══════════════════════════════════════════════════════════════════════════

const log = (tag, msg) => process.stderr.write(`  [${tag}] ${msg}\n`);

function evalMath(expr) {
  try {
    const safe = expr.replace(/[^0-9+\-*/.() ]/g, '');
    const v = Function('"use strict"; return (' + safe + ')')();
    if (typeof v === 'number' && isFinite(v)) return Math.floor(v);
  } catch (_) {}
  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENGINE 4 — GENERAL PASS (math, string.char, dead code, anti-debug, etc.)
//  Sources: lua-deobfuscator.jsx  +  extra patterns
// ═══════════════════════════════════════════════════════════════════════════

/** Simplifica expresiones matemáticas anidadas: ((((7+3412)*47)/47)-3412) → 7 */
function simplifyMath(code) {
  let result = code;
  for (let pass = 0; pass < 50; pass++) {
    const prev = result;
    result = result.replace(/\(([^()]*)\)/g, (match, inner) => {
      if (/^[\d\s+\-*/.]+$/.test(inner)) {
        const v = evalMath(match);
        if (v !== null) return String(v);
      }
      return match;
    });
    if (result === prev) break;
  }
  return result;
}

/** string.char(65,66,67) → "ABC" */
function decodeStringChar(code) {
  return code.replace(/string\.char\(([\d,\s]+)\)/g, (match, args) => {
    const nums = args.split(',').map(n => parseInt(n.trim(), 10));
    if (nums.some(n => isNaN(n) || n < 0 || n > 255)) return match;
    return JSON.stringify(nums.map(n => String.fromCharCode(n)).join(''));
  });
}

/** Elimina ramas muertas como: if type(nil)=="number" then ... end */
function removeDeadCode(code) {
  let r = code;
  const patterns = [
    /if\s+not\s*\(\d+\s*==\s*\d+\s*\)\s+then\s+local\s+\w+\s*=\s*\d+\s+end\s*/g,
    /if\s+type\s*\(\s*nil\s*\)\s*==\s*"number"\s+then[\s\S]*?end\s*/g,
    /if\s+type\s*\(\s*math\.pi\s*\)\s*==\s*"string"\s+then[\s\S]*?end\s*/g,
    /do\s+local\s+\w+\s*=\s*\{\}\s+\w+\["_"\]\s*=\s*1\s+\w+\s*=\s*nil\s+end\s*/g,
    /if\s+false\s+then[\s\S]*?end\s*/g,
    /while\s+false\s+do[\s\S]*?end\s*/g,
    /repeat\s*until\s+true\s*/g,
    /if\s+\d+\s*==\s*\d+\s*then\s*end\s*/g,
  ];
  for (const p of patterns) r = r.replace(p, '');
  return r;
}

/** Anti-debug: os.clock loops, debug.sethook, getinfo traps, error guards */
function stripAntiDebug(code) {
  let r = code;
  r = r.replace(/local\s+_adT\s*=\s*os\.clock\(\)[\s\S]*?end\s*/g, '');
  r = r.replace(/if\s+debug\s+and\s+debug\.sethook[\s\S]*?end\s*/g, '');
  r = r.replace(/debug\.sethook\s*\([^)]*\)\s*/g, '');
  r = r.replace(/local\s+\w+\s*=\s*function\s*\(\s*\)\s*local\s+\w+\s*=\s*error[\s\S]*?end\s+\w+\(\)\s*/g, '');
  // Anti-tamper: hash checks  _ENV tampering detection
  r = r.replace(/if\s+_ENV\s*~=[\s\S]*?then[\s\S]*?end\s*/g, '');
  // Silent corrupt patterns (self-modifying table guards)
  r = r.replace(/local\s+\w+\s*=\s*\{\s*\}\s+setmetatable\s*\(\s*\w+\s*,\s*\{[\s\S]*?\}\s*\)\s*/g, '');
  // getinfo anti-tamper
  r = r.replace(/debug\.getinfo\s*\([^)]*\)[^\n]*\n/g, '');
  return r;
}

/** Decodifica strings hexadecimales: "\x41\x42" → "AB" */
function decodeHexStrings(code) {
  return code.replace(/"((?:\\x[0-9a-fA-F]{2})+)"/g, (match, inner) => {
    try {
      const str = inner.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)));
      return JSON.stringify(str);
    } catch (_) { return match; }
  });
}

/** Decodifica strings base64 si aparecen con un decode wrapper */
function decodeBase64Strings(code) {
  return code.replace(/(?:base64\.decode|b64decode|Base64\.decode)\s*\(\s*"([A-Za-z0-9+/=]+)"\s*\)/g, (match, b64) => {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (/^[\x20-\x7E\n\r\t]*$/.test(decoded)) return JSON.stringify(decoded);
    } catch (_) {}
    return match;
  });
}

/** XOR string decoding: si hay un patrón local s = xor("...", key) */
function decodeXorStrings(code) {
  return code.replace(/(?:xor_str|XOR|bxor_str)\s*\(\s*"([^"]+)"\s*,\s*(\d+)\s*\)/g, (match, str, keyStr) => {
    try {
      const key = parseInt(keyStr, 10);
      const decoded = str.split('').map(c =>
        String.fromCharCode(c.charCodeAt(0) ^ key)).join('');
      if (/^[\x20-\x7E]*$/.test(decoded)) return JSON.stringify(decoded);
    } catch (_) {}
    return match;
  });
}

/** Unwrap funciones proxy: local f = function(a,b) return a+b end → inlining */
function unwrapProxyFunctions(code) {
  // Patrón: local alias = realFunc  → reemplaza usos de alias
  const aliases = {};
  code.replace(/local\s+(\w+)\s*=\s*(\w+)\s*\n/g, (_, a, b) => {
    if (/^[a-zA-Z_]\w*$/.test(b)) aliases[a] = b;
  });
  let result = code;
  for (const [alias, real] of Object.entries(aliases)) {
    const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'g');
    result = result.replace(re, real);
  }
  return result;
}

/** Decodifica string arrays con rotación: local _0x = ["a","b","c"]; función rotadora */
function decodeStringArrays(code) {
  // Busca: local _arr = {"str1","str2",...} y accesos _arr[N]
  const arrMatch = code.match(/local\s+(\w+)\s*=\s*\{((?:\s*"[^"]*"\s*,?\s*)+)\}/);
  if (!arrMatch) return code;
  const [, varName, body] = arrMatch;
  const strings = [];
  body.replace(/"([^"]*)"/g, (_, s) => strings.push(s));
  if (strings.length === 0) return code;

  let result = code;
  result = result.replace(new RegExp(`${escapeRegex(varName)}\\[(\\d+)\\]`, 'g'), (match, idx) => {
    const i = parseInt(idx, 10);
    if (i >= 0 && i < strings.length) return JSON.stringify(strings[i]);
    return match;
  });
  return result;
}

/** Control flow flattening: desenrolla while-true/switch-state patterns */
function removeControlFlowJunk(code) {
  // Elimina: while true do if state==N then ... state=M end end
  // Solo limpieza superficial de guards de estado constante
  let r = code;
  r = r.replace(/local\s+\w+\s*=\s*\d+\s*\n\s*while\s+true\s+do\s*\n\s*if\s+\w+\s*==\s*1\s+then\s*\n([\s\S]*?)\n\s*break\s*\n\s*end\s*\n\s*end/g, '$1');
  return r;
}

/** Elimina comentarios de ofuscación y espacios/nops extra */
function cleanupNoise(code) {
  let r = code;
  // Blank semicolons y nops
  r = r.replace(/;\s*;/g, ';');
  r = r.replace(/\bdo\s+end\b/g, '');
  // Múltiples líneas vacías → una sola
  r = r.replace(/\n{3,}/g, '\n\n');
  return r.trim();
}

function runGeneralPass(code) {
  log('GENERAL', 'Iniciando pase general...');
  let c = code;
  c = simplifyMath(c);         log('GENERAL', '✓ Matemáticas simplificadas');
  c = decodeStringChar(c);     log('GENERAL', '✓ string.char() decodificado');
  c = decodeHexStrings(c);     log('GENERAL', '✓ Strings hex decodificados');
  c = decodeBase64Strings(c);  log('GENERAL', '✓ Base64 decodificado');
  c = decodeXorStrings(c);     log('GENERAL', '✓ XOR strings decodificados');
  c = stripAntiDebug(c);       log('GENERAL', '✓ Anti-debug/tamper eliminado');
  c = removeDeadCode(c);       log('GENERAL', '✓ Código muerto eliminado');
  c = removeControlFlowJunk(c);log('GENERAL', '✓ Control flow junk limpiado');
  c = decodeStringArrays(c);   log('GENERAL', '✓ String arrays resueltos');
  c = unwrapProxyFunctions(c); log('GENERAL', '✓ Proxy functions unwrapped');
  c = cleanupNoise(c);         log('GENERAL', '✓ Ruido limpiado');
  return c;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENGINE 1 — vmmer TRUE VM  (pool / order / key / salt)
//  Sources: lua-deobfuscator.jsx  +  Fucion_2.txt
// ═══════════════════════════════════════════════════════════════════════════

function parseLuaTable(str) {
  return str.split(',').map(p => p.trim()).filter(Boolean).map(p => {
    const v = evalMath(p);
    return v !== null ? v : parseInt(p, 10);
  });
}

function extractVmmerPayload(code) {
  // Buscar _pool
  const poolM = code.match(/local\s+_pool\s*=\s*\{([^}]*)\}/);
  if (!poolM) return null;
  const poolVarNames = poolM[1].split(',').map(s => s.trim()).filter(Boolean);

  // Obtener bytes de cada variable
  const memChunks = [];
  for (const varName of poolVarNames) {
    const re = new RegExp(`local\\s+${escapeRegex(varName)}\\s*=\\s*\\{([^}]*)\\}`);
    const m = code.match(re);
    if (!m) return null;
    memChunks.push(parseLuaTable(m[1]));
  }

  // _order
  const orderM = code.match(/local\s+_order\s*=\s*\{([^}]*)\}/);
  if (!orderM) return null;
  const order = parseLuaTable(orderM[1]);

  // KEY y SALT: local STACK={} local KEY=N local SALT=M
  const ksM = code.match(/local\s+\w+\s*=\s*\{\}\s*local\s+\w+\s*=\s*([^\s\n]+)\s*local\s+\w+\s*=\s*([^\s\n]+)/);
  if (!ksM) return null;
  const KEY  = evalMath(ksM[1]) ?? parseInt(ksM[1], 10);
  const SALT = evalMath(ksM[2]) ?? parseInt(ksM[2], 10);

  // Descifrar
  const chars = [];
  let gIdx = 0;
  for (const idx of order) {
    const chunk = memChunks[idx - 1];
    if (!chunk) continue;
    for (const encByte of chunk) {
      let b = (encByte - KEY - gIdx * SALT) % 256;
      if (b < 0) b += 256;
      chars.push(String.fromCharCode(b));
      gIdx++;
    }
  }
  const payload = chars.join('');
  return payload.length > 10 ? payload : null;
}

function runVmmerEngine(code) {
  log('vmmer', 'Buscando capas VM (pool/order/key/salt)...');
  let current = code;
  let layers = 0;
  for (let i = 0; i < 20; i++) {
    const payload = extractVmmerPayload(current);
    if (payload) {
      layers++;
      log('vmmer', `✓ Capa ${layers} desencriptada (${payload.length} bytes)`);
      current = runGeneralPass(payload);
    } else break;
  }
  if (layers === 0) log('vmmer', '— No se detectó payload vmmer');
  else log('vmmer', `✓ Total: ${layers} capas desencriptadas`);
  return { code: current, layers };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENGINE 2 — CodeVault v35  (symbol map + brute-force key×salt)
//  Source: CodeVault_v35_deobfuscator.py  →  portado a JS
// ═══════════════════════════════════════════════════════════════════════════

function findSymbolMap(lua) {
  for (const m of lua.matchAll(/\{([^}]{20,400})\}/g)) {
    const body = m[1];
    const entries = [...body.matchAll(/\["(.)"\]\s*=\s*(0[xX][0-9a-fA-F]+|\d+)/g)];
    if (entries.length === 10) {
      const parsed = {};
      for (const [, ch, val] of entries)
        parsed[ch] = parseInt(val, val.startsWith('0x') || val.startsWith('0X') ? 16 : 10);
      const vals = Object.values(parsed).sort((a, b) => a - b);
      if (JSON.stringify(vals) === JSON.stringify([0,1,2,3,4,5,6,7,8,9]))
        return parsed;
    }
  }
  return null;
}

function findEncodedStrings(lua, validSyms) {
  const results = [];
  for (const m of lua.matchAll(/"([^"]*)"/g)) {
    const s = m[1];
    if (s.length >= 6 && s.length % 3 === 0 && [...s].every(c => validSyms.has(c)))
      results.push({ pos: m.index, len: s.length, s });
  }
  return results;
}

function pickChunks(candidates) {
  if (!candidates.length) return null;
  const maxLen = Math.max(...candidates.map(c => c.len));
  const thresh  = maxLen * 0.6;
  let chunks = candidates.filter(c => c.len < thresh).sort((a, b) => a.pos - b.pos);
  if (chunks.length >= 4) return chunks.slice(0, 4).map(c => c.s);
  if (chunks.length === 0) {
    const all = [...candidates].sort((a, b) => a.pos - b.pos);
    return all.slice(0, Math.max(4, all.length)).map(c => c.s);
  }
  return chunks.map(c => c.s);
}

function decodeSymbols(encoded, symMap) {
  const result = [];
  for (let i = 0; i + 2 < encoded.length; i += 3) {
    const d0 = symMap[encoded[i]]   ?? 0;
    const d1 = symMap[encoded[i+1]] ?? 0;
    const d2 = symMap[encoded[i+2]] ?? 0;
    result.push(d0 * 100 + d1 * 10 + d2);
  }
  return result;
}

function bruteForceKeysSalt(ciphered, verbose = true) {
  const TEST_LEN = Math.min(40, ciphered.length);
  const LUA_KWS  = ['local ', 'function', ' end', 'return', 'if ', 'then', 'for ', 'while '];
  let tested = 0;
  for (let key = 1; key < 255; key++) {
    for (let salt = 1; salt < 254; salt++) {
      tested++;
      let ok = true;
      for (let i = 0; i < TEST_LEN; i++) {
        const b = ((ciphered[i] - key - i * salt) % 256 + 256) % 256;
        if (!(b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126))) { ok = false; break; }
      }
      if (!ok) continue;

      const raw = Buffer.from(ciphered.map((c, i) => ((c - key - i * salt) % 256 + 256) % 256));
      let text;
      try { text = raw.toString('utf8'); } catch (_) { continue; }
      const hits = LUA_KWS.filter(kw => text.includes(kw)).length;
      if (hits >= 2) {
        if (verbose) log('CV35', `✓ key=${key} salt=${salt} (${tested.toLocaleString()} intentos)`);
        return { text, key, salt };
      }
    }
  }
  return null;
}

function runCodeVaultV35Engine(code) {
  log('CV35', 'Buscando símbolo-mapa CodeVault v35...');
  const symMap = findSymbolMap(code);
  if (!symMap) { log('CV35', '— No es CodeVault v35'); return null; }

  const codec = Object.entries(symMap).sort((a,b) => a[1]-b[1]).map(e => e[0]).join('');
  log('CV35', `✓ Codec: '${codec}'`);

  const validSyms = new Set(Object.keys(symMap));
  const candidates = findEncodedStrings(code, validSyms);
  if (!candidates.length) { log('CV35', '— Sin strings codificados'); return null; }

  const chunks = pickChunks(candidates);
  if (!chunks) { log('CV35', '— Sin chunks válidos'); return null; }

  const fullEncoded = chunks.join('');
  log('CV35', `✓ Payload: ${fullEncoded.length} símbolos → ${Math.floor(fullEncoded.length/3)} bytes cifrados`);

  const ciphered = decodeSymbols(fullEncoded, symMap);
  log('CV35', `  Fuerza bruta key×salt (254×253 = ${(254*253).toLocaleString()} combos)...`);
  const result = bruteForceKeysSalt(ciphered, true);

  if (!result) { log('CV35', '— key/salt no encontrado'); return null; }
  log('CV35', `✓ Descifrado exitoso (${result.text.length} bytes)`);
  return result.text;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENGINE 3 — CodeVault alt  (10-char codec string + rolling XOR)
//  Source: Fucion_1.txt  →  portado a JS
// ═══════════════════════════════════════════════════════════════════════════

function extractStringAssignments(code) {
  const assignments = {};
  for (const m of code.matchAll(/local\s+([a-zA-Z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"/g))
    assignments[m[1]] = m[2];
  return assignments;
}

function extractHexNumbers(code) {
  const nums = {};
  for (const m of code.matchAll(/local\s+([a-zA-Z_]\w*)\s*=\s*(\(?)\s*(-?)(0[xX][0-9a-fA-F]+)\s*(\)?)/g)) {
    const sign = m[3] === '-' ? -1 : 1;
    nums[m[1]] = sign * parseInt(m[4], 16);
  }
  return nums;
}

function findCodecString(assignments) {
  for (const [varName, s] of Object.entries(assignments))
    if (s.length === 10 && new Set(s).size === 10) return { varName, s };
  return null;
}

function findCodecChunks(code, assignments, codecStr) {
  const concatPat = /local\s+(\w+)\s*=\s*(\w+)\s*\(\s*\{([^}]+)\}\)/;
  const m = code.match(concatPat);
  if (!m) return null;
  const chunkVars = m[3].split(',').map(v => v.trim());
  const validChars = new Set(codecStr);
  return chunkVars.map(v => assignments[v]).filter(s => s && [...s].every(c => validChars.has(c)));
}

function findCodecKeySalt(code, nums) {
  // key_var via _kv pattern
  const km = code.match(/local\s+_kv\s*=\s*\(\s*(\w+)\s*\+0\s*\)\s*%/);
  const keyVar = km ? km[1] : null;
  // salt_var via decode-line pattern
  const dl = code.match(/string\.char\s*\(\s*math\.floor\s*\(\s*\((\w+)\s*-\s*_kv\s*-\s*_xi\s*\*\s*(\w+)\s*\)\s*%\s*256\s*\)/);
  const saltVar = dl ? dl[2] : null;
  return { key: keyVar ? nums[keyVar] : null, salt: saltVar ? nums[saltVar] : null };
}

function decodeCodecPayload(chunks, codecStr, key, salt) {
  const encoded = chunks.join('');
  const map = {};
  for (let i = 0; i < codecStr.length; i++) map[codecStr[i]] = i;
  const bytes = [];
  for (let i = 0; i + 2 < encoded.length; i += 3) {
    const d = (map[encoded[i]] ?? 0) * 100 + (map[encoded[i+1]] ?? 0) * 10 + (map[encoded[i+2]] ?? 0);
    bytes.push(((d - key - (i/3) * salt) % 256 + 256) % 256);
  }
  return Buffer.from(bytes).toString('utf8');
}

function runCodecEngine(code) {
  log('CODEC', 'Buscando codec de 10 caracteres...');
  const assignments = extractStringAssignments(code);
  const nums        = extractHexNumbers(code);
  const codec       = findCodecString(assignments);
  if (!codec) { log('CODEC', '— Sin codec string'); return null; }
  log('CODEC', `✓ Codec: '${codec.s}'`);

  const chunks = findCodecChunks(code, assignments, codec.s);
  if (!chunks || chunks.length === 0) { log('CODEC', '— Sin chunks'); return null; }
  log('CODEC', `✓ ${chunks.length} chunks (${chunks.reduce((s,c)=>s+c.length,0)} chars total)`);

  const { key, salt } = findCodecKeySalt(code, nums);
  if (key == null || salt == null) {
    log('CODEC', `— key/salt no encontrado (key=${key}, salt=${salt})`);
    return null;
  }
  log('CODEC', `✓ key=${key} salt=${salt}`);

  try {
    const decoded = decodeCodecPayload(chunks, codec.s, key, salt);
    log('CODEC', `✓ Payload decodificado (${decoded.length} bytes)`);
    return decoded;
  } catch (e) {
    log('CODEC', `— Error al decodificar: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ORQUESTADOR PRINCIPAL — todos los engines en cascada
// ═══════════════════════════════════════════════════════════════════════════

function deobfuscate(inputCode) {
  const bar = '═'.repeat(60);
  process.stderr.write(`\n${bar}\n  SUPER LUA/LUAU DEOBFUSCATOR\n${bar}\n`);
  process.stderr.write(`  Input: ${inputCode.length.toLocaleString()} bytes\n\n`);

  let code = inputCode;
  let changed = true;
  let totalPasses = 0;

  while (changed && totalPasses < 30) {
    changed = false;
    totalPasses++;

    // ── Pase general siempre primero ──────────────────────────────────────
    const afterGeneral = runGeneralPass(code);
    if (afterGeneral !== code) { code = afterGeneral; changed = true; }

    // ── Engine 1: vmmer VM ────────────────────────────────────────────────
    const vmResult = runVmmerEngine(code);
    if (vmResult.layers > 0) { code = vmResult.code; changed = true; continue; }

    // ── Engine 2: CodeVault v35 ───────────────────────────────────────────
    const cv35 = runCodeVaultV35Engine(code);
    if (cv35) { code = runGeneralPass(cv35); changed = true; continue; }

    // ── Engine 3: Codec alt ───────────────────────────────────────────────
    const codec = runCodecEngine(code);
    if (codec) { code = runGeneralPass(codec); changed = true; continue; }
  }

  process.stderr.write(`\n${bar}\n`);
  process.stderr.write(`  Output : ${code.length.toLocaleString()} bytes\n`);
  process.stderr.write(`  Passes : ${totalPasses}\n`);
  process.stderr.write(`  Status : ✓ DONE\n${bar}\n\n`);
  return code;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════════════════════════════

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error([
      '',
      'SUPER LUA/LUAU DEOBFUSCATOR',
      '',
      'Uso:  node super-deobfuscator.js <input.lua> [output.lua]',
      '',
      'Engines:',
      '  [1] vmmer true-VM     (pool/order/key/salt XOR)',
      '  [2] CodeVault v35     (symbol-map + brute-force)',
      '  [3] CodeVault alt     (10-char codec + rolling XOR)',
      '  [4] General pass      (math, string.char, anti-debug, hex, base64,',
      '                         XOR strings, dead code, junk, CFF, proxy fns)',
      '',
      'Técnicas cubiertas:',
      '  • Virtual Machine (vmmer, fragile-VM, diabolical mode)',
      '  • Math obfuscation  ((((n+k)*m)/m)-k) → n',
      '  • string.char()  →  literal string',
      '  • Hex/Base64/XOR string encoding',
      '  • Anti-debug (os.clock, debug.sethook, debug.getinfo)',
      '  • Anti-tamper (_ENV checks, metatable guards)',
      '  • Junk code (dead branches, false loops)',
      '  • Control flow flattening (state machines)',
      '  • String arrays con rotación/shuffle',
      '  • Proxy / alias functions',
      '  • Silent-corrupt guards',
      '  • CodeVault v35 rolling-XOR cipher',
      '',
    ].join('\n'));
    process.exit(1);
  }

  const inFile  = args[0];
  const outFile = args[1] ?? inFile.replace(/(\.[^.]+)?$/, '_deobf.lua');

  let inputCode;
  try { inputCode = fs.readFileSync(inFile, 'utf8'); }
  catch (e) { console.error('Error al leer:', e.message); process.exit(1); }

  const result = deobfuscate(inputCode);

  try { fs.writeFileSync(outFile, result, 'utf8'); }
  catch (e) { console.error('Error al escribir:', e.message); process.exit(1); }

  console.log(result);
}

main();
