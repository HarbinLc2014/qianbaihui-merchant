import { CONFIG } from './config.mjs';
import { MerchantApi } from './api.mjs';
import { STATUS_LABELS, money, availableActions, actionPrompt, appendText, confirmedAmount } from './orders.mjs';

const $ = id => document.getElementById(id);
const state = { busy:false, orders:[], pending:null };
const ACTION_LABELS = {confirm:'确认订单',mark_paid:'登记已实际收款',ship:'确认发货',complete:'完成订单',cancel:'取消订单',refund:'登记已实际退款'};
let api;

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = error ? 'notice error' : 'notice';
  $('notice').hidden = !message;
}
function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('button,input,select').forEach(element => { element.disabled = busy; });
  $('login-button').textContent = busy ? '正在处理…' : '登录订单台';
}
function showLogin() {
  $('login-panel').hidden = false; $('workspace').hidden = true; $('account-bar').hidden = true;
  $('orders').replaceChildren(); $('summary').replaceChildren(); $('account-name').textContent = '';
  state.orders = []; state.pending = null;
}
function showWorkspace() {
  $('login-panel').hidden = true; $('workspace').hidden = false; $('account-bar').hidden = false;
  $('account-name').textContent = api.accountName;
}
function renderSummary(summary = {}) {
  $('summary').replaceChildren();
  for (const [label, value] of [['待确认',summary.submitted],['待收款',summary.awaitingPayment],['待发货',summary.paid],['售后申请',summary.refundRequested]]) {
    const metric = appendText($('summary'),'div','','metric');
    appendText(metric,'span',label); appendText(metric,'strong',Number(value || 0));
  }
}
function renderOrders(result) {
  state.orders = Array.isArray(result.orders) ? result.orders : [];
  renderSummary(result.summary); $('orders').replaceChildren();
  $('empty-state').hidden = state.orders.length > 0;
  $('list-note').textContent = `显示 ${state.orders.length} 笔订单，最多查询最近 200 笔。未付款的线下预订单超过 48 小时会自动释放库存。`;
  for (const order of state.orders) {
    const card = appendText($('orders'),'article','','order');
    const heading = appendText(card,'div','','order-heading');
    const reference = appendText(heading,'div','');
    appendText(reference,'h2',order.orderNo || '订单');
    const date = new Date(order.createdAt);
    appendText(reference,'p',`${order.orderKind === 'wholesale' ? '批发' : '零售'} · ${order.paymentMethod === 'offline' ? '线下预订单' : '支付方式待核对'} · ${Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')}`,'order-meta');
    appendText(heading,'span',STATUS_LABELS[order.status] || '状态待核对','badge');
    appendText(card,'p',money(order.payableAmount),'amount');
    appendText(card,'p',`${order.shippingName || ''} · ${order.shippingPhone || ''}`,'address');
    appendText(card,'p',order.shippingAddress || '未提供收货地址','address');
    if (order.note) appendText(card,'p',`顾客留言：${order.note}`,'customer-note');
    const items = appendText(card,'ul','','items');
    for (const item of order.items || []) appendText(items,'li',`${item.productName || '商品'} · ${[item.color,item.size].filter(Boolean).join(' / ')} · ${item.quantity} 件 × ${money(item.unitPrice)} = ${money(item.subtotal)}`);
    if (order.trackingNo) appendText(card,'p',`物流：${order.trackingCompany || '快递'} ${order.trackingNo}`,'address');
    const actions = availableActions(order);
    const container = appendText(card,'div','','actions');
    let companyInput, trackingInput;
    if (actions.includes('ship')) {
      const form = appendText(container,'div','','shipping-form');
      const companyLabel = appendText(form,'label','物流公司');
      companyInput = appendText(companyLabel,'input',''); companyInput.placeholder = '例如：顺丰'; companyInput.maxLength = 100;
      const trackingLabel = appendText(form,'label','物流单号');
      trackingInput = appendText(trackingLabel,'input',''); trackingInput.placeholder = '填写实际发货单号'; trackingInput.maxLength = 100;
    }
    for (const action of actions) {
      const button = appendText(container,'button',ACTION_LABELS[action],['cancel','refund'].includes(action) ? 'danger' : '');
      button.type = 'button';
      button.addEventListener('click', () => {
        if (state.busy) return;
        const extra = action === 'ship' ? {trackingCompany:companyInput.value.trim() || '快递',trackingNo:trackingInput.value.trim()} : {};
        if (action === 'ship' && !extra.trackingNo) { notice('请填写物流单号',true); trackingInput.focus(); return; }
        openConfirmation(order,action,extra);
      });
    }
    if (['awaiting_payment','paid','shipping','completed','refund_requested'].includes(order.status) && order.paymentMethod !== 'offline') {
      appendText(card,'p','此订单不提供线下收款或退款登记。请先核对实际支付方式，线上付款以支付确认结果为准。','muted small');
    }
  }
}
function openConfirmation(order, action, extra) {
  if (!availableActions(order).includes(action)) return;
  const prompt = actionPrompt(order,action);
  state.pending = {order,action,extra,prompt};
  $('confirm-title').textContent = prompt.title; $('confirm-message').textContent = prompt.message;
  $('payable-label').hidden = action !== 'confirm';
  $('payable-amount').required = action === 'confirm';
  $('payable-amount').value = Number(order.payableAmount ?? order.totalAmount ?? 0).toFixed(2);
  $('restock-label').hidden = !prompt.offersRestock; $('restock').checked = order.status === 'paid';
  $('acknowledge-label').hidden = !prompt.requiresAcknowledgement; $('acknowledge').checked = false;
  $('confirm-error').hidden = true; $('confirm-submit').textContent = ACTION_LABELS[action];
  $('confirm-dialog').showModal();
}
async function refreshOrders() {
  const result = await api.listOrders({status:$('status-filter').value,keyword:$('keyword').value});
  showWorkspace(); renderOrders(result);
}
function handleError(error) {
  if (!api.signedIn || error.status === 401 || error.status === 403) { api.clearSession(); showLogin(); }
  notice(error.message || '暂时无法处理，请稍后重试',true);
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.busy || !api) return;
  setBusy(true); notice('');
  try { const result = await api.signIn($('login-account').value,$('login-password').value); showWorkspace(); renderOrders(result); }
  catch (error) { handleError(error); }
  finally { $('login-password').value = ''; setBusy(false); }
});
$('logout').addEventListener('click', async () => {
  if (state.busy) return;
  setBusy(true); const signingOut = api.signOut(); showLogin(); notice('已退出登录');
  try { await signingOut; } finally { setBusy(false); }
});
async function runRefresh(event) {
  event?.preventDefault(); if (state.busy || !api) return;
  setBusy(true); notice('');
  try { await refreshOrders(); } catch (error) { handleError(error); } finally { setBusy(false); }
}
$('refresh').addEventListener('click',runRefresh); $('filters').addEventListener('submit',runRefresh);
$('close-confirm').addEventListener('click', () => { $('confirm-dialog').close(); state.pending = null; });
$('confirm-dialog').addEventListener('cancel', () => { state.pending = null; });
$('confirm-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.busy || !state.pending) return;
  const pending = state.pending;
  if (pending.action === 'confirm') {
    try { pending.extra.payableAmount = confirmedAmount($('payable-amount').value); }
    catch (error) {
      $('confirm-error').textContent = error.message; $('confirm-error').hidden = false;
      $('payable-amount').focus(); return;
    }
  }
  if (pending.prompt.requiresAcknowledgement && !$('acknowledge').checked) {
    $('confirm-error').textContent = '请先确认已经实际完成收款或退款'; $('confirm-error').hidden = false; return;
  }
  if (pending.action === 'refund') pending.extra.restock = $('restock').checked;
  state.pending = null; $('confirm-dialog').close(); setBusy(true); notice('正在处理订单…');
  try {
    await api.updateOrder(pending.order.id,pending.action,pending.extra);
    await refreshOrders(); notice('订单已更新');
  } catch (error) {
    // A network failure may happen after the server committed. Refresh the
    // actual order before the operator decides whether another action is needed.
    if (api.signedIn && ![401,403].includes(error.status)) { try { await refreshOrders(); } catch { /* Preserve original operation error. */ } }
    handleError(error);
  } finally { setBusy(false); }
});

async function start() {
  if (window.self !== window.top) {
    document.querySelector('main').replaceChildren();
    document.querySelector('main').textContent = '商家订单台禁止在其他页面中嵌入，请直接打开安全地址登录。';
    $('account-bar').hidden = true;
    return;
  }
  if (location.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(location.hostname)) {
    notice('请使用 HTTPS 安全地址打开商家订单台',true); setBusy(true); return;
  }
  try { api = new MerchantApi({url:CONFIG.url,anonKey:CONFIG.anonKey,storage:sessionStorage}); }
  catch { notice('无法初始化安全会话，请检查浏览器的会话存储设置',true); setBusy(true); return; }
  showLogin(); setBusy(false);
  if (api.signedIn) await runRefresh();
}
void start();
