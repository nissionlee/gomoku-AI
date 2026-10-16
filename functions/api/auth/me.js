/**
 * GET /api/auth/me  当前登录用户（未登录返回 401）
 */
import { json, requireDb, currentUser } from '../../_lib/auth.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  const dbError = requireDb(env);
  if (dbError) return dbError;

  try {
    const user = await currentUser(request, env);
    if (!user) return json({ ok: false, error: '未登录' }, 401);
    return json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role
      }
    });
  } catch (err) {
    return json({ ok: false, error: `读取会话失败：${err.message || err}` }, 500);
  }
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
