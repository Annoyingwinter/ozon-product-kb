/**
 * 图片处理: 下载 → sharp放大到1200x1200 → 上传到图床 → 返回公共URL
 * Ozon要求: ≥1000x1000, 推荐2000x2000, 格式jpg/png
 */
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const IMAGES_DIR = path.resolve("images");
const TARGET_SIZE = 1200;

// 图片URL缓存（避免重复处理同一张图）
const _cache = new Map();

/**
 * 下载图片 → 放大到1200x1200 → 保存到本地 → 返回本地路径
 */
export async function processAndSave(url, slug) {
  const cacheKey = url;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  try {
    // 转换URL格式
    let fetchUrl = url.replace(/\.(jpg|jpeg|png)_\.webp$/i, ".$1");

    const r = await fetch(fetchUrl, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;

    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000) return null;

    const img = sharp(buf);
    const meta = await img.metadata();
    if (!meta.width || !meta.height || meta.width < 100) return null;

    // 已经 ≥1000 就不放大（保持原始质量）
    const needResize = meta.width < 1000 || meta.height < 1000;

    const processed = needResize
      ? await img.resize(TARGET_SIZE, TARGET_SIZE, {
          fit: "contain",
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        }).jpeg({ quality: 92 }).toBuffer()
      : await img.jpeg({ quality: 92 }).toBuffer();

    // 保存本地
    const dir = path.join(IMAGES_DIR, slug);
    await fs.mkdir(dir, { recursive: true });
    const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 8);
    const filePath = path.join(dir, `${hash}.jpg`);
    await fs.writeFile(filePath, processed);

    _cache.set(cacheKey, filePath);
    return filePath;
  } catch {
    return null;
  }
}

/**
 * 批量处理产品图片，返回本地路径数组
 */
export async function processProductImages(imageUrls, slug) {
  const results = [];
  for (const url of imageUrls.slice(0, 8)) {
    const filePath = await processAndSave(url, slug);
    if (filePath) results.push(filePath);
    if (results.length >= 6) break;
  }
  return results;
}

/**
 * 把本地图片路径转为可被Ozon访问的URL
 * 本地开发时: 通过服务器代理 /images/...
 * 部署后: 通过公网域名访问
 */
export function localPathToUrl(filePath, baseUrl = "") {
  const rel = path.relative(path.resolve("."), filePath).replace(/\\/g, "/");
  return baseUrl ? `${baseUrl}/${rel}` : `/${rel}`;
}
