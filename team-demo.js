(() => {
 const $=id=>document.getElementById(id);let stream,csrf,timer,version=0;
 const status=text=>{$('status').textContent=text;};
 function clear(){const c=$('overlay');c.getContext('2d').clearRect(0,0,c.width,c.height);}
 function stop(){version++;clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());stream=null;$('video').srcObject=null;clear();$('review-demo').hidden=true;$('start').disabled=!csrf||!$('consent').checked;$('stop').disabled=true;status('Camera stopped.');}
 async function scan(token){
  if(!stream||token!==version)return;
  try{
   const v=$('video');if(v.readyState<2)throw new Error('Waiting for camera...');
   const frame=document.createElement('canvas');frame.width=640;frame.height=Math.round(640*v.videoHeight/v.videoWidth);frame.getContext('2d').drawImage(v,0,0,frame.width,frame.height);
   const response=await fetch('/api/team-demo/detect',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({image:frame.toDataURL('image/jpeg',0.75).split(',')[1],consent:true,simulateUnknown:$('simulate-unknown').checked})});
   const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'Detection failed');
   if(token!==version)return;
   const canvas=$('overlay');canvas.width=v.videoWidth;canvas.height=v.videoHeight;const ctx=canvas.getContext('2d');ctx.strokeStyle='#22e875';ctx.fillStyle='#22e875';ctx.lineWidth=3;ctx.font='18px sans-serif';
   for(const face of data.faces){ctx.strokeStyle=ctx.fillStyle=face.name==='Unknown'?'#ffb347':'#22e875';const b=face.box,x=b.x*canvas.width,y=b.y*canvas.height;ctx.strokeRect(x,y,b.width*canvas.width,b.height*canvas.height);ctx.fillText(face.name+(face.simulated?' (demo simulation)':'')+(Number.isFinite(face.similarity)?' - '+Math.round(face.similarity*100)+'% match score':''),Math.max(0,x),Math.max(20,y-8));}
   status(data.faces.length+' face'+(data.faces.length===1?'':'s')+' in team demo - live');
   const unknowns=data.faces.filter(face=>face.name==='Unknown');$('review-demo').hidden=!unknowns.length;$('review-demo').textContent=unknowns.length?'Demo: unmatched participant - ask staff to verify their visitor pass. '+(unknowns.some(f=>f.simulated)?'Olivia is intentionally marked Unknown for this roleplay. ':'')+'This is a local display, not a notification or saved review item.':'';
  }catch(e){if(token===version){clear();status(e.message);}}
  finally{if(stream&&token===version)timer=setTimeout(()=>scan(token),150);}
 }
 $('start').onclick=async()=>{if(!$('consent').checked)return;const token=++version;$('start').disabled=true;try{const camera=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720}},audio:false});if(token!==version){camera.getTracks().forEach(t=>t.stop());return;}stream=camera;$('video').srcObject=stream;await $('video').play();$('stop').disabled=false;scan(token);}catch(e){status(e.message);$('start').disabled=!csrf||!$('consent').checked;}};
 $('consent').onchange=()=>{if(!$('consent').checked)stop();$('start').disabled=!csrf||!!stream||!$('consent').checked;};
 $('stop').onclick=stop;window.addEventListener('pagehide',stop);
 fetch('/api/me',{credentials:'same-origin'}).then(async r=>{if(!r.ok)throw new Error('Staff sign-in required');const me=await r.json();if(!['teacher','admin'].includes(me.user.role))throw new Error('Staff sign-in required');csrf=me.csrfToken;$('start').disabled=!$('consent').checked;status('Confirm team consent, then start the camera.');}).catch(e=>status(e.message));
})();
