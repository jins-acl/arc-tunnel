export interface ScreenshotOptions {
  format: 'jpeg' | 'png';
  quality: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface ScreenshotResult {
  screenshot: string;
  mimeType: 'image/jpeg' | 'image/png';
  format: 'jpeg' | 'png';
  quality?: number;
  width?: number;
  height?: number;
  originalWidth?: number;
  originalHeight?: number;
  resized: boolean;
}

type RawScreenshotOptions = Partial<Record<keyof ScreenshotOptions, unknown>>;
type ScreenshotSizeLimits = Pick<Partial<ScreenshotOptions>, 'maxWidth' | 'maxHeight'>;

export function normalizeScreenshotOptions(raw: RawScreenshotOptions = {}): ScreenshotOptions {
  const format = raw.format ?? 'jpeg';
  if (format !== 'jpeg' && format !== 'png') {
    throw new Error('format must be either jpeg or png');
  }

  const quality = raw.quality ?? 80;
  if (!Number.isInteger(quality) || (quality as number) < 1 || (quality as number) > 100) {
    throw new Error('quality must be an integer between 1 and 100');
  }

  const options: ScreenshotOptions = { format, quality: quality as number };
  for (const key of ['maxWidth', 'maxHeight'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new Error(`${key} must be a positive integer`);
    }
    options[key] = value as number;
  }
  return options;
}

export function calculateOutputSize(
  originalWidth: number,
  originalHeight: number,
  limits: ScreenshotSizeLimits
): { width: number; height: number; resized: boolean } {
  const widthScale = limits.maxWidth === undefined ? 1 : limits.maxWidth / originalWidth;
  const heightScale = limits.maxHeight === undefined ? 1 : limits.maxHeight / originalHeight;
  const scale = Math.min(1, widthScale, heightScale);

  if (scale === 1) {
    return { width: originalWidth, height: originalHeight, resized: false };
  }

  return {
    width: Math.max(1, Math.round(originalWidth * scale)),
    height: Math.max(1, Math.round(originalHeight * scale)),
    resized: true
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function processScreenshot(
  data: string,
  options: ScreenshotOptions
): Promise<ScreenshotResult> {
  const mimeType = options.format === 'png' ? 'image/png' : 'image/jpeg';
  const quality = options.format === 'jpeg' ? options.quality : undefined;
  if (options.maxWidth === undefined && options.maxHeight === undefined) {
    return {
      screenshot: data,
      mimeType,
      format: options.format,
      quality,
      resized: false
    };
  }

  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('Screenshot resizing is not supported by this browser');
  }

  const sourceBlob = await (await fetch(`data:${mimeType};base64,${data}`)).blob();
  const source = await createImageBitmap(sourceBlob);
  const originalWidth = source.width;
  const originalHeight = source.height;
  try {
    const size = calculateOutputSize(originalWidth, originalHeight, options);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('Unable to create a 2D canvas context for screenshot resizing');
    }
    context.drawImage(source, 0, 0, size.width, size.height);
    const blob = await canvas.convertToBlob({ type: mimeType, quality: options.quality / 100 });
    const encoded = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));

    return {
      screenshot: encoded,
      mimeType,
      format: options.format,
      quality,
      width: size.width,
      height: size.height,
      originalWidth,
      originalHeight,
      resized: size.resized
    };
  } finally {
    source.close();
  }
}
