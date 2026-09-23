# Third-party notices

## dev-browser

This project is derived from [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser),
revision `a25e7672e199153b2f5b52a841a62436a28d925f`. The Chrome extension is adapted from upstream
revision `b549fb0` (the archived extension implementation). The warm daemon, Puppeteer runtime,
persistent named pages, snapshots, CLI and much of the test suite originate in that project.

Thank you to Sawyer Hood and the dev-browser contributors for the foundation. Their MIT
copyright and permission notice is preserved in [LICENSE](LICENSE).

This repository has independent naming, release history and maintenance. It is not an official
release of dev-browser, Jev/TypeSafe, Browser Use, OpenAI or Anthropic.

## jev-ultrafast

The operation/target fan-out and decision instructions in `src/jev/model.ts`, and the scoped
freshness guards and bounded post-input waiting in `src/page/snapshot/inpage.ts` and `src/jev/browser.ts`, are adapted from
[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast), revision `1231850`.

MIT License

Copyright (c) 2026 Browser Use

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
