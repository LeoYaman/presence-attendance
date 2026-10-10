import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localDemoConfiguration,authorizeLocalDemoRequest} from '../scripts/local-demo.mjs';

const remoteEnv={LOCAL_DEMO_PUBLIC_ORIGIN:'https://attendance.example-tailnet.ts.net',LOCAL_DEMO_TAILSCALE_LOGIN:'teacher@example.com'};
const request=(headers,remoteAddress='127.0.0.1')=>({headers,socket:{remoteAddress}});

test('default local demo retains localhost access and its configured port',()=>{
  const config=localDemoConfiguration({});
  assert.equal(config.port,3000);
  assert.equal(config.publicOrigin,'http://localhost:3000');
  assert.equal(config.secureCookies,false);
  assert.equal(authorizeLocalDemoRequest(request({host:'localhost:3000'}),config),true);
  assert.equal(authorizeLocalDemoRequest(request({host:'127.0.0.1:3000'}),config),false);
  assert.equal(authorizeLocalDemoRequest(request({host:['localhost:3000']}),config),false);
  const custom=localDemoConfiguration({LOCAL_DEMO_PORT:'3001'});
  assert.equal(authorizeLocalDemoRequest(request({host:'localhost:3001'}),custom),true);
  for(const port of ['0','1023','65536','3000.5','invalid']) assert.throws(()=>localDemoConfiguration({LOCAL_DEMO_PORT:port}),/Invalid local port/);
});

test('remote demo requires the exact public host and Tailscale login from loopback',()=>{
  const config=localDemoConfiguration(remoteEnv);
  const headers={host:'attendance.example-tailnet.ts.net','tailscale-user-login':'teacher@example.com'};
  assert.equal(config.publicOrigin,remoteEnv.LOCAL_DEMO_PUBLIC_ORIGIN);
  assert.equal(config.secureCookies,true);
  for(const address of ['127.0.0.1','::1','::ffff:127.0.0.1'])
    assert.equal(authorizeLocalDemoRequest(request(headers,address),config),true);
  for(const host of ['localhost:3000','other.example-tailnet.ts.net','attendance.example-tailnet.ts.net:443',undefined,[headers.host]])
    assert.equal(authorizeLocalDemoRequest(request({...headers,host}),config),false);
  for(const login of [undefined,'other@example.com','Teacher@example.com',[headers['tailscale-user-login']]])
    assert.equal(authorizeLocalDemoRequest(request({...headers,'tailscale-user-login':login}),config),false);
  assert.equal(authorizeLocalDemoRequest(request(headers,'100.64.1.2'),config),false);
  assert.equal(authorizeLocalDemoRequest({headers},config),false);
});

test('remote configuration rejects unsupported origins and missing or malformed logins',()=>{
  for(const origin of ['', 'http://attendance.example-tailnet.ts.net','https://example.com','https://ts.net',
    'https://attendance.example-tailnet.ts.net.evil.example','https://user:pass@attendance.example-tailnet.ts.net',
    'https://attendance.example-tailnet.ts.net/path','https://attendance.example-tailnet.ts.net/?query=1',
    'https://attendance.example-tailnet.ts.net/#fragment','https://attendance.example-tailnet.ts.net/../',
    ' https://attendance.example-tailnet.ts.net'])
    assert.throws(()=>localDemoConfiguration({...remoteEnv,LOCAL_DEMO_PUBLIC_ORIGIN:origin}),/HTTPS ts.net root origin/);
  for(const login of [undefined,'',' ','teacher@example.com\n','a'.repeat(255)])
    assert.throws(()=>localDemoConfiguration({...remoteEnv,LOCAL_DEMO_TAILSCALE_LOGIN:login}),/LOCAL_DEMO_TAILSCALE_LOGIN/);
  assert.equal(localDemoConfiguration({...remoteEnv,LOCAL_DEMO_PUBLIC_ORIGIN:remoteEnv.LOCAL_DEMO_PUBLIC_ORIGIN+'/'}).publicOrigin,remoteEnv.LOCAL_DEMO_PUBLIC_ORIGIN);
});
