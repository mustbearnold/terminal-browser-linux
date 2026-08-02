import type { EngineInfo, Rgba } from "pixel-react";

export interface Theme {
  bg: Rgba;
  fg: Rgba;
  muted: Rgba;
  disabled: Rgba;
  error: Rgba;
  accent: Rgba;
  field: Rgba;
  fieldBorder: Rgba;
  hover: Rgba;
  hoverStrong: Rgba;
  hairline: Rgba;
  selection: Rgba;
}

export function mix(base: Rgba, toward: Rgba, t: number): Rgba {
  const channel = (b: number, w: number) => Math.round(b + (w - b) * t);
  return [
    channel(base[0], toward[0]),
    channel(base[1], toward[1]),
    channel(base[2], toward[2]),
    255,
  ];
}

export function makeTheme(colors: EngineInfo["colors"]): Theme {
  const bg = colors.background ?? [30, 32, 38, 255];
  const fg = colors.foreground ?? [235, 237, 242, 255];
  const accent = colors.palette[12] ?? colors.palette[4] ?? [93, 156, 255, 255];
  return {
    bg,
    fg,
    accent,
    muted: mix(fg, bg, 0.35),
    disabled: mix(fg, bg, 0.7),
    error: colors.palette[9] ?? colors.palette[1] ?? [220, 90, 90, 255],
    field: mix(bg, fg, 0.06),
    fieldBorder: mix(bg, fg, 0.16),
    hover: mix(bg, fg, 0.12),
    hoverStrong: mix(bg, fg, 0.26),
    hairline: mix(bg, fg, 0.12),
    selection: mix(bg, accent, 0.35),
  };
}
