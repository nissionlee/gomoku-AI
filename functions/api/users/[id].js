/**
 * 单个用户管理（仅管理员）
 *   PATCH  /api/users/:id  改密码 / 改角色 / 改昵称
 *   DELETE /api/users/:id  删除用户（不能删自己，且系统至少保留一个管理员）
 */
import { json, requireDb, readJsonBody, requireAdmin, hashPassword, randomHex, validPassword } from '../../_lib/auth.js';

function parseId(raw) {
  const id = Number.parseInt(String(raw || ''), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const dbError = requireDb(env);
  if (dbError) return dbError;

  const { error } = await requireAdmin(request, env);
  if (error) return error;

  const id = parseId(params.id);
  if (!id) return json({ ok: false, error: '用户 ID 不合法' }, 400);

  const body = await readJsonBody(request, 4096);
  if (!body.ok) return json({ ok: false, error: body.error }, 400);

  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(id).first();
  if (!target) return json({ ok: false, error: '用户不存在' }, 404);

  const sets = [];
  const values = [];

  if (typeof body.data.displayName === 'string') {
    const dn = body.data.displayName.trim().slice(0, 30);
    if (dn) {
      sets.push('display_name = ?');
      values.push(dn);
    }
  }

  if (body.data.password !== undefined) {
    const p = validPassword(body.data.password);
    if (!p.ok) return json({ ok: false, error: p.error }, 400);
    const salt = randomHex(16);
    const hash = await hashPassword(p.value, salt);
    sets.push('password_hash = ?', 'salt = ?');
    values.push(hash, salt);
  }

  if (body.data.role !== undefined) {
    const role = body.data.role === 'admin' ? 'admin' : 'user';
    if (target.role === 'admin' && role !== 'admin') {
      const admins = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first();
      if (admins && admins.n <= 1) {
        return json({ ok: false, error: '系统至少需保留一个管理员' }, 400);
      }
    }
    sets.push('role = ?');
    values.push(role);
  }

  if (!sets.length) return json({ ok: false, error: '没有需要更新的字段' }, 400);

  try {
    values.push(id);
    await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

    // 改密码后踢掉该用户所有旧会话
    if (body.data.password !== undefined) {
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
    }

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: `更新失败：${err.message || err}` }, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const dbError = requireDb(env);
  if (dbError) return dbError;

  const { user, error } = await requireAdmin(request, env);
  if (error) return error;

  const id = parseId(params.id);
  if (!id) return json({ ok: false, error: '用户 ID 不合法' }, 400);
  if (id === user.id) return json({ ok: false, error: '不能删除当前登录的账号' }, 400);

  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(id).first();
  if (!target) return json({ ok: false, error: '用户不存在' }, 404);

  try {
    if (target.role === 'admin') {
      const admins = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first();
      if (admins && admins.n <= 1) {
        return json({ ok: false, error: '系统至少需保留一个管理员' }, 400);
      }
    }

    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: `删除失败：${err.message || err}` }, 500);
  }
}

export async function onRequest() {
  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
