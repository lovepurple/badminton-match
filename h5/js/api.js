(function (global) {
  const BA = (global.BA = global.BA || {});
  let token = '';

  function setToken(value) {
    token = value || '';
  }

  function base() {
    return (global.BA_API_BASE || '').replace(/\/$/, '');
  }

  async function request(path, options) {
    const opts = options || {};
    const method = opts.method || 'GET';
    const headers = { 'content-type': 'application/json' };
    if (opts.auth !== false && token) headers.Authorization = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(base() + path, {
        method,
        headers,
        body: opts.data === undefined ? undefined : JSON.stringify(opts.data)
      });
    } catch (e) {
      throw { offline: true, err: e };
    }

    const text = await res.text();
    let payload = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (e) {
      /* 保留文本 */
    }
    if (res.ok) return payload;
    throw { status: res.status, detail: (payload && payload.detail) || '请求失败' };
  }

  BA.api = { request, setToken };
})(window);
