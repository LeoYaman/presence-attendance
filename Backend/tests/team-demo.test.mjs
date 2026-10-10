import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTeamDemo} from '../src/team-demo.mjs';
test('team preview scopes four identities, simulates Olivia, and never writes records',async()=>{
 const rows=['anthony','leo','rebbeca','olivia'].map(name=>({reference_key:'team_'+name,person_id:name,full_name:name}));const queries=[];
 const fail=(status,code,message)=>{throw Object.assign(new Error(message),{code});};
 const camera=createTeamDemo({enabled:true,fail,fields:()=>{},pool:{query:async sql=>{queries.push(sql);return {rows:sql.startsWith('SELECT r.')?rows:[]};}},faceWorker:{request:async req=>{assert.equal(req.allowedIds.length,4);return {matches:rows.map(r=>({studentId:r.person_id,referenceKey:r.reference_key,similarity:.8,box:{x:0,y:0,width:.2,height:.2}}))};}}});
 const user={id:'staff',role:'teacher'},body={image:'AAAA',consent:true};const normal=await camera({user,body});assert.equal(normal.faces.length,4);assert.equal(normal.faces[3].name,'olivia');const simulated=await camera({user,body:{...body,simulateUnknown:true}});assert.equal(simulated.faces[3].name,'Unknown');assert.equal(simulated.faces[3].similarity,null);assert.equal(simulated.faces[3].simulated,true);assert.ok(queries.every(q=>q.startsWith('SELECT')));await assert.rejects(camera({user,body:{...body,consent:false}}),{code:'consent_required'});await assert.rejects(camera({user:{id:'student',role:'student'},body}),{code:'staff_required'});
});
