const fs=require("fs"),crypto=require("crypto");
const b=fs.readFileSync(process.argv[2]);
const eocd=b.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
const cd=b.readUInt32LE(eocd+16),cdSize=b.readUInt32LE(eocd+12);
console.log("centralDirStart:",cd,"centralDirSize:",cdSize,"cdEnd:",cd+cdSize,"eocd:",eocd,"fileLen:",b.length);
const magic=Buffer.from("APK Sig Block 42","ascii");
let m=-1;for(let i=cd-16;i>=Math.max(0,cd-400000);i--){if(b.compare(magic,0,16,i,i+16)===0){m=i;break;}}
console.log("magic found at:",m,"(cd -",cd-m,"bytes)");
const size=Number(b.readBigUInt64LE(m-8));
const blockStart=m-8-size;
console.log("size field:",size,"blockStart:",blockStart,"first field:",Number(b.readBigUInt64LE(blockStart)));
let p=blockStart+8;const pairsEnd=m-8;const seen=[];
while(p+12<=pairsEnd){const l=Number(b.readBigUInt64LE(p));const id=b.readUInt32LE(p+8);if(l<4||p+8+l>pairsEnd+1)break;seen.push({id:"0x"+id.toString(16),len:l,start:p+12});p+=8+l;}
console.log("pairs:",seen.map(s=>s.id+":"+s.len).join("  "));
console.log("gap between block end and first local entry:",blockStart,"(cd-8-size-16+? )");
let certs=[];
for(const pair of seen){
  for(let i=pair.start;i+4<pair.start+pair.len;i++){
    if(b[i]===0x30&&b[i+1]===0x82){const len=2+b.readUInt16BE(i+2)+2;if(i+len<=pair.start+pair.len){try{const x=new crypto.X509Certificate(b.subarray(i,i+len));certs.push({subject:x.subject.replace(/\r?\n/g," / "),issuer:x.issuer.replace(/\r?\n/g," / "),notBefore:x.validFrom,notAfter:x.validTo,sigAlg:x.sigAlg,bits:x.asymmetricKeySize,isCA:x.ca});}catch(e){}}}}
}
const dedup=[];const set=new Set();for(const c of certs){const k=c.subject+c.notAfter;if(!set.has(k)){set.add(k);dedup.push(c);}}
console.log("certificates:",dedup.length);dedup.forEach(c=>console.log(JSON.stringify(c)));
const now=new Date("2026-10-28T16:00:00Z");
for(const c of dedup)console.log(c.subject,"valid at 2026-10-28?",new Date(c.notBefore)<=now&&now<=new Date(c.notAfter));
