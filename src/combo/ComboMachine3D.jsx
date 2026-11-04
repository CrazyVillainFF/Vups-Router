// The dynamic-import seam. ComboPowerCore lazily fetches this module only after
// a WebGL context has been proven available, so three.js and the whole renderer
// stay out of the main bundle. The scene itself lives in ./machine/ - this file
// exists to keep that import path and the split chunk name stable.
export { default } from "./machine/ApexScene.jsx";
