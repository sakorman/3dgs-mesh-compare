import {createServer} from "node:http";
import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {resolve, extname} from "node:path";
import {createHash} from "node:crypto";
import {gunzipSync,gzipSync} from "node:zlib";
import {modelHttpFixture, type HttpSceneAssets} from "../tests/helpers/http-model-fixture";

const root=resolve(".qa/release-startup"), site=`${root}/site`;
const hash=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
const manifest=JSON.parse(readFileSync(`${site}/manifest.json`,"utf8"));
const previous=JSON.parse(readFileSync("docs/benchmarks/spz-alpha16-2026-10-27.json","utf8"));
const assets:Record<string,HttpSceneAssets>={};
for(const scene of ["pipes","office"]) {
  const a=previous.assets.find((x:{scene:string})=>x.scene===scene), spz=readFileSync(`.qa/spz-sh8/${scene}-sh8.spz`),
    alpha=readFileSync(`.qa/spz-alpha16/${scene}.ap16.bin`),ply=readFileSync(`.qa/${scene}-gaussians.bin`);
  if(hash(spz)!==a.spzSha256||hash(gunzipSync(alpha))!==a.alphaRawSha256||hash(gunzipSync(ply))!==a.plySha256) throw Error("Asset mismatch");
  const old=Buffer.from(gunzipSync(alpha));old.writeUInt16LE(old.readUInt16LE(48)===0?1:0,48);
  assets[scene]={spz:{bytes:spz,digest:a.spzSha256},alpha:{bytes:alpha,digest:a.alphaRawSha256,encoding:"gzip"},
    ply:{bytes:ply,digest:a.plySha256,encoding:"gzip"},oldAlpha:{bytes:gzipSync(old),digest:hash(old),encoding:"gzip"}};
}
const models=modelHttpFixture(assets);
const files=new Map<string,{bytes:Buffer;type:string;gzip?:boolean}>();
const types:Record<string,string>={".js":"text/javascript",".html":"text/html",".css":"text/css",".json":"application/json"};
for(const f of manifest.files) {
  const raw=readFileSync(site+f.url),gz=readFileSync(site+f.url+".gz");
  if(hash(raw)!==f.sha256||hash(gz)!==f.gzipSha256) throw Error("Static build mismatch");
  files.set(f.url,{bytes:gz,type:types[extname(f.url)]||"application/octet-stream",gzip:true});
}
files.set("/manifest.json",{bytes:readFileSync(`${site}/manifest.json`),type:"application/json"});
for(const path of ["docs/benchmarks/spz-alpha16-2026-10-27.json","docs/benchmarks/sh-scoped-2026-10-31.json"])
  files.set("/"+path,{bytes:readFileSync(path),type:"application/json"});
for(const scene of ["pipes","office"]) files.set(`/scenes/${scene}/scene.json`,{bytes:readFileSync(`public/scenes/${scene}/scene.json`),type:"application/json"});
mkdirSync(`${root}/samples`,{recursive:true});
createServer((req,res)=> {
  const path=new URL(req.url!,"http://127.0.0.1").pathname;
  if(path==="/__release_result"&&req.method==="POST") {
    if(req.headers.origin!=="http://127.0.0.1:5194") {res.writeHead(403).end();return;}
    const chunks:Buffer[]=[];let bytes=0;
    req.on("data",b=>{bytes+=b.length;if(bytes>2*1024**2)req.destroy();else chunks.push(b);});
    req.on("end",()=>{try {
      const text=Buffer.concat(chunks).toString(),d=JSON.parse(text);
      if(!["pipes","office"].includes(d.scene)||!["rebuilt","scoped"].includes(d.variant)||!Number.isInteger(d.documentIndex)||d.documentIndex<0||d.documentIndex>7) throw Error("Invalid result");
      writeFileSync(`${root}/samples/${d.scene}-${d.variant}-${d.documentIndex}.json`,text+"\n",{flag:"wx"});
      res.writeHead(201).end("Saved");
    }catch(e){res.writeHead(400).end(String(e));}});
    return;
  }
  models(req,res,()=>{
    const file=files.get(path);
    if(!file||req.method!=="GET"){res.writeHead(404).end();return;}
    if(file.gzip&&!req.headers["accept-encoding"]?.includes("gzip")){res.writeHead(406).end("gzip required");return;}
    res.writeHead(200,{"Content-Type":file.type,"Content-Length":file.bytes.length,"Cache-Control":"no-store",
      ...(file.gzip?{"Content-Encoding":"gzip","Vary":"Accept-Encoding"}:{})});res.end(file.bytes);
  });
}).listen(5194,"127.0.0.1",()=>console.log("Static build: http://127.0.0.1:5194/tests/browser/release-startup.html"));
