import type { NativeImage, OffscreenSharedTexture, TextureInfo } from "electron";
import type { Surface, SurfaceTexture } from "pixel-react";
import { damageOf, paintedNothing } from "./types";

/** Converts the paint event's platform-specific handle into an engine frame.
 * Returns null when the handle is one the engine cannot map for CPU reads. */
export function textureFrameOf(info: TextureInfo): SurfaceTexture | null {
  const { ioSurface, nativePixmap } = info.handle;
  if (ioSurface) return { ioSurface };
  if (!nativePixmap || nativePixmap.planes.length !== 1) return null;
  // A dmabuf is only CPU-mappable when the GPU laid it out linearly
  // (DRM_FORMAT_MOD_LINEAR, modifier 0); tiled layouts need a GPU import.
  if (BigInt(nativePixmap.modifier) !== 0n) return null;
  const [plane] = nativePixmap.planes;
  return {
    pixmap: {
      fd: plane.fd,
      width: info.codedSize.width,
      height: info.codedSize.height,
      stride: plane.stride,
      offset: plane.offset,
      size: plane.size,
    },
  };
}

/** Presents one shared-texture paint. Returns true when the surface received
 * pixels, so callers know their next paint no longer has to cover the whole
 * surface. Always releases the texture. */
export function presentTexture(
  surface: Surface,
  texture: OffscreenSharedTexture,
  wholeSurface: boolean,
): boolean {
  try {
    const info = texture.textureInfo;
    if (info.widgetType !== "frame" || info.pixelFormat !== "bgra") return false;
    const frame = textureFrameOf(info);
    if (!frame) return false;
    if (paintedNothing(info) && !wholeSurface) return false;
    const damage = wholeSurface ? undefined : damageOf(info);
    surface.present({ ...frame, damage });
    return true;
  } finally {
    texture.release();
  }
}

/** Presents one software paint (offscreen mode without shared textures).
 * The image is the whole window, so no damage is forwarded. */
export function presentBitmap(surface: Surface, image: NativeImage): boolean {
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) return false;
  surface.present({ bgra: image.toBitmap(), width: size.width, height: size.height });
  return true;
}
