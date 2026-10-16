/**
 * 后端 API 封装（认证 / 用户管理 / 对局）
 * 全部同源请求，会话靠 HttpOnly Cookie，前端不碰 token。
 */

async function request(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function post(path, payload) {
  return request(path, { method: 'POST', body: JSON.stringify(payload || {}) });
}

function patch(path, payload) {
  return request(path, { method: 'PATCH', body: JSON.stringify(payload || {}) });
}

function del(path) {
  return request(path, { method: 'DELETE' });
}

export const api = {
  /* 认证 */
  bootstrapStatus: () => request('/api/auth/bootstrap'),
  bootstrap: (username, password) => post('/api/auth/bootstrap', { username, password }),
  login: (username, password) => post('/api/auth/login', { username, password }),
  logout: () => post('/api/auth/logout'),
  me: () => request('/api/auth/me'),

  /* 用户管理（管理员） */
  listUsers: () => request('/api/users'),
  createUser: (payload) => post('/api/users', payload),
  updateUser: (id, payload) => patch(`/api/users/${id}`, payload),
  deleteUser: (id) => del(`/api/users/${id}`),

  /* 对局 */
  listGames: () => request('/api/games'),
  createGame: (myColor) => post('/api/games', { myColor }),
  joinGame: (roomCode) => post('/api/games/join', { roomCode }),
  lobby: () => request('/api/games/lobby'),
  getGame: (id, since = 0) => request(`/api/game/${id}${since > 0 ? `?since=${since}` : ''}`),
  move: (id, r, c) => post(`/api/game/${id}/move`, { r, c }),
  resign: (id) => post(`/api/game/${id}/resign`)
};

export default api;
