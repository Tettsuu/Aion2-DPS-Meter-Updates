import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Transfer only the prepared blobs; publish when both exact digests match.
// The workflow never executes the meter or accepts arbitrary destinations.
const repo=process.env.GH_REPOSITORY;
if(repo!=='Tettsuu/Aion2-DPS-Meter-Updates')throw Error('Unexpected downloads repository');
const api=`https://api.github.com/repos/${repo}`;
const manifest=JSON.parse(await fs.readFile('release/manifest.json','utf8'));
if(!/^v\d+\.\d+\.\d+\.\d+$/.test(manifest.tag)||manifest.assets.length!==2)throw Error('Invalid V2 manifest');
const expected=new Set([`Aion2-DPS-V2-${manifest.tag.slice(1)}.zip`,`Aion2-DPS-V2-${manifest.tag.slice(1)}-Codigo-Fuente.zip`]);
for(const asset of manifest.assets){
 if(!expected.delete(asset.name)||!Number.isSafeInteger(asset.bytes)||asset.bytes<1||asset.bytes>250*1024*1024||!/^[a-f0-9]{64}$/.test(asset.sha256))throw Error('Invalid asset manifest');
}
if(expected.size)throw Error('Missing corresponding source');
async function request(route,options={}){
 const response=await fetch(api+route,{...options,headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...options.headers}});
 if(!response.ok)throw Error(`GitHub ${response.status}: ${(await response.text()).slice(0,800)}`);
 return response.json();
}
const repository=await request('');if(repository.private!==false)throw Error('Downloads channel must be public');
const releases=await request('/releases?per_page=100');
let release=releases.find(r=>r.tag_name===manifest.tag);
const notes=await fs.readFile('release/notes.md','utf8');
if(!release)release=await request('/releases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag_name:manifest.tag,target_commitish:process.env.GITHUB_SHA,name:manifest.name,body:notes,draft:true,prerelease:false})});
if(release.prerelease)throw Error('Unexpected prerelease');
let assets=await request(`/releases/${release.id}/assets`);
for(const asset of assets){const expected=manifest.assets.find(a=>a.name===asset.name);if(!expected||asset.state==='uploaded'&&(asset.size!==expected.bytes||asset.digest!==`sha256:${expected.sha256}`))throw Error('Uploaded assets differ from the verified package');}
let transfer=null;
if(manifest.transferSHA256){
 if(!/^[a-f0-9]{64}$/.test(manifest.transferSHA256))throw Error('Invalid transfer digest');
 const text=await fs.readFile('release/transfer.json','utf8');
 if(createHash('sha256').update(text).digest('hex')!==manifest.transferSHA256)throw Error('Transfer manifest digest mismatch');
 transfer=JSON.parse(text);
}
if(transfer&&assets.length!==2){
 if(!release.draft||transfer.tag!==manifest.tag||!Array.isArray(transfer.assets)||transfer.assets.length!==2)throw Error('Unexpected transfer manifest');
 const transferNames=new Set();
 for(const asset of transfer.assets){
  const expected=manifest.assets.find(a=>a.name===asset.name);
  if(!expected||transferNames.has(asset.name)||asset.bytes!==expected.bytes||asset.sha256!==expected.sha256||!Array.isArray(asset.parts)||asset.parts.length<1||asset.parts.length>500)throw Error('Transfer differs from the verified package');
  transferNames.add(asset.name);
  let bytes=0;
  for(const part of asset.parts){if(!part||!Number.isSafeInteger(part.bytes)||part.bytes<1||part.bytes>600000||!(/^[a-f0-9]{40}$/).test(part.sha)||!(/^[a-f0-9]{64}$/).test(part.sha256))throw Error('Invalid transfer part');bytes+=part.bytes;}
  if(bytes!==asset.bytes)throw Error('Incomplete transfer');
 }
 const stage=await fs.mkdtemp(path.join(os.tmpdir(),'aion2-v2-'));
 try{
  for(const asset of transfer.assets){
   if(assets.some(a=>a.name===asset.name))continue;
   const file=path.join(stage,asset.name),hash=createHash('sha256');
   await fs.writeFile(file,Buffer.alloc(0));
   for(const [index,part] of asset.parts.entries()){
    const blob=await request(`/git/blobs/${part.sha}`);
    if(blob.sha!==part.sha||blob.encoding!=='base64'||blob.size!==part.bytes)throw Error('Unexpected repository blob');
    const bytes=Buffer.from(blob.content,'base64');
    if(bytes.length!==part.bytes||createHash('sha256').update(bytes).digest('hex')!==part.sha256||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==part.sha)throw Error('Corrupted transfer part');
    hash.update(bytes);await fs.appendFile(file,bytes);
    if((index+1)%25===0)console.log(`Verified ${asset.name}: ${index+1}/${asset.parts.length} parts`);
   }
   if((await fs.stat(file)).size!==asset.bytes||hash.digest('hex')!==asset.sha256)throw Error('Transferred ZIP digest mismatch');
   const url=`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`;
   const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/zip','Content-Length':String(asset.bytes)},body:await fs.readFile(file)});
   if(!response.ok)throw Error(`Asset upload failed: ${response.status}`);
   const uploaded=await response.json();
   if(uploaded.name!==asset.name||uploaded.state!=='uploaded'||uploaded.size!==asset.bytes||uploaded.digest!==`sha256:${asset.sha256}`)throw Error('Uploaded ZIP digest mismatch');
   assets.push(uploaded);console.log(`Uploaded and verified: ${asset.name}`);
  }
 }finally{await fs.rm(stage,{recursive:true,force:true});}
 assets=await request(`/releases/${release.id}/assets`);
 for(const asset of assets){const expected=manifest.assets.find(a=>a.name===asset.name);if(!expected||asset.size!==expected.bytes||asset.digest!==`sha256:${expected.sha256}`)throw Error('Published package mismatch');}
}
if(assets.length!==2||assets.some(a=>a.state!=='uploaded')){if(!release.draft)throw Error('Incomplete public release');console.log(`Prepared draft awaiting verified files: ${release.html_url}`);process.exit(0);}
if(!release.draft){console.log(`Already published and verified: ${release.html_url}`);process.exit(0);}
const published=await request(`/releases/${release.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:manifest.name,body:notes,draft:false,prerelease:false,make_latest:'false'})});
console.log(`Published verified V2: ${published.html_url}`);

