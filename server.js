const http=require('http'),fs=require('fs'),path=require('path');
const root=__dirname, dataFile=path.join(root,'data','demo.json');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
function data(){return JSON.parse(fs.readFileSync(dataFile,'utf8'))}
function send(res,status,body,type='application/json; charset=utf-8'){res.writeHead(status,{'Content-Type':type});res.end(typeof body==='string'?body:JSON.stringify(body))}
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');
 if(u.pathname==='/api/overview') return send(res,200,data());
 if(u.pathname==='/api/health') return send(res,200,{ok:true,localOnly:true});
 if(u.pathname==='/api/orders'&&req.method==='POST'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{let x;try{x=JSON.parse(b)}catch{return send(res,400,{error:'JSON无效'})} if(!x.customer||!x.items)return send(res,400,{error:'客户和商品明细必填'});const d=data();const order={id:'LOCAL-'+Date.now(),customer:x.customer,source:x.source||'手工录入',status:'待人工确认',amount:Number(x.amount)||0,items:Array.isArray(x.items)?x.items.length:0};d.orders.unshift(order);fs.writeFileSync(dataFile,JSON.stringify(d,null,2));send(res,201,order)}) ;return}
 let file=u.pathname==='/'?'/index.html':u.pathname;let p=path.normalize(path.join(root,'public',file));if(!p.startsWith(path.join(root,'public')))return send(res,403,'Forbidden','text/plain');fs.readFile(p,(e,b)=>e?send(res,404,'Not found','text/plain'):send(res,200,b,mime[path.extname(p)]||'application/octet-stream'));
});
server.listen(Number(process.env.PORT)||3088,process.env.HOST||'0.0.0.0',()=>console.log('晨升经营助手 running at http://localhost:'+(process.env.PORT||3088)));
