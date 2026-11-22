import { Button } from "@cloudflare/kumo/components/button";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import { DownloadSimple, X } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useT } from "../../i18n";

/**
 * Pure TypeScript ISO/IEC 18004 Byte-mode QR Code matrix encoder (Versions 1..10, ECC-L).
 * Zero external runtime dependencies, handles up to 271 UTF-8 bytes (subscription URLs).
 */
const EC_CODEWORDS_L = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const NUM_BLOCKS_L = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ALIGNMENT_CENTERS: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree: number): Uint8Array {
  let poly: number[] = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return Uint8Array.from(poly);
}

function rsRemainder(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGenerator(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let j = 0; j < ecLen; j++) {
      rem[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return rem;
}

function formatBits(mask: number): number {
  // ECC Level L = 01
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

export function encodeQrMatrix(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const dataCw = TOTAL_CODEWORDS[v] - EC_CODEWORDS_L[v] * NUM_BLOCKS_L[v];
    const headerBits = 4 + (v >= 10 ? 16 : 8);
    const capacityBytes = Math.floor((dataCw * 8 - headerBits) / 8);
    if (bytes.length <= capacityBytes) {
      version = v;
      break;
    }
  }
  if (version === 0) return null;

  const totalCw = TOTAL_CODEWORDS[version];
  const ecPerBlock = EC_CODEWORDS_L[version];
  const blocks = NUM_BLOCKS_L[version];
  const dataCw = totalCw - ecPerBlock * blocks;

  // Build bit stream: Byte mode (0100), char count, data bytes, terminator, pad bytes
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) pushBits(b, 8);
  const maxBits = dataCw * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  let padToggle = true;
  while (bits.length < maxBits) {
    pushBits(padToggle ? 0xec : 0x11, 8);
    padToggle = !padToggle;
  }

  const rawData = new Uint8Array(dataCw);
  for (let i = 0; i < dataCw; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b];
    rawData[i] = byte;
  }

  // Split blocks & compute RS ECC
  const shortBlockLen = Math.floor(dataCw / blocks);
  const numLongBlocks = dataCw % blocks;
  const numShortBlocks = blocks - numLongBlocks;
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < blocks; b++) {
    const len = shortBlockLen + (b >= numShortBlocks ? 1 : 0);
    const slice = rawData.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(slice);
    ecBlocks.push(rsRemainder(slice, ecPerBlock));
  }

  // Interleave codewords
  const codewords: number[] = [];
  const maxDataLen = shortBlockLen + (numLongBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < dataBlocks[b].length) codewords.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < blocks; b++) codewords.push(ecBlocks[b][i]);
  }

  const size = version * 4 + 17;
  const grid: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));

  const setModule = (r: number, c: number, dark: boolean, isFunc = true) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    grid[r][c] = dark;
    if (isFunc) reserved[r][c] = true;
  };

  const drawFinder = (tr: number, tc: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = tr + dr;
        const c = tc + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const center = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setModule(r, c, inside && (border || center));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const centers = ALIGNMENT_CENTERS[version];
  for (const cr of centers) {
    for (const cc of centers) {
      if ((cr === 6 && cc === 6) || (cr === 6 && cc === size - 7) || (cr === size - 7 && cc === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setModule(cr + dr, cc + dc, dark);
        }
      }
    }
  }

  // Reserve format info + dark module
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
  }
  for (let i = size - 8; i < size; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  setModule(size - 8, 8, true);

  // Version info for v >= 7
  if (version >= 7) {
    const vBits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setModule(r, c, bit);
      setModule(c, r, bit);
    }
  }

  // Place data bits in zigzag
  let bitIdx = 0;
  const totalDataBits = codewords.length * 8;
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (reserved[row][c]) continue;
        let dark = false;
        if (bitIdx < totalDataBits) {
          dark = ((codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx++;
        }
        grid[row][c] = dark;
      }
    }
    upward = !upward;
  }

  // Apply mask 0: (row + col) % 2 === 0 and pick best of masks 0..3 by simple dark/light balance + runs
  const maskFns = [
    (r: number, c: number) => (r + c) % 2 === 0,
    (r: number) => r % 2 === 0,
    (_r: number, c: number) => c % 3 === 0,
    (r: number, c: number) => (r + c) % 3 === 0,
  ];

  let bestGrid = grid;
  let bestMask = 0;
  let bestScore = Infinity;

  for (let m = 0; m < maskFns.length; m++) {
    const candidate = grid.map((row, r) =>
      row.map((val, c) => (reserved[r][c] ? val : maskFns[m](r, c) ? !val : val)),
    );
    const fmt = formatBits(m);
    for (let i = 0; i < 15; i++) {
      const bit = ((fmt >> i) & 1) === 1;
      if (i < 6) candidate[8][i] = bit;
      else if (i < 8) candidate[8][i + 1] = bit;
      else candidate[8][size - 15 + i] = bit;

      if (i < 8) candidate[size - 1 - i][8] = bit;
      else if (i === 8) candidate[7][8] = bit;
      else candidate[14 - i][8] = bit;
    }

    let darkCount = 0;
    let penalty = 0;
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 0; c < size; c++) {
        if (candidate[r][c]) darkCount++;
        if (c > 0) {
          if (candidate[r][c] === candidate[r][c - 1]) {
            run++;
            if (run === 5) penalty += 3;
            else if (run > 5) penalty += 1;
          } else run = 1;
        }
      }
    }
    const ratioPenalty = Math.abs(Math.round((darkCount * 100) / (size * size)) - 50) * 2;
    const score = penalty + ratioPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestMask = m;
      bestGrid = candidate;
    }
  }
  void bestMask;
  return bestGrid;
}

