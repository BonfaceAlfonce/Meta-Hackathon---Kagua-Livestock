import test from 'node:test';
import assert from 'node:assert/strict';
import { advisoryFeeds, buildAdvisory, evaluateEvidence, parseSamBoxes, readingValues } from '../supabase/functions/_shared/advisory.js';
import { createAdvisoryHandler } from '../supabase/functions/_shared/advisory-handler.js';
const farm = '11111111-1111-4111-8111-111111111111', user = '22222222-2222-4222-8222-222222222222';
const event = '33333333-3333-4333-8333-333333333333', requestId = '44444444-4444-4444-8444-444444444444';
const row = { id: event, farm_id: farm, zone_id: '55555555-5555-4555-8555-555555555555', device_id: null, captured_at: '2026-10-28T10:00:00Z', temperature_c: '28.5', humidity_pct: 92, ammonia_ppm: 38, measurements: { ground_moisture_pct: 96 } };
const warning = { id: 'warning-a', farm_id: farm, zone_id: row.zone_id, telemetry_event_id: event, alert_type: 'demo_high_ammonia', severity: 'warning' };
const rule = { id: 'rule-a', farm_id: farm, zone_id: row.zone_id, enabled: true, metric_key: 'ammonia_ppm', operator: 'gt', threshold: 30, severity: 'warning' };
test('advisory uses only the four recorded environmental values, preserving zeros and missing data', () => {
  assert.deepEqual(readingValues({ ...row, measurements: { ground_moisture_pct: 0, invented: 99 }, temperature_c: 0, humidity_pct: null, ammonia_ppm: '' }), { temperature_c: 0, humidity_pct: null, ammonia_ppm: null, ground_moisture_pct: 0 });
  assert.equal(readingValues({ ...row, temperature_c: true }).temperature_c, null);
  assert.equal(readingValues({ ...row, ammonia_ppm: 'not a number' }).ammonia_ppm, null);
  assert.throws(() => buildAdvisory({ ...row, zone_id: null }));
});
test('only enabled, farm/zone-matched existing rules can flag a reading', () => {
  assert.equal(evaluateEvidence(row, [rule]).severity, 'warning');
  for (const changed of [{ farm_id: 'another' }, { zone_id: 'another' }, { enabled: false }, { metric_key: 'invented' }, { threshold: 'bad' }, { operator: 'bad' }]) assert.equal(evaluateEvidence(row,[{ ...rule, ...changed }]).checks.length,0);
  assert.equal(evaluateEvidence({ ...row, ammonia_ppm: null },[rule]).checks.length,0);
  const plain = buildAdvisory(row);
  assert.equal(plain.evidence.severity,'info');
  assert.ok(plain.result.concerns[0].includes('does not establish'));
});
test('unrelated, resolved or previous advisory alerts cannot become evidence', () => {
  assert.equal(evaluateEvidence(row,[],[warning]).warning_ids.length,1);
  for (const changed of [{ farm_id:'another' }, { zone_id:'another' }, { telemetry_event_id:'another' }, { alert_type:'farm_advisory' }, { resolved_at:'2026-10-29' }]) assert.equal(evaluateEvidence(row,[],[{ ...warning,...changed }]).warning_ids.length,0);
});
test('advisory never echoes unrestricted warning text or raw model wording', () => {
  const advisory = buildAdvisory(row,[],[{ ...warning, title:'unsafe-source-title', message:'unsafe-source-message' }],[{ image_id:advisoryFeeds[0].id,source:'sam',boxes:[],text:'unsafe-model-message' }]);
  assert.ok(!advisory.message.includes('unsafe'));
  assert.ok(!JSON.stringify(advisory.result).includes('unsafe'));
  assert.ok(advisory.message.includes('contact your vet'));
  assert.ok(advisory.message.includes('28.5 °C'));
  assert.ok(advisory.result.observations[0].includes('not synchronized'));
});
test('SAM parser accepts validated boxes and explicit zero detections but rejects malformed/refused/incomplete output', () => {
  const boxes = parseSamBoxes({ status:'completed', output_text:'<0f>0<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=20|><|mask;x=0;y=0;data=0|>' });
  assert.equal(boxes.length,1); assert.equal(boxes[0].width,10);
  assert.deepEqual(parseSamBoxes({ status:'completed',output:[] }),[]);
  for (const invalid of [{}, { status:'incomplete',output:[] }, { output_text:'unreadable text' }, { output_text:'<|box;x1=1;y1=2;x2=30;y2=4;w=10;h=20|>' }, { output:[{ content:[{type:'refusal'}] }] }]) assert.throws(() => parseSamBoxes(invalid));
});
function setup(options = {}) {
  const calls = { fetch:[],rpc:[],update:[],queries:[] };
  const settings = { DAS_FARM_ID:farm,SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service',META_API_KEY:'server-only-secret',VISION_SITE_ORIGIN:'https://farm.example',...options.env };
  function createClient() {
    return {
      auth:{getUser:async()=>({data:{user:options.noUser?null:{id:user}},error:null})},
      from(table) {
        const query={filters:[],select(){return this;},eq(key,value){this.filters.push([key,value]);calls.queries.push([table,key,value]);return this;},neq(){return this;},
          update(patch){calls.update.push(patch);return this;},
          async maybeSingle(){
            if(table==='farm_members')return {data:options.noMembership?null:{farm_id:farm}};
            if(table==='telemetry_events')return {data:options.noReading?null:row};
            if(table==='farm_image_analyses')return {data:options.cached || null,error:options.noMigration?{}:null};
            throw new Error(`Unexpected query: ${table}`);
          },
          then(resolve,reject){let data=table==='alert_rules'?[rule]:table==='farm_alerts'?[warning]:null;return Promise.resolve({data,error:options.contextError?{}:null}).then(resolve,reject);}
        };return query;
      },
      async rpc(name,args){calls.rpc.push([name,args]);return name==='publish_farm_advisory'?{data:{id:requestId,farm_id:farm,status:'complete',advisory:args.p_advisory},error:options.publishError?{}:null}:{error:options.rateLimit?{}:null};}
    };
  }
  const handler=createAdvisoryHandler({env:key=>settings[key],createClient,fetchImpl:async(url,init)=>{
    calls.fetch.push([url,init]);
    const status=options.failSecond && calls.fetch.length===2?403:200;
    return new Response(JSON.stringify(options.badSam?{output_text:'unsupported'}:{status:'completed',output_text:'<0f>0<|box;x1=1;y1=1;x2=4;y2=4;w=10;h=10|>'}),{status});
  }});
  const request=(body={},headers={})=>handler(new Request('https://project.supabase.co/functions/v1/farm-advisory',{method:'POST',headers:{authorization:'Bearer session',origin:'https://farm.example',...headers},body:JSON.stringify({farm_id:farm,telemetry_event_id:event,request_id:requestId,mode:'sample',...body})}));
  return {calls,request};
}
test('unauthenticated, cross-farm and inaccessible readings are rejected before SAM or database reservation',async()=>{
  for(const [options,body,headers,status] of [[{}, {},{authorization:''},401],[{noUser:true},{},{},401],[{}, {farm_id:'other'},{},403],[{noMembership:true},{},{},403],[{noReading:true},{},{},404],[{}, {},{origin:'https://untrusted.example'},403]]){
    const {request,calls}=setup(options);assert.equal((await request(body,headers)).status,status);assert.equal(calls.fetch.length,0);assert.equal(calls.rpc.length,0);
  }
});
test('sample publication retrieves server readings and ignores forged client inputs',async()=>{
  const {request,calls}=setup({env:{META_API_KEY:''}});
  const response=await request({temperature_c:999,image_url:'https://untrusted.example',message:'unsafe-message'});
  assert.equal(response.status,200);assert.equal(calls.fetch.length,0);
  const advisory=(await response.json()).record.advisory;
  assert.equal(advisory.evidence.values.temperature_c,28.5);
  assert.ok(!advisory.message.includes('999'));assert.ok(!advisory.message.includes('unsafe-message'));
  assert.equal(advisory.visual.length,2);assert.equal(advisory.visual[0].source,'prepared');
  assert.ok(calls.queries.some(q=>q[0]==='telemetry_events'&&q[1]==='farm_id'&&q[2]===farm));
});
test('SAM mode calls the responses API for exactly the two registered images before publication',async()=>{
  const {request,calls}=setup();assert.equal((await request({mode:'meta'})).status,200);assert.equal(calls.fetch.length,2);
  calls.fetch.forEach(([url,init],i)=>{assert.equal(url,'https://api.meta.ai/v1/responses');const body=JSON.parse(init.body);assert.equal(body.model,'sam-3.1');assert.equal(body.input[0].content[0].text,'chicken');assert.equal(body.input[0].content[1].image_url,advisoryFeeds[i].url);});
  const publication=calls.rpc.find(x=>x[0]==='publish_farm_advisory')[1].p_advisory;
  assert.equal(publication.visual[0].boxes.length,1);assert.ok(!publication.message.includes('server-only-secret'));
});
test('missing key, failed second frame, unreadable SAM output, context failures and rate limits never publish a combined advisory',async()=>{
  for(const options of [{env:{META_API_KEY:''}},{failSecond:true},{badSam:true},{contextError:true},{rateLimit:true},{noMigration:true}]){
    const {request,calls}=setup(options);assert.ok((await request({mode:'meta'})).status>=400);assert.equal(calls.rpc.some(x=>x[0]==='publish_farm_advisory'),false);
  }
});
test('completed evidence is reused without more SAM calls or alert publication',async()=>{
  const cached={id:requestId,status:'complete',farm_id:farm};const {request,calls}=setup({cached});
  const response=await request({mode:'meta'});assert.equal(response.status,200);assert.equal((await response.json()).reused,true);assert.equal(calls.fetch.length,0);assert.equal(calls.rpc.length,0);
});
test('failed alert publication marks the analysis failed and permits a later evidence retry',async()=>{
  const {request,calls}=setup({publishError:true});assert.equal((await request()).status,502);assert.ok(calls.update.some(p=>p.status==='failed'&&p.advisory_key===null));
});
