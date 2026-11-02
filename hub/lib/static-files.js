'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const { gzip } = require('node:zlib'), { promisify } = require('node:util');
const compress = promisify(gzip);
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.json']);

function acceptsGzip(header = '') {
  const entries = String(header).toLowerCase().split(',').map(part => {
    const [name, ...params] = part.trim().split(';');
    const q = params.map(x => x.trim()).find(x => x.startsWith('q='));
    return { name, q: q === undefined ? 1 : Number(q.slice(2)) };
  });
  const pick = entries.find(x => x.name === 'gzip') || entries.find(x => x.name === '*');
  return Boolean(pick && pick.q > 0 && pick.q <= 1);
}
function matchesTag(header, tag) {
  return String(header || '').split(',').some(x => x.trim() === '*' || x.trim().replace(/^W\//, '') === tag.replace(/^W\//, ''));
}
async function sendEncoded(req, res, body, headers) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  headers = { ...headers, Vary: 'Accept-Encoding' };
  const encoded = data.length > 1024 && acceptsGzip(req.headers['accept-encoding']);
  const bytes = encoded ? await compress(data) : data;
  if (encoded) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, { ...headers, 'Content-Length': bytes.length });
  res.end(bytes);
}
class StaticFiles {
  constructor({root,live=false}={}) {
    this.cache = new Map();this.snapshot=root&&!live?new Map():null;
    if(this.snapshot){
      const sync=require('node:fs'),hash=require('node:crypto').createHash;
      const walk=dir=>{for(const e of sync.readdirSync(dir,{withFileTypes:true})){
        const file=path.join(dir,e.name);if(e.isDirectory())walk(file);
        else if(e.isFile()){const bytes=sync.readFileSync(file);this.snapshot.set(file,{bytes,tag:'W/"'+hash('sha256').update(bytes).digest('hex')+'"'});}
      }};walk(root);
    }
  }
  async send(req, res, file, type, fallback) {
    if(this.snapshot){
      const entry=this.snapshot.get(file);if(!entry)return fallback(res,404,'not found','text/plain');
      const headers={'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',ETag:entry.tag,Vary:'Accept-Encoding'};
      if(matchesTag(req.headers['if-none-match'],entry.tag)){res.writeHead(304,headers);return res.end();}
      let bytes=entry.bytes;
      if(bytes.length>1024&&COMPRESSIBLE.has(path.extname(file))&&acceptsGzip(req.headers['accept-encoding'])){
        entry.gzip ||= compress(bytes);bytes=await entry.gzip;headers['Content-Encoding']='gzip';
      }
      res.writeHead(200,{...headers,'Content-Length':bytes.length});return res.end(bytes);
    }
    let stat;
    try { stat = await fs.stat(file); if (!stat.isFile()) throw Error('not a file'); }
    catch { return fallback(res, 404, 'not found', 'text/plain'); }
    // Weak validators describe the same content for identity and gzip responses.
    const tag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ETag: tag, Vary: 'Accept-Encoding' };
    if (matchesTag(req.headers['if-none-match'], tag)) { res.writeHead(304, headers); return res.end(); }
    const encoded = stat.size > 1024 && COMPRESSIBLE.has(path.extname(file)) && acceptsGzip(req.headers['accept-encoding']);
    let bytes;
    try {
      if (encoded) {
        let cached = this.cache.get(file);
        if (!cached || cached.tag !== tag) {
          // Only compressed variants are retained, with a fixed entry and size limit.
          cached = { tag, bytes: fs.readFile(file).then(compress) };
          this.cache.delete(file);
          this.cache.set(file, cached);
          while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
        }
        bytes = await cached.bytes;
        if (bytes.length > 1024 * 1024 && this.cache.get(file) === cached) this.cache.delete(file);
        headers['Content-Encoding'] = 'gzip';
      } else bytes = await fs.readFile(file);
    } catch {
      this.cache.delete(file);
      return fallback(res, 404, 'not found', 'text/plain');
    }
    res.writeHead(200, { ...headers, 'Content-Length': bytes.length });
    res.end(bytes);
  }
}
module.exports = { StaticFiles, sendEncoded };
