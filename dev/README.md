# Developer tools

These files are for building and testing the app. The app itself never loads them.

## Build

```
python3 dev/build.py                 # icons + sw.js file list and version
python3 dev/build.py ../update.zip   # same, plus a zip of the whole repo for upload
```

Run it after every change: `sw.js` must list every app file and get a new `VERSION`,
otherwise installed copies keep the old files.

## Test

Serve the repo root, then run the tests (they use a fake GitHub, never the real one):

```
python3 -m http.server 8123 &
node dev/test/e2e.mjs      # two simulated devices: connect, import, push, pull, conflicts, themes
node dev/test/wiki.mjs     # Wiki tab: starter import, groups, pages, links, back button, search, phone
node dev/test/wikiedit.mjs # Wiki editing: new page, editor, / menu, links, pictures, undo, move, delete
node dev/test/sw.mjs       # offline loading and the "new version" prompt
```

`dev/starter-wiki.json` is the starter wiki import from part 2b (also used by wiki.mjs).

Needs Python with Pillow, Node 18+, Playwright and Chrome
(`CHROME`, `PLAYWRIGHT_DIR`, `BASE` and `SHOTS` environment variables override the defaults).
Screenshots go to `/tmp/brr-shots/`.
