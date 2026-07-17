import qrcode from 'qrcode-generator';
import s from './ui.module.css';

// A QR code rendered as inline SVG. Not a raster and not a remote image: the value is a TOTP secret,
// so it must never leave the browser to some QR-image service — it is drawn here from the module
// grid the generator computes, with no network at all.
//
// Always dark-on-white, whatever the app theme. A scanner expects that polarity, and a QR inverted
// to match a dark dashboard is a QR many phones refuse to read; the white card is the correct,
// boring choice. Integer module coordinates + crispEdges keep the finder patterns sharp at any size.

export function QrCode({ value, size = 176, label }: { value: string; size?: number; label?: string }) {
  const qr = qrcode(0, 'M'); // type 0 = smallest that fits; 'M' tolerates ~15% occlusion (a logo, a smudge)
  qr.addData(value);
  qr.make();

  const count  = qr.getModuleCount();
  const margin = 4;                 // the "quiet zone" the spec requires around the symbol
  const dim    = count + margin * 2;

  let d = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }

  return (
    <svg
      class={s.qr}
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shape-rendering="crispEdges"
      role="img"
      aria-label={label ?? 'QR code'}
    >
      <rect width={dim} height={dim} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
