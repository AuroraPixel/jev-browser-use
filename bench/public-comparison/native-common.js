// Paste these prepared declarations into the supported Codex CUA REPL.
// Read its documentation and bind baselineForm (in-app Tab) / chromeApp (native
// Google Chrome App) first. These are not Puppeteer substitutes for Codex tools.
var nativeRows = [], desktopRows = [], desktopObservations = [];
var nativeAssert = (ok, message) => { if (!ok) throw Error(message); };
var nativeMultiline = 'First line\nSecond line';
var nativeTaskUrls = {
  'selenium-form': 'https://www.selenium.dev/selenium/web/web-form.html',
  'selenium-dynamic': 'https://www.selenium.dev/selenium/web/dynamic.html',
  'internet-controls': 'https://the-internet.herokuapp.com/dropdown',
  'internet-dynamic': 'https://the-internet.herokuapp.com/dynamic_controls'
};
