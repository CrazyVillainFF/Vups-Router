const fs=require("fs"),zlib=require("zlib"),crypto=require("crypto");
const b=fs.readFileSync(process.argv[2]);
const eocd=b.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
const cd=b.readUInt32LE(eocd+16),count=b.readUInt16LE(eocd+10);
const T=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;T[n]=c;}
function crc32(buf){let c=-1;for(let i=0;i<buf.length;i++)c=T[(c^buf[i])&0xff]^(c>>>8);return (c^-1)>>>0;}
function entries(){let p=cd;const out=[];for(let i=0;i<count;i++){
 const method=b.readUInt16LE(p+10),crc=b.readUInt32LE(p+16),cs=b.readUInt32LE(p+20),us=b.readUInt32LE(p+24);
 const nl=b.readUInt16LE(p+28),el=b.readUInt16LE(p+30),cl=b.readUInt16LE(p+32),lho=b.readUInt32LE(p+42);
 const name=b.toString("utf8",p+46,p+46+nl);
 const lnl=b.readUInt16LE(lho+26),lel=b.readUInt16LE(lho+28);
 out.push({name,method,crc,cs,us,start:lho+30+lnl+lel,lho});p+=46+nl+el+cl;}return out;}
const E=entries();
function data(e){const raw=b.subarray(e.start,e.start+(e.method===8?e.cs:e.us));return e.method===8?zlib.inflateRawSync(raw):raw;}
let bad=0;for(const e of E){try{if(crc32(data(e))!==e.crc)bad++;}catch(x){bad++;}}
console.log("sha256:",crypto.createHash("sha256").update(b).digest("hex"));
console.log("entries:",E.length,"CRC/decode failures:",bad);
const m=E.find(e=>e.name==="AndroidManifest.xml");const xml=data(m);
const poolOff=8,sc=xml.readUInt32LE(poolOff+8),fl=xml.readUInt32LE(poolOff+12),ss=xml.readUInt32LE(poolOff+20),isU8=(fl&0x100)!==0,base=poolOff+ss;
const strs=[];for(let i=0;i<sc;i++){let p=base+xml.readUInt32LE(poolOff+28+i*4);
 if(isU8){const c1=xml[p];p+=(c1&0x80)?2:1;if(xml[p]===0)p++;const c2=xml[p];p+=(c2&0x80)?2:1;strs.push(xml.toString("utf8",p,p+(c2&0x7f)));}
 else{const a=xml.readUInt16LE(p);p+=2;const len=(a&0x8000)?(((a&0x7fff)<<16)|xml.readUInt16LE(p)):a;p+=(a&0x8000)?2:0;strs.push(xml.toString("utf16le",p,p+len*2));}}
const S=i=>(i>=0&&i<sc)?strs[i]:null;
let p=8+xml.readUInt32LE(poolOff+4);if(xml.readUInt16LE(p)===0x0008)p+=xml.readUInt32LE(p+4);
const depth=[];const lines=[];
while(p+8<=xml.length){const type=xml.readUInt16LE(p),size=xml.readUInt32LE(p+4);if(size<8||p+size>xml.length)break;
 if(type===0x0102){const nameIdx=xml.readUInt32LE(p+16+(xml.readUInt16LE(p+8+4)||16));}
 if(type===0x0102){}
 if(type===0x0102){}
 if(type===0x0102){}
 if(type===0x0102){}
 if(type===0x0102){}
 if(type===0x0102){}
 if(type===0x0102){p+=size;continue;}
 if(type===0x0103){p+=size;continue;}
 if(type===0x0102){p+=size;continue;}
 p+=size;}
function walk(){let q=8+xml.readUInt32LE(poolOff+4);if(xml.readUInt16LE(q)===0x0008)q+=xml.readUInt32LE(q+4);
 while(q+8<=xml.length){const t=xml.readUInt16LE(q),sz=xml.readUInt32LE(q+4);if(sz<8||q+sz>xml.length)break;
  if(t===0x0102||t===0x0103){/*namespace*/}
  if(t===0x0102){}
  if(t===0x0102){}
  if(t===0x0102){}
  if(t===0x0102){q+=sz;continue;}
  if(t===0x0103){q+=sz;continue;}
  if(t===0x0102){q+=sz;continue;}
  q+=sz;}}
console.log("pool strings matching identity:",JSON.stringify(strs.filter(s=>s&&/vups|Vups|activit|permiss|package|Sdk|vers|authorit|scheme|label|theme|provider|file/i.test(s))).slice(0,60));
console.log("attr name candidates:",JSON.stringify(strs.filter(s=>s&&/^(minSdkVersion|targetSdkVersion|compileSdkVersion|versionCode|versionName|package|name|authorities|grantUriPermissions|android:name|label|icon|theme|exported|requested|maxSdkVersion)$/.test(s))));
