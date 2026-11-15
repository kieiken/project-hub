'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {create,sameIdentity}=require('../lib/idea-directory-identity');
const {fixture,U}=require('./idea-fixture.cjs');
const V='e2066b38-54ed-4d91-a667-dbf016501e42';
function simulated(dev=7,ino=23,birth=100,volume=V){return create({platform:'darwin',stat:()=>({dev,ino,birthtimeMs:birth}),run:(cmd)=>cmd==='/bin/df'?'Filesystem blocks Used Available Capacity Mounted on\n/dev/disk3s5 1 1 1 1% /System/Volumes/Data\n':`<dict><key>VolumeUUID</key><string>${volume}</string></dict>`})('/folder');}
test('Mac reboot: changed device number retains persistent directory binding',()=>{assert.equal(sameIdentity(simulated(7),simulated(9)),true);});
test('different volume, replaced inode or creation time cannot reuse binding',()=>{for(const other of [simulated(7,24),simulated(7,23,101),simulated(7,23,100,'12345678-1234-1234-1234-123456789abc')])assert.equal(sameIdentity(simulated(),other),false);});
test('legacy records require exact device and inode until explicitly reconciled',()=>{assert.equal(sameIdentity([7,23],simulated(7)),true);assert.equal(sameIdentity([7,23],simulated(9)),false);assert.equal(sameIdentity([7,22],simulated(7)),false);});
test('Windows and unavailable volume lookup retain exact legacy comparison',()=>{assert.deepEqual(create({platform:'win32',stat:()=>({dev:7,ino:23}),run:()=>{throw Error('must not run');}})('/x'),[7,23]);assert.deepEqual(create({platform:'darwin',stat:()=>({dev:7,ino:23}),run:()=>{throw Error('offline');}})('/x'),[7,23]);});
test('volume lookup is bounded and cached for a mounted device',()=>{let calls=0;const id=create({platform:'darwin',stat:()=>({dev:7,ino:23,birthtimeMs:100}),run:(cmd,args,opts)=>{calls++;assert.equal(opts.timeout,3000);return cmd==='/bin/df'?'/dev/disk3s5 1 1 1 1% /x':`<key>VolumeUUID</key><string>${V}</string>`;}});id('/x');id('/x');assert.equal(calls,2);});
test('registry and lane accept persistent binding across device renumbering, preserve path/branch checks',t=>{
 const f=fixture(t);const {IdeaLane}=require('../paid/idea-automation/idea-lane');const lane=new IdeaLane({ideas:f.ideas,baseOf:()=>f.main,gate:f.gate});lane.set('P',{opId:U.uuid(),settingsRev:f.ideas.read('P').settings.rev,task:'lane'});
 const reg=U.json(f.ideas.registryFile);assert.ok(reg.projects.P.identity[2],'real Mac volume proof');reg.projects.P.identity[0]++;fs.writeFileSync(f.ideas.registryFile,U.bytes(reg));assert.equal(f.ideas.read('P').projectUid,reg.projects.P.projectUid);
 f.ideas.internal('P',U.uuid(),{test:'reboot'},d=>{d.settings.lane.workdirIdentity[0]++;d.settings.lane.targetBinding.identity[0]++;});assert.equal(lane.resolve('P').task,'lane');
 f.ideas.internal('P',U.uuid(),{test:'branch'},d=>{d.settings.lane.targetBinding.branchRef='refs/heads/wrong';});assert.throws(()=>lane.resolve('P'),{code:'lane-binding'});
 reg.projects.P.realpath+='/moved';fs.writeFileSync(f.ideas.registryFile,U.bytes(reg));assert.throws(()=>f.ideas.read('P'),{code:'project-binding'});
});
