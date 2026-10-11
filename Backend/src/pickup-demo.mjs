import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function pickupConfiguration(env = process.env) {
  const configuration = {leoId:env.PICKUP_LEO_ID, rebecaId:env.PICKUP_REBECA_ID, anthonyId:env.PICKUP_ANTHONY_ID};
  const enabled = env.PICKUP_DEMO_ENABLED === 'true' && Object.values(configuration).every(id => idPattern.test(id || '')) && new Set(Object.values(configuration)).size === 3;
  return {enabled, configuration, manualApproval:true, approvalMode:'manual', mailConfigured:false};
}

// Only server-verified IDs from the same frame participate; names are display data.
export function evaluatePickup(matches, configuration) {
  if (!Array.isArray(matches) || matches.some(m=>!m || (m.identityMatched===true && (typeof m.subjectId !== 'string' || !m.subjectId)))) return {state:'blocked',reason:'Invalid recognition result.'};
  const known = matches.filter(m => m.identityMatched === true && m.subjectId);
  const ids = known.map(m => m.subjectId);
  if (new Set(ids).size !== ids.length) return {state:'blocked', reason:'Duplicate identity in this frame; retry with each participant visible once.'};
  if (matches.some(m => m.identityMatched !== true)) return {state:'blocked', reason:'An unrecognized participant is present.'};
  if (ids.length > 2) return {state:'blocked', reason:'More than two participants are present. Show only the pickup pair.'};
  if (ids.length === 2) {
    if (ids.includes(configuration.leoId) && ids.includes(configuration.anthonyId)) return {state:'approved', reason:'Leo and Anthony were identified together in this frame.'};
    return {state:'pending', reason:'Both participants were identified, but they are not a configured pickup pair. Operator review and manual demo approval are required.'};
  }
  if (ids.length === 1) return {state:'blocked',reason:'Cannot exit alone.'};
  return {state:'waiting',reason:'No participant is identified in this frame.'};
}

