// Actual 24 September prepared executor, exported from the supported Codex CUA REPL.
// Pass the live in-app Tab explicitly; do not capture a tab from a previous turn.
var splitNativeRows = [];
var runSplitNativeRound = async(round,p)=>{
 const value='Browser benchmark '+round,rows=[];
 const urls={'selenium-form':'https://www.selenium.dev/selenium/web/web-form.html','selenium-dynamic':'https://www.selenium.dev/selenium/web/dynamic.html','internet-controls':'https://the-internet.herokuapp.com/dropdown','internet-dynamic':'https://the-internet.herokuapp.com/dynamic_controls'};
 const assert=(ok,msg)=>{if(!ok)throw Error(msg);}; const multiline='First line\nSecond line';
 for(const [task,url]of Object.entries(urls)){
  const started=performance.now();let loaded=started,actual=null,error=null;
  try{
   if((await p.url())===url)await p.reload();else await p.goto(url);loaded=performance.now();
   if(task==='selenium-form'){
    await p.playwright.getByRole('textbox',{name:'Text input',exact:true}).fill(value);await p.playwright.getByRole('textbox',{name:'Textarea',exact:true}).fill(multiline);await p.playwright.getByRole('combobox',{name:'Dropdown (select)',exact:true}).selectOption({label:'Two'});await p.playwright.getByRole('checkbox',{name:'Default checkbox',exact:true}).check();await p.playwright.getByRole('checkbox',{name:'Checked checkbox',exact:true}).uncheck();await p.playwright.getByRole('radio',{name:'Default radio',exact:true}).check();
    const fields=await p.playwright.evaluate(()=>({text:document.querySelector('[name="my-text"]').value,area:document.querySelector('textarea').value,select:document.querySelector('select').value,checks:Array.from(document.querySelectorAll('input[type="checkbox"]')).map(e=>e.checked),radios:Array.from(document.querySelectorAll('input[type="radio"]')).map(e=>e.checked)}));
    assert(fields.text===value&&fields.area===multiline&&fields.select==='2'&&JSON.stringify(fields.checks)==='[false,true]'&&JSON.stringify(fields.radios)==='[false,true]','Incorrect form fields');
    await p.playwright.getByRole('button',{name:'Submit',exact:true}).click();await p.playwright.getByText('Received!',{exact:true}).waitFor({state:'visible',timeoutMs:10000});const received=await p.playwright.evaluate(()=>({url:location.href,text:document.body.innerText}));const params=new URL(received.url).searchParams;assert(received.text.includes('Received!')&&params.get('my-text')===value&&params.get('my-textarea').replace(/\r/g,'')===multiline&&params.get('my-select')==='2','Submission not verified');actual={fields,received:true};
   }else if(task==='selenium-dynamic'){
    await p.playwright.getByRole('button',{name:'Reveal a new input',exact:true}).click();await p.playwright.getByRole('textbox').waitFor({state:'visible',timeoutMs:10000});await p.playwright.getByRole('textbox').fill(value);
    const values=await p.playwright.evaluate(()=>Array.from(document.querySelectorAll('input')).filter(e=>e.type==='text').map(e=>e.value));const visible=await p.playwright.getByRole('textbox').isVisible();assert(values.length===1&&values[0]===value&&visible,'Revealed input not verified');actual=[{value:values[0],visible}];
   }else if(task==='internet-controls'){
    await p.playwright.getByRole('combobox').selectOption({label:'Option 2'});const selection=await p.playwright.evaluate(()=>({value:document.querySelector('select').value,index:document.querySelector('select').selectedIndex}));assert(selection.value==='2'&&selection.index===2,'Dropdown not verified');await p.goto('https://the-internet.herokuapp.com/checkboxes');await p.playwright.getByRole('checkbox').nth(0).check();await p.playwright.getByRole('checkbox').nth(1).uncheck();const checks=await p.playwright.evaluate(()=>Array.from(document.querySelectorAll('input[type="checkbox"]')).map(e=>e.checked));assert(JSON.stringify(checks)==='[true,false]','Checkboxes not verified');actual={selection,checks};
   }else{
    for(const[button,message]of[['Remove',"It's gone!"],['Add',"It's back!"],['Enable',"It's enabled!"]]){await p.playwright.getByRole('button',{name:button,exact:true}).click();await p.playwright.getByText(message,{exact:true}).waitFor({state:'visible',timeoutMs:10000});}
    await p.playwright.getByRole('textbox').fill(value);await p.playwright.getByRole('button',{name:'Disable',exact:true}).click();await p.playwright.getByText("It's disabled!",{exact:true}).waitFor({state:'visible',timeoutMs:10000});actual=await p.playwright.evaluate(()=>({value:document.querySelector('input[type="text"]').value,disabled:document.querySelector('input[type="text"]').disabled,checkboxes:document.querySelectorAll('input[type="checkbox"]').length,message:document.body.innerText.includes("It's disabled!")}));assert(actual.value===value&&actual.disabled&&actual.checkboxes===1&&actual.message,'Dynamic controls not verified');
   }
  }catch(e){error=String(e);}
  const finished=performance.now();const row={arm:'codex-browser-use',round,task,verified:!error,error,navigationMs:loaded-started,executionMs:finished-loaded,workflowMs:finished-started,actual};rows.push(row);splitNativeRows.push(row);
 }
 nodeRepl.write(JSON.stringify({at:new Date().toISOString(),round,rows}));return rows;
};
