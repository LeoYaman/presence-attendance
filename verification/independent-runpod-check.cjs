const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
const fs=require('node:fs/promises');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const results=[];
 try {
  for(const [role,path] of [['Professor','/index.html'],['Student','/student.html?demo=1'],['Faculty','/parent-child.html'],['Security','/criminal-detection.html']]){
   const context=await browser.newContext({viewport:{width:1400,height:1000}});
   const page=await context.newPage(); const errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto('https://lls3utct362n0w-8888.proxy.runpod.net/login.html');
   await page.locator(`[data-login-role="${role}"]`).click();
   await page.waitForURL('**'+path,{timeout:30000});
   const me=await context.request.get('https://lls3utct362n0w-8888.proxy.runpod.net/api/me');
   await page.screenshot({path:__dirname+'/runpod-'+role+'.png',fullPage:true});
   results.push({role,url:page.url(),sessionStatus:me.status(),errors});
   await context.close();
  }
 } finally {await browser.close();}
 await fs.writeFile(__dirname+'/independent-runpod-results.json',JSON.stringify(results,null,2));
 console.log(JSON.stringify(results,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});
