// mammoth ships types for its Node entry only; the browser bundle (a
// browserify build of the same API, no `fs`) is that module too.
declare module 'mammoth/mammoth.browser' {
  import mammoth = require('mammoth');
  export = mammoth;
}
