/**
 * POST /api/auth/logout  退出登录
 */
import { json, parseCookies, destroySession, clearCookie, COOKIE_NAME } from '../../_lib/auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const token = parseCookies(request)[COOKIE_NAME];
    if (token && env.DB) await destroySession(env, token);
  } catch (e) {
    /* 退出失败也照常清 Cookie */
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
