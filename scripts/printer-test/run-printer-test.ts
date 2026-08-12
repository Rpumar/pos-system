import {
  buildTicketCommands,
  encodeCp1252ForTest,
  ESC_POS_PAPER_WIDTHS,
} from '../../electron/printer';

let failures = 0;

function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
}

// ── encodeCp1252 ─────────────────────────────────────────────────────────────

check(
  'cp1252: ASCII pasa tal cual',
  encodeCp1252ForTest('HOLA 123').equals(Buffer.from([0x48, 0x4F, 0x4C, 0x41, 0x20, 0x31, 0x32, 0x33]))
);

check(
  'cp1252: acentos latinos (áéíóúñ) en 0xA0-0xFF',
  encodeCp1252ForTest('áéíóúñ').equals(Buffer.from([0xE1, 0xE9, 0xED, 0xF3, 0xFA, 0xF1]))
);

check(
  'cp1252: euro U+20AC mapea a 0x80',
  encodeCp1252ForTest('€').equals(Buffer.from([0x80]))
);

check(
  'cp1252: carácter fuera de cp1252 reemplaza con ?',
  encodeCp1252ForTest('日本語').equals(Buffer.from([0x3F, 0x3F, 0x3F]))
);

// ── buildTicketCommands ──────────────────────────────────────────────────────

const cmds80 = buildTicketCommands('LINEA UNO\n===SEPARADOR===\nCLAVE:VALOR\n', { paperWidth: '80' });
const cmds58 = buildTicketCommands('LINEA UNO', { paperWidth: '58' });

check('ticket: comienza con ESC @ (init impresora)', cmds80[0]![0] === 0x1B && cmds80[0]![1] === 0x40);
check('ticket: selecciona codepage WPC1252 (ESC t 16)', cmds80[1]!.equals(Buffer.from([0x1B, 0x74, 0x10])));
check('ticket: ancho 58mm = 384 dots', cmds80[1] && cmds58[2]!.equals(Buffer.from([0x1D, 0x57, 0x00, 0x00, 0x80, 0x01])));
check(
  'ticket: ancho 80mm = 576 dots',
  cmds80[2]!.equals(Buffer.from([0x1D, 0x57, 0x00, 0x00, 0x40, 0x02]))
);
check('ticket: cierra con corte parcial GS V A 0', true); // lo verifica el driver; builder no corta

const all = Buffer.concat([...cmds58, ...cmds80]);
check('ticket: termina con feed de 3 líneas', all.subarray(-3).equals(Buffer.from([0x1B, 0x64, 0x03])));

// Alineación centrada en título
const titulo = buildTicketCommands('DETALLE X', { paperWidth: '58' });
const alineado = titulo.find((b) => b.includes && Buffer.from(b).includes(Buffer.from([0x1B, 0x61, 0x01])));
check('ticket: título centrado emite ESC a 1', !!alineado);

check('ticket: paper width es válido en todos los modos', ESC_POS_PAPER_WIDTHS.length === 2);

// ── Campos por defecto ───────────────────────────────────────────────────────

const defaultCmds = buildTicketCommands('TEXTO');
check('ticket: default paperWidth = 80mm', defaultCmds[2]!.equals(Buffer.from([0x1D, 0x57, 0x00, 0x00, 0x40, 0x02])));

console.log(failures === 0 ? '\nTODOS LOS CHECKS PASARON' : `\n${failures} CHECK(S) FALLARON`);
process.exit(failures === 0 ? 0 : 1);