/**
 * Un lector de código de barras es, a nivel de sistema, un teclado HID
 * que "escribe" cada carácter en menos de ~20ms y siempre termina con
 * Enter. Un cajero escribiendo a mano en el buscador (F2) no alcanza
 * esa cadencia ni de cerca. Usamos esa diferencia de tiempo entre
 * pulsaciones para decidir si una racha de teclas es un escaneo o
 * tecleo humano — sin necesitar ningún driver ni permiso especial.
 */
export class ScannerDetector {
  private buffer = '';
  private lastKeystroke = 0;
  private readonly scannerThresholdMs: number;
  private readonly minCodeLength: number;

  constructor(scannerThresholdMs = 30, minCodeLength = 6) {
    this.scannerThresholdMs = scannerThresholdMs;
    this.minCodeLength = minCodeLength;
  }

  /** Alimenta un carácter con su timestamp (en ms, ej. performance.now()). */
  feed(char: string, timestamp: number): void {
    const elapsed = timestamp - this.lastKeystroke;
    if (elapsed > this.scannerThresholdMs && this.buffer.length > 0) {
      // Demasiado lento entre teclas: lo que venía acumulado no era un
      // escaneo (probablemente tecleo humano residual). Se descarta.
      this.buffer = '';
    }
    this.buffer += char;
    this.lastKeystroke = timestamp;
  }

  /**
   * Se llama al recibir Enter. Devuelve el código si el buffer acumulado
   * cumple el largo mínimo esperado de un código de barras real
   * (EAN-13/UPC-A rondan 8-13 dígitos); si no, devuelve null y limpia.
   */
  complete(): string | null {
    const code = this.buffer.length >= this.minCodeLength ? this.buffer : null;
    this.buffer = '';
    return code;
  }

  /** Descarta cualquier buffer parcial sin completar (ej. al presionar ESC). */
  reset(): void {
    this.buffer = '';
  }
}
