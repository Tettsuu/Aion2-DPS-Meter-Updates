import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

// Upload prepared, hashed artifacts. This workflow never executes the meter.
const repo=process.env.GH_REPOSITORY;
if(repo!=='Tettsuu/Aion2-DPS-Meter-Updates')throw Error('Unexpected repository');
const api=`https://api.github.com/repos/${repo}`;
const manifest=JSON.parse(await fs.readFile('release/manifest.json','utf8'));
if(!/^v\d+\.\d+\.\d+\.\d+$/.test(manifest.tag)||!/^upload\/v\d+-[a-f0-9]{12}$/.test(manifest.payloadBranch))throw Error('Invalid release metadata');
if(manifest.assets.length!==2)throw Error('Expected program and corresponding source');
const expected=new Set([`Aion2-DPS-V2-${manifest.tag.slice(1)}.zip`,`Aion2-DPS-V2-${manifest.tag.slice(1)}-Codigo-Fuente.zip`]);
const headers={Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
async function request(url,options={}){
 const response=await fetch(url,{...options,headers:{...headers,...options.headers}});
 if(!response.ok)throw Error(`GitHub ${response.status}: ${(await response.text()).slice(0,800)}`);
 return response.status===204?null:response.json();
}
const repository=await request(api);if(repository.private!==false)throw Error('Public downloads repository required; publication stopped');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const output=path.resolve('release-files');await fs.mkdir(output,{recursive:true});
const files=[];
for(const asset of manifest.assets){
 if(!expected.delete(asset.name)||!Number.isSafeInteger(asset.bytes)||asset.bytes<1||asset.bytes>250*1024*1024||!/[a-f0-9]{64}/.test(asset.sha256))throw Error('Invalid asset');
 const pieces=[];
 for(const part of asset.parts){
  if(!/^[a-f0-9]{40}$/.test(part.blob)||!Number.isSafeInteger(part.bytes)||part.bytes<1||part.bytes>8*1024*1024)throw Error('Invalid part');
  const blob=await request(`${api}/git/blobs/${part.blob}`);
  if(blob.encoding!=='base64')throw Error('Unexpected blob encoding');
  const data=Buffer.from(blob.content,'base64');
  if(data.length!==part.bytes||hash(data)!==part.sha256)throw Error('Part integrity mismatch');
  pieces.push(data);
 }
 const data=Buffer.concat(pieces);
 if(data.length!==asset.bytes||hash(data)!==asset.sha256)throw Error('Asset integrity mismatch');
 const filename=path.join(output,asset.name);await fs.writeFile(filename,data);files.push({asset,filename});
 console.log(`Verified ${asset.name}: ${asset.bytes} bytes, sha256:${asset.sha256}`);
}
if(expected.size)throw Error('Missing corresponding source');
const notes=await fs.readFile('release/notes.md','utf8');
const existing=await request(`${api}/releases?per_page=30`);
let release=existing.find(r=>r.tag_name===manifest.tag);
if(release&&!release.draft)throw Error('Release already public; do not replace it');
if(!release)release=await request(`${api}/releases`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag_name:manifest.tag,target_commitish:process.env.GITHUB_SHA,name:manifest.name,body:notes,draft:true,prerelease:false})});
for(const {asset,filename} of files){
 const current=(await request(`${api}/releases/${release.id}/assets`)).find(a=>a.name===asset.name);
 if(current){if(current.size!==asset.bytes||current.digest!==`sha256:${asset.sha256}`)throw Error('Existing draft asset differs');continue;}
 const upload=`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`;
 const uploaded=await request(upload,{method:'POST',headers:{'Content-Type':'application/zip'},body:await fs.readFile(filename)});
 if(uploaded.state!=='uploaded'||uploaded.size!==asset.bytes||uploaded.digest!==`sha256:${asset.sha256}`)throw Error('Uploaded digest mismatch');
}
const uploaded=await request(`${api}/releases/${release.id}/assets`);
if(uploaded.length!==2||files.some(({asset})=>!uploaded.some(a=>a.name===asset.name&&a.state==='uploaded'&&a.size===asset.bytes&&a.digest===`sha256:${asset.sha256}`)))throw Error('Release asset set differs');
release=await request(`${api}/releases/${release.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:false,prerelease:false,make_latest:'true',body:notes})});
console.log(`Published ${release.html_url}`);
// Only remove our temporary transfer branch after both assets are public.
await request(`${api}/git/refs/heads/${manifest.payloadBranch}`,{method:'DELETE'});
console.log('Temporary transfer branch removed');

