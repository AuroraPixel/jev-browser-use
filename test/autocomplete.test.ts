import { afterAll, expect, test } from 'bun:test';
import { JevController } from '../src/jev/controller.ts';
import { observe, prepare } from '../src/jev/browser.ts';
import { buildRequest } from '../src/jev/model.ts';
import { evaluateCheckpoint } from '../src/jev/checkpoint.ts';
import { parseCheckpoint, type Decision, type Operation } from '../src/jev/types.ts';
import { withPage, closeBrowser } from './helpers/browser.ts';
import { startServer } from './helpers/server.ts';

afterAll(closeBrowser);
const choose = (operation: Operation, target?: string): Decision => ({ operation, target, confidence:1, targetConfidence:1, model:'fixture', latencyMs:0 });
const signal = () => new AbortController().signal;
const fixture = `<!doctype html><style>li{list-style:none}#options{position:absolute;display:none;background:white;z-index:20;padding:5px}#options li{cursor:pointer;padding:8px}</style>
<form><ul><li><span><label>Origin</label></span><div><input type=hidden id=origin value=OLD><input id=originText value=Oldtown></div></li>
<li><span><label>Destination</label></span><div><input type=hidden id=destination value=OTHER><input id=destinationText value=Elsewhere></div></li></ul>
<button type=button id=query>Query</button></form><ul id=options></ul><h2></h2><table><tbody></tbody></table>
<script>
const cities={'南京':'NJH','拉萨':'LSO','Oldtown':'OLD','Elsewhere':'OTHER'};
window.queries=0;window.keyups=0;window.activations=0;
for(const input of document.querySelectorAll('input:not([type=hidden])')) {
 input.addEventListener('mouseover',()=>{window.activations++;
 input.addEventListener('keydown',()=>{const r=input.getBoundingClientRect();options.style.left=r.left+'px';options.style.top=r.bottom+'px';options.style.display='block'});
 input.addEventListener('keyup',()=>{window.keyups++;options.replaceChildren();
  for(const [name,code] of Object.entries(cities)) if(name===input.value){const li=document.createElement('li');li.textContent=name;li.title=name;
   li.onclick=()=>{input.value=name;document.getElementById(input.id.replace(/Text$/,'')).value=code;options.style.display='none'};options.append(li)}
 });
 },{once:true});
}
query.onclick=()=>{window.queries++;document.querySelector('h2').textContent=originText.value+' → '+destinationText.value;
 const a=Object.entries(cities).find(x=>x[1]===document.querySelector('#origin').value)?.[0];
 const b=Object.entries(cities).find(x=>x[1]===document.querySelector('#destination').value)?.[0];
 document.querySelector('tbody').innerHTML='<tr><td>Z123</td><td>'+a+'</td><td>'+b+'</td></tr>'};
</script>`;

test('legacy display/backing pickers expose labels without exposing hidden values to Jev', () => withPage(async p => {
  await p.setContent(fixture + '<label>Notes<input id=notes></label><input type=hidden id=csrf value=PRIVATE_TOKEN>');
  const o = await observe(p,signal());
  expect(o.elements.find(e=>e.label==='Origin')).toMatchObject({picker:true,role:'textbox',operations:['TYPE_TEXT','CLICK']});
  expect(o.elements.find(e=>e.label==='Destination')?.picker).toBe(true);
  expect(o.elements.find(e=>e.label==='Notes')?.operations).toEqual(['TYPE_TEXT']);
  const request = JSON.stringify(buildRequest(o,'Query',[]));
  expect(request).not.toContain('PRIVATE_TOKEN');
  expect(request).not.toContain('"OLD"');
}));

test('hover-initialized keyboard pickers commit both actual identities before one verified query', () => withPage(async p => {
  const server = await startServer({'/':fixture});
  try {
    await p.goto(server.url('/'));
    const c = new JevController(p,async o => {
      const pending=o.pendingSelections?.[0];
      if(pending) { expect(pending.options).toHaveLength(1); return choose('CLICK',pending.options[0]); }
      const field=o.elements.find(e=>['Origin','Destination'].includes(e.label)&&e.operations.includes('TYPE_TEXT'));
      return field ? choose('TYPE_TEXT',field.ref) : choose('CLICK',o.elements.find(e=>e.label==='Query')!.ref);
    });
    const r = await c.call({action:'run',goal:'Query 南京 to 拉萨',
      inputs:[{url:p.url(),label:'Origin',text:'南京'},{url:p.url(),label:'Destination',text:'拉萨'}],
      until:{rows:[{text:['Z123','南京','拉萨']}]}});
    expect(r.status).toBe('done'); expect(r.stopReason).toBe('checkpoint_reached'); expect(r.steps).toBe(5);
    expect(r.taskState?.pendingSelections).toEqual([]);
    expect(await p.evaluate(()=>({origin:(document.querySelector('#origin') as HTMLInputElement).value,dest:(document.querySelector('#destination') as HTMLInputElement).value,queries:(window as any).queries,keyups:(window as any).keyups,activations:(window as any).activations})))
      .toEqual({origin:'NJH',dest:'LSO',queries:1,keyups:2,activations:2});
  } finally {await server.stop();}
}));