export function createPickupMailer(env = process.env) {
  return message => new Promise((resolve, reject) => {
    const python = env.FACE_PYTHON || fileURLToPath(new URL(process.platform==='win32'?'../../face_data/.venv/Scripts/python.exe':'../../face_data/.venv/bin/python', import.meta.url));
    const child = spawn(python, [fileURLToPath(new URL('../scripts/pickup-mail.py', import.meta.url))], {windowsHide:true, stdio:['pipe','ignore','pipe'], env});
    const timer = setTimeout(() => {child.kill(); reject(new Error('Email delivery timed out'));}, 30000);
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => {clearTimeout(timer); reject(new Error('Email transport unavailable'));});
    child.on('exit', code => {clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Email delivery failed'));});
    child.stdin.end(JSON.stringify(message));
  });
}

// Demo state is deliberately ephemeral: restarting expires all requests and links.
export function createPickupDemo({settings = pickupConfiguration(), recognize, sendMail = createPickupMailer(), origin, fail, fields, now = Date.now}) {
  const actors = new Map();
  const publicRequest = (r,state) => ({id:r.id,status:r.status,createdAt:r.createdAt,expiresAt:r.expiresAt,reason:r.reason,matchedNames:[...(r.matchedNames || [])],approvalMode:'manual',canApprove:r.status==='pending' && r.expiresAt>now() && r.signature===state.signature && state.observedAt!==undefined && now()-state.observedAt<=5000});
  const publicApprovals = state => state.approvals.map(event=>({...event,matchedNames:[...event.matchedNames]}));
  function actorState(user) {
    for (const [id, state] of actors) if (now() - state.updated > 15 * 60000 && !state.busy) actors.delete(id);
    if (!actors.has(user.id)) {if (actors.size >= 1000) fail(429,'pickup_capacity','Try again later'); actors.set(user.id,{requests:[],approvals:[],approvedSignature:null,latest:null,signature:null,updated:now(),busy:false,revision:0});}
    const state = actors.get(user.id); state.updated = now();
    for (const r of state.requests) if (r.status === 'pending' && r.expiresAt <= now()) r.status = 'expired';
    if (state.observedAt!==undefined && now()-state.observedAt>5000) state.latest=null;
    return state;
  }
  return async ({method,path,user,body}) => {
    if (!['teacher','admin'].includes(user.role)) fail(403,'forbidden','An authorized demo operator is required');
    const state = actorState(user);
    if (method === 'GET' && path === '/api/pickup-demo') return {enabled:settings.enabled,configuration:settings.enabled?settings.configuration:null,manualApproval:true,approvalMode:'manual',mailConfigured:false,requests:state.requests.map(r=>publicRequest(r,state)),approvals:publicApprovals(state),latest:state.latest};
    if (!settings.enabled) fail(503,'pickup_disabled','Configure the three consenting adult subject IDs before enabling this demo');
    if (method==='POST' && path==='/api/pickup-demo/reset') {
      fields(body,[]);state.revision++;state.signature=null;state.approvedSignature=null;state.latest=null;
      for(const r of state.requests)if(['pending','approved'].includes(r.status))r.status='superseded';
      return {state:'waiting',reason:'Camera observation cleared.'};
    }
    if (method === 'POST' && path === '/api/pickup-demo/decide') {
      fields(body,['image'],['image']);
      if (state.busy) fail(429,'pickup_busy','Wait for the next frame');
      state.busy=true;const revision=state.revision;
      try {
        const result = await recognize(user, body.image);
        if(revision!==state.revision)fail(409,'stale_observation','Camera observation was cleared');
        const decision = evaluatePickup(result.matches, settings.configuration);
        const signature = JSON.stringify(result.matches.map(m => m.identityMatched ? m.subjectId : '?').sort());
        if (state.signature !== signature || decision.state !== 'pending' || (state.observedAt !== undefined && now()-state.observedAt>5000)) for (const r of state.requests) if (['pending','approved'].includes(r.status)) r.status='superseded';
        state.signature=signature; state.observedAt=now();
        const matchedNames=result.matches.filter(m=>m.identityMatched).map(m=>m.name);
        // History records an observed pair, never grants permission to a later frame.
        if (decision.state === 'approved') {
          if (state.approvedSignature !== signature) {
            state.approvals.unshift({id:randomUUID(),createdAt:new Date(now()).toISOString(),matchedNames:[...matchedNames],reason:decision.reason,state:'approved'});
            state.approvals=state.approvals.slice(0,20);
          }
          state.approvedSignature=signature;
        } else state.approvedSignature=null;
        if (decision.state === 'pending') {
          let r = state.requests.find(r=>r.signature===signature && ['pending','approved'].includes(r.status) && r.expiresAt>now());
          if (!r) {
            r={id:randomUUID(),status:'pending',createdAt:new Date(now()).toISOString(),expiresAt:now()+10*60000,reason:decision.reason,matchedNames:[...matchedNames],signature};
            state.requests.unshift(r); state.requests=state.requests.slice(0,20);
          }
          if (r.status === 'approved') {decision.state='approved';decision.reason='The pickup request was manually approved for the current participants.';}
          decision.request=publicRequest(r,{...state,busy:false});
        }
        state.latest={...decision,matchedNames};
        // The same server-verified frame drives both the camera display and decision.
        return {...state.latest,approvals:publicApprovals(state),recognition:result};
      } catch (error) {
        state.signature=null;state.approvedSignature=null;state.latest={state:'blocked',reason:'Recognition unavailable; no exit approval.',matchedNames:[]};
        for(const r of state.requests) if(['pending','approved'].includes(r.status))r.status='superseded';
        throw error;
      } finally {state.busy=false;}
    }
    const approve=path.match(/^\/api\/pickup-demo\/requests\/([a-f0-9-]+)\/approve$/);
    if (method==='POST' && approve) {
      fields(body,[]);
      const r=state.requests.find(r=>r.id===approve[1]);
      if(!r) fail(403,'invalid_approval','Invalid pickup request or operator');
      if(state.busy) fail(429,'pickup_busy','Wait for the current camera check to finish');
      if(r.status!=='pending' || r.expiresAt<=now() || r.signature!==state.signature || now()-state.observedAt>5000) fail(409,'stale_approval','Keep the participants visible and use a current pending request');
      r.status='approved';state.latest={state:'approved',reason:'Pickup request manually approved by the signed-in demo operator.',request:publicRequest(r,state),matchedNames:state.latest?.matchedNames??[]};
      return state.latest;
    }
    fail(405,'method_not_allowed','Method not allowed');
  };
}
