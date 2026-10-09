const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const logs = [];
const moduleContext = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../backend/middleware/errorHandler.js'), 'utf8'), {
    module: moduleContext, console: { error: (...args) => logs.push(args) }
});
const { sanitizeResponses, notFoundHandler, errorHandler } = moduleContext.exports;
function response() {
    return { statusCode: 200, headersSent: false, status(value) { this.statusCode=value; return this; },
        json(value) { this.body=value; return this; } };
}
test('unexpected exception is logged and returns generic JSON', () => {
    const res=response(); const err=new Error('ER_BAD_FIELD_ERROR SELECT private_table');
    errorHandler(err,{method:'GET',path:'/test'},res,()=>{});
    assert.equal(res.statusCode,500); assert.equal(logs.at(-1)[1],err);
    assert.doesNotMatch(JSON.stringify(res.body),/SELECT|private_table|ER_BAD_FIELD|stack/);
});
test('all server-error payload shapes become generic messages', () => {
    for(const body of [{message:'secret',error:{sql:'SELECT secret'},stack:'trace'},['secret'],'secret',null]) {
        const res=response(); sanitizeResponses({},res,()=>{});res.status(500).json(body);
        assert.equal(res.body.success,false);assert.doesNotMatch(JSON.stringify(res.body),/secret|trace|SELECT/);
    }
});
test('nested arrays and objects cannot expose SQL fields', () => {
    const res=response();sanitizeResponses({},res,()=>{});
    res.status(400).json({ details:[{sql:'SELECT secret',sqlMessage:'private',stack:'trace',errno:12,message:'Unknown column private'}] });
    assert.doesNotMatch(JSON.stringify(res.body),/SELECT|private|trace|errno|sqlMessage/);
});
test('normal success data and validation error codes remain usable', () => {
    const res=response();sanitizeResponses({},res,()=>{});
    res.json({items:[{product_id:1,quantity:3}],success:true});assert.equal(res.body.items[0].quantity,3);
    res.status(400).json({message:'Invalid rating',error:'INVALID_RATING'});assert.equal(res.body.error,'INVALID_RATING');
});
test('unknown endpoint returns JSON 404', () => {
    const res=response();notFoundHandler({},res);assert.equal(res.statusCode,404);assert.equal(res.body.message,'Not found');
});
test('malformed JSON uses fixed 400 without reflecting submitted body', () => {
    const res=response();errorHandler({status:400,type:'entity.parse.failed',message:'secret request body'},{method:'POST',path:'/test'},res,()=>{});
    assert.equal(res.statusCode,400);assert.equal(res.body.message,'Invalid JSON request body');
});
test('invalid exception statuses fall back to 500', () => {
    for(const status of [200,999,-1,NaN,400.5]) {const res=response();errorHandler({status},{},res,()=>{});assert.equal(res.statusCode,500);}
});
test('already-sent response delegates error without sending again', () => {
    const res=response();res.headersSent=true;const err=new Error('late');let received;
    errorHandler(err,{},res,value=>{received=value;});assert.equal(received,err);assert.equal(res.body,undefined);
});
test('middleware surrounds parsers and routes, including A6 webhook', () => {
    const server=fs.readFileSync(path.join(__dirname,'../../backend/server.js'),'utf8');
    assert.ok(server.indexOf('app.use(sanitizeResponses)')<server.indexOf("app.post('/api/payments/webhook'"));
    assert.ok(server.indexOf('app.use(sanitizeResponses)')<server.indexOf('app.use(express.json())'));
    assert.ok(server.indexOf('app.use(notFoundHandler)')>server.lastIndexOf('app.use("/api/'));
    assert.ok(server.indexOf('app.use(errorHandler)')>server.indexOf('app.use(notFoundHandler)'));
});
