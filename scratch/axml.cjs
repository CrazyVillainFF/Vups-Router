const fs=require("fs"),zlib=require("zlib");
function readEntry(buf,name){const eocd=buf.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));const cd=buf.readUInt32LE(eocd+16),n=buf.readUInt16LE(eocd+10);let p=cd;
for(let i=0;i<n;i++){const nl=buf.readUInt16LE(p+28),el=buf.readUInt16LE(p+30),cl=buf.readUInt16LE(p+32);const nm=buf.toString("utf8",p+46,p+46+nl);
const method=buf.readUInt16LE(p+10),cs=buf.readUInt32LE(p+20),us=buf.readUInt32LE(p+24),lho=buf.readUInt32LE(p+42);
if(nm===name){const lnl=buf.readUInt16LE(lho+26),lel=buf.readUInt16LE(lho+28),start=lho+30+lnl+lel;const raw=buf.subarray(start,start+(method===8?cs:us));return method===8?zlib.inflateRawSync(raw):raw;}
p+=46+nl+el+cl;}throw new Error("entry not found: "+name);}
function decode(xml){
 const START_EL=0x0102,END_EL=0x0103;
 console.error("file header type=0x"+xml.readUInt16LE(0).toString(16),"size=",xml.readUInt32LE(4),"total=",xml.length);
 let p=xml.readUInt16LE(2);
 console.error("next chunk type=0x"+xml.readUInt16LE(p).toString(16),"chunkSize=",xml.readUInt32LE(p+4));
 const sc=xml.readUInt32LE(p+8),styleCount=xml.readUInt32LE(p+12),flags=xml.readUInt32LE(p+16),ss=xml.readUInt32LE(p+20);
 const isU8=(flags&0x100)!==0,base=p+ss,strs=[];
 for(let i=0;i<sc;i++){let s=base+xml.readUInt32LE(p+28+i*4);
  if(isU8){const c1=xml[s];s+=(c1&0x80)?2:1;if(xml[s]===0)s++;const c2=xml[s];s+=(c2&0x80)?2:1;strs.push(xml.toString("utf8",s,s+(c2&0x7f)));}
  else{const a=xml.readUInt16LE(s);s+=2;const len=(a&0x8000)?(((a&0x7fff)<<16)|xml.readUInt16LE(s)):a;s+=(a&0x8000)?2:0;strs.push(xml.toString("utf16le",s,s+len*2));}}
 console.error("strings=",sc,"styles=",styleCount,"encoding=",isU8?"utf8":"utf16");
 p+=xml.readUInt32LE(p+4);
 let resMap=null;
 if(xml.readUInt16LE(p)===0x0008){const cnt=(xml.readUInt32LE(p+4)-12)/4;resMap=[];for(let i=0;i<cnt;i++)resMap.push(xml.readUInt32LE(p+12+i*4));console.error("resource map entries=",cnt);p+=xml.readUInt32LE(p+4);}
 const out=[];let depth=0,guard=0;
 while(p+8<=xml.length&&guard++<3000){const t=xml.readUInt16LE(p),sz=xml.readUInt32LE(p+4);if(sz<8||p+sz>xml.length){console.error("stop: bad chunk at",p,"type 0x"+t.toString(16),"size",sz);break;}
  if(t===START_EL){const body=p+16;const nameIdx=xml.readUInt32LE(body+8);const attrStart=xml.readUInt16LE(body+16);const attrCnt=xml.readUInt16LE(body+20);
   const tag=strs[nameIdx]||("str#"+nameIdx);const attrs=[];
   for(let i=0;i<attrCnt;i++){const a=body+attrStart+i*32;if(a+32>xml.length)break;
    const anIdx=xml.readUInt32LE(a+8),rawIdx=xml.readUInt32LE(a+16),vType=xml[a+27],vData=xml.readUInt32LE(a+28);
    const key=(strs[anIdx]!==undefined?strs[anIdx]:"str#"+anIdx);const rid=resMap&&resMap[anIdx]!==undefined?"@0x"+(resMap[anIdx]>>>0).toString(16):"";
    let val;
    if(rawIdx!==0xffffffff&&rawIdx<sc)val=JSON.stringify(strs[rawIdx]);
    else if(vType===0x10)val=String(vData>>>0);else if(vType===0x12)val=String(vData!==0);
    else if(vType===0x03)val="ref@0x"+(vData>>>0).toString(16);else if(vType===0x11)val=String(vData);else if(vType===0x01&&vData<sc)val=JSON.stringify(strs[vData]);else val="type0x"+vType.toString(16)+":0x"+(vData>>>0).toString(16);
    attrs.push(key+(rid?"["+rid+"]":"")+"="+val);}
   out.push("  ".repeat(depth)+"<"+tag+(attrs.length?" "+attrs.join(" "):"")+">");depth++;}
  else if(t===END_EL){depth=Math.max(0,depth-1);}
  p+=sz;}
 return out.join("\n");}
const buf=fs.readFileSync(process.argv[2]);
console.log(decode(readEntry(buf,"AndroidManifest.xml")));
