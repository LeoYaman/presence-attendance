'use strict';
// Render the existing authenticated dynamic feed without introducing another API.
(() => {
 const select=document.getElementById('record');
 const queue=document.getElementById('workspace-records');
 const search=document.getElementById('workspace-search');
 function render(){
  const query=search.value.trim().toLowerCase();
  const options=[...select.options].filter(option=>option.value&&option.textContent.toLowerCase().includes(query));
  const rows=options.map(option=>{
   const row=document.createElement('li');row.className='student';
   const button=document.createElement('button');button.type='button';button.className='button button--secondary';
   button.textContent=option.textContent;button.disabled=select.disabled;
   button.setAttribute('aria-pressed',String(select.value===option.value));
   button.addEventListener('click',()=>{select.value=option.value;select.dispatchEvent(new Event('change'));render();});
   row.append(button);return row;
  });
  if(!rows.length){const empty=document.createElement('li');empty.className='usecase-empty';empty.textContent=select.disabled?'Feed unavailable. Sign in or refresh to connect.':'No fictional test records match.';rows.push(empty);}
  queue.replaceChildren(...rows);
  document.getElementById('workspace-status').textContent=select.disabled
   ? 'Dynamic test feed unavailable. Sign in or refresh to connect.'
   : `${options.length} fictional test record(s) shown. Camera remains preview only.`;
 }
 new MutationObserver(render).observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
 select.addEventListener('change',render);search.addEventListener('input',render);render();
})();
