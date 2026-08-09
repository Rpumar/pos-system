/**
 * Simula timestamps reales: un scanner HID típico envía cada carácter
 * en 1-15ms; un humano tecleando ronda 80-250ms entre teclas, incluso
 * escribiendo rápido. El test reproduce ambos patrones temporales.
 */
import { ScannerDetector } from '../../src/presentation/services/ScannerDetector';

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
  } else {
    console.log(`  ❌ ${message}`);
    failures++;
  }
}

function feedString(detector: ScannerDetector, text: string, msPerChar: number, startAt = 0): number {
  let t = startAt;
  for (const char of text) {
    detector.feed(char, t);
    t += msPerChar;
  }
  return t;
}

console.log('=== Verificación de ScannerDetector ===');

// Test 1: escaneo real (rápido) debe reconocerse como código válido.
console.log('\nTest 1: escaneo rápido (8ms entre caracteres, típico de un lector HID)');
{
  const detector = new ScannerDetector();
  feedString(detector, '7791234567890', 8);
  const code = detector.complete();
  assert(code === '7791234567890', `el código completo se reconoció (fue: ${code})`);
}

// Test 2: tecleo humano lento NO debe reconocerse como un código de barras,
// aunque el cajero escriba más de 6 caracteres antes de Enter.
console.log('\nTest 2: tecleo humano lento (150ms entre caracteres)');
{
  const detector = new ScannerDetector();
  feedString(detector, '123456', 150);
  const code = detector.complete();
  assert(code === null, `NO se reconoce como escaneo (fue: ${code})`);
}

// Test 3: caso límite — un cajero empieza a escribir lento, se detiene,
// y LUEGO sí pasa el scanner. Solo debe quedar el código del scanner,
// sin arrastrar caracteres del tecleo humano previo.
console.log('\nTest 3: tecleo humano lento seguido de un escaneo real (no deben mezclarse)');
{
  const detector = new ScannerDetector();
  let t = feedString(detector, 'ab', 150); // tecleo humano lento, buffer parcial
  t = feedString(detector, '7790009876543', 8, t + 5); // 5ms después arranca el scanner
  const code = detector.complete();
  assert(code === '7790009876543', `el código quedó limpio, sin restos de "ab" (fue: ${code})`);
}

// Test 4: código demasiado corto, aunque sea rápido, no se acepta
// (evita falsos positivos con teclas sueltas tipo flechas o atajos).
console.log('\nTest 4: ráfaga rápida pero demasiado corta para ser un código real');
{
  const detector = new ScannerDetector();
  feedString(detector, '123', 5);
  const code = detector.complete();
  assert(code === null, `se rechaza por ser más corto que el mínimo (fue: ${code})`);
}

// Test 5: reset() debe limpiar cualquier buffer parcial (ej. al presionar ESC).
console.log('\nTest 5: reset() descarta un buffer parcial en curso');
{
  const detector = new ScannerDetector();
  feedString(detector, '779000', 8);
  detector.reset();
  const code = detector.complete();
  assert(code === null, `el buffer quedó vacío tras reset() (fue: ${code})`);
}

console.log(`\n${failures === 0 ? '✅ TODOS LOS CHECKS PASARON' : `❌ ${failures} CHECK(S) FALLARON`}`);
process.exit(failures === 0 ? 0 : 1);
