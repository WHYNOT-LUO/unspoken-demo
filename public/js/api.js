// Talks to the server's JSON API. Errors carry the server's `code` (or "network").

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized = () => {};

/** Called whenever the server says the session is gone (expired, logged out elsewhere, account deleted). */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(method, path, body, { keepalive = false } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      keepalive,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.error === "unauthorized") onUnauthorized();
    throw new ApiError(res.status, data.error || "server");
  }
  return data;
}

export const get = (path) => api("GET", path);
export const put = (path, body, options) => api("PUT", path, body ?? {}, options);
export const post = (path, body) => api("POST", path, body ?? {});
export const patch = (path, body) => api("PATCH", path, body);
export const del = (path, body) => api("DELETE", path, body);
