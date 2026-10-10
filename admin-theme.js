(() => {
  const root = document.documentElement;
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const save = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const university = document.createElement('select');
  university.setAttribute('aria-label', 'University');
  for (const [value, name] of [['ucf','UCF'],['fullsail','Full Sail']]) {
    const option = document.createElement('option'); option.value=value; option.textContent=name; university.append(option);
  }
  const theme = document.createElement('button'); theme.type='button';
  function apply() {
    const selected=read('presence-university'); root.dataset.university=['ucf','fullsail'].includes(selected)?selected:'ucf';
    const appearance=read('presence-theme'); root.dataset.theme=['light','dark'].includes(appearance)?appearance:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
    university.value=root.dataset.university; theme.textContent=root.dataset.theme==='dark'?'Light mode':'Dark mode';
    theme.setAttribute('aria-pressed',String(root.dataset.theme==='dark'));
  }
  university.addEventListener('change',()=>{save('presence-university',university.value);apply();});
  theme.addEventListener('click',()=>{save('presence-theme',root.dataset.theme==='dark'?'light':'dark');apply();});
  const controls=document.createElement('div'); controls.className='appearance-controls'; controls.append(university,theme);
  document.querySelector('.page-header')?.append(controls);
  window.addEventListener('storage',apply); apply();
})();