test('typed text cannot satisfy a checkpoint or a DONE while its backing identity is stale', () => withPage(async p => {
  await p.setContent(fixture);
  let calls=0;
  const c=new JevController(p,async o=>++calls===1?choose('TYPE_TEXT',o.elements.find(e=>e.label==='Origin')!.ref):choose('DONE'));
  const first=await c.call({action:'run',goal:'Select 南京',until:{fields:[{label:'Origin',value:'南京'}]}});
  const r=await c.call({action:'resume',sessionId:first.sessionId,requestId:first.requestId!,text:'南京'});
  expect(r.status).toBe('needs_host');expect(r.taskState?.pendingSelections?.[0]?.label).toBe('Origin');
  expect(r.checkpoint?.matched).toBe(false);
  expect(await p.$eval('#origin',e=>(e as HTMLInputElement).value)).toBe('OLD');
  expect(await p.evaluate(()=>(window as any).queries)).toBe(0);
}));

test('a model that skips a pending picker cannot dispatch a query', () => withPage(async p => {
  await p.setContent(fixture);
  let calls=0;
  const c=new JevController(p,async o=>++calls===1?choose('TYPE_TEXT',o.elements.find(e=>e.label==='Origin')!.ref):choose('CLICK',o.elements.find(e=>e.label==='Query')!.ref));
  const first=await c.call({action:'run',goal:'Query'});
  const r=await c.call({action:'resume',sessionId:first.sessionId,requestId:first.requestId!,text:'南京'});
  expect(r.status).toBe('needs_host');expect(r.reason).toContain('Selection for Origin');expect(r.steps).toBe(1);
  expect(await p.evaluate(()=>(window as any).queries)).toBe(0);
}));

test('fresh guards reject a backing-value change before a query click', () => withPage(async p => {
  await p.setContent(fixture);
  const o=await observe(p,signal()),d=choose('CLICK',o.elements.find(e=>e.label==='Query')!.ref);
  await p.$eval('#origin',e=>(e as HTMLInputElement).value='CHANGED');
  await expect(prepare(p,o,d,signal())).rejects.toThrow('Page changed');
}));

test('data-row evidence cannot be supplied by a heading or combined across different rows', () => withPage(async p => {
  const contract=parseCheckpoint({rows:[{text:['南京','拉萨']}]});
  await p.setContent('<h1>南京 → 拉萨</h1><table><tr><td>南京</td><td>上海</td></tr><tr><td>北京</td><td>拉萨</td></tr></table>');
  expect(evaluateCheckpoint(contract,await observe(p,signal())).matched).toBe(false);
  await p.$eval('table',e=>e.innerHTML='<tr><td>南京</td><td>拉萨</td></tr>');
  expect(evaluateCheckpoint(contract,await observe(p,signal())).matched).toBe(true);
  for(const rows of [[],[{text:[]}],[{text:['南京'],hidden:true}]]) expect(()=>parseCheckpoint({rows})).toThrow();
}));

test('goal-only completion hands off on low confidence or an incomplete observation', () => withPage(async p => {
  await p.setContent('<h1>Ready</h1>');
  const low=new JevController(p,async()=>({...choose('DONE'),confidence:.43}));
  expect((await low.call({action:'run',goal:'Read results'})).stopReason).toBe('low_confidence');
  await p.setContent('<div style="height:20px">'+Array.from({length:170},(_,i)=>'<button>'+i+'</button>').join('')+'</div>');
  const partial=new JevController(p,async()=>choose('DONE'));
  const r=await partial.call({action:'run',goal:'Read all results'});
  expect(r.status).toBe('needs_host');expect(r.page?.truncated).toBe(true);
}));

test('an explicit ARIA picker remains pending while its menu is expanded', () => withPage(async p => {
  await p.setContent('<input aria-label=Airport role=combobox aria-controls=menu aria-expanded=false oninput="this.setAttribute(\'aria-expanded\',\'true\');document.querySelector(\'#menu\').hidden=false"><div id=menu role=listbox hidden><div role=option onclick="document.querySelector(\'input\').setAttribute(\'aria-expanded\',\'false\');this.parentElement.hidden=true">Nanjing Lukou International Airport</div></div>');
  const c=new JevController(p,async o=>choose('TYPE_TEXT',o.elements.find(e=>e.label==='Airport')!.ref));
  const first=await c.call({action:'run',goal:'Select 南京'});
  await c.call({action:'resume',sessionId:first.sessionId,requestId:first.requestId!,text:'南京',maxSteps:1});
  const o=await observe(p,signal());
  expect(o.pendingSelections?.[0]?.options).toHaveLength(1);
  expect(evaluateCheckpoint({fields:[{label:'Airport',value:'南京'}]},o).matched).toBe(false);
}));
