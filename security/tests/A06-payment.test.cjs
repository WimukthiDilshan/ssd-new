const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../backend', file), 'utf8'), {
    module, exports: module.exports, process: { env: {} }, console: { log() {}, error() {} },
    require: id => id === 'util' ? require(id) : mocks[id]
  });
  return module.exports;
}
function response() { return { statusCode: 200, status(n) { this.statusCode=n; return this; }, json(body) { this.body=body; return this; } }; }
function setup(overrides = {}) {
  const state = { deductions: 0, created: [], completed: false, connections: 0, order: {
    order_id: 20, user_id: 1, total_amount: '125.50', order_status: 'PENDING', order_type: 'DIRECT_SALE', payment_method: 'CARD'
  }, intent: { id: 'pi_test', client_secret: 'secret', status: 'succeeded', amount: 12550, amount_received: 12550, currency: 'usd', metadata: { order_id: '20', user_id: '1' } } };
  Object.assign(state, overrides);
  let tail = Promise.resolve();
  const connection = () => {
    state.connections++;
    let unlock;
    const release = () => { if (unlock) { unlock(); unlock=undefined; } };
    const api = {
      beginTransaction: async () => {}, commit: async () => release(), rollback: async () => release(),
      execute: async (sql, args) => {
        if (sql.includes('FROM orders')) {
          if (sql.includes('FOR UPDATE')) {
            const previous=tail; tail=new Promise(resolve => { unlock=resolve; }); await previous;
          }
          return [[state.order]];
        }
        if (sql.includes('FROM payments')) {
          if (sql.includes('ORDER BY')) return [[]];
          if (sql.includes("payment_status = 'COMPLETED'")) return [state.completed ? [{payment_id:1}] : []];
          return [[{ payment_id:1, amount:'125.50', payment_status: state.completed ? 'COMPLETED' : 'PENDING' }]];
        }
        if (sql.startsWith('UPDATE payments')) state.completed=true;
        if (sql.startsWith('UPDATE orders')) state.order.order_status=args[0];
        return [{}];
      }
    };
    return { promise: () => api, query(sql, args, callback) { callback(null, []); }, end: release };
  };
  const controller=load('controller/paymentController.js', {
    '../utils/paymentConnection': connection,
    stripe: () => ({ paymentIntents: {
      retrieve: async () => state.intent,
      create: async data => {state.created.push(data); return state.intent;}
    }}),
    './OrderController': { processOrder: async () => {state.deductions++;}, deductDirectSaleStock: async () => {state.deductions++;} }
  });
  const req={ user:{user_id:1}, body:{order_id:20,amount:0.5}, params:{paymentIntentId:'pi_test'},db:{} };
  return {state,controller,req};
}
test('browser price ignored and intent creation does not deduct stock',async()=>{
  const {state,controller,req}=setup();const res=response();await controller.createPaymentIntent(req,res);
  assert.equal(res.statusCode,200);assert.equal(state.created[0].amount,12550);assert.equal(state.deductions,0);
});
test('another customer cannot create or confirm payment',async()=>{
  const {state,controller,req}=setup();req.user.user_id=2;
  for(const action of ['createPaymentIntent','confirmPayment']) {const res=response();await controller[action](req,res);assert.equal(res.statusCode,403);}
  assert.equal(state.deductions,0);assert.equal(state.created.length,0);
});
test('failed payment cannot deduct stock',async()=>{
  const {state,controller,req}=setup();state.intent.status='requires_payment_method';const res=response();await controller.confirmPayment(req,res);
  assert.equal(res.statusCode,400);assert.equal(state.deductions,0);assert.equal(state.connections,0);
});
test('mismatched order, amount, currency and owner rejected',async()=>{
  for(const change of [{metadata:{order_id:'99',user_id:'1'}},{amount_received:1},{amount:1},{currency:'eur'},{metadata:{order_id:'20',user_id:'2'}}]) {
    const {state,controller,req}=setup();Object.assign(state.intent,change);const res=response();await controller.confirmPayment(req,res);
    assert.equal(res.statusCode,400);assert.equal(state.deductions,0);
  }
});
test('repeated and concurrent confirms deduct exactly once',async()=>{
  const {state,controller,req}=setup();const responses=[response(),response()];
  await Promise.all(responses.map(res=>controller.confirmPayment(req,res)));
  await controller.confirmPayment(req,response());
  assert.equal(state.deductions,1);assert.equal(state.completed,true);responses.forEach(res=>assert.equal(res.statusCode,200));
});
test('production payment processes ingredients after success',async()=>{
  const {state,controller,req}=setup();state.order.order_type='PRODUCTION_ORDER';await controller.confirmPayment(req,response());
  assert.equal(state.deductions,1);assert.equal(state.order.order_status,'DONE');
});
test('another completed payment prevents a second fulfillment',async()=>{
  const {state,controller,req}=setup();state.order.order_status='DONE';const res=response();await controller.confirmPayment(req,res);
  assert.equal(res.statusCode,409);assert.equal(state.deductions,0);
});
test('invalid order ID returns before opening database connection',async()=>{
  const {state,controller,req}=setup();req.body={};const res=response();await controller.createPaymentIntent(req,res);
  assert.equal(res.statusCode,400);assert.equal(state.connections,0);
});

