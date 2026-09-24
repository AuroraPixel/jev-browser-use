import type { Browser } from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extendPage } from "../src/page/extend.ts";
import { observe } from "../src/jev/browser.ts";

/** Opt-in from smoke-extension.ts. Only rendered chart marks, axis labels and
 * visible tooltips are read; no React state, source answers or network payloads. */
export async function chartTrials(browser: Browser, directory: string, live = false): Promise<void> {
  mkdirSync(directory, {recursive:true});
  const results: Array<Record<string, unknown>> = [];
  for (let run = 1; run <= (live ? 1 : 10); run++) {
    const mode = live || run % 2 === 0 ? 'relocate-and-read' : 'captured-handle';
    const p = extendPage(await browser.newPage());
    const started = performance.now();
    const result: Record<string, unknown> = {run,mode,startedAt:new Date().toISOString(),success:false,tooltips:[]};
    try {
      await p.setViewport({width:1280,height:900});
      await p.goto('https://webgames.convergence.ai/chart-transcribe-hard');
      const selector = 'path.recharts-rectangle[fill="#8b5cf6"]';
      await p.waitForSelector(selector,{visible:true,timeout:10000});
      const times = await p.$$eval('svg text',es=>es.map(e=>e.textContent!).filter(t=>/^\d\d:\d\d$/.test(t)));
      if(times.length!==6 || new Set(times).size!==6) throw new Error('Expected six distinct visible time labels');
      result.readyMs = Math.round(performance.now()-started);
      const tips: string[] = [], attempts: number[] = [];
      const readStart = performance.now();
      for(let i=0;i<times.length;i++) {
        let tip: string;
        if(mode==='captured-handle') {
          const bars=await p.$$(selector);
          try { await bars[i]!.click(); } finally { await Promise.all(bars.map(h=>h.dispose())); }
          await p.waitForFunction(t=>[...document.querySelectorAll('li')].some(e=>e.parentElement?.parentElement?.innerText.startsWith(t)),{timeout:3000,polling:'mutation'},times[i]!);
          tip=await p.$eval('li',e=>e.parentElement!.parentElement!.innerText);
        } else {
          const r=await p.interact({operation:'hover',selector,index:i,count:6,read:{selector:'.recharts-default-tooltip',includes:times[i]!}});
          tip=r.text!; attempts.push(r.attempts);
        }
        const match=tip.match(/(\d\d:\d\d)\s+Primary\s*:\s*(-?\d+(?:\.\d+)?)\s+Secondary\s*:\s*(-?\d+(?:\.\d+)?)/);
        if(!match || match[1]!==times[i]) throw new Error('Incomplete or wrong-time tooltip');
        tips.push(tip); result.tooltips=[...tips];
      }
      result.readMs=Math.round(performance.now()-readStart); result.attempts=attempts;
      const csv=tips.map(t=>t.match(/(\d\d:\d\d)\s+Primary\s*:\s*(-?\d+(?:\.\d+)?)\s+Secondary\s*:\s*(-?\d+(?:\.\d+)?)/)!.slice(1).join(',')).join('\n');
      result.csv=csv;
      const snapshot=await p.snapshot({interactive:true}) as string;
      writeFileSync(join(directory,`run-${run}-initial.txt`),snapshot);
      const field=snapshot.match(/textbox[^\n]*\[ref=(\w+)\]/)?.[1];
      const submit=snapshot.match(/button "Submit"[^\n]*\[ref=(\w+)\]/)?.[1];
      if(!field || !submit) throw new Error('Observed controls missing');
      await p.fill('ref/'+field,csv);
      const expected=await p.$eval('ref/'+field,e=>(e as HTMLTextAreaElement).value);
      if(expected!==csv) throw new Error('CSV did not persist');
      // The paired comparison keeps final submission identical in both arms.
      // A separate opt-in live run exercises the real Jev completion contract.
      if (live) {
        const observed = await observe(p,new AbortController().signal);
        const label = observed.elements.find(e=>e.ref===field)?.label;
        if (!label) throw new Error('Filled field is not visible for submit verification');
        result.jev = await p.jev({action:'run',goal:'Submit the completed six-row CSV exactly once and confirm success.',completion:{
          submitLabel:'Submit',before:{fields:[{label,value:csv}]},after:{text:['Congratulations!']},
        }});
        if ((result.jev as any).stopReason !== 'submission_confirmed') throw new Error('Live Jev did not confirm submission: '+JSON.stringify(result.jev));
      } else await p.interact({operation:'click',selector:'ref/'+submit});
      await p.waitForFunction(()=>document.body.innerText.includes('Congratulations!'),{timeout:5000,polling:'mutation'});
      const final=await p.snapshot() as string;
      result.success=final.includes('Congratulations!') && final.includes('DataScribeHard2024');
      result.final=final; result.wallMs=Math.round(performance.now()-started);
      if(live || run===2 || run===10) await p.screenshot({path:join(directory,`run-${run}-success.png`),fullPage:true});
    } catch(error) {
      result.error=String(error); result.wallMs=Math.round(performance.now()-started);
      await p.screenshot({path:join(directory,`run-${run}-failure.png`),fullPage:true}).catch(()=>{});
    } finally {
      results.push(result);
      writeFileSync(join(directory,'results.json'),JSON.stringify({protocol:live ? 'Separate live Jev submit contract test after six visible-tooltip readings; not part of timing comparison.' : '10 alternating fresh random chart tasks; same updated runtime/extension/profile/viewport; captured handle vs relocation read path. Not a Codex comparison or old-binary benchmark.',results},null,2));
      console.log(JSON.stringify({run,mode,success:result.success,wallMs:result.wallMs,readMs:result.readMs,error:result.error}));
      await p.close();
    }
  }
  if (results.some(r => r.mode === 'relocate-and-read' && !r.success)) throw new Error('Chart relocation arm failed; inspect the saved report');
}
