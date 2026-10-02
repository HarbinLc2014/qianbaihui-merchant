export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
}

export function normalizeAccount(value) {
  const account = String(value || '').trim();
  if (!account || /\s/.test(account)) throw new ApiError('请输入员工手机号或邮箱');
  const email = account.includes('@') ? account : `${account}@example.com`;
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) throw new ApiError('账号格式不正确');
  return email;
}

const STORAGE_KEY = 'qianbaihui.merchant.session.v1';
export class MerchantApi {
  constructor({ url, anonKey, storage, fetchImpl = (...args) => globalThis.fetch(...args), now = () => Date.now() }) {
    if (!/^https:\/\//.test(url)) throw new Error('订单服务必须使用 HTTPS');
    this.url = url.replace(/\/$/, ''); this.anonKey = anonKey;
    this.storage = storage; this.fetch = fetchImpl; this.now = now;
    this.session = null; this.refreshing = null; this.pendingOrders = new Set();
    try {
      const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
      if (saved?.access_token && saved?.refresh_token && Number.isFinite(saved.expires_at)) this.session = saved;
      else storage.removeItem(STORAGE_KEY);
    } catch { storage.removeItem(STORAGE_KEY); }
  }
  get signedIn() { return Boolean(this.session); }
  get accountName() { return this.session?.email || '门店员工'; }
  clearSession() { this.session = null; this.storage.removeItem(STORAGE_KEY); }
  saveSession(data) {
    if (!data.access_token || !data.refresh_token) throw new ApiError('登录响应无效');
    this.session = { access_token:data.access_token, refresh_token:data.refresh_token,
      expires_at:Number(data.expires_at || Math.floor(this.now()/1000)+Number(data.expires_in || 3600)),
      email:data.user?.email || this.session?.email || '' };
    try { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.session)); }
    catch { this.clearSession(); throw new ApiError('浏览器无法保存本次会话，请允许当前站点的会话存储'); }
  }
  async request(path, body, jwt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await this.fetch(this.url + path, { method:'POST',
        headers:{ apikey:this.anonKey, 'Content-Type':'application/json', ...(jwt ? {Authorization:`Bearer ${jwt}`} : {}) },
        body:JSON.stringify(body), signal:controller.signal, credentials:'omit', cache:'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message = response.status === 403 ? '当前账号没有本店订单处理权限，请联系店长' :
          response.status === 401 ? '登录已失效，请重新登录' :
          path.startsWith('/auth/') ? '账号或密码不正确，或暂时无法登录' : String(data?.error || '订单服务暂时不可用');
        throw new ApiError(message, response.status);
      }
      if (data?.error) throw new ApiError(String(data.error));
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('网络连接中断，请刷新订单核对处理结果后再操作');
    } finally { clearTimeout(timer); }
  }
  async signIn(account, password) {
    if (!password) throw new ApiError('请输入密码');
    this.clearSession();
    const data = await this.request('/auth/v1/token?grant_type=password', {email:normalizeAccount(account),password});
    this.saveSession(data);
    try { return await this.listOrders(); }
    catch (error) { this.clearSession(); throw error; }
  }
  async ensureToken() {
    if (!this.session) throw new ApiError('请先登录员工账号', 401);
    if (this.session.expires_at * 1000 > this.now() + 30000) return this.session.access_token;
    if (!this.refreshing) {
      const refreshToken = this.session.refresh_token;
      this.refreshing = this.request('/auth/v1/token?grant_type=refresh_token', {refresh_token:refreshToken})
        .then(data => { if (!this.session || this.session.refresh_token !== refreshToken) throw new ApiError('请重新登录',401); this.saveSession(data); return this.session.access_token; })
        .catch(error => { this.clearSession(); throw error; })
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async invoke(name, body) {
    const token = await this.ensureToken();
    try { return await this.request(`/functions/v1/${name}`, body, token); }
    catch (error) { if (error.status === 401) this.clearSession(); throw error; }
  }
  listOrders({status = '', keyword = ''} = {}) { return this.invoke('admin-list-orders',{status:status || null,keyword:keyword.trim() || null}); }
  async updateOrder(orderId, action, extra = {}) {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(orderId)) throw new ApiError('订单编号无效');
    if (!['confirm','mark_paid','ship','complete','cancel','refund'].includes(action)) throw new ApiError('订单操作无效');
    if (this.pendingOrders.has(orderId)) throw new ApiError('这笔订单正在处理，请勿重复提交');
    if (action === 'ship' && !String(extra.trackingNo || '').trim()) throw new ApiError('请填写物流单号');
    this.pendingOrders.add(orderId);
    try { return await this.invoke('admin-update-order', {orderId,action,...extra}); }
    finally { this.pendingOrders.delete(orderId); }
  }
  async signOut() {
    const token = this.session?.access_token;
    this.clearSession();
    if (token) { try { await this.request('/auth/v1/logout?scope=local',{},token); } catch { /* Local session is already removed. */ } }
  }
}
