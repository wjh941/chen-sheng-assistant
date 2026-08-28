const http=require('http'),fs=require('fs'),path=require('path');
const root=__dirname,dataFile=path.join(root,'data','demo.json');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
function read(){return JSON.parse(fs.readFileSync(dataFile,'utf8'))}
function save(d){fs.writeFileSync(dataFile,JSON.stringify(d,null,2)+'\n')}
function send(res,status,body,type='application/json; charset=utf-8'){res.writeHead(status,{'Content-Type':type});res.end(typeof body==='string'?body:JSON.stringify(body))}
function body(req,done){let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{done(JSON.parse(b||'{}'))}catch{send(req.res,400,{error:'JSON无效'})}})}
function audit(d,action,detail){d.audit=d.audit||[];d.audit.unshift({id:Date.now(),time:new Date().toISOString(),action,detail})}
const server=http.createServer((req,res)=>{req.res=res;const u=new URL(req.url,'http://localhost');let d;
 if(req.method==='GET'&&u.pathname==='/api/overview'){d=read();return send(res,200,d)}
 if(req.method==='GET'&&u.pathname==='/api/health')return send(res,200,{ok:true,localOnly:true,version:'0.2.0'});
 if(req.method==='POST'&&u.pathname==='/api/orders'){return body(req,x=>{if(!x.customer||!Array.isArray(x.items)||!x.items.length)return send(res,400,{error:'客户和商品明细必填'});d=read();const order={id:'LOCAL-'+Date.now(),customer:x.customer,source:x.source||'手工录入',status:'待人工确认',amount:Number(x.amount)||0,items:x.items.map(i=>typeof i==='string'?{name:i,qty:1}:i),speedaNo:''};d.orders.unshift(order);audit(d,'新增订单',order.id+' '+order.customer);save(d);send(res,201,order)})}
 const match=u.pathname.match(/^\/api\/orders\/([^/]+)\/(approve|speeda)$/);if(req.method==='POST'&&match)return body(req,x=>{d=read();const o=d.orders.find(v=>v.id===decodeURIComponent(match[1]));if(!o)return send(res,404,{error:'订单不存在'});if(match[2]==='approve'){o.status='已确认待速达开单';o.confirmedAt=new Date().toISOString();audit(d,'人工确认订单',o.id)}else{if(o.status!=='已确认待速达开单'&&!x.force)return send(res,409,{error:'请先人工确认订单'});if(!x.speedaNo)return send(res,400,{error:'请填写速达单号'});o.speedaNo=x.speedaNo;o.status='已登记速达单号';audit(d,'登记速达单号',o.id+' → '+x.speedaNo)}save(d);send(res,200,o)})
 if(req.method==='POST'&&u.pathname==='/api/import'){return body(req,x=>{if(!x.customer||!x.content)return send(res,400,{error:'客户和文件内容必填'});const lines=String(x.content).split(/\r?\n/).map(v=>v.trim()).filter(Boolean),items=lines.slice(1).map(line=>{const c=line.split(/[\t,，]/);return{name:c[0],qty:Number(c[1])||1,unit:c[2]||'件'}});d=read();const o={id:'IMP-'+Date.now(),customer:x.customer,source:x.filename||'Excel/CSV',status:'待人工确认',amount:Number(x.amount)||0,items,speedaNo:''};d.orders.unshift(o);audit(d,'导入订单',o.id+' '+o.source);save(d);send(res,201,o)})}
 if(req.method==='POST'&&u.pathname==='/api/dispatch'){return body(req,x=>{d=read();const v=d.vehicles.find(v=>v.name===x.vehicle);if(!v)return send(res,404,{error:'车辆不存在'});v.load=x.route||'已安排';audit(d,'人工安排配送',v.name+' '+v.load);save(d);send(res,200,v)})}
 let file=u.pathname==='/'?'/index.html':u.pathname,p=path.normalize(path.join(root,'public',file));if(!p.startsWith(path.join(root,'public')))return send(res,403,'Forbidden','text/plain');fs.readFile(p,(e,b)=>e?send(res,404,'Not found','text/plain'):send(res,200,b,mime[path.extname(p)]||'application/octet-stream'));
});
server.listen(Number(process.env.PORT)||3088,process.env.HOST||'0.0.0.0',()=>console.log('晨升经营助手 v0.2 running at http://localhost:'+(process.env.PORT||3088)));
