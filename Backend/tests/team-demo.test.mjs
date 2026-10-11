import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTeamDemo} from '../src/team-demo.mjs';
test('team preview scopes four identities, simulates Olivia, and never writes records',async()=>{
 const rows=['anthony','leo','rebbeca','olivia'].map(name=>({reference_key:'team_'+name,person_id:name,full_name:name}));const queries=[];
 const fail=(status,code,message)=>{throw Object.assign(new Error(message),{code});};
 const camera=createTeamDemo({enabled:true,fail,fields:()=>{},pool:{query:async sql=>{queries.push(sql);return {rows:sql.startsWith('SELECT r.')?rows:[]};}},faceWorker:{request:async req=>{assert.equal(req.allowedIds.length,req.referenceMappings.length);return {matches:rows.map(r=>({studentId:r.person_id,referenceKey:r.reference_key,similarity:.8,box:{x:0,y:0,width:.2,height:.2}}))};}}});
 const user={id:'staff',role:'teacher'},body={image:'AAAA',consent:true};const normal=await camera({user,body});assert.equal(normal.faces.length,4);assert.equal(normal.faces[3].name,'olivia');const excluded=await camera({user,body:{...body,activeReferences:['team_anthony','team_leo','team_rebbeca']}});assert.equal(excluded.faces[3].name,'Unknown');assert.equal(excluded.faces[3].similarity,null);const empty=await camera({user,body:{...body,activeReferences:[]}});assert.ok(empty.faces.every(f=>f.name==='Unknown'));await assert.rejects(camera({user,body:{...body,activeReferences:['s1']}}),{code:'invalid_demo'});await assert.rejects(camera({user,body:{...body,activeReferences:['team_leo','team_leo']}}),{code:'invalid_demo'});assert.ok(queries.every(q=>q.startsWith('SELECT')));await assert.rejects(camera({user,body:{...body,consent:false}}),{code:'consent_required'});await assert.rejects(camera({user:{id:'student',role:'student'},body}),{code:'staff_required'});
});

test('temporary participant consent, ownership and deletion are enforced without database writes',async()=>{
 const rows=['anthony','leo','rebbeca','olivia'].map(name=>({reference_key:'team_'+name,person_id:name,full_name:name}));const calls=[];
 const fail=(status,code,message)=>{throw Object.assign(new Error(message),{code});};
 const camera=createTeamDemo({enabled:true,fail,fields:()=>{},pool:{query:async()=>({rows})},faceWorker:{request:async req=>{calls.push(req);return {enrolled:true,deleted:true,matches:[]};}}});
 const user={id:'staff-a',role:'teacher'};
 await assert.rejects(camera({user,action:'add',body:{name:'Judge',image:'AAAA',consent:false}}),{code:'consent_required'});
 const added=await camera({user,action:'add',body:{name:'Judge',image:'AAAA',consent:true}});
 assert.equal((await camera({user,action:'list'})).participants[0].name,'Judge');
 assert.equal((await camera({user:{id:'staff-b',role:'teacher'},action:'list'})).participants.length,0);
 await assert.rejects(camera({user:{id:'staff-b',role:'teacher'},action:'delete',body:{id:added.participant.id}}),{code:'not_found'});
 await camera({user,action:'delete',body:{id:added.participant.id}});
 assert.equal((await camera({user,action:'list'})).participants.length,0);
 assert.deepEqual(calls.map(c=>c.action),['demo_enroll','demo_delete']);
});
