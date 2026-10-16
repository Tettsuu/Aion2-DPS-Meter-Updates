import fs from 'node:fs/promises';

// Publish only an uploaded draft whose exact digests match the manifest.
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
const assets=await request(`/releases/${release.id}/assets`);
for(const asset of assets){const expected=manifest.assets.find(a=>a.name===asset.name);if(!expected||asset.state==='uploaded'&&(asset.size!==expected.bytes||asset.digest!==`sha256:${expected.sha256}`))throw Error('Uploaded assets differ from the verified package');}
if(assets.length!==2||assets.some(a=>a.state!=='uploaded')){if(!release.draft)throw Error('Incomplete public release');console.log(`Prepared draft awaiting verified files: ${release.html_url}`);process.exit(0);}
if(!release.draft){console.log(`Already published and verified: ${release.html_url}`);process.exit(0);}
const published=await request(`/releases/${release.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:manifest.name,body:notes,draft:false,prerelease:false,make_latest:'false'})});
console.log(`Published verified V2: ${published.html_url}`);