function orderSetup() {
  const state={updates:0};
  const api={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{}, execute:async(sql)=>{
    if(sql.includes('FROM product WHERE'))return [[{product_id:1,product_name:'Cake',selling_price:10}]];
    if(sql.includes('FROM product_stock'))return [[{stock_id:1,quantity_available:10}]];
    if(sql.includes('FROM user'))return [[]];
    if(sql.includes('UPDATE product_stock'))state.updates++;
    return [{insertId:20}];
  }};
  const db={promise:()=>api,end(){}};
  const controller=load('controller/OrderController.js',{'../utils/paymentConnection':()=>db,'../utils/emailService':{sendOrderConfirmation:async()=>{}}});
  const req={db:{},user:{user_id:1,role:'customer'},body:{items:[{product_id:1,quantity:2}],order_type:'DIRECT_SALE',payment_method:'CARD'}};
  return {state,controller,req};
}
test('card order checks stock without deducting; authorized cash deducts immediately',async()=>{
  for(const method of ['CARD','CASH']) {
    const {state,controller,req}=orderSetup();req.body.payment_method=method;req.user.role='cashier';const res=response();
    await controller.handleOrderFlow(req,res);assert.equal(res.statusCode,201);assert.equal(state.updates,method==='CASH'?1:0);
  }
});
test('customer cannot use cash or legacy production route to bypass card payment',async()=>{
  const {state,controller,req}=orderSetup();req.body.payment_method='CASH';
  for(const action of ['handleOrderFlow','processProductionOrder']) {const res=response();await controller[action](req,res);assert.equal(res.statusCode,403);}
  assert.equal(state.updates,0);
});
test('nonpositive quantities rejected before order creation',async()=>{
  const {state,controller,req}=orderSetup();req.body.items[0].quantity=-1;const res=response();await controller.handleOrderFlow(req,res);
  assert.equal(res.statusCode,400);assert.equal(state.updates,0);
});
test('FIFO processing marks releases so later calls do not deduct again',async()=>{
  const {controller}=orderSetup();let released=false,updates=0;
  const db={query:async(sql)=>{
    if(sql.includes('SELECT release_id'))return released?[]:[{release_id:1,item_id:1,quantity:2}];
    if(sql.includes('SELECT stock_id'))return [{stock_id:1,quantity_available:10}];
    if(sql.includes('UPDATE inventory_stock')){updates++;return {affectedRows:1};}
    if(sql.includes("status = 'released'"))released=true;
    return {affectedRows:1};
  }};
  await controller.processOrder(db,20);await controller.processOrder(db,20);assert.equal(updates,1);assert.equal(released,true);
});
