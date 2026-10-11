(() => {
 const root=document.documentElement;
 function university(key){if(!['ucf','fullsail'].includes(key))return;root.dataset.university=key;document.querySelectorAll('[data-uni]').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.uni===key)));try{localStorage.setItem('presence-university',key);}catch{}}
 function theme(mode){root.dataset.theme=mode;$('theme-btn').setAttribute('aria-pressed',String(mode==='dark'));$('theme-btn').setAttribute('aria-label',mode==='dark'?'Light mode':'Dark mode');try{localStorage.setItem('presence-theme',mode);}catch{}}
 const $=id=>document.getElementById(id);let stream,csrf,timer,version=0,galleryVersion=0;
 const participants=()=>Array.from(document.querySelectorAll('[data-reference]:checked')).map(input=>input.dataset.reference);
 function updateParticipants(){galleryVersion++;clear();$('review-demo').hidden=true;$('reference-count').textContent=participants().length;try{sessionStorage.setItem('presence-team-gallery',JSON.stringify(participants()));}catch{}}
 document.querySelectorAll('[data-reference]').forEach(input=>input.onchange=updateParticipants);
 $('restore-team').onclick=()=>{document.querySelectorAll('[data-reference]').forEach(input=>input.checked=true);updateParticipants();};
 try{const saved=JSON.parse(sessionStorage.getItem('presence-team-gallery'));if(Array.isArray(saved))document.querySelectorAll('[data-reference]').forEach(input=>input.checked=saved.includes(input.dataset.reference));}catch{}
 $('reference-count').textContent=participants().length;
 document.querySelectorAll('[data-uni]').forEach(b=>b.onclick=()=>university(b.dataset.uni));$('theme-btn').onclick=()=>theme(root.dataset.theme==='dark'?'light':'dark');
 try{university(localStorage.getItem('presence-university')||'ucf');theme(localStorage.getItem('presence-theme')||'light');}catch{}
 const status=text=>{$('status').textContent=text;};
 function clear(){const c=$('overlay');c.getContext('2d').clearRect(0,0,c.width,c.height);}
 function stop(){version++;clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());stream=null;$('video').srcObject=null;clear();$('review-demo').hidden=true;$('start').disabled=!csrf||!$('consent').checked;$('stop').disabled=true;status('Camera stopped.');}
 async function scan(token){
  if(!stream||token!==version)return;
  try{
   const v=$('video');if(v.readyState<2)throw new Error('Waiting for camera...');
   const frame=document.createElement('canvas');frame.width=640;frame.height=Math.round(640*v.videoHeight/v.videoWidth);frame.getContext('2d').drawImage(v,0,0,frame.width,frame.height);
   const selectionVersion=galleryVersion;
   const response=await fetch('/api/team-demo/detect',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({image:frame.toDataURL('image/jpeg',0.75).split(',')[1],consent:true,activeReferences:participants()})});
   const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'Detection failed');
   if(token!==version||selectionVersion!==galleryVersion)return;
   const canvas=$('overlay');$('video').parentElement.style.aspectRatio=v.videoWidth+'/'+v.videoHeight;canvas.width=v.videoWidth;canvas.height=v.videoHeight;const ctx=canvas.getContext('2d');ctx.strokeStyle='#22e875';ctx.fillStyle='#22e875';ctx.lineWidth=3;ctx.font='18px sans-serif';
   for(const face of data.faces){ctx.strokeStyle=ctx.fillStyle=face.name==='Unknown'?'#ffb347':'#22e875';const b=face.box,x=b.x*canvas.width,y=b.y*canvas.height;ctx.strokeRect(x,y,b.width*canvas.width,b.height*canvas.height);ctx.fillText(face.name+(Number.isFinite(face.similarity)?' - '+Math.round(face.similarity*100)+'% match score':''),Math.max(0,x),Math.max(20,y-8));}
   status(data.faces.length+' face'+(data.faces.length===1?'':'s')+' in team demo - live');
   const unknowns=data.faces.filter(face=>face.name==='Unknown');$('review-demo').hidden=!unknowns.length;$('review-demo').textContent=unknowns.length?'Demo: unmatched participant - ask staff to verify their visitor pass. '+'This is a local display, not a notification or saved review item.':'';
  }catch(e){if(token===version){clear();status(e.message);}}
  finally{if(stream&&token===version)timer=setTimeout(()=>scan(token),150);}
 }
 $('start').onclick=async()=>{if(!$('consent').checked)return;const token=++version;$('start').disabled=true;try{const camera=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720}},audio:false});if(token!==version){camera.getTracks().forEach(t=>t.stop());return;}stream=camera;$('video').srcObject=stream;await $('video').play();$('stop').disabled=false;scan(token);}catch(e){status(e.message);$('start').disabled=!csrf||!$('consent').checked;}};
 $('consent').onchange=()=>{if(!$('consent').checked)stop();$('start').disabled=!csrf||!!stream||!$('consent').checked;};
 $('stop').onclick=stop;window.addEventListener('pagehide',stop);
 async function guestApi(path,body){const r=await fetch(path,{credentials:'same-origin',method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error?.message||'Request failed');return data;}
 async function refreshGuests(){const data=await guestApi('/api/team-demo/participants');$('guest-list').replaceChildren();for(const guest of data.participants){const row=document.createElement('p'),name=document.createElement('span'),button=document.createElement('button');name.textContent=guest.name+' (temporary) ';button.textContent='Delete participant';button.type='button';button.className='button button--secondary';button.onclick=async()=>{button.disabled=true;try{await guestApi('/api/team-demo/participants/delete',{id:guest.id});galleryVersion++;clear();await refreshGuests();$('guest-status').textContent='Temporary reference deleted.';}catch(e){$('guest-status').textContent=e.message;button.disabled=false;}};row.append(name,button);$('guest-list').append(row);}}
 $('guest-form').onsubmit=async e=>{e.preventDefault();if(!stream||!csrf){$('guest-status').textContent='Start the camera first.';return;}if(!$('guest-consent').checked)return;$('guest-add').disabled=true;try{const v=$('video'),c=document.createElement('canvas');c.width=640;c.height=Math.round(640*v.videoHeight/v.videoWidth);c.getContext('2d').drawImage(v,0,0,c.width,c.height);await guestApi('/api/team-demo/participants',{name:$('guest-name').value,consent:true,image:c.toDataURL('image/jpeg',.8).split(',')[1]});galleryVersion++;clear();await refreshGuests();$('guest-form').reset();$('guest-status').textContent='Participant added. Look at the camera to see their name.';}catch(e){$('guest-status').textContent=e.message;}finally{$('guest-add').disabled=false;}};
 fetch('/api/me',{credentials:'same-origin'}).then(async r=>{if(!r.ok)throw new Error('Staff sign-in required');const me=await r.json();if(!['teacher','admin'].includes(me.user.role))throw new Error('Staff sign-in required');csrf=me.csrfToken;$('start').disabled=!$('consent').checked;status('Confirm team consent, then start the camera.');refreshGuests().catch(e=>$('guest-status').textContent=e.message);setInterval(()=>{if(csrf)refreshGuests().catch(()=>{});},15000);}).catch(e=>status(e.message));
})();
