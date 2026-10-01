const C="wa90-v2";
const CORE=["./","index.html","manifest.webmanifest","icon-192.png","icon-512.png","apple-touch-icon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",e=>{
  const r=e.request; if(r.method!=="GET") return;
  const u=new URL(r.url); if(u.origin!==self.location.origin&&!/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) return;
  if(r.mode==="navigate"){ e.respondWith(fetch(r).then(res=>{const cp=res.clone(); caches.open(C).then(c=>c.put("index.html",cp)); return res;}).catch(()=>caches.match("index.html"))); return; }
  e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>{ if(res.ok||res.type==="opaque"){const cp=res.clone(); caches.open(C).then(c=>c.put(r,cp));} return res; }).catch(()=>m)));
});
