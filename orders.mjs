export const STATUS_LABELS = {submitted:'待确认',pending_payment:'待确认',awaiting_payment:'待收款',payment_pending:'支付确认中',paid:'待发货',shipping:'已发货',completed:'已完成',cancelled:'已取消',refund_requested:'售后申请',refunded:'已退款'};
export const money = value => `¥${Number(value || 0).toFixed(2)}`;

export function confirmedAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || Number(text) > 1000000) {
    throw new Error('请填写有效的最终应付金额，最多两位小数');
  }
  return Number(text);
}

export function availableActions(order) {
  const actions = [];
  if (['submitted','pending_payment'].includes(order.status)) actions.push('confirm');
  if (['submitted','pending_payment','awaiting_payment'].includes(order.status)) actions.push('cancel');
  if (order.status === 'awaiting_payment' && order.paymentMethod === 'offline') actions.push('mark_paid');
  if (order.status === 'paid') actions.push('ship');
  if (order.status === 'shipping') actions.push('complete');
  if (['paid','shipping','completed','refund_requested'].includes(order.status) && order.paymentMethod === 'offline') actions.push('refund');
  return actions;
}

export function actionPrompt(order, action) {
  const reference = `订单 ${order.orderNo}，金额 ${money(order.payableAmount)}`;
  const prompts = {
    confirm:['确认订单',`${reference}。请核对库存、颜色、尺码和收货信息，确认后联系顾客付款。`],
    mark_paid:['登记已实际收到货款',`${reference}。请先确认门店已经实际收到这笔线下货款。登记后会扣减库存并记出库流水；本页面不会收取顾客资金。`],
    ship:['确认发货',`${reference}。请核对商品和物流单号，并确保包裹已交付承运商。`],
    complete:['完成订单',`${reference}。请确认顾客已经收货。`],
    cancel:['取消订单',`${reference}。取消后释放这笔订单占用的库存，顾客会看到取消状态。`],
    refund:['登记已实际办理线下退款',`${reference}。请先向顾客实际退还货款，再登记退款。只有商品已退回或无需发货时才勾选回补库存；本页面不会转出资金。`],
  };
  if (!prompts[action]) throw new Error('未知订单操作');
  return {title:prompts[action][0],message:prompts[action][1],requiresAcknowledgement:['mark_paid','refund'].includes(action),offersRestock:action==='refund'};
}

export function appendText(parent, tag, text, className = '') {
  const node = parent.ownerDocument.createElement(tag);
  node.textContent = String(text ?? '');
  if (className) node.className = className;
  parent.append(node); return node;
}
