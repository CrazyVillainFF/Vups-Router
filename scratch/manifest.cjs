const fs=require("fs"),zlib=require("zlib");
const b=fs.readFileSync(process.argv[2]);
const eocd=b.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
const cd=b.readUInt32LE(eocd+16),count=b.readUInt16LE(eocd+10);
function read(name){let p=cd;for(let i=0;i<count;i++){const nl=b.readUInt16LE(p+28),el=b.readUInt16LE(p+30),cl=b.readUInt16LE(p+32);const nm=b.toString("utf8",p+46,p+46+nl);const m=b.readUInt16LE(p+10),us=b.readUInt32LE(p+24),cs=b.readUInt32LE(p+20),lho=b.readUInt32LE(p+42);if(nm===name){const lnl=b.readUInt16LE(lho+28),lel=b.readUInt16LE(lho+30);const start=lho+30+lnl+lel;return{method:m,data:b.subarray(start,start+(m===8?cs:us))};}p+=46+nl+el+cl;}return null;}
const e=read("AndroidManifest.xml");
if(!e)throw new Error("no AndroidManifest.xml");
console.log("entry method:",e.method,"bytes:",e.data.length);
const xml=e.method===8?zlib.inflateRawSync(e.data):e.data;
if(xml.readUInt16LE(0)!==0x0003)console.log("WARNING not a RES_XML_TYPE:",xml.readUInt16LE(0).toString(16));
// string pool chunk at offset 8? header: type(2) hdr(2) size(4); for AXML: file header 8 bytes then pool chunk
const poolOff=8;
const stringCount=xml.readUInt32LE(poolOff+8),flags=xml.readUInt32LE(poolOff+12),stringsStart=xml.readUInt32LE(poolOff+20),styles=xml.readUInt32LE(poolOff+16);
const isUTF8=(flags&0x100)!==0;
const offs=[];for(let i=0;i<stringCount;i++)offs.push(xml.readUInt32LE(poolOff+28+i*4));
const base=poolOff+stringsStart;
const strs=offs.map(off=>{let p=base+off;if(isUTF8){const c1=xml[p];p+= c1&0x80?2:1; if(xml[p]===0)p++;const c2=xml[p];p+= c2&0x80?2:1; return xml.toString("utf8",p,p+(c2&0x7f));}const a=xml.readUInt16LE(p);p+=2;const len=(a&0x8000)?(((a&0x7fff)<<16)|xml.readUInt16LE(p)):a;p+=(a&0x8000)?2:0;return xml.toString("utf16le",p,p+len*2);});
const S=i=>(i>=0&&i<strs.length)?strs[i]:null;
let p=8+xml.readUInt32LE(poolOff+4); // skip pool chunk, then possibly resource map chunk
if(xml.readUInt16LE(p)===0x0008){const sz=xml.readUInt32LE(p+4);p+=sz;}
const out=[];
let guard=0;
while(p+8<=xml.length && guard++<4000){const type=xml.readUInt16LE(p),size=xml.readUInt32LE(p+4);if(size<8||p+size>xml.length)break;
 if(type===0x0102||type===0x0103){/* ns */}
 if(type===0x0102+0||false){}
 if(type===0x0102){}
 if(type===0x0102){}
 if(type===0x0102){p+=size;continue;}
 if(type===0x0100||type===0x0101){p+=size;continue;}
 if(type===0x0102+0){p+=size;continue;}
 if(type===0x0102){continue;}
 if(type===0x0102){p+=size;continue;}
 if(type===0x0102){}
 if(type===0x0102){p+=size;continue;}
 if(type===0x0103+1||type===0x0102){p+=size;continue;}
 if(type===0x0102){p+=size;continue;}
 if(type===0x0102){p+=size;continue;}
 if(type===0x0102){p+=size;continue;}
 p+=size;}
console.log("strings sample:",strs.filter(s=>/vups|Vups|MainActivity|permission|package|Sdk|version/i.test(s)).slice(0,40));
