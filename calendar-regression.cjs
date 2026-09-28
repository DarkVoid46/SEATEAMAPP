// Run with: node tests/calendar-regression.cjs
// In-memory DOM and Supabase adapter: no live accounts or database writes.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const code=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]).sort((a,b)=>b.length-a.length)[0];
const today='2026-09-28';
function row(date,extra={}){return {report_date:date,participants:20,daily_nps:0,monthly_nps:90,daily_pat:5,monthly_pat:8,upsell:100,screening_code:date.slice(2,4)+'-'+date.slice(5,7)+date.slice(8,10)+'_SEA,1',tracking_number:'00123456',marina_present:true,taylor_present:false,mia_present:true,victor_present:true,floater_present:false,floater_name:null,filled_by:'Test operator',...extra}}
function harness({rows=[row(today),row('2026-09-26')],storage=new Map()}={}){
  const db=new Map(rows.map(x=>[x.report_date,structuredClone(x)])),elements=new Map(),events=new Map(),timers=new Map(),calls=[];
  let timer=0,readError=false,writeError=false,writeDelay=null,session=false;
  const inputIDs=new Set(['totalParticipantsTop','dailyNpsTop','monthlyNpsTop','monthlyPatTop','dailyPatTop','dailyUpsellTop','trackingCountTop','filledByTop','floaterNameInput','codeSuffix']);
  function element(id){if(!elements.has(id)){let value='';elements.set(id,{id,innerHTML:'',textContent:'',style:{},classList:{add(){},remove(){}},get value(){return value},set value(v){value=String(v)},matches(){return inputIDs.has(id)},addEventListener(type,fn){events.set(id+':'+type,fn)}})}return elements.get(id)}
  const document={activeElement:null,visibilityState:'visible',getElementById:element,querySelectorAll:()=>[],querySelector:()=>({contains:e=>inputIDs.has(e.id)}),addEventListener(type,fn){events.set('document:'+type,fn)}};
  class Query{
    constructor(){this.op='select';this.eqValue=null}
    select(){return this} eq(_key,value){this.eqValue=value;return this} gte(_key,value){this.start=value;return this} lt(_key,value){this.end=value;return this}
    update(value){this.op='update';this.value=structuredClone(value);return this} insert(value){this.op='insert';this.value=structuredClone(value);return this}
    order(){return this.run()} maybeSingle(){return this.run(true)} single(){return this.run(true)}
    async run(single=false){
      calls.push({op:this.op,date:this.eqValue||this.value?.report_date,value:this.value});
      if(this.op==='select'){
        if(readError)return {data:null,error:{message:'Read unavailable'}};
        const matches=[...db.values()].filter(r=>(!this.eqValue||r.report_date===this.eqValue)&&(!this.start||r.report_date>=this.start)&&(!this.end||r.report_date<this.end));
        return {data:structuredClone(single?(matches[0]||null):matches),error:null};
      }
      if(writeDelay)await writeDelay;
      if(writeError)return {data:null,error:{message:'Offline'}};
      if(this.op==='insert'){
        if(db.has(this.value.report_date))return {data:null,error:{code:'23505'}};
        db.set(this.value.report_date,structuredClone(this.value));
      }else{
        if(!db.has(this.eqValue))return {data:null,error:{message:'No matching report'}};
        db.set(this.eqValue,{...db.get(this.eqValue),...this.value});
      }
      return {data:structuredClone(db.get(this.eqValue||this.value.report_date)),error:null};
    }
  }
  const sb={from(name){assert.equal(name,'daily_reports');return new Query()},channel(){return {on(_event,_filter,fn){events.set('realtime',fn);return this},subscribe(){return this}}},removeChannel(){},auth:{getSession:async()=>({data:{session:session?{}:null}}),onAuthStateChange(){},signOut:async()=>({})}};
  class FixedDate extends Date{constructor(...args){super(...(args.length?args:['2026-09-28T12:00:00']))}static now(){return new Date('2026-09-28T12:00:00').getTime()}}
  const context=vm.createContext({document,window:{supabase:{createClient:()=>sb},addEventListener(type,fn){events.set('window:'+type,fn)}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,val)=>storage.set(key,String(val))},navigator:{},Date:FixedDate,console,setTimeout(fn){const id=++timer;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)}});
  vm.runInContext(code,context);
  const run=expression=>vm.runInContext(expression,context);
  const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve()};
  return {db,calls,elements,document,events,storage,run,settle,element,readsFail:v=>readError=v,writesFail:v=>writeError=v,delayWrites:p=>writeDelay=p,async login(){await run('enterApp()');await settle()},async edit(id,value){document.activeElement=element(id);element(id).value=value;run('autoSaveCurrentReport()')},async blur(){document.activeElement=null;events.get('document:focusout')();for(const [id,fn]of [...timers]){timers.delete(id);await fn()}await settle()},pending:()=>JSON.parse(storage.get('eodPendingReports')||'{}')};
}
const tests=[];function test(name,fn){tests.push([name,fn])}
test('A fresh browser reads September 26 from cloud without changing today or writing any row',async()=>{
  const h=harness();await h.login();await h.run("selectDay('2026-09-26')");
  assert.match(h.element('selectedDay').innerHTML,/Loaded from cloud/);
  assert.match(h.element('selectedDay').innerHTML,/Daily NPS: 0%/);
  assert.match(h.element('selectedDay').innerHTML,/00123456/);
  assert.equal(h.run('state.date'),today);
  assert.equal(h.calls.filter(x=>x.op!=='select').length,0);
  assert.match(h.element('calendarGrid').innerHTML,/26 •/);
  h.run('changeCalendarMonth(1)');await h.settle();assert.match(h.element('calendarMonth').textContent,/October/);
  await h.run("selectDay('2026-10-01')");assert.equal(h.db.size,2);
});
test('Failed cloud reads retain cached history and never report deletion or write a blank row',async()=>{
  const h=harness();await h.login();await h.run("selectDay('2026-09-26')");h.readsFail(true);
  await h.run("selectDay('2026-09-26')");assert.match(h.element('selectedDay').innerHTML,/Could not check the cloud/);assert.match(h.element('selectedDay').innerHTML,/00123456/);
  await h.edit('totalParticipantsTop','99');await h.run('saveCloud()');
  assert.ok(h.pending()[today]);assert.equal(h.db.get(today).participants,20);
  assert.equal(h.calls.filter(x=>x.op!=='select').length,0);
});
test('Saving today updates only edited fields and leaves September 26 unchanged',async()=>{
  const h=harness();await h.login();const saturday=structuredClone(h.db.get('2026-09-26'));
  h.db.get(today).monthly_nps=77;await h.edit('totalParticipantsTop','40');await h.run('saveCloud()');
  assert.equal(h.db.get(today).participants,40);assert.equal(h.db.get(today).monthly_nps,77);
  assert.deepEqual(h.db.get('2026-09-26'),saturday);assert.equal(Object.keys(h.pending()).length,0);
  assert.match(h.element('syncStatus').textContent,/saved to cloud/);
});
test('Failed saves survive a reload and retry without losing the local draft',async()=>{
  const first=harness();await first.login();first.writesFail(true);await first.edit('filledByTop','Retained draft');await first.run('saveCloud()');
  assert.ok(first.pending()[today]);assert.match(first.element('syncStatus').textContent,/Cloud save failed/);
  const second=harness({rows:[...first.db.values()],storage:first.storage});await second.login();await second.run('saveCloud()');await second.settle();
  assert.equal(second.db.get(today).filled_by,'Retained draft');assert.equal(Object.keys(second.pending()).length,0);
});
test('Uploading an old local copy never overwrites a cloud row that already exists',async()=>{
  const h=harness();await h.login();await h.run("selectDay('2026-09-26')");h.run("state.saved['2026-09-26'].participants=999");
  await h.run("uploadLocalReport('2026-09-26')");assert.equal(h.db.get('2026-09-26').participants,20);
  assert.equal(h.calls.filter(x=>x.op==='update').length,0);
});
test('In-flight saves cannot acknowledge newer edits or overwrite typing with an older echo',async()=>{
  const h=harness();await h.login();let release;h.delayWrites(new Promise(r=>release=r));
  await h.edit('filledByTop','First');const saving=h.run('saveCloud()');await h.settle();
  await h.edit('filledByTop','Latest');release();await saving;h.delayWrites(null);
  assert.ok(h.pending()[today]);assert.equal(h.element('filledByTop').value,'Latest');
  await h.run('saveCloud()');assert.equal(h.db.get(today).filled_by,'Latest');
  const old=row(today,{filled_by:'First'});h.events.get('realtime')({new:old});
  assert.equal(h.element('filledByTop').value,'Latest');await h.blur();assert.equal(h.element('filledByTop').value,'Latest');
});
test('Starting a new day preserves an older locally saved report and employee snapshot',async()=>{
  const storage=new Map([['eodState',JSON.stringify({date:'2026-09-26',employees:{Victor:true},daily:{participants:25,filledBy:'Saturday'},saved:{}})]]);
  const h=harness({storage});assert.equal(h.run("state.saved['2026-09-26'].participants"),25);assert.equal(h.run('state.date'),today);
  h.run('state.employees.Victor=false');assert.equal(h.run("state.saved['2026-09-26'].employees.Victor"),true);
});
(async()=>{for(const[name,fn]of tests){await fn();console.log('PASS '+name)}console.log(`${tests.length} regression checks passed; no live database used.`)})().catch(e=>{console.error(e);process.exitCode=1});