export function QrCodeSvg({
  value,
  size = 208,
  label,
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const matrix = useMemo(() => encodeQrMatrix(value), [value]);
  if (!matrix) return null;
  const quiet = 3;
  const dim = matrix.length + quiet * 2;
  const paths: string[] = [];
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (matrix[r][c]) paths.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
    }
  }
  return (
    <div className="inline-flex rounded-xl border border-kumo-line bg-white p-3 shadow-xs">
      <svg
        role="img"
        aria-label={label ?? "QR code"}
        width={size}
        height={size}
        viewBox={`0 0 ${dim} ${dim}`}
        shapeRendering="crispEdges"
      >
        <rect width={dim} height={dim} fill="#ffffff" />
        <path d={paths.join("")} fill="#111827" />
      </svg>
    </div>
  );
}

export function QrCodeModal({
  open,
  onClose,
  title,
  subtitle,
  value,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  value: string;
}) {
  const t = useT("common");
  const matrix = useMemo(() => (open ? encodeQrMatrix(value) : null), [open, value]);

  function downloadSvg() {
    if (!matrix) return;
    const quiet = 4;
    const dim = matrix.length + quiet * 2;
    const paths: string[] = [];
    for (let r = 0; r < matrix.length; r++) {
      for (let c = 0; c < matrix.length; c++) {
        if (matrix[r][c]) paths.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${paths.join("")}" fill="#111827"/></svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "subscription-qr.svg";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog size="base" className="p-0 overflow-hidden" data-kumo-dialog={open ? "open" : undefined}>
        <div className="flex items-center justify-between gap-3 border-b border-kumo-line px-6 py-4">
          <div className="min-w-0">
            <Dialog.Title className="truncate text-base font-semibold text-kumo-strong">{title}</Dialog.Title>
            {subtitle && <Dialog.Description className="truncate text-xs text-kumo-subtle">{subtitle}</Dialog.Description>}
          </div>
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="ghost" shape="square" size="sm" aria-label={t("close", "Close")}>
                <X size={16} />
              </Button>
            )}
          />
        </div>
        <div className="flex flex-col items-center gap-4 p-6">
          <QrCodeSvg value={value} size={220} label={title} />
          <p className="text-center text-xs text-kumo-subtle">
            {t("qr.hint", "Scan this QR code with your mobile proxy client to import the remote profile.")}
          </p>
          <div className="w-full min-w-0">
            <ClipboardText
              text={value}
              size="sm"
              labels={{ copyAction: t("copy", "Copy") }}
              tooltip={{ text: t("copy", "Copy"), copiedText: t("copied", "Copied") }}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-kumo-line px-6 py-3.5">
          <Tooltip
            content={t("qr.downloadHint", "Save QR code as an SVG image")}
            render={
              <Button variant="secondary" size="sm" icon={DownloadSimple} onClick={downloadSvg} disabled={!matrix}>
                {t("qr.download", "Save SVG")}
              </Button>
            }
          />
          <Button variant="primary" size="sm" onClick={onClose}>
            {t("done", "Done")}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
