// Prepared desktop Computer Use workflow in the Codex CUA REPL.
// Only a disposable, agent-created Chrome tab may be the active target.
// Indices are always derived from fresh accessibility observations. The Chinese
// role names below reflect the tested macOS/Chrome locale; adapt from observation.
var axRead = async () => await chromeApp.getAXState({ emit: false, disableDiffing: true });
var axMatches = (s, re) => s.split('\n').filter(l => /^\s*\d+ /.test(l) && re.test(l));
var axIndex = (s, re) => {
  const m = axMatches(s, re); if (m.length !== 1) throw Error('AX target count ' + m.length + ' for ' + re);
  return Number(m[0].match(/^\s*(\d+)/)[1]);
};
var axUntil = async (s, predicate, description) => {
  const begin = performance.now();
  while (!predicate(s)) {
    if (performance.now() - begin > 15000) throw Error('AX wait timeout: ' + description);
    // Pending navigation/dynamic transition needs new visual and accessibility
    // context. The CUA API handles observation pacing; no artificial sleep.
    const next = await chromeApp.getAXStateAndScreenshot({ emit: false, disableDiffing: true }); s = next.state;
  }
  return s;
};
var axGoto = async (url, ready) => {
  await chromeApp.pressKey('super+l'); await chromeApp.paste(url); await chromeApp.pressKey('Return');
  return await axUntil(await axRead(), s => s.includes('HTML 内容') &&
    s.includes(url.replace('https://www.', '').replace('https://', '')) && ready.test(s), 'load ' + url);
};
var runDesktopTask = async (round, task) => {
  const value = 'Browser benchmark ' + round, url = nativeTaskUrls[task], started = performance.now();
  let loaded = started, actual = null, error = null, s = '';
  try {
    const ready = { 'selenium-form': /按钮 Submit/, 'selenium-dynamic': /Reveal a new input/,
      'internet-controls': /弹出式按钮 Please select an option/, 'internet-dynamic': /按钮 Remove/ }[task];
    s = await axGoto(url, ready); loaded = performance.now();
    if (task === 'selenium-form') {
      await chromeApp.setValue(axIndex(s, /文本栏 \(settable\) Text input(?:,|$)/), value);
      await chromeApp.setValue(axIndex(s, /文本输入区 \(settable\) Textarea(?:,|$)/), nativeMultiline);
      await chromeApp.click(axIndex(s, /弹出式按钮 Dropdown \(select\)/)); s = await axRead();
      await chromeApp.click(axIndex(s, /\d+ (?:\(selected\) )?Two, ID:/)); s = await axRead();
      await chromeApp.click(axIndex(s, /复选框 Default checkbox, Value: 0/));
      await chromeApp.click(axIndex(s, /复选框 Checked checkbox, Value: 1/));
      await chromeApp.click(axIndex(s, /单选按钮 Default radio, Value: 0/)); s = await axRead();
      nativeAssert(s.includes('Text input, Value: ' + value) && s.includes('Textarea, Value: ' + nativeMultiline) &&
        s.includes('Dropdown (select), Value: Two') && s.includes('Checked checkbox, Value: 0') &&
        s.includes('Default checkbox, Value: 1') && s.includes('Checked radio, Value: 0') &&
        s.includes('Default radio, Value: 1'), 'Desktop form fields not verified');
      const fields = { text: value, area: nativeMultiline, select: '2', checks: [false, true], radios: [false, true] };
      await chromeApp.click(axIndex(s, /\d+ 按钮 Submit$/));
      s = await axUntil(await axRead(), s => s.includes('文本 Received!') && s.includes('submitted-form.html'), 'submission');
      const html = axMatches(s, /HTML 内容.*submitted-form.html/)[0];
      const params = new URL('https://' + html.split('URL: ')[1].replace(/^https?:\/\//, '')).searchParams;
      nativeAssert(params.get('my-text') === value && params.get('my-textarea').replace(/\r/g, '') === nativeMultiline &&
        params.get('my-select') === '2', 'Desktop submitted values not verified'); actual = { fields, received: true };
    } else if (task === 'selenium-dynamic') {
      await chromeApp.click(axIndex(s, /\d+ 按钮 Reveal a new input$/));
      s = await axUntil(await axRead(), s => axMatches(s, /文本栏 \(settable\)(?! 地址和搜索栏)/).length === 1, 'reveal input');
      await chromeApp.setValue(axIndex(s, /文本栏 \(settable\)(?! 地址和搜索栏)/), value); s = await axRead();
      nativeAssert(axMatches(s, /文本栏 \(settable\)(?! 地址和搜索栏)/).some(l => l.includes(value)), 'Desktop input not verified');
      actual = [{ value, visible: true }];
    } else if (task === 'internet-controls') {
      await chromeApp.click(axIndex(s, /弹出式按钮 Please select an option$/)); s = await axRead();
      await chromeApp.click(axIndex(s, /\d+ (?:\(selected\) )?Option 2, ID:/)); s = await axRead();
      nativeAssert(s.includes('弹出式按钮 Option 2'), 'Desktop dropdown not verified');
      s = await axGoto('https://the-internet.herokuapp.com/checkboxes', /复选框/);
      const boxes = axMatches(s, /\d+ 复选框/); nativeAssert(boxes.length === 2, 'Desktop checkbox count');
      for (const line of boxes) await chromeApp.click(Number(line.match(/^\s*(\d+)/)[1]));
      s = await axRead(); const after = axMatches(s, /\d+ 复选框/);
      nativeAssert(after.length === 2 && /复选框 1$/.test(after[0]) && /复选框 0$/.test(after[1]), 'Desktop checkbox values not verified');
      actual = { selection: { value: '2', index: 2 }, checks: [true, false] };
    } else {
      for (const [button, message] of [['Remove', "It's gone!"], ['Add', "It's back!"], ['Enable', "It's enabled!"]]) {
        await chromeApp.click(axIndex(s, new RegExp('\\d+ 按钮 ' + button + '$')));
        s = await axUntil(await axRead(), s => s.includes(message), 'feedback ' + message);
      }
      await chromeApp.setValue(axIndex(s, /文本栏 \(settable\)(?! 地址和搜索栏)/), value); s = await axRead();
      await chromeApp.click(axIndex(s, /\d+ 按钮 Disable$/));
      s = await axUntil(await axRead(), s => s.includes("It's disabled!"), 'disable feedback');
      nativeAssert(axMatches(s, /文本栏 \(disabled\)/).some(l => l.includes(value)) &&
        axMatches(s, /\d+ 复选框/).length === 1, 'Desktop disabled field and restored checkbox not verified');
      actual = { value, disabled: true, checkboxes: 1, message: true };
    }
  } catch (e) { error = String(e); }
  const finished = performance.now();
  const row = { arm: 'codex-computer-use', round, task, verified: !error, error,
    navigationMs: loaded - started, executionMs: finished - loaded, workflowMs: finished - started, actual };
  desktopRows.push(row); desktopObservations.push({ round, task, finalState: s });
  nodeRepl.write(JSON.stringify(row)); return row;
};
