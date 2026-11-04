/* Numbers the stage and the DOM both need, kept out of the WebGL modules so a
   fallback can measure the same room without importing three.js. */

export const CAMERA_FOV = 30;
/** The plate is 2 units wide and centred on the origin, so a floor a little
    below its base is the surface the plinth appears to stand on. */
export const FLOOR_Y = -1.62;
/** How far the canvas is from the copy column at the hero pose, in world units
    — the poster lays its own mark out by the same proportion. */
export const STAGE_ASPECT = 1.6;
