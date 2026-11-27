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
node dev/test/customize.mjs # Customize: groups, sub-groups, templates, hiding, reset, review, phone drag
node dev/test/tasks.mjs    # Tasks & Bugs: quick add, folders, filters, list/board, task page, wiki box, phone
node dev/test/ideas.mjs    # Ideas: sections, outline, folding, idea page, make a task, copy ideas, phone
node dev/test/mindmap.mjs  # Mind map: select, drag, select mode, menus, connections, fold, tidy, undo, zoom, phone pinch
node dev/test/sw.mjs       # offline loading and the "new version" prompt
```

`dev/starter-wiki.json` is the starter wiki import from part 2b (also used by wiki.mjs).
`dev/starter-tasks.json` is the starter tasks import from part 2c (also used by tasks.mjs).
`dev/starter-ideas.json` is the starter ideas import from part 2c Ideas (also used by ideas.mjs).

Needs Python with Pillow, Node 18+, Playwright and Chrome
(`CHROME`, `PLAYWRIGHT_DIR`, `BASE` and `SHOTS` environment variables override the defaults).
Screenshots go to `/tmp/brr-shots/`.
