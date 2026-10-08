/**
 * Cloudflare Pages Function (跨设备配置同步)
 * 路径: /api/sync/:code
 *   PUT     上传/覆盖设置（有效期 30 天，每次上传刷新）
 *   GET     读取云端设置
 *   DELETE  清除云端设置
 *
 * 存储：KV 命名空间 SETTINGS_KV（见 wrangler.toml 的 [[kv_namespaces]]）
 * 安全：只接受本站来源（不放开 CORS）、同步码格式校验、载荷体积与结构校验、写入频控。
 * 免费额度：Cloudflare Workers/KV 每日 10 万次请求，个人多设备同步远够用。
 */

const KEY_PREFIX = 'settings:';
const TTL_SECONDS = 30 * 24 * 60 * 60;   // 30 天
const MAX_BODY_CHARS = 8 * 1024;         // 8KB 足够放一份设置，超出即视为异常
const CODE_MIN = 8;
const CODE_MAX = 16;
const WRITE_LIMIT_PER_HOUR = 60;         // 同一来源 IP 每小时写/删上限
const READ_LIMIT_PER_HOUR = 200;         // 同一来源 IP 每小时读取上限（枚举同步码的兜底防护）

// Worker 隔离级别内存频控（尽力而为，用于抬高枚举同步码的成本）
const writeBuckets = new Map();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function checkCode(raw) {
  const code = normalizeCode(raw);
  if (code.length < CODE_MIN || code.length > CODE_MAX) {
    return { ok: false, error: `同步码需为 ${CODE_MIN}-${CODE_MAX} 位字母或数字` };
  }
  return { ok: true, code };
}

function hitRateLimit(request, action, limit) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
  const key = `${ip}:${action}`;
  const now = Date.now();
  const bucket = writeBuckets.get(key);

  if (!bucket || now - bucket.start > 3600 * 1000) {
    if (writeBuckets.size > 4096) writeBuckets.clear();
    writeBuckets.set(key, { start: now, count: 1 });
    return false;
  }

  bucket.count += 1;
  return bucket.count > limit;
}

function validatePayload(text) {
  if (!text) return { ok: false, error: '配置内容为空' };
  if (text.length > MAX_BODY_CHARS) return { ok: false, error: '配置内容过大，已拒绝' };

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: '配置内容不是合法 JSON' };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: '配置结构不正确' };
  }
  if (data.kind !== 'gomoku-settings') return { ok: false, error: '不是本游戏的配置包' };
  if (data.v !== 1) return { ok: false, error: '配置版本不受支持' };
  if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) {
    return { ok: false, error: '配置缺少 settings 字段' };
  }
  if (typeof data.updatedAt !== 'number' || data.updatedAt <= 0) {
    return { ok: false, error: '配置缺少更新时间' };
  }

  return { ok: true, data };
}

function requireKv(env) {
  if (!env || !env.SETTINGS_KV) {
    return json({ ok: false, error: '服务端未绑定 KV 命名空间 SETTINGS_KV' }, 500);
  }
  return null;
}

export async function onRequestGet(context) {
  const kvError = requireKv(context.env);
  if (kvError) return kvError;

  const checked = checkCode(context.params.code);
  if (!checked.ok) return json({ ok: false, error: checked.error }, 400);

  if (hitRateLimit(context.request, 'get', READ_LIMIT_PER_HOUR)) {
    return json({ ok: false, error: '读取过于频繁，请稍后再试' }, 429);
  }

  try {
    const stored = await context.env.SETTINGS_KV.get(KEY_PREFIX + checked.code, 'json');
    if (!stored) {
      return json({ ok: false, error: '云端没有找到该同步码的配置（若刚上传请稍候约 1 分钟再试，云端同步有短暂延迟；也可能是已过期或被清除）' }, 404);
    }
    return json({ ok: true, data: stored, code: checked.code });
  } catch (err) {
    return json({ ok: false, error: `读取失败：${err.message || err}` }, 500);
  }
}

export async function onRequestPut(context) {
  const kvError = requireKv(context.env);
  if (kvError) return kvError;

  const checked = checkCode(context.params.code);
  if (!checked.ok) return json({ ok: false, error: checked.error }, 400);

  if (hitRateLimit(context.request, 'put', WRITE_LIMIT_PER_HOUR)) {
    return json({ ok: false, error: '写入过于频繁，请稍后再试' }, 429);
  }

  let text = '';
  try {
    text = await context.request.text();
  } catch (err) {
    return json({ ok: false, error: '无法读取上传内容' }, 400);
  }

  const validated = validatePayload(text);
  if (!validated.ok) return json({ ok: false, error: validated.error }, 400);

  try {
    await context.env.SETTINGS_KV.put(KEY_PREFIX + checked.code, JSON.stringify(validated.data), {
      expirationTtl: TTL_SECONDS
    });
    return json({
      ok: true,
      code: checked.code,
      updatedAt: validated.data.updatedAt,
      expiresAt: Date.now() + TTL_SECONDS * 1000
    });
  } catch (err) {
    return json({ ok: false, error: `保存失败：${err.message || err}` }, 500);
  }
}

export async function onRequestDelete(context) {
  const kvError = requireKv(context.env);
  if (kvError) return kvError;

  const checked = checkCode(context.params.code);
  if (!checked.ok) return json({ ok: false, error: checked.error }, 400);

  if (hitRateLimit(context.request, 'delete', WRITE_LIMIT_PER_HOUR)) {
    return json({ ok: false, error: '操作过于频繁，请稍后再试' }, 429);
  }

  try {
    await context.env.SETTINGS_KV.delete(KEY_PREFIX + checked.code);
    return json({ ok: true, code: checked.code });
  } catch (err) {
    return json({ ok: false, error: `清除失败：${err.message || err}` }, 500);
  }
}

export async function onRequestOptions() {
  // 刻意不返回 Access-Control-Allow-Origin：仅同源页面可用
  return new Response(null, { status: 204 });
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
